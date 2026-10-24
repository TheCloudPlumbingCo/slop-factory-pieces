import { describe, expect, it } from '@effect/vitest'
import {
	DeliveryClosed,
	DeliveryId,
	type DeliveryClient,
	type DeliveryClientTarget,
} from '@humanlayer/channels-delivery'
import { GitHubId, GitHubIssue, GitHubIssueRef } from '@humanlayer/channels-github'
import { Effect, Exit, Fiber, Layer, Redacted, Ref, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { AgentSessionMessage, AgentSessions, DeliveryApi, MOCK_WORK_DURATION } from '@slop/core'

import { makeInProcessAgentSessions } from '../src/InProcessAgent'

const message = AgentSessionMessage.make({
	prompt: 'why does CI fail?',
	discussion: GitHubIssue.make({
		ref: GitHubIssueRef.make({
			installationId: GitHubId.make(100),
			repositoryId: GitHubId.make(200),
			owner: 'acme',
			repository: 'web',
			number: GitHubId.make(42),
		}),
		mailboxKey: 'github:issue:42',
	}),
	deliveryId: DeliveryId.make('delivery:v1:abc:def'),
	accessToken: Redacted.make('secret-token'),
})
const encoded = Schema.encodeSync(AgentSessionMessage)(message)

/** A DeliveryApi whose n-th `complete` call fails with `failures[n]` when that entry is set, and succeeds otherwise. */
const fakeDeliveryApi = (failures: ReadonlyArray<DeliveryClosed | undefined>) =>
	Effect.gen(function* () {
		const calls = yield* Ref.make<ReadonlyArray<DeliveryClientTarget>>([])
		const complete = (call: DeliveryClientTarget) =>
			Effect.gen(function* () {
				const before = yield* Ref.getAndUpdate(calls, (all) => [...all, call])
				const failure = failures[before.length]
				if (failure !== undefined) return yield* Effect.fail(failure)
				return { _tag: 'DeliveryMutationReceipt', deliveryId: message.deliveryId, status: 'accepted' } as const
			})
		// The test double implements the methods `answer` calls, so it is widened to the client type here.
		const api = { complete, activity: { set: () => Effect.void } } as unknown as DeliveryClient
		return { calls, api }
	})

const setup = (failures: ReadonlyArray<DeliveryClosed | undefined> = []) =>
	Effect.gen(function* () {
		const fake = yield* fakeDeliveryApi(failures)
		const { layer, drain } = yield* makeInProcessAgentSessions
		const sessions = yield* AgentSessions.pipe(
			Effect.provide(layer.pipe(Layer.provide(Layer.succeed(DeliveryApi, fake.api)))),
		)
		return { ...fake, drain, sessions, send: sessions.getByName('github:issue:42').send }
	})

describe('makeInProcessAgentSessions', () => {
	it.effect('send returns before the echo has completed the delivery', () =>
		Effect.gen(function* () {
			const { calls, send, drain } = yield* setup()
			yield* send(encoded)
			expect(yield* Ref.get(calls)).toHaveLength(0)
			const fiber = yield* drain.pipe(Effect.forkChild)
			yield* TestClock.adjust(MOCK_WORK_DURATION)
			yield* Fiber.join(fiber)
			expect(yield* Ref.get(calls)).toHaveLength(1)
		}),
	)

	it.effect('drain returns only after the 5 second echo wait and the complete call', () =>
		Effect.gen(function* () {
			const { calls, send, drain } = yield* setup()
			yield* send(encoded)
			const fiber = yield* drain.pipe(Effect.forkChild)
			yield* TestClock.adjust('4999 millis')
			expect(fiber.pollUnsafe()).toBeUndefined()
			expect(yield* Ref.get(calls)).toHaveLength(0)
			yield* TestClock.adjust('1 millis')
			yield* Fiber.join(fiber)
			expect(yield* Ref.get(calls)).toHaveLength(1)
		}),
	)

	it.effect('drain also waits for an echo sent while it is draining', () =>
		Effect.gen(function* () {
			const { calls, send, drain } = yield* setup()
			yield* send(encoded)
			const fiber = yield* drain.pipe(Effect.forkChild)
			yield* TestClock.adjust('2 seconds')
			yield* send(encoded)
			yield* TestClock.adjust('3 seconds')
			expect(fiber.pollUnsafe()).toBeUndefined()
			yield* TestClock.adjust('2 seconds')
			yield* Fiber.join(fiber)
			expect(yield* Ref.get(calls)).toHaveLength(2)
		}),
	)

	it.effect('a send for the same message twice completes the delivery once and ignores DeliveryClosed', () =>
		Effect.gen(function* () {
			// Both sends call `complete`: the first succeeds, the second gets DeliveryClosed and is treated as done.
			const { calls, send, drain } = yield* setup([undefined, new DeliveryClosed()])
			yield* send(encoded)
			yield* TestClock.adjust('1 seconds')
			yield* send(encoded)
			const fiber = yield* drain.pipe(Effect.forkChild)
			yield* TestClock.adjust('10 seconds')
			yield* Fiber.join(fiber)
			expect(yield* Ref.get(calls)).toHaveLength(2)
		}),
	)

	it.effect('a message for another mailbox key dies', () =>
		Effect.gen(function* () {
			const { sessions } = yield* setup()
			const exit = yield* sessions.getByName('github:issue:99').send(encoded).pipe(Effect.exit)
			expect(Exit.hasDies(exit)).toBe(true)
		}),
	)
})
