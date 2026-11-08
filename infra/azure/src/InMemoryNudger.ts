import { Effect, Layer } from 'effect'

import { Nudger } from './Nudger'

/** What runs when a nudge fires: process one mailbox. It may reject; the nudger logs and drops the error. */
export type NudgeRunner = (mailboxKey: string) => Promise<void>

export interface InMemoryNudger {
	/** The `Nudger` service for `makeHandlers`. */
	readonly layer: Layer.Layer<Nudger>
	/** Set what a firing nudge runs. The handlers need the nudger first, so this is called after they exist. */
	readonly bind: (run: NudgeRunner) => void
	/** How many timers wait now. For tests and shutdown logs. */
	readonly pendingCount: () => number
	/** Cancel every waiting timer. */
	readonly stop: () => void
}

/**
 * A `Nudger` that keeps its wake-ups in the app's memory, as `setTimeout` timers. There is no queue and no sweep.
 * If the app stops or restarts, the waiting timers are lost, and so is the work they would start. Cosmos still holds
 * the saved comment, but nothing wakes it until a new event for that mailbox arrives.
 *
 * - One timer per mailbox. A nudge that is later than the waiting one is dropped. A sooner one replaces it.
 * - A nudge fires `run(mailboxKey)`. A failure is logged and not retried.
 *
 * @param log - where failures go; `console.error` by default
 */
export const makeInMemoryNudger = (log: (message: string, error?: unknown) => void = defaultLog): InMemoryNudger => {
	const waiting = new Map<string, { readonly at: number; readonly timer: ReturnType<typeof setTimeout> }>()
	let run: NudgeRunner | undefined

	const fire = (mailboxKey: string) => {
		waiting.delete(mailboxKey)
		if (run === undefined) return log(`nudge fired before the handlers were bound: ${mailboxKey}`)
		run(mailboxKey).catch((error: unknown) => log(`processing failed for ${mailboxKey}; no retry`, error))
	}

	const schedule = (mailboxKey: string, delayMs: number) => {
		const at = Date.now() + Math.max(0, delayMs)
		const current = waiting.get(mailboxKey)
		if (current !== undefined && current.at <= at) return
		if (current !== undefined) clearTimeout(current.timer)
		waiting.set(mailboxKey, { at, timer: setTimeout(() => fire(mailboxKey), Math.max(0, delayMs)) })
	}

	return {
		layer: Layer.succeed(
			Nudger,
			Nudger.of({ nudge: (mailboxKey, delayMs) => Effect.sync(() => schedule(mailboxKey, delayMs)) }),
		),
		bind: (next) => {
			run = next
		},
		pendingCount: () => waiting.size,
		stop: () => {
			for (const { timer } of waiting.values()) clearTimeout(timer)
			waiting.clear()
		},
	}
}

const defaultLog = (message: string, error?: unknown) => console.error(`in_memory_nudger: ${message}`, error ?? '')
