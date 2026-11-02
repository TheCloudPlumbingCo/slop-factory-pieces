/**
 * The handlers over the memory table, the fake queue and a fake GitHub API: the Receiver answers a web request with
 * the SDK's webhook route, the Processor runs one mailbox per nudge message and drains the in-process echo agent, and
 * the sweep re-nudges every due mailbox. Also `ServiceBusNudgerLive`, `envConfigProvider` and the Functions HTTP
 * adapter over fakes.
 */
import { createHmac } from 'node:crypto'

import { describe, expect, it } from '@effect/vitest'
import { DeliverySlot, Timestamp } from '@humanlayer/channels-delivery'
import {
	GitHubApi,
	GitHubDiscussionRef,
	GitHubId,
	GitHubIssueComment,
	GitHubParticipant,
} from '@humanlayer/channels-github'
import { AgentSessionMessage, AgentSessions, DeliveryApi, echoReply, targetOf } from '@slop/core'
import { botMention, conformanceBot } from '@slop/core/conformance/driver'
import { Clock, Config, ConfigProvider, Effect, Exit, Fiber, FiberSet, Layer, Ref, Schema, Scope } from 'effect'
import { TestClock } from 'effect/testing'

import { envConfigProvider } from '../src/Config'
import { toHttpResult, toWebRequest } from '../src/functions/adapter'
import {
	type HandlerDependencies,
	type Handlers,
	entryPoints,
	makeHandlers,
	PASS_BUDGET_MS,
	REARM_FLOOR_MS,
} from '../src/Handlers'
import { emptyMailboxState, type MailboxState } from '../src/MailboxState'
import { MailboxTable, TableUnavailable } from '../src/MailboxTable'
import { MemoryMailboxTable } from '../src/MemoryMailboxTable'
import { Nudger } from '../src/Nudger'
import { ServiceBusNudgerLive } from '../src/ServiceBusNudger'
import { makeFakeQueue } from './support/fake-queue'

const signingKey = 'handlers-test-key'
const sign = (key: string, body: string) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`

const config = ConfigProvider.fromUnknown({
	GITHUB_WEBHOOK_SECRET: signingKey,
	GITHUB_BOT_MENTION_NAME: conformanceBot.mentionName,
	GITHUB_BOT_USER_ID: String(conformanceBot.userId),
})

const botAuthor = GitHubParticipant.make({
	id: GitHubId.make(conformanceBot.userId),
	login: `${conformanceBot.mentionName}[bot]`,
	type: 'Bot',
})

/** A GitHub that grants write access to everyone and records the comments posted. */
const makeFakeGitHub = Effect.gen(function* () {
	const comments = yield* Ref.make<ReadonlyArray<GitHubIssueComment>>([])
	const post = (discussion: GitHubDiscussionRef, markdown: string) =>
		Ref.modify(comments, (current) => {
			const comment = GitHubIssueComment.make({
				ref: { discussion, id: GitHubId.make(900_000 + current.length) },
				body: markdown,
				url: `https://github.com/acme/web/issues/${discussion.ref.number}#issuecomment-${current.length}`,
				author: botAuthor,
			})
			return [comment, [...current, comment]] as const
		})
	const layer = Layer.mock(GitHubApi, {
		fetchUserAccess: () => Effect.succeed('write' as const),
		addReaction: () => Effect.void,
		removeReaction: () => Effect.void,
		listIssueComments: () => Ref.get(comments),
		listPullRequestComments: () => Ref.get(comments),
		postIssueComment: ({ issue, content }) =>
			post(GitHubDiscussionRef.cases.Issue.make({ ref: issue }), content.markdown),
		postPullRequestComment: ({ pullRequest, content }) =>
			post(GitHubDiscussionRef.cases.PullRequest.make({ ref: pullRequest }), content.markdown),
	})
	return { layer, comments: Ref.get(comments).pipe(Effect.map((all) => all.map((comment) => comment.body))) }
})

/** A table that cannot be reached. */
const unavailableTable = Layer.succeed(
	MailboxTable,
	MailboxTable.of({
		read: () => Effect.fail(new TableUnavailable({ reason: 'test: table down' })),
		write: () => Effect.fail(new TableUnavailable({ reason: 'test: table down' })),
		due: () => Effect.fail(new TableUnavailable({ reason: 'test: table down' })),
		subscribe: () => Effect.fail(new TableUnavailable({ reason: 'test: table down' })),
		isSubscribed: () => Effect.fail(new TableUnavailable({ reason: 'test: table down' })),
		unsubscribe: () => Effect.fail(new TableUnavailable({ reason: 'test: table down' })),
	}),
)

/** A memory table whose writes fail with `TableUnavailable` while `failWrites` is set; reads still work. */
const makeFlakyTable = Effect.gen(function* () {
	const memory = yield* MemoryMailboxTable.make
	const state = { failWrites: false }
	const table = MailboxTable.of({
		...memory,
		write: (request) =>
			state.failWrites ? Effect.fail(new TableUnavailable({ reason: 'test: writes failing' })) : memory.write(request),
	})
	return { table, state }
})

/**
 * An agent that, for each handed-off delivery, waits `workMs` and then completes it through the delivery API with
 * `'slow reply'`; `drain` waits for every such wait.
 */
const makeSlowAgent = (workMs: number) =>
	Effect.gen(function* () {
		const fibers = yield* FiberSet.make<void, never>().pipe(Scope.provide(yield* Scope.make()))
		const layer = Layer.effect(
			AgentSessions,
			Effect.gen(function* () {
				const api = yield* DeliveryApi
				return AgentSessions.of({
					getByName: () => ({
						send: (input: typeof AgentSessionMessage.Encoded) =>
							Effect.gen(function* () {
								const message = yield* Schema.decodeEffect(AgentSessionMessage)(input).pipe(Effect.orDie)
								yield* FiberSet.run(
									fibers,
									Effect.sleep(workMs).pipe(
										Effect.andThen(api.complete({ ...targetOf(message), payload: { markdown: 'slow reply' } })),
										Effect.ignore,
									),
								)
							}),
					}),
				})
			}),
		)
		return { layer, drain: FiberSet.awaitEmpty(fibers) }
	})

/** Handlers over a fresh flaky memory table (or `table`), a fresh fake queue and a fake GitHub. */
const setup = (
	input: {
		readonly table?: Layer.Layer<MailboxTable>
		readonly agentSessions?: HandlerDependencies<never>['agentSessions']
	} = {},
) =>
	Effect.gen(function* () {
		const flaky = yield* makeFlakyTable
		const queue = makeFakeQueue()
		const gitHub = yield* makeFakeGitHub
		const dependencies: HandlerDependencies<never> = {
			table: input.table ?? Layer.succeed(MailboxTable, flaky.table),
			nudger: queue.nudger,
			config: Effect.succeed(config),
			gitHubApi: gitHub.layer,
			...(input.agentSessions === undefined ? {} : { agentSessions: input.agentSessions }),
		}
		const handlers: Handlers = yield* makeHandlers(dependencies)
		return { handlers, table: flaky.table, tableState: flaky.state, queue, comments: gitHub.comments }
	})

/** Take every message due now off the queue without running anything. */
const dropDue = (queue: ReturnType<typeof makeFakeQueue>) => queue.deliverDue(() => Effect.void)

const mentionBody = (input: { readonly eventId: string; readonly number: number; readonly text: string }) => {
	const author = { id: 1_001, login: 'maintainer-1', type: 'User' }
	const htmlUrl = `https://github.com/acme/web/issues/${input.number}`
	return JSON.stringify({
		action: 'created',
		installation: { id: 100 },
		repository: { id: 200, name: 'web', owner: { login: 'acme' } },
		issue: {
			id: 500_000 + input.number,
			number: input.number,
			title: `Discussion ${input.number}`,
			body: null,
			state: 'open',
			html_url: htmlUrl,
			user: author,
		},
		comment: {
			id: 700_000 + input.number,
			body: `${botMention} ${input.text}`,
			html_url: `${htmlUrl}#issuecomment-${700_000 + input.number}`,
			user: author,
		},
		sender: author,
	})
}

/** A POST to the GitHub webhook route, as the Functions host hands it to the Receiver. */
const webhookEvent = (input: { readonly body: string; readonly headers: Record<string, string> }): Request =>
	new Request('https://func.example.test/integrations/github/webhook', {
		method: 'POST',
		headers: input.headers,
		body: input.body,
	})

const signedMention = (input: { readonly eventId: string; readonly number: number; readonly text: string }) => {
	const body = mentionBody(input)
	return webhookEvent({
		body,
		headers: {
			'content-type': 'application/json',
			'x-github-delivery': input.eventId,
			'x-github-event': 'issue_comment',
			'x-hub-signature-256': sign(signingKey, body),
		},
	})
}

/** The body of one nudge message, as `ServiceBusNudgerLive` sends it. */
const nudgeBody = (mailboxKey: string) => JSON.stringify({ mailboxKey })

const mailboxDueAt = (mailboxKey: string, readyAt: number | null): MailboxState => ({
	...emptyMailboxState({ mailboxKey, provider: 'github' }),
	deliveries: DeliverySlot.make({
		active: null,
		readyAt: readyAt === null ? null : Timestamp.make(readyAt),
		retained: [],
	}),
})

/** One real event-loop turn, so promise-based work (Web Crypto, the in-process HTTP client) can finish. */
const realTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

/** Move the test clock in 100 ms steps, with real turns in between, until `fiber` has finished. */
const runToEnd = <A, E>(fiber: Fiber.Fiber<A, E>, maxMs: number) =>
	Effect.gen(function* () {
		for (let elapsed = 0; elapsed <= maxMs && fiber.pollUnsafe() === undefined; elapsed += 100) {
			for (let turn = 0; turn < 5; turn++) yield* realTurn
			yield* TestClock.adjust(100)
		}
		return yield* Fiber.join(fiber)
	})

describe('receiver', () => {
	it.effect('receiver returns 200 for a signed mention and queues one nudge', () =>
		Effect.gen(function* () {
			const { handlers, queue } = yield* setup()
			const result = yield* handlers.receiver(signedMention({ eventId: 'r-1', number: 42, text: 'hello' }))
			expect(result.status).toBe(200)
			const pending = yield* queue.pending
			expect(pending).toHaveLength(1)
			expect(pending[0]?.mailboxKey).toContain('42')
		}),
	)

	it.effect('receiver verifies the signature of a non-ASCII body with mixed-case header names', () =>
		Effect.gen(function* () {
			const { handlers, queue } = yield* setup()
			/** Non-ASCII text, so a body decoded or re-encoded the wrong way changes its bytes and fails the HMAC. */
			const body = mentionBody({ eventId: 'r-2', number: 43, text: 'pourquoi ça échoue? 🚀' })
			const result = yield* handlers.receiver(
				webhookEvent({
					body,
					headers: {
						'Content-Type': 'application/json',
						'X-GitHub-Delivery': 'r-2',
						'X-GitHub-Event': 'issue_comment',
						'X-Hub-Signature-256': sign(signingKey, body),
					},
				}),
			)
			expect(result.status).toBe(200)
			expect(yield* queue.pending).toHaveLength(1)
		}),
	)

	it.effect('receiver returns 401 or 403 for a bad signature and queues nothing', () =>
		Effect.gen(function* () {
			const { handlers, queue } = yield* setup()
			const body = mentionBody({ eventId: 'r-3', number: 44, text: 'hello' })
			const result = yield* handlers.receiver(
				webhookEvent({
					body,
					headers: {
						'content-type': 'application/json',
						'x-github-delivery': 'r-3',
						'x-github-event': 'issue_comment',
						'x-hub-signature-256': sign('wrong-key', body),
					},
				}),
			)
			/** The SDK answers a failed signature check with 401. */
			expect(result.status).toBe(401)
			expect(yield* queue.pending).toEqual([])
		}),
	)

	it.effect('receiver returns 503 when the table is unavailable', () =>
		Effect.gen(function* () {
			const { handlers, queue } = yield* setup({ table: unavailableTable })
			const result = yield* handlers.receiver(signedMention({ eventId: 'r-4', number: 45, text: 'hello' }))
			expect(result.status).toBe(503)
			expect(yield* queue.pending).toEqual([])
		}),
	)
})

describe('processor', () => {
	it.effect('processor handles a nudge for an idle mailbox and returns no failures', () =>
		Effect.gen(function* () {
			const { handlers, queue } = yield* setup()
			yield* handlers.processor(nudgeBody('github:issue:no-such-mailbox'))
			expect(yield* queue.pending).toEqual([])
		}),
	)

	it.effect('processor re-nudges a mailbox whose readyAt is still in the future after its passes', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(1_000_000)
			const { handlers, table, queue } = yield* setup()
			/** Due in 20 minutes: past the 15-minute nudge cap, so a capped nudge arrives early and finds nothing due. */
			yield* table.write({ state: mailboxDueAt('github:issue:7', 1_000_000 + 1_200_000), expectedVersion: null })
			yield* handlers.processor(nudgeBody('github:issue:7'))
			expect(yield* queue.pending).toEqual([{ mailboxKey: 'github:issue:7', deliverAt: 1_000_000 + 900_000 }])
		}),
	)

	it.effect('processor re-nudges a stuck mailbox (due, but its pass found no work) after REARM_FLOOR_MS, not at once', () =>
		Effect.gen(function* () {
			const { handlers, tableState, queue } = yield* setup()
			const received = yield* handlers.receiver(signedMention({ eventId: 'stuck-1', number: 60, text: 'hello' }))
			expect(received.status).toBe(200)
			const mailboxKey = (yield* queue.pending)[0]!.mailboxKey
			yield* dropDue(queue)
			/** Every claim write now fails; the engine reports the mailbox as skipped, so the pass ends with no work. */
			tableState.failWrites = true
			const now = yield* Clock.currentTimeMillis
			yield* handlers.processor(nudgeBody(mailboxKey))
			const pending = yield* queue.pending
			expect(pending.map((message) => message.deliverAt)).toEqual([now + REARM_FLOOR_MS])
		}),
	)

	it.effect('processor stops starting passes after PASS_BUDGET_MS and queues a delay-0 nudge for the work left', () =>
		Effect.gen(function* () {
			const slow = yield* makeSlowAgent(PASS_BUDGET_MS + 1_000)
			const { handlers, queue, comments } = yield* setup({ agentSessions: slow })
			yield* handlers.receiver(signedMention({ eventId: 'budget-1', number: 61, text: 'take long' }))
			const mailboxKey = (yield* queue.pending)[0]!.mailboxKey
			/** Past the 3 s debounce, so the first pass claims; its drain then outlasts the budget. */
			yield* TestClock.adjust(3_000)
			yield* dropDue(queue)
			const startedAt = yield* Clock.currentTimeMillis
			const fiber = yield* handlers.processor(nudgeBody(mailboxKey)).pipe(Effect.forkChild)
			yield* runToEnd(fiber, 60_000)
			const endedAt = yield* Clock.currentTimeMillis
			expect(endedAt - startedAt).toBeGreaterThanOrEqual(PASS_BUDGET_MS)
			/** The reply is due, but no pass started after the budget, so it is posted by the next invocation. */
			expect(yield* comments).toEqual([])
			/** The re-nudge is the invocation's last send: at once, since work remains. */
			expect((yield* queue.pending).at(-1)).toEqual({ mailboxKey, deliverAt: endedAt })
			yield* dropDue(queue)
			yield* handlers.processor(nudgeBody(mailboxKey))
			expect(yield* comments).toEqual(['slow reply'])
		}),
	)

	it.effect('processor does not nudge when the mailbox has nothing pending', () =>
		Effect.gen(function* () {
			const { handlers, table, queue } = yield* setup()
			yield* table.write({ state: mailboxDueAt('github:issue:8', null), expectedVersion: null })
			yield* handlers.processor(nudgeBody('github:issue:8'))
			expect(yield* queue.pending).toEqual([])
		}),
	)

	it.effect('processor fails, for Service Bus to deliver again, on a body that is not a nudge', () =>
		Effect.gen(function* () {
			const { handlers } = yield* setup()
			expect(Exit.isFailure(yield* Effect.exit(handlers.processor('not json')))).toBe(true)
			expect(Exit.isFailure(yield* Effect.exit(handlers.processor({ mailboxKey: '' })))).toBe(true)
		}),
	)

	it.effect('processor accepts the nudge as JSON text or as an already parsed object', () =>
		Effect.gen(function* () {
			const { handlers } = yield* setup()
			expect(Exit.isSuccess(yield* Effect.exit(handlers.processor(nudgeBody('github:issue:12'))))).toBe(true)
			expect(Exit.isSuccess(yield* Effect.exit(handlers.processor({ mailboxKey: 'github:issue:12' })))).toBe(true)
		}),
	)

	it.effect('processor fails, for Service Bus to deliver again, when the table is unavailable', () =>
		Effect.gen(function* () {
			const { handlers } = yield* setup({ table: unavailableTable })
			expect(Exit.isFailure(yield* Effect.exit(handlers.processor(nudgeBody('github:issue:11'))))).toBe(true)
		}),
	)

	it.effect('processor runs a signed mention through to the echo reply', () =>
		Effect.gen(function* () {
			const { handlers, queue, comments } = yield* setup()
			const received = yield* handlers.receiver(signedMention({ eventId: 'e2e-1', number: 50, text: 'run it' }))
			expect(received.status).toBe(200)

			/**
			 * Each due queue message is one Processor invocation, run to its end while the clock moves (the echo's 5 s
			 * wait is drained inside it). The first, at once, finds the 3 s debounce running and defers; the next, at
			 * 3 s, claims, hands off, drains the echo and posts the reply.
			 */
			const invocations: Array<{
				readonly succeeded: boolean
				readonly startedAt: number
				readonly endedAt: number
				readonly commentsAtEnd: number
			}> = []
			const invoke = (mailboxKey: string) =>
				Effect.gen(function* () {
					const startedAt = yield* Clock.currentTimeMillis
					const fiber = yield* handlers.processor(nudgeBody(mailboxKey)).pipe(Effect.forkChild)
					const exit = yield* runToEnd(fiber, 30_000).pipe(Effect.exit)
					invocations.push({
						succeeded: Exit.isSuccess(exit),
						startedAt,
						endedAt: yield* Clock.currentTimeMillis,
						commentsAtEnd: (yield* comments).length,
					})
				})
			for (let step = 0; step < 100 && (yield* comments).length === 0; step++) {
				yield* queue.deliverDue(invoke)
				yield* TestClock.adjust(100)
			}
			expect(invocations.length).toBeGreaterThanOrEqual(2)
			expect(invocations.every(({ succeeded }) => succeeded)).toBe(true)
			expect(yield* comments).toEqual([echoReply(`${botMention} run it`)])
			/** The reply came from the invocation that claimed: it stayed open through the echo's 5 s wait. */
			const replying = invocations.find(({ commentsAtEnd }) => commentsAtEnd === 1)
			expect(replying!.endedAt - replying!.startedAt).toBeGreaterThanOrEqual(5_000)
		}),
	)
})

describe('sweep', () => {
	it.effect('sweepHandler nudges each due mailbox and reports the count', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(10_000)
			const { handlers, table, queue } = yield* setup()
			yield* table.write({ state: mailboxDueAt('due-long-ago', 0), expectedVersion: null })
			yield* table.write({ state: mailboxDueAt('due-just-now', 10_000), expectedVersion: null })
			yield* table.write({ state: mailboxDueAt('due-later', 10_001), expectedVersion: null })
			yield* table.write({ state: mailboxDueAt('idle', null), expectedVersion: null })
			expect(yield* handlers.sweep).toEqual({ nudged: 2 })
			const pending = yield* queue.pending
			expect(pending.map((message) => message.mailboxKey).sort()).toEqual(['due-just-now', 'due-long-ago'])
		}),
	)
})

describe('entryPoints', () => {
	it.effect('builds the handlers once per cold start, and again after a build that failed', () =>
		Effect.gen(function* () {
			let builds = 0
			const stub: Handlers = {
				receiver: () => Effect.succeed(new Response(null, { status: 204 })),
				researchSession: () => Effect.succeed(new Response(null, { status: 404 })),
				processor: () => Effect.void,
				sweep: Effect.succeed({ nudged: 7 }),
				processNudge: () => Effect.void,
			}
			const points = entryPoints(Effect.suspend(() => (++builds === 1 ? Effect.fail('config down') : Effect.succeed(stub))))
			const first = yield* Effect.promise(() => points.sweep().then(() => 'ok', () => 'rejected'))
			expect(first).toBe('rejected')
			expect(yield* Effect.promise(() => points.sweep())).toEqual({ nudged: 7 })
			expect((yield* Effect.promise(() => points.receiver(new Request('https://x.test/'))))?.status).toBe(204)
			expect(builds).toBe(2)
		}),
	)
})

describe('ServiceBusNudgerLive', () => {
	const message = (mailboxKey: string) => ({ body: JSON.stringify({ mailboxKey }), contentType: 'application/json' })

	it.effect('sends a delayed nudge as a scheduled message at the due time', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(1_000_000)
			const scheduled: Array<{ readonly body: string; readonly at: number }> = []
			const sender = {
				sendMessages: () => Promise.reject(new Error('should schedule')),
				scheduleMessages: (sent: { readonly body: string }, at: Date) => Promise.resolve(void scheduled.push({ body: sent.body, at: at.getTime() })),
			}
			const nudger = yield* Nudger.pipe(Effect.provide(ServiceBusNudgerLive(sender)))
			yield* nudger.nudge('github:issue:42', 2_500)
			expect(scheduled).toEqual([{ body: message('github:issue:42').body, at: 1_002_500 }])
		}),
	)

	it.effect('sends a zero-delay nudge at once, with no schedule', () =>
		Effect.gen(function* () {
			const sent: Array<unknown> = []
			const sender = {
				sendMessages: (item: unknown) => Promise.resolve(void sent.push(item)),
				scheduleMessages: () => Promise.reject(new Error('should send at once')),
			}
			const nudger = yield* Nudger.pipe(Effect.provide(ServiceBusNudgerLive(sender)))
			yield* nudger.nudge('github:issue:42', 0)
			expect(sent).toEqual([message('github:issue:42')])
		}),
	)

	it.effect('logs and swallows a failed send', () =>
		Effect.gen(function* () {
			const sender = {
				sendMessages: () => Promise.reject(new Error('queue down')),
				scheduleMessages: () => Promise.reject(new Error('queue down')),
			}
			const nudger = yield* Nudger.pipe(Effect.provide(ServiceBusNudgerLive(sender)))
			yield* nudger.nudge('github:issue:42', 0)
			yield* nudger.nudge('github:issue:42', 5_000)
		}),
	)
})

describe('envConfigProvider', () => {
	it.effect('reads the bot settings from the environment it is given', () =>
		Effect.gen(function* () {
			const provider = yield* envConfigProvider({ GITHUB_APP_ID: '12345', GITHUB_WEBHOOK_SECRET: 'secret', UNSET: undefined })
			const values = yield* Config.all({
				appId: Config.String('GITHUB_APP_ID'),
				secret: Config.String('GITHUB_WEBHOOK_SECRET'),
			}).pipe(Effect.provide(ConfigProvider.layer(provider)))
			expect(values).toEqual({ appId: '12345', secret: 'secret' })
			const missing = yield* Config.String('UNSET').pipe(Effect.provide(ConfigProvider.layer(provider)), Effect.exit)
			expect(Exit.isFailure(missing)).toBe(true)
		}),
	)
})

describe('Functions HTTP adapter', () => {
	it.effect('keeps the body bytes and lower-cases header names', () =>
		Effect.gen(function* () {
			const body = new TextEncoder().encode('{"text":"ça 🚀"}')
			const headers = new Map([['X-GitHub-Event', 'issue_comment']])
			const request = yield* Effect.promise(() =>
				toWebRequest({
					url: 'https://func.example.test/integrations/github/webhook',
					method: 'POST',
					headers: { forEach: (callback) => headers.forEach((value, name) => callback(value, name)) },
					arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer),
				}),
			)
			expect(request.headers.get('x-github-event')).toBe('issue_comment')
			expect(new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()))).toEqual(body)
		}),
	)

	it.effect('turns a web Response into status, headers and text', () =>
		Effect.gen(function* () {
			const result = yield* Effect.promise(() =>
				toHttpResult(new Response('nope', { status: 401, headers: { 'x-reason': 'signature' } })),
			)
			expect(result).toEqual({ status: 401, headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-reason': 'signature' }, body: 'nope' })
		}),
	)
})
