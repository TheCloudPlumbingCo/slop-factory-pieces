/**
 * The Lambda entry points of the bot on AWS:
 *
 * - `receiverHandler` (API Gateway HTTP API, payload 2.0): the SDK's webhook routes verify and save the event; the
 *   store's write nudges the mailbox.
 * - `processorHandler` (SQS, batch size 1, `ReportBatchItemFailures`): runs the engine for the nudged mailbox only,
 *   draining the in-process echo agent after every pass, for at most `PASS_BUDGET_MS`, then re-nudges the mailbox
 *   if it is still due (see `processNudge`).
 * - `sweepHandler` (EventBridge Scheduler, once a minute): nudges every mailbox whose `readyAt` has passed.
 *
 * Environment variables (read once per cold start):
 * - `MAILBOX_TABLE`: the DynamoDB mailbox table's name
 * - `NUDGE_QUEUE_URL`: the SQS queue the nudges go to and the Processor reads
 * - `SSM_PREFIX`: the SSM path holding `GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_MENTION_NAME`, `GITHUB_BOT_USER_ID`,
 *   `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY`
 *
 * Everything but the mailbox-scoped processing is built once per cold start by `makeHandlers`; the processing for
 * one mailbox is built per nudge and discarded.
 */
import { Buffer } from 'node:buffer'

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
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
import type {
	APIGatewayProxyEventV2,
	APIGatewayProxyStructuredResultV2,
	SQSBatchResponse,
	SQSEvent,
	SQSRecord,
} from 'aws-lambda'
import { Clock, Config, ConfigProvider, Context, Effect, Exit, Layer, Option, Schema, Scope } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpEffect, HttpRouter, type HttpServerRequest } from 'effect/http'

import { ssmConfigProvider } from './Config'
import { makeDynamoStorage, sweep } from './DynamoMailboxStore'
import { DynamoMailboxTableLive } from './DynamoMailboxTable'
import { makeInProcessAgentSessions } from './InProcessAgent'
import { MailboxTable, type TableUnavailable } from './MailboxTable'
import { Nudger, nudgeDelay } from './Nudger'
import { SqsNudgerLive } from './SqsNudger'

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
 * delay-0 nudge loop running at Lambda speed, as the Cloudflare alarm's `max(readyAt, now + rearmAfterMs)` does.
 */
export const REARM_FLOOR_MS = 5_000

/** Requests from the in-process delivery client never leave the process; this host only fills the URL. */
const IN_PROCESS_ORIGIN = 'http://in-process.delivery-api'

/** The body of one nudge message, as `SqsNudgerLive` sends it. */
const NudgeMessage = Schema.fromJsonString(Schema.Struct({ mailboxKey: Schema.NonEmptyString }))

/** What the handlers are built over; production passes the AWS services, tests pass fakes. */
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
	readonly agentSessions?: {
		readonly layer: Layer.Layer<AgentSessions, never, DeliveryApi>
		readonly drain: Effect.Effect<void>
	}
}

/** The three handlers as effects, over services built once. */
export interface Handlers {
	/** Answer one webhook request. Never fails: every outcome is an HTTP response. */
	readonly receiver: (event: APIGatewayProxyEventV2) => Effect.Effect<APIGatewayProxyStructuredResultV2>
	/** Process each nudged mailbox; a record that fails is reported for SQS to deliver again. */
	readonly processor: (event: SQSEvent) => Effect.Effect<SQSBatchResponse>
	/** Nudge every mailbox due now and report how many. */
	readonly sweep: Effect.Effect<{ readonly nudged: number }, TableUnavailable>
	/**
	 * Exactly what the Processor runs for one record's mailbox: passes over that mailbox only, then the re-nudge. It
	 * fails when the record should be delivered again.
	 */
	readonly processNudge: (mailboxKey: string) => Effect.Effect<void, unknown>
}

/** A web `Request` with the original body bytes (base64 decoded, never re-serialized) and lower-cased headers. */
const toRequest = (event: APIGatewayProxyEventV2): Request => {
	const headers = new Headers()
	for (const [name, value] of Object.entries(event.headers)) {
		if (value !== undefined) headers.set(name.toLowerCase(), value)
	}
	if (event.cookies !== undefined && event.cookies.length > 0) headers.set('cookie', event.cookies.join('; '))
	const method = event.requestContext.http.method
	const body =
		event.body === undefined || method === 'GET' || method === 'HEAD'
			? undefined
			: event.isBase64Encoded
				? new Uint8Array(Buffer.from(event.body, 'base64'))
				: event.body
	const query = event.rawQueryString === '' ? '' : `?${event.rawQueryString}`
	return new Request(`https://${event.requestContext.domainName}${event.rawPath}${query}`, { method, headers, body })
}

/** The Lambda result for a web `Response`: its status, headers and text body. */
const toResult = async (response: Response): Promise<APIGatewayProxyStructuredResultV2> => {
	const headers: Record<string, string> = {}
	response.headers.forEach((value, name) => {
		headers[name] = value
	})
	return { statusCode: response.status, headers, body: await response.text(), isBase64Encoded: false }
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
			Layer.provide(makeDynamoStorage({ polling: 'disabled' }).layer.pipe(Layer.provide(tableAndNudger))),
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
					makeDynamoStorage({ polling: 'disabled', scope: mailboxKey }).layer.pipe(Layer.provide(tableAndNudger)),
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
		const renudge = Effect.fn('aws.processor.renudge')(function* (mailboxKey: string, workRemains: boolean) {
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
		const processNudge = Effect.fn('aws.processor.mailbox')(function* (mailboxKey: string) {
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

		/** One SQS record: `none` when processed, `some(messageId)` when SQS should deliver it again. */
		const processRecord = (record: SQSRecord) =>
			Schema.decodeUnknownEffect(NudgeMessage)(record.body).pipe(
				Effect.flatMap(({ mailboxKey }) => processNudge(mailboxKey)),
				Effect.as(Option.none<string>()),
				Effect.catchCause((cause) =>
					Effect.logError('AWS processor record failed', cause).pipe(
						Effect.annotateLogs({ messageId: record.messageId }),
						Effect.as(Option.some(record.messageId)),
					),
				),
			)

		const receiver = Effect.fn('aws.receiver')(function* (event: APIGatewayProxyEventV2) {
			const response = yield* send(toRequest(event))
			return yield* Effect.promise(() => toResult(response))
		})

		const processor = Effect.fn('aws.processor')(function* (event: SQSEvent) {
			const failed = yield* Effect.forEach(event.Records, processRecord)
			return {
				batchItemFailures: failed.flatMap((messageId) =>
					Option.isSome(messageId) ? [{ itemIdentifier: messageId.value }] : [],
				),
			}
		})

		const sweepNow = Clock.currentTimeMillis.pipe(
			Effect.flatMap(sweep),
			Effect.map((nudged) => ({ nudged })),
			Effect.provideService(MailboxTable, table),
			Effect.provideService(Nudger, nudger),
			Effect.withSpan('aws.sweep'),
		)

		return { receiver, processor, sweep: sweepNow, processNudge } satisfies Handlers
	})

/** The Lambda entry points: Promise-returning functions over handlers built on first use. */
export interface LambdaEntryPoints {
	readonly receiverHandler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>
	readonly processorHandler: (event: SQSEvent) => Promise<SQSBatchResponse>
	readonly sweepHandler: () => Promise<{ readonly nudged: number }>
}

/**
 * Lambda entry points over `build`, run once per cold start on the first invocation and reused after. A build that
 * fails is not kept: its scope is closed and the next invocation builds again.
 */
export const lambdaEntryPoints = <E>(build: Effect.Effect<Handlers, E, Scope.Scope>): LambdaEntryPoints => {
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
		receiverHandler: (event) => handlers().then((ready) => Effect.runPromise(ready.receiver(event))),
		processorHandler: (event) => handlers().then((ready) => Effect.runPromise(ready.processor(event))),
		sweepHandler: () => handlers().then((ready) => Effect.runPromise(ready.sweep)),
	}
}

/** The production handlers: DynamoDB, SQS, SSM and the real GitHub API, named by the environment. */
const productionHandlers = Effect.gen(function* () {
	const tableName = yield* Config.String('MAILBOX_TABLE')
	const queueUrl = yield* Config.String('NUDGE_QUEUE_URL')
	const ssmPrefix = yield* Config.String('SSM_PREFIX')
	return yield* makeHandlers({
		table: DynamoMailboxTableLive({ tableName, client: DynamoDBDocumentClient.from(new DynamoDBClient({})) }),
		nudger: SqsNudgerLive(queueUrl),
		config: ssmConfigProvider(ssmPrefix),
		gitHubApi: GitHubApiLive,
	})
})

const production = lambdaEntryPoints(productionHandlers)

/** Receiver Lambda: API Gateway HTTP API (payload 2.0) webhook requests. */
export const receiverHandler: LambdaEntryPoints['receiverHandler'] = production.receiverHandler

/** Processor Lambda: SQS nudges, batch size 1, with `ReportBatchItemFailures`. */
export const processorHandler: LambdaEntryPoints['processorHandler'] = production.processorHandler

/** Sweep Lambda: run by EventBridge Scheduler once a minute. */
export const sweepHandler: LambdaEntryPoints['sweepHandler'] = production.sweepHandler
