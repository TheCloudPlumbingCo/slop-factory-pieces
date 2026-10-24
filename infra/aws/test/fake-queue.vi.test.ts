/** The fake SQS queue itself: SQS's whole-second delays, and a loud failure on a nudge loop. */
import { describe, expect, it } from '@effect/vitest'
import { Context, Effect, Exit, Layer } from 'effect'

import { Nudger } from '../src/Nudger'
import { makeFakeQueue } from './support/fake-queue'

describe('makeFakeQueue', () => {
	it.effect('rounds a delay up to whole seconds, as SQS DelaySeconds does', () =>
		Effect.gen(function* () {
			const queue = makeFakeQueue()
			const nudger = Context.get(yield* Layer.build(queue.nudger), Nudger)
			yield* nudger.nudge('a', 2_500)
			yield* nudger.nudge('b', 0)
			yield* nudger.nudge('c', 3_000)
			expect(yield* queue.pending).toEqual([
				{ mailboxKey: 'a', deliverAt: 3_000 },
				{ mailboxKey: 'b', deliverAt: 0 },
				{ mailboxKey: 'c', deliverAt: 3_000 },
			])
		}),
	)

	it.effect('deliverDue dies when a delivery keeps re-nudging at once', () =>
		Effect.gen(function* () {
			const queue = makeFakeQueue()
			const nudger = Context.get(yield* Layer.build(queue.nudger), Nudger)
			yield* nudger.nudge('loop', 0)
			const exit = yield* queue.deliverDue((mailboxKey) => nudger.nudge(mailboxKey, 0)).pipe(Effect.exit)
			expect(Exit.hasDies(exit)).toBe(true)
		}),
	)
})
