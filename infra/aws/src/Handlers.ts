/**
 * The Lambda entry points of the bot on AWS:
 *
 * - `receiverHandler` (API Gateway HTTP API, payload 2.0): the SDK's webhook routes verify and save the event; the
 *   store's write nudges the mailbox.
 * - `processorHandler` (SQS, batch size 1, `ReportBatchItemFailures`): runs the engine for the nudged mailbox only,
 *   draining the in-process echo agent after every pass, then re-nudges the mailbox if it is still due later.
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
}

/** The three handlers as effects, over services built once. */
export interface Handlers {
	/** Answer one webhook request. Never fails: every outcome is an HTTP response. */
	readonly receiver: (event: APIGatewayProxyEventV2) => Effect.Effect<APIGatewayProxyStructuredResultV2>
	/** Process each nudged mailbox; a record that fails is reported for SQS to deliver again. */
	readonly processor: (event: SQSEvent) => Effect.Effect<SQSBatchResponse>
	/** Nudge every mailbox due now and report how many. */
	readonly sweep: Effect.Effect<{ readonly nudged: number }, TableUnavailable>
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
		const agent = yield* makeInProcessAgentSessions
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
		 * Nudge the mailbox again if it is still due at some time. A pass that wrote nothing nudged nothing, and a
		 * nudge capped at 15 minutes arrives before a later `readyAt`; without this, either would wait for the sweep.
		 */
		const renudge = Effect.fn('aws.processor.renudge')(function* (mailboxKey: string) {
			const stored = yield* table.read(mailboxKey)
			if (Option.isNone(stored)) return
			const { readyAt } = stored.value.state.deliveries
			if (readyAt === null) return
			const now = yield* Clock.currentTimeMillis
			yield* nudger.nudge(mailboxKey, nudgeDelay(readyAt, now))
		})

		/** Pass while a pass finds work (at most 20), draining the echo agent after each, then re-nudge. */
		const processMailbox = Effect.fn('aws.processor.mailbox')(function* (mailboxKey: string) {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const processing = Context.get(yield* Layer.build(processingLayer(mailboxKey)), MailboxProcessing)
					for (let passes = 0; passes < MAX_PASSES_PER_NUDGE; passes++) {
						const { claimed, output } = yield* processing.processReady.pipe(Effect.ensuring(agent.drain))
						if (claimed === 0 && output === 0) break
					}
				}),
			)
			yield* renudge(mailboxKey)
		})

		/** One SQS record: `none` when processed, `some(messageId)` when SQS should deliver it again. */
		const processRecord = (record: SQSRecord) =>
			Schema.decodeUnknownEffect(NudgeMessage)(record.body).pipe(
				Effect.flatMap(({ mailboxKey }) => processMailbox(mailboxKey)),
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

		return { receiver, processor, sweep: sweepNow } satisfies Handlers
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
