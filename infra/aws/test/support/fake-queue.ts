/**
 * A stand-in for the SQS queue that carries nudges: each nudge becomes a message held until its delay has passed
 * on Effect's `Clock`, then handed to whoever calls `deliverDue`. Like SQS, it keeps every message (no dedup) and
 * outlives the processes that read it.
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
	 * delivered.
	 */
	readonly deliverDue: (run: (mailboxKey: string) => Effect.Effect<void>) => Effect.Effect<number>
}

/** Rounds of newly due messages one `deliverDue` call follows before leaving the rest for the next call. */
const MAX_DELIVERY_ROUNDS = 100

/** A new empty queue. */
export const makeFakeQueue = (): FakeQueue => {
	let messages: ReadonlyArray<QueuedNudge> = []

	const nudger = Layer.succeed(
		Nudger,
		Nudger.of({
			nudge: (mailboxKey, delayMs) =>
				Clock.currentTimeMillis.pipe(
					Effect.map((now) => {
						messages = [...messages, { mailboxKey, deliverAt: now + delayMs }]
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
			if (due.length === 0) break
			for (const message of due) yield* run(message.mailboxKey)
			delivered += due.length
		}
		return delivered
	})

	return { nudger, pending: Effect.sync(() => messages), deliverDue }
}
