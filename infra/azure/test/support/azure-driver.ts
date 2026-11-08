/**
 * The shared behaviour suite's driver for the bot on AWS: the real bot over `makeStorage` and a
 * `MailboxTable` (in memory, or DynamoDB Local). Its structure is Cloudflare's memory driver
 * (`infra/cloudfare/test/support/memory-driver.ts`) with the SDK's in-memory store replaced by the AWS one:
 *
 * - The real provider (`makeGitHubProvider`, so the real `githubHandlers` and `handOff`), the real namespace and
 *   event processing (`botSettings`), the SDK's webhook routes and delivery API, all in this test's fiber so the
 *   `TestClock` drives the debounce, retries and the hand-off timeout.
 * - Faked: `GitHubApi` (records reactions and comments), `AgentSessions` (records agent starts), the `DeliveryApi`
 *   client (reaches the delivery API routes in process), and in `'nudge'` mode the queue (`makeFakeQueue`).
 * - `'polling'`: one long-lived processing layer polls the whole table every 100 ms; nudges go nowhere.
 * - `'nudge'`: polling is disabled. Every stored write nudges the fake queue; `advance` delivers due messages, and
 *   each delivery is one Processor invocation: the production `processNudge` from `makeHandlers` (passes over that
 *   mailbox only, within the pass cap and time budget, then the re-nudge), with this driver's fake GitHub and its
 *   recording `AgentSessions` (nothing to drain). A failed invocation is delivered again after the queue's
 *   visibility timeout, as SQS does.
 * - The table and the queue are built once; `restart` drops all processing and builds it again over them.
 */
import { createHmac } from 'node:crypto'

import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import {
	Channels,
	DeliveryClosed,
	DeliveryControlLive,
	DeliveryTerminalConflict,
	deliveryApiRoutes,
	makeDeliveryClient,
} from '@humanlayer/channels-delivery'
import {
	type GitHubAccessLevel,
	GitHubApi,
	GitHubApiError,
	GitHubDiscussionRef,
	GitHubId,
	GitHubIssueComment,
	GitHubParticipant,
	type GitHubReactionRequest,
} from '@humanlayer/channels-github'
import { type AgentSessionMessage, AgentSessions, botSettings, DeliveryApi, echoReply, makeGitHubProvider } from '@slop/core'
import { type AgentStart, type ControlLayerDriver, conformanceBot } from '@slop/core/conformance/driver'
import { Clock, ConfigProvider, Context, Effect, Exit, Layer, Redacted, Ref, Scope } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpEffect, HttpRouter, HttpServerRequest } from 'effect/http'
import { TestClock } from 'effect/testing'

import { makeStorage } from '../../src/MailboxStore'
import { type Handlers, makeHandlers } from '../../src/Handlers'
import { MailboxTable } from '../../src/MailboxTable'
import { Nudger } from '../../src/Nudger'
import { makeFakeQueue } from './fake-queue'

const signingKey = 'control-layer-test-key'
const ORIGIN = 'http://control-layer.test'
/** How often `'polling'` mode looks for due mailboxes. */
const POLL_MS = 100
/** `advance` moves the clock in steps no longer than this, so work woken by one step can schedule the next. */
const ADVANCE_STEP_MS = 100
/** SQS hides a message whose invocation failed for this long before delivering it again (6 x the 30 s timeout). */
const VISIBILITY_TIMEOUT_MS = 180_000
/** Real event-loop turns with no table call in flight before background processing counts as settled. */
const QUIET_TURNS = 3
/** The most real event-loop turns one settle waits for table calls to finish. */
const MAX_SETTLE_TURNS = 10_000

/** How processing is woken: by polling the table, or by nudges through a queue. */
export type AzureDriverMode = 'polling' | 'nudge'

/** The suite's driver plus a lever to nudge a mailbox by hand. */
export interface AwsControlLayerDriver extends ControlLayerDriver {
	/** Send a nudge with no delay for `mailboxKey`, whatever the mailbox holds. */
	readonly nudge: (mailboxKey: string) => Effect.Effect<void>
}

const repository = {
	installationId: GitHubId.make(100),
	repositoryId: GitHubId.make(200),
	owner: 'acme',
	repository: 'web',
}
const botAuthor = GitHubParticipant.make({
	id: GitHubId.make(conformanceBot.userId),
	login: `${conformanceBot.mentionName}[bot]`,
	type: 'Bot',
})

/** What the GitHub provider reads from the environment. */
const configProvider = ConfigProvider.fromUnknown({
	GITHUB_WEBHOOK_SECRET: signingKey,
	GITHUB_BOT_MENTION_NAME: conformanceBot.mentionName,
	GITHUB_BOT_USER_ID: String(conformanceBot.userId),
})
const environment = ConfigProvider.layer(configProvider)

/** Signed the way GitHub signs: `sha256=` + hex HMAC-SHA256 of the raw body. */
const sign = (key: string, body: string) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`

interface Recorded {
	readonly reactions: ReadonlyArray<GitHubReactionRequest>
	readonly comments: ReadonlyArray<GitHubIssueComment>
	readonly failCommentPosts: number
	/** Comment post attempts that `failCommentPosts` actually failed. */
	readonly failedCommentPosts: number
	readonly access: ReadonlyMap<string, GitHubAccessLevel>
	readonly starts: ReadonlyArray<AgentStart & { readonly accessToken: string }>
}

const discussionKey = (discussion: GitHubDiscussionRef) => `${discussion._tag}:${discussion.ref.number}`

/** One real event-loop turn, so I/O a background fiber started (DynamoDB Local calls) can finish. */
const realTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

/**
 * Build the driver over `input.table` (built once, kept across `restart`) in `input.mode`.
 *
 * @param input.table - where mailboxes live; a fresh one per driver
 * @param input.mode - `'polling'` (poll every 100 ms, no nudges) or `'nudge'` (no polling, fake queue)
 */
export const makeAzureDriver = (input: {
	readonly table: Layer.Layer<MailboxTable>
	readonly mode: AzureDriverMode
}): Effect.Effect<AwsControlLayerDriver, never, Scope.Scope> =>
	Effect.gen(function* () {
		const recorded = yield* Ref.make<Recorded>({
			reactions: [],
			comments: [],
			failCommentPosts: 0,
			failedCommentPosts: 0,
			access: new Map(),
			starts: [],
		})

		const post = (discussion: GitHubDiscussionRef, markdown: string) =>
			Ref.modify(recorded, (current): readonly [Effect.Effect<GitHubIssueComment, GitHubApiError>, Recorded] => {
				if (current.failCommentPosts > 0) {
					const error = new GitHubApiError({
						operation: discussion._tag === 'Issue' ? 'post_issue_comment' : 'post_pull_request_comment',
						reason: 'unavailable',
						retryable: true,
						status: 503,
					})
					return [
						Effect.fail(error),
						{
							...current,
							failCommentPosts: current.failCommentPosts - 1,
							failedCommentPosts: current.failedCommentPosts + 1,
						},
					]
				}
				const comment = GitHubIssueComment.make({
					ref: { discussion, id: GitHubId.make(900_000 + current.comments.length) },
					body: markdown,
					url: `https://github.com/acme/web/issues/${discussion.ref.number}#issuecomment-${current.comments.length}`,
					author: botAuthor,
				})
				return [Effect.succeed(comment), { ...current, comments: [...current.comments, comment] }]
			}).pipe(Effect.flatten)
		const commentsOn = (discussion: GitHubDiscussionRef) =>
			Ref.get(recorded).pipe(
				Effect.map((current) =>
					current.comments.filter((comment) => discussionKey(comment.ref.discussion) === discussionKey(discussion)),
				),
			)

		const gitHubApi = Layer.mock(GitHubApi, {
			fetchUserAccess: ({ login }) =>
				Ref.get(recorded).pipe(Effect.map((current) => current.access.get(login) ?? 'write')),
			addReaction: (request) =>
				Ref.update(recorded, (current) => ({ ...current, reactions: [...current.reactions, request] })),
			removeReaction: () => Effect.void,
			listIssueComments: ({ issue }) => commentsOn(GitHubDiscussionRef.cases.Issue.make({ ref: issue })),
			listPullRequestComments: ({ pullRequest }) =>
				commentsOn(GitHubDiscussionRef.cases.PullRequest.make({ ref: pullRequest })),
			postIssueComment: ({ issue, content }) =>
				post(GitHubDiscussionRef.cases.Issue.make({ ref: issue }), content.markdown),
			postPullRequestComment: ({ pullRequest, content }) =>
				post(GitHubDiscussionRef.cases.PullRequest.make({ ref: pullRequest }), content.markdown),
		})

		const agentSessions = Layer.succeed(
			AgentSessions,
			AgentSessions.of({
				getByName: (mailboxKey: string) => ({
					send: (message: typeof AgentSessionMessage.Encoded) =>
						Ref.update(recorded, (current) => ({
							...current,
							starts: [
								...current.starts,
								{
									deliveryId: message.deliveryId,
									mailboxKey,
									prompt: message.prompt,
									accessToken: message.accessToken,
								},
							],
						})),
				}),
			}),
		)

		const options = { ...botSettings, providers: [makeGitHubProvider(gitHubApi)] } as const
		const services = Layer.mergeAll(NodeCrypto.layer, agentSessions, environment)

		/**
		 * The table, built once for the driver's life: `restart` keeps it. Every call is counted while in flight, so
		 * `advance` can wait for real I/O (DynamoDB Local) that background processing started.
		 */
		const table = Context.get(yield* Layer.build(input.table), MailboxTable)
		let tableCallsInFlight = 0
		const tracked = <A, E>(call: Effect.Effect<A, E>): Effect.Effect<A, E> =>
			Effect.suspend(() => {
				tableCallsInFlight++
				return call
			}).pipe(Effect.ensuring(Effect.sync(() => tableCallsInFlight--)))
		const trackedTable = Layer.succeed(
			MailboxTable,
			MailboxTable.of({
				read: (mailboxKey) => tracked(table.read(mailboxKey)),
				write: (request) => tracked(table.write(request)),
				due: (now) => tracked(table.due(now)),
				subscribe: (mailboxKey) => tracked(table.subscribe(mailboxKey)),
				isSubscribed: (mailboxKey) => tracked(table.isSubscribed(mailboxKey)),
				unsubscribe: (mailboxKey) => tracked(table.unsubscribe(mailboxKey)),
			}),
		)

		/** The fake queue stands in for the in-memory nudger's timers. It is built once; its messages survive `restart`. */
		const queue = makeFakeQueue()
		const queueNudger = Context.get(yield* Layer.build(queue.nudger), Nudger)
		const nudger = Layer.succeed(
			Nudger,
			Nudger.of({
				nudge: (mailboxKey, delayMs) =>
					Effect.suspend(() => {
						if (input.mode === 'polling') return Effect.void
						return queueNudger.nudge(mailboxKey, delayMs)
					}),
			}),
		)
		const tableAndNudger = Layer.merge(trackedTable, nudger)

		/** The store the webhook routes and the delivery API write through: every mailbox, never polling. */
		const routeStore = makeStorage({ polling: 'disabled' }).layer.pipe(Layer.provide(tableAndNudger))

		/** The webhook half: webhook routes and the delivery API, on one router. */
		const routerLayer = Layer.merge(
			Channels.routesLayer(options),
			deliveryApiRoutes({}).pipe(Layer.provide(DeliveryControlLive)),
		).pipe(
			Layer.provideMerge(
				HttpRouter.layer.pipe(Layer.provide(Layer.succeed(HttpRouter.RouterConfig, Channels.routerConfig))),
			),
			Layer.provide(routeStore),
			Layer.provide(services),
		)
		/**
		 * `HttpRouter.Request<'Error', ...>` is a type-only marker of the errors a route may raise, never a service to
		 * provide; the SDK's own `start` builds the same layer without it. Serving turns those errors into responses.
		 */
		const routerContext = yield* Layer.build(
			routerLayer as Layer.Layer<Layer.Success<typeof routerLayer>, Layer.Error<typeof routerLayer>>,
		).pipe(Effect.orDie)
		const router = Context.get(routerContext, HttpRouter.HttpRouter)
		/** Requests run with this test's services, its `TestClock` among them. */
		const handle = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(
			yield* Effect.context<never>(),
		)(router.asHttpEffect())
		const send = (request: Request) => Effect.promise(() => handle(request))

		/** `'polling'` mode's processing: one layer over the whole table, polling every `intervalMs`. */
		const pollingLayer = (polling: { readonly intervalMs: number }) =>
			Channels.processingLayer(options, polling).pipe(
				Layer.provide(makeStorage({ polling }).layer.pipe(Layer.provide(tableAndNudger))),
				Layer.provide(services),
			)

		/**
		 * Everything processing holds in memory lives in this scope; `restart` closes it. In `'polling'` mode it holds
		 * the poll loop. In `'nudge'` mode it holds the production handlers (a fresh cold start after each restart),
		 * whose `processNudge` scopes each delivery's processing itself.
		 */
		const startProcessing = Effect.gen(function* () {
			const scope = yield* Scope.make()
			if (input.mode === 'polling') {
				yield* Layer.buildWithScope(pollingLayer({ intervalMs: POLL_MS }), scope).pipe(Effect.orDie)
				return { scope, handlers: undefined }
			}
			const handlers: Handlers = yield* makeHandlers({
				table: trackedTable,
				nudger,
				config: Effect.succeed(configProvider),
				gitHubApi,
				agentSessions: { layer: agentSessions, drain: Effect.void },
			}).pipe(Scope.provide(scope), Effect.orDie)
			return { scope, handlers }
		})
		const processing = yield* Ref.make(yield* startProcessing)
		yield* Effect.addFinalizer(() =>
			Ref.get(processing).pipe(Effect.flatMap(({ scope }) => Scope.close(scope, Exit.void))),
		)

		/**
		 * One nudge delivered: exactly what the Processor runs for one record. A failed run is logged and the message
		 * comes back after the visibility timeout, as SQS redelivers a record reported in `batchItemFailures`.
		 */
		const runNudge = (mailboxKey: string) =>
			Effect.gen(function* () {
				const { handlers } = yield* Ref.get(processing)
				if (handlers === undefined) return yield* Effect.die(new Error('runNudge is only used in nudge mode'))
				yield* handlers.processNudge(mailboxKey).pipe(
					Effect.catchCause((cause) =>
						Effect.logError('AWS nudge processing failed', cause).pipe(
							Effect.andThen(queueNudger.nudge(mailboxKey, VISIBILITY_TIMEOUT_MS)),
						),
					),
				)
			})

		/** Wait until no table call has been in flight for a few real event-loop turns; die if that never happens. */
		const settle = Effect.gen(function* () {
			let quiet = 0
			for (let turn = 0; turn < MAX_SETTLE_TURNS && quiet < QUIET_TURNS; turn++) {
				yield* Effect.yieldNow
				quiet = tableCallsInFlight === 0 ? quiet + 1 : 0
				yield* realTurn
			}
			if (quiet < QUIET_TURNS) {
				return yield* Effect.die(
					new Error(
						`azure-driver: table calls still in flight after ${MAX_SETTLE_TURNS} event-loop turns (${tableCallsInFlight} now)`,
					),
				)
			}
		})

		/** The delivery API client an AgentSession uses, reaching the routes above in process. */
		const inProcess = HttpClient.make((request) =>
			HttpClientRequest.toWeb(request).pipe(
				Effect.flatMap(send),
				Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
				Effect.orDie,
			),
		)
		const deliveryClient = yield* makeDeliveryClient({ baseUrl: ORIGIN }).pipe(
			Effect.provideService(HttpClient.HttpClient, inProcess),
		)

		/** Stable ids per login and per webhook, so a redelivered webhook is byte for byte the same. */
		const ids = new Map<string, number>()
		const idFor = (key: string) => {
			const known = ids.get(key)
			if (known !== undefined) return known
			const next = 1_000 + ids.size
			ids.set(key, next)
			return next
		}

		const postGitHubMention: ControlLayerDriver['postGitHubMention'] = (mention) =>
			Effect.gen(function* () {
				const author = { id: idFor(`user:${mention.author}`), login: mention.author, type: 'User' }
				const htmlUrl = `https://github.com/acme/web/${mention.kind === 'pr' ? 'pull' : 'issues'}/${mention.number}`
				const body = JSON.stringify({
					action: 'created',
					installation: { id: repository.installationId },
					repository: { id: repository.repositoryId, name: repository.repository, owner: { login: repository.owner } },
					issue: {
						id: 500_000 + mention.number,
						number: mention.number,
						title: `Discussion ${mention.number}`,
						body: null,
						state: 'open',
						html_url: htmlUrl,
						user: author,
						...(mention.kind === 'pr'
							? { pull_request: { url: `https://api.github.com/repos/acme/web/pulls/${mention.number}` } }
							: {}),
					},
					comment: {
						id: idFor(`comment:${mention.eventId}`),
						body: mention.body,
						html_url: `${htmlUrl}#issuecomment-${idFor(`comment:${mention.eventId}`)}`,
						user: author,
					},
					sender: author,
				})
				const response = yield* send(
					new Request(`${ORIGIN}/integrations/github/webhook`, {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							'x-github-delivery': mention.eventId,
							'x-github-event': 'issue_comment',
							'x-hub-signature-256': sign(mention.signature === 'valid' ? signingKey : 'wrong-key', body),
						},
						body,
					}),
				)
				return { status: response.status }
			})

		const advance = (ms: number) =>
			Effect.gen(function* () {
				for (let left = ms; left > 0; left -= ADVANCE_STEP_MS) {
					yield* TestClock.adjust(Math.min(left, ADVANCE_STEP_MS))
					yield* settle
					if (input.mode === 'nudge') yield* queue.deliverDue(runNudge)
				}
				yield* Effect.yieldNow
			})

		/** What the echo agent's last call does, written against the core `DeliveryApi` port. */
		const completeDelivery = (deliveryId: string) =>
			Effect.gen(function* () {
				const start = (yield* Ref.get(recorded)).starts.find((candidate) => candidate.deliveryId === deliveryId)
				if (start === undefined) return yield* Effect.die(new Error(`No agent start for delivery ${deliveryId}`))
				const api = yield* DeliveryApi
				yield* api
					.complete({
						deliveryId,
						accessToken: Redacted.make(start.accessToken),
						payload: { markdown: echoReply(start.prompt) },
					})
					.pipe(
						Effect.catchIf(
							(error) => error instanceof DeliveryClosed || error instanceof DeliveryTerminalConflict,
							(error) => Effect.logInfo('control-layer driver: the delivery already ended', error),
						),
						Effect.orDie,
					)
			}).pipe(Effect.provideService(DeliveryApi, deliveryClient))

		return {
			postGitHubMention,
			advance,
			agentStarts: Ref.get(recorded).pipe(
				Effect.map((current) =>
					current.starts.map(({ deliveryId, mailboxKey, prompt }) => ({ deliveryId, mailboxKey, prompt })),
				),
			),
			completeDelivery,
			output: Ref.get(recorded).pipe(
				Effect.map((current) => ({
					reactions: current.reactions.map((request) => request.reaction),
					comments: current.comments.map((comment) => comment.body),
					failedCommentPosts: current.failedCommentPosts,
				})),
			),
			failNextCommentPosts: (count) => Ref.update(recorded, (current) => ({ ...current, failCommentPosts: count })),
			setAuthorAccess: (login, access) =>
				Ref.update(recorded, (current) => ({ ...current, access: new Map(current.access).set(login, access) })),
			restart: Effect.gen(function* () {
				yield* Scope.close((yield* Ref.get(processing)).scope, Exit.void)
				yield* Ref.set(processing, yield* startProcessing)
			}),
			nudge: (mailboxKey) => queueNudger.nudge(mailboxKey, 0),
		} satisfies AwsControlLayerDriver
	})
