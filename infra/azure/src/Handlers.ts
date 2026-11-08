/**
 * The handlers of the bot on Azure, as plain effects over web `Request`s; `server.ts` wires them to HTTP routes.
 *
 * - `receiver`: the SDK's webhook routes verify and save the event; the store's write nudges the mailbox.
 * - `processNudge`: runs the engine for one mailbox only, draining the in-process echo agent after every pass, for
 *   at most `PASS_BUDGET_MS`, then nudges the mailbox again if more work is due. The in-memory nudger calls it.
 *
 * There is no queue and no sweep. A nudge is a timer in the app's memory. If the app stops, the timer is lost.
 *
 * Everything but the mailbox-scoped processing is built once per start by `makeHandlers`; the processing for
 * one mailbox is built per nudge and discarded.
 */
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import {
	Channels,
	DeliveryControlLive,
	deliveryApiRoutes,
	MailboxProcessing,
	makeDeliveryClient,
} from '@humanlayer/channels-delivery'
import { GitHubApi, GitHubApiLive } from '@humanlayer/channels-github'
import { AgentSessions, botSettings, DeliveryApi, makeGitHubProvider } from '@slop/core'
import { Clock, type Config, ConfigProvider, Context, Effect, Exit, Layer, Option, Scope } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpEffect, HttpRouter, type HttpServerRequest } from 'effect/http'

import { makeInProcessAgentSessions } from './InProcessAgent'
import { makeStorage } from './MailboxStore'
import { MailboxTable } from './MailboxTable'
import { Nudger, nudgeDelay } from './Nudger'

/** The most processing passes one nudge runs, as the Cloudflare mailbox alarm does. */
export const MAX_PASSES_PER_NUDGE = 20

/**
 * How long one nudge keeps starting passes. A pass can last about 5 s (the callback, then the echo's drain), so a
 * burst of batches on one mailbox would otherwise run past the Processor's 30 s timeout and cut an echo off. Once
 * the budget is spent, no new pass starts and a delay-0 nudge continues in a fresh invocation.
 */
export const PASS_BUDGET_MS = 15_000

/** Requests from the in-process delivery client never leave the process; this host only fills the URL. */
const IN_PROCESS_ORIGIN = 'http://in-process.delivery-api'

/** What the handlers are built over; production passes the Azure services, tests pass fakes. */
export interface HandlerDependencies<E> {
	/** Where mailboxes live. */
	readonly table: Layer.Layer<MailboxTable>
	/** How a mailbox is woken later. */
	readonly nudger: Layer.Layer<Nudger>
	/** The bot's configuration (webhook secret, bot identity, GitHub App credentials). */
	readonly config: Effect.Effect<ConfigProvider.ConfigProvider, E>
	/** GitHub, configured from `config`. */
	readonly gitHubApi: Layer.Layer<GitHubApi, Config.ConfigError>
	/**
	 * Where handed-off deliveries go, and how to wait for the work they started before an invocation returns.
	 * Default: the echo agent in process (`makeInProcessAgentSessions`). The shared suite's driver passes its own.
	 */
	/**
	 * The runner's OIDC-authenticated proxy (`/research-session/{id}/...`), built over the router so it can call the
	 * delivery API in process; default: not found.
	 */
	readonly researchSession?: (forward: (request: Request) => Promise<Response>) => (request: Request) => Promise<Response>
	readonly agentSessions?: {
		readonly layer: Layer.Layer<AgentSessions, never, DeliveryApi>
		readonly drain: Effect.Effect<void>
	}
}

/** The handlers as effects, over services built once. */
export interface Handlers {
	/** Answer one webhook request. Never fails: every outcome is an HTTP response. */
	readonly receiver: (request: Request) => Effect.Effect<Response>
	/** Answer a runner's OIDC-authenticated proxy call. Never fails. */
	readonly researchSession: (request: Request) => Effect.Effect<Response>
	/**
	 * What the nudger runs for one mailbox: passes over that mailbox only, then the re-nudge. It fails when the
	 * table is unavailable. Nothing retries it: the nudger logs the failure.
	 */
	readonly processNudge: (mailboxKey: string) => Effect.Effect<void, unknown>
}

/**
 * Build the handlers over `dependencies`: the table, nudger, configuration, GitHub, the webhook and delivery API
 * router, and the in-process echo agent, once. Everything lives until `Scope` closes.
 */
export const makeHandlers = <E>(
	dependencies: HandlerDependencies<E>,
): Effect.Effect<Handlers, E | Config.ConfigError, Scope.Scope> =>
	Effect.gen(function* () {
		const configLayer = ConfigProvider.layer(yield* dependencies.config)
		const table = Context.get(yield* Layer.build(dependencies.table), MailboxTable)
		const nudger = Context.get(yield* Layer.build(dependencies.nudger), Nudger)
		const tableAndNudger = Layer.merge(Layer.succeed(MailboxTable, table), Layer.succeed(Nudger, nudger))
		const gitHubApi = Context.get(
			yield* Layer.build(dependencies.gitHubApi.pipe(Layer.provide(configLayer))),
			GitHubApi,
		)
		const options = { ...botSettings, providers: [makeGitHubProvider(Layer.succeed(GitHubApi, gitHubApi))] } as const
		const services = Layer.merge(NodeCrypto.layer, configLayer)

		/** The webhook routes and the delivery API on one router, over a store that sees every mailbox. */
		const routerLayer = Layer.merge(
			Channels.routesLayer(options),
			deliveryApiRoutes({}).pipe(Layer.provide(DeliveryControlLive)),
		).pipe(
			Layer.provideMerge(
				HttpRouter.layer.pipe(Layer.provide(Layer.succeed(HttpRouter.RouterConfig, Channels.routerConfig))),
			),
			Layer.provide(makeStorage({ polling: 'disabled' }).layer.pipe(Layer.provide(tableAndNudger))),
			Layer.provide(services),
		)
		/**
		 * `HttpRouter.Request<'Error', ...>` is a type-only marker of the errors a route may raise, never a service to
		 * provide; the SDK's own `start` builds the same layer without it. Serving turns those errors into responses.
		 */
		const router = Context.get(
			yield* Layer.build(
				routerLayer as Layer.Layer<Layer.Success<typeof routerLayer>, Layer.Error<typeof routerLayer>>,
			),
			HttpRouter.HttpRouter,
		)
		const handle = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(
			yield* Effect.context<never>(),
		)(router.asHttpEffect())
		const send = (request: Request) => Effect.promise(() => handle(request))

		/** The echo agent's delivery API client, reaching the router above in process. */
		const inProcess = HttpClient.make((request) =>
			HttpClientRequest.toWeb(request).pipe(
				Effect.flatMap(send),
				Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
				Effect.orDie,
			),
		)
		const deliveryClient = yield* makeDeliveryClient({ baseUrl: IN_PROCESS_ORIGIN }).pipe(
			Effect.provideService(HttpClient.HttpClient, inProcess),
		)
		const agent = dependencies.agentSessions ?? (yield* makeInProcessAgentSessions)
		const agentSessions = Context.get(
			yield* Layer.build(agent.layer.pipe(Layer.provide(Layer.succeed(DeliveryApi, deliveryClient)))),
			AgentSessions,
		)

		/** Mailbox processing over a store that sees only `mailboxKey`, as one nudge's invocation does. */
		const processingLayer = (mailboxKey: string) =>
			Channels.processingLayer(options, 'disabled').pipe(
				Layer.provide(
					makeStorage({ polling: 'disabled', scope: mailboxKey }).layer.pipe(Layer.provide(tableAndNudger)),
				),
				Layer.provide(Layer.merge(services, Layer.succeed(AgentSessions, agentSessions))),
			)

		/**
		 * Nudge the mailbox again if it is still due. A nudge capped at 15 minutes arrives before a later `readyAt`.
		 * - `readyAt` null: nothing to do, no nudge.
		 * - `readyAt` later: nudge then.
		 * - `readyAt` passed and `workRemains` (the passes stopped at the cap or the budget while still finding work):
		 *   nudge at once.
		 * - `readyAt` passed and the last pass found no work: the mailbox is stuck. No retry timer: the next event
		 *   for this mailbox wakes it.
		 */
		const renudge = Effect.fn('azure.processor.renudge')(function* (mailboxKey: string, workRemains: boolean) {
			const stored = yield* table.read(mailboxKey)
			if (Option.isNone(stored)) return
			const { readyAt } = stored.value.state.deliveries
			if (readyAt === null) return
			const now = yield* Clock.currentTimeMillis
			if (readyAt <= now && !workRemains) {
				yield* Effect.logWarning('Mailbox is due but a pass found no work; no retry is scheduled').pipe(
					Effect.annotateLogs({ mailboxKey }),
				)
				return
			}
			yield* nudger.nudge(mailboxKey, readyAt > now ? nudgeDelay(readyAt, now) : 0)
		})

		/**
		 * Pass while a pass finds work, at most `MAX_PASSES_PER_NUDGE` passes and no new pass after `PASS_BUDGET_MS`,
		 * draining the agent after each; then re-nudge.
		 */
		const processNudge = Effect.fn('azure.processor.mailbox')(function* (mailboxKey: string) {
			const workRemains = yield* Effect.scoped(
				Effect.gen(function* () {
					const processing = Context.get(yield* Layer.build(processingLayer(mailboxKey)), MailboxProcessing)
					const startedAt = yield* Clock.currentTimeMillis
					let foundWork = false
					for (let passes = 0; passes < MAX_PASSES_PER_NUDGE; passes++) {
						if (passes > 0 && (yield* Clock.currentTimeMillis) - startedAt >= PASS_BUDGET_MS) break
						const { claimed, output } = yield* processing.processReady.pipe(Effect.ensuring(agent.drain))
						foundWork = claimed > 0 || output > 0
						if (!foundWork) break
					}
					return foundWork
				}),
			)
			yield* renudge(mailboxKey, workRemains)
		})

		const receiver = Effect.fn('azure.receiver')(function* (request: Request) {
			return yield* send(request)
		})

		const proxy = dependencies.researchSession?.(handle)
		const researchSession = (request: Request) =>
			Effect.promise(async () => (await proxy?.(request)) ?? new Response('Not found', { status: 404 }))

		return { receiver, researchSession, processNudge } satisfies Handlers
	})

/** The entry points the HTTP server and the nudger call: Promise-returning functions over handlers built on first use. */
export interface EntryPoints {
	readonly receiver: (request: Request) => Promise<Response>
	readonly researchSession: (request: Request) => Promise<Response>
	readonly processNudge: (mailboxKey: string) => Promise<void>
}

/**
 * Entry points over `build`, run once on the first call and reused after. A build that fails is
 * not kept: its scope is closed and the next invocation builds again.
 */
export const entryPoints = <E>(build: Effect.Effect<Handlers, E, Scope.Scope>): EntryPoints => {
	let built: Promise<Handlers> | undefined
	const handlers = () => {
		built ??= Effect.runPromise(
			Effect.gen(function* () {
				const scope = yield* Scope.make()
				return yield* build.pipe(
					Scope.provide(scope),
					Effect.onError(() => Scope.close(scope, Exit.void)),
				)
			}),
		).catch((error: unknown) => {
			built = undefined
			throw error
		})
		return built
	}
	return {
		receiver: (request) => handlers().then((ready) => Effect.runPromise(ready.receiver(request))),
		researchSession: (request) => handlers().then((ready) => Effect.runPromise(ready.researchSession(request))),
		processNudge: (mailboxKey) => handlers().then((ready) => Effect.runPromise(ready.processNudge(mailboxKey))),
	}
}
