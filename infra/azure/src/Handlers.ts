/**
 * The handlers of the bot on Azure, as plain effects over web `Request`s and nudge message bodies; `functions/` wires
 * them to Azure Functions triggers.
 *
 * - `receiver` (HTTP trigger): the SDK's webhook routes verify and save the event; the store's write nudges the
 *   mailbox.
 * - `processor` (Service Bus trigger, one message at a time): runs the engine for the nudged mailbox only, draining
 *   the in-process echo agent after every pass, for at most `PASS_BUDGET_MS`, then re-nudges the mailbox if it is
 *   still due (see `processNudge`). It fails when the message should be delivered again.
 * - `sweep` (timer trigger, once a minute): nudges every mailbox whose `readyAt` has passed.
 *
 * Everything but the mailbox-scoped processing is built once per cold start by `makeHandlers`; the processing for
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
import { Clock, type Config, ConfigProvider, Context, Effect, Exit, Layer, Option, Schema, Scope } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpEffect, HttpRouter, type HttpServerRequest } from 'effect/http'

import { makeInProcessAgentSessions } from './InProcessAgent'
import { makeStorage, sweep } from './MailboxStore'
import { MailboxTable, type TableUnavailable } from './MailboxTable'
import { Nudger, nudgeDelay } from './Nudger'

/** The most processing passes one nudge runs, as the Cloudflare mailbox alarm does. */
export const MAX_PASSES_PER_NUDGE = 20

/**
 * How long one nudge keeps starting passes. A pass can last about 5 s (the callback, then the echo's drain), so a
 * burst of batches on one mailbox would otherwise run past the Processor's 30 s timeout and cut an echo off. Once
 * the budget is spent, no new pass starts and a delay-0 nudge continues in a fresh invocation.
 */
export const PASS_BUDGET_MS = 15_000

/**
 * The shortest re-nudge for a mailbox that is still due but whose last pass found no work: it is stuck (a claim or
 * write that keeps failing, which the engine reports as a skipped mailbox). Waiting at least this long stops a
 * delay-0 nudge loop running at Function speed, as the Cloudflare alarm's `max(readyAt, now + rearmAfterMs)` does.
 */
export const REARM_FLOOR_MS = 5_000

/** Requests from the in-process delivery client never leave the process; this host only fills the URL. */
const IN_PROCESS_ORIGIN = 'http://in-process.delivery-api'

/** The body of one nudge message, as `ServiceBusNudgerLive` sends it. */
const NudgeFields = Schema.Struct({ mailboxKey: Schema.NonEmptyString })
const NudgeMessage = Schema.fromJsonString(NudgeFields)

/** A trigger hands over the body as JSON text, or as an object when it has already parsed it. */
const decodeNudge = (body: unknown) =>
	typeof body === 'string' ? Schema.decodeUnknownEffect(NudgeMessage)(body) : Schema.decodeUnknownEffect(NudgeFields)(body)

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

/** The three handlers as effects, over services built once. */
export interface Handlers {
	/** Answer one webhook request. Never fails: every outcome is an HTTP response. */
	readonly receiver: (request: Request) => Effect.Effect<Response>
	/** Answer a runner's OIDC-authenticated proxy call. Never fails. */
	readonly researchSession: (request: Request) => Effect.Effect<Response>
	/**
	 * Process one nudge message (its JSON text, or the object a trigger already parsed). It fails when the message
	 * should be delivered again.
	 */
	readonly processor: (body: unknown) => Effect.Effect<void, unknown>
	/** Nudge every mailbox due now and report how many. */
	readonly sweep: Effect.Effect<{ readonly nudged: number }, TableUnavailable>
	/**
	 * Exactly what the Processor runs for one record's mailbox: passes over that mailbox only, then the re-nudge. It
	 * fails when the record should be delivered again.
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
		 * Nudge the mailbox again if it is still due, so nothing waits for the sweep: a pass that wrote nothing nudged
		 * nothing, and a nudge capped at 15 minutes arrives before a later `readyAt`.
		 * - `readyAt` null: nothing to do, no nudge.
		 * - `readyAt` later: nudge then.
		 * - `readyAt` passed and `workRemains` (the passes stopped at the cap or the budget while still finding work):
		 *   nudge at once.
		 * - `readyAt` passed and the last pass found no work: the mailbox is stuck; nudge after `REARM_FLOOR_MS`.
		 */
		const renudge = Effect.fn('azure.processor.renudge')(function* (mailboxKey: string, workRemains: boolean) {
			const stored = yield* table.read(mailboxKey)
			if (Option.isNone(stored)) return
			const { readyAt } = stored.value.state.deliveries
			if (readyAt === null) return
			const now = yield* Clock.currentTimeMillis
			const delayMs = readyAt > now ? nudgeDelay(readyAt, now) : workRemains ? 0 : REARM_FLOOR_MS
			yield* nudger.nudge(mailboxKey, delayMs)
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

		const processor = Effect.fn('azure.processor')(function* (body: unknown) {
			const { mailboxKey } = yield* decodeNudge(body)
			yield* processNudge(mailboxKey)
		}, Effect.tapCause((cause) => Effect.logError('Azure processor message failed', cause)))

		const sweepNow = Clock.currentTimeMillis.pipe(
			Effect.flatMap(sweep),
			Effect.map((nudged) => ({ nudged })),
			Effect.provideService(MailboxTable, table),
			Effect.provideService(Nudger, nudger),
			Effect.withSpan('azure.sweep'),
		)

		return { receiver, researchSession, processor, sweep: sweepNow, processNudge } satisfies Handlers
	})

/** The entry points the Functions triggers call: Promise-returning functions over handlers built on first use. */
export interface EntryPoints {
	readonly receiver: (request: Request) => Promise<Response>
	readonly researchSession: (request: Request) => Promise<Response>
	readonly processor: (body: unknown) => Promise<void>
	readonly sweep: () => Promise<{ readonly nudged: number }>
}

/**
 * Entry points over `build`, run once per cold start on the first invocation and reused after. A build that fails is
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
		processor: (body) => handlers().then((ready) => Effect.runPromise(ready.processor(body))),
		sweep: () => handlers().then((ready) => Effect.runPromise(ready.sweep)),
	}
}
