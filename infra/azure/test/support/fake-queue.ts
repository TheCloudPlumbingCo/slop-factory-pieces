/**
 * A stand-in for the SQS queue that carries nudges: each nudge becomes a message held until its delay has passed
 * on Effect's `Clock`, then handed to whoever calls `deliverDue`. Like SQS, it keeps every message (no dedup),
 * outlives the processes that read it, and counts delays in whole seconds, rounded up as `SqsNudgerLive` sends them.
 */
import { Clock, Effect, Layer } from 'effect'

import { Nudger } from '../../src/Nudger'

/** One queued nudge: wake `mailboxKey` once the clock reaches `deliverAt`. */
export interface QueuedNudge {
	readonly mailboxKey: string
	readonly deliverAt: number
}

export interface FakeQueue {
	/** A `Nudger` that sends to this queue. */
	readonly nudger: Layer.Layer<Nudger>
	/** Messages not delivered yet, in the order they were sent. */
	readonly pending: Effect.Effect<ReadonlyArray<QueuedNudge>>
	/**
	 * Deliver every message whose `deliverAt` is at or before now, oldest first, by running `run` for its mailbox.
	 * Messages sent while delivering that are already due are delivered in the same call. Returns how many were
	 * delivered. Dies if messages are still due after `MAX_DELIVERY_ROUNDS` rounds: something re-nudges at once
	 * forever, which on SQS would run Lambdas back to back.
	 */
	readonly deliverDue: (run: (mailboxKey: string) => Effect.Effect<void>) => Effect.Effect<number>
}

/** Rounds of newly due messages one `deliverDue` call follows before it counts as a nudge loop. */
export const MAX_DELIVERY_ROUNDS = 100

/** SQS's `DelaySeconds` is whole seconds; `SqsNudgerLive` rounds up. */
const sqsDelayMs = (delayMs: number) => Math.ceil(Math.max(0, delayMs) / 1000) * 1000

/** A new empty queue. */
export const makeFakeQueue = (): FakeQueue => {
	let messages: ReadonlyArray<QueuedNudge> = []

	const nudger = Layer.succeed(
		Nudger,
		Nudger.of({
			nudge: (mailboxKey, delayMs) =>
				Clock.currentTimeMillis.pipe(
					Effect.map((now) => {
						messages = [...messages, { mailboxKey, deliverAt: now + sqsDelayMs(delayMs) }]
					}),
				),
		}),
	)

	/** Take the messages due now off the queue. */
	const takeDue = Clock.currentTimeMillis.pipe(
		Effect.map((now) => {
			const due = messages.filter((message) => message.deliverAt <= now)
			messages = messages.filter((message) => message.deliverAt > now)
			return due
		}),
	)

	const deliverDue = Effect.fn('FakeQueue.deliverDue')(function* (run: (mailboxKey: string) => Effect.Effect<void>) {
		let delivered = 0
		for (let round = 0; round < MAX_DELIVERY_ROUNDS; round++) {
			const due = yield* takeDue
			if (due.length === 0) return delivered
			for (const message of due) yield* run(message.mailboxKey)
			delivered += due.length
		}
		const left = yield* Clock.currentTimeMillis.pipe(
			Effect.map((now) => messages.filter((message) => message.deliverAt <= now)),
		)
		if (left.length === 0) return delivered
		return yield* Effect.die(
			new Error(
				`FakeQueue: messages still due after ${MAX_DELIVERY_ROUNDS} delivery rounds (a delay-0 nudge loop?) for ${[
					...new Set(left.map((message) => message.mailboxKey)),
				].join(', ')}`,
			),
		)
	})

	return { nudger, pending: Effect.sync(() => messages), deliverDue }
}
