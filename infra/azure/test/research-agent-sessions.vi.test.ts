import { describe, expect, it } from '@effect/vitest'
import { DeliveryId, type DeliveryClient } from '@humanlayer/channels-delivery'
import { GitHubId, GitHubIssue, GitHubIssueRef } from '@humanlayer/channels-github'
import { AgentSessionMessage, AgentSessions, DeliveryApi } from '@slop/core'
import { Context, Effect, Layer, Redacted, Schema } from 'effect'

import type { RepositoryDispatch } from '../src/GithubDispatch'
import { makeMemoryPendingResearch } from '../src/PendingResearch'
import { researchAgentSessions, researchTask } from '../src/ResearchAgentSessions'

const encoded = (prompt: string, repository = 'web') =>
	Schema.encodeSync(AgentSessionMessage)(
		AgentSessionMessage.make({
			prompt,
			discussion: GitHubIssue.make({
				ref: GitHubIssueRef.make({
					installationId: GitHubId.make(7),
					repositoryId: GitHubId.make(8),
					owner: 'acme',
					repository,
					number: GitHubId.make(42),
				}),
				mailboxKey: 'github:issue:42',
			}),
			deliveryId: DeliveryId.make('delivery:v1:abc:def'),
			accessToken: Redacted.make('secret-token'),
		}),
	)

describe('researchTask', () => {
	it('reads the task after the command', () => {
		expect(researchTask('@slopcodebot /research why does CI fail?')).toBe('why does CI fail?')
	})
	it('keeps a multi-line task', () => {
		expect(researchTask('@bot /research line one\nline two')).toBe('line one\nline two')
	})
	it('returns an empty task when none is given', () => {
		expect(researchTask('@bot /research')).toBe('')
	})
	it('ignores other comments', () => {
		expect(researchTask('@bot please look')).toBeUndefined()
		expect(researchTask('/research no mention')).toBeUndefined()
	})
})

/** Run `send` over the research sessions with fakes; returns what was dispatched, failed and echoed. */
const run = (prompt: string, dispatch: (d: RepositoryDispatch) => Promise<void>,
	pending = makeMemoryPendingResearch(), repository = 'web',
) =>
	Effect.gen(function* () {
		const dispatched: Array<RepositoryDispatch> = []
		const failed: Array<unknown> = []
		const echoed: Array<string> = []
		const api = Layer.succeed(DeliveryApi, {
			fail: (call: unknown) => Effect.sync(() => void failed.push(call)),
		} as unknown as DeliveryClient)
		const fallback = Layer.succeed(AgentSessions, {
			getByName: () => ({ send: (input: { prompt: string }) => Effect.sync(() => void echoed.push(input.prompt)) }),
		} as never)
		const layer = researchAgentSessions({
			dispatch: async (d) => {
				dispatched.push(d)
				await dispatch(d)
			},
			brokerOrigin: 'https://broker.example',
			pending,
			fallback,
		}).pipe(Layer.provide(api))
		const sessions = Context.get(yield* Layer.build(layer), AgentSessions)
		yield* sessions.getByName('github:issue:42').send(encoded(prompt, repository))
		return { dispatched, failed, echoed, pending }
	}).pipe(Effect.scoped)

describe('researchAgentSessions', () => {
	it.effect('dispatches a research command with the delivery details', () =>
		Effect.gen(function* () {
			const { dispatched, failed, echoed } = yield* run('@slopcodebot /research why does CI fail?', async () => {})
			expect(dispatched).toHaveLength(1)
			expect(dispatched[0]).toMatchObject({
				installationId: 7,
				owner: 'acme',
				repository: 'web',
				eventType: 'slopcodebot-research',
				clientPayload: {
					task: 'why does CI fail?',
					issueNumber: 42,
					deliveryId: 'delivery:v1:abc:def',
					runId: 'delivery:v1:abc:def',
					brokerOrigin: 'https://broker.example',
				},
			})
			expect(dispatched[0]!.clientPayload).not.toHaveProperty('accessToken')
			expect(JSON.stringify(dispatched[0])).not.toContain('secret-token')
			expect(failed).toEqual([])
			expect(echoed).toEqual([])
		}),
	)

	it.effect('saves the pending record before the dispatch is sent', () =>
		Effect.gen(function* () {
			const pending = makeMemoryPendingResearch()
			let atDispatch: unknown
			yield* run(
				'@slopcodebot /research x',
				async () => {
					atDispatch = await pending.peek('delivery:v1:abc:def', Date.now())
				},
				pending,
			)
			expect(atDispatch).toMatchObject({
				deliveryId: 'delivery:v1:abc:def',
				repositoryId: '8',
				installationId: '7',
				accessToken: 'secret-token',
			})
		}),
	)

	it.effect('drops the pending record when GitHub refuses the dispatch', () =>
		Effect.gen(function* () {
			const { pending } = yield* run('@slopcodebot /research x', async () => {
				throw new Error('403')
			})
			expect(yield* Effect.promise(() => pending.peek('delivery:v1:abc:def', Date.now()))).toBeUndefined()
		}),
	)

	it.effect('sends other prompts to the fallback and dispatches nothing', () =>
		Effect.gen(function* () {
			const { dispatched, echoed } = yield* run('@slopcodebot hello', async () => {})
			expect(dispatched).toEqual([])
			expect(echoed).toEqual(['@slopcodebot hello'])
		}),
	)

	it.effect('fails the delivery when GitHub refuses the dispatch', () =>
		Effect.gen(function* () {
			const { failed } = yield* run('@slopcodebot /research x', async () => {
				throw new Error('GitHub repository dispatch failed: 403 Resource not accessible by integration')
			})
			expect(failed).toHaveLength(1)
			expect(JSON.stringify(failed[0])).toContain('Could not start')
			expect(JSON.stringify(failed[0])).toContain('403 Resource not accessible by integration')
		}),
	)

	it.effect('fails the delivery when the task is empty, without dispatching', () =>
		Effect.gen(function* () {
			const { dispatched, failed } = yield* run('@slopcodebot /research', async () => {})
			expect(dispatched).toEqual([])
			expect(failed).toHaveLength(1)
			expect(JSON.stringify(failed[0])).toContain('Add a task')
		}),
	)
})

describe('researchAgentSessions in a workspace repo', () => {
	const inWorkspace = (prompt: string) =>
		run(prompt, async () => {}, makeMemoryPendingResearch(), 'tea-workspace')

	it.effect('dispatches with the workspace id and the notes as the task', () =>
		Effect.gen(function* () {
			const { dispatched, failed } = yield* inWorkspace('@slopcodedev /research --ws be how does tea call water?')
			expect(failed).toEqual([])
			expect(dispatched).toHaveLength(1)
			expect(dispatched[0]).toMatchObject({
				repository: 'tea-workspace',
				clientPayload: { workspace: 'be', task: 'how does tea call water?', issueNumber: 42 },
			})
		}),
	)

	it.effect('lets the issue be the task when there are no notes', () =>
		Effect.gen(function* () {
			const { dispatched, failed } = yield* inWorkspace('@slopcodedev /research --ws ops')
			expect(failed).toEqual([])
			expect(dispatched[0]).toMatchObject({ clientPayload: { workspace: 'ops', task: '' } })
		}),
	)

	it.effect('fails the delivery with a hint when --ws is missing, without dispatching', () =>
		Effect.gen(function* () {
			const { dispatched, failed } = yield* inWorkspace('@slopcodedev /research how does tea call water?')
			expect(dispatched).toEqual([])
			expect(failed).toHaveLength(1)
			expect(JSON.stringify(failed[0])).toContain('--ws')
		}),
	)

	it.effect('fails the delivery naming the bad id when --ws is invalid', () =>
		Effect.gen(function* () {
			const { dispatched, failed } = yield* inWorkspace('@slopcodedev /research --ws=../x')
			expect(dispatched).toEqual([])
			expect(JSON.stringify(failed[0])).toContain('../x')
		}),
	)

	it.effect('leaves other repositories alone: --ws stays in the task and no workspace is sent', () =>
		Effect.gen(function* () {
			const { dispatched } = yield* run('@slopcodedev /research --ws be x', async () => {})
			expect(dispatched[0]!.clientPayload).toMatchObject({ task: '--ws be x' })
			expect(dispatched[0]!.clientPayload).not.toHaveProperty('workspace')
		}),
	)
})
