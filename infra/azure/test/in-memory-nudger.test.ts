/** The in-memory nudger: timers in the app's memory, one per mailbox, no retry. */
import { Context, Effect, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeInMemoryNudger } from '../src/InMemoryNudger'
import { Nudger } from '../src/Nudger'

const setup = () => {
	const logs: Array<string> = []
	const nudger = makeInMemoryNudger((message) => logs.push(message))
	const ran: Array<string> = []
	nudger.bind((key) => Promise.resolve(void ran.push(key)))
	const service = Effect.runSync(Layer.build(nudger.layer).pipe(Effect.map((context) => Context.get(context, Nudger)), Effect.scoped))
	const nudge = (key: string, delayMs: number) => Effect.runSync(service.nudge(key, delayMs))
	return { nudger, ran, logs, nudge }
}

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe('makeInMemoryNudger', () => {
	it('runs the mailbox after the delay, and not before', async () => {
		const { ran, nudge } = setup()
		nudge('a', 3_000)
		await vi.advanceTimersByTimeAsync(2_999)
		expect(ran).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(ran).toEqual(['a'])
	})

	it('runs a zero-delay nudge on the next turn', async () => {
		const { ran, nudge } = setup()
		nudge('a', 0)
		await vi.advanceTimersByTimeAsync(0)
		expect(ran).toEqual(['a'])
	})

	it('keeps one timer per mailbox: a later nudge is dropped when a sooner one waits', async () => {
		const { ran, nudger, nudge } = setup()
		nudge('a', 1_000)
		nudge('a', 5_000)
		expect(nudger.pendingCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(ran).toEqual(['a'])
	})

	it('replaces a waiting timer with a sooner nudge', async () => {
		const { ran, nudge } = setup()
		nudge('a', 5_000)
		nudge('a', 1_000)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(ran).toEqual(['a'])
		await vi.advanceTimersByTimeAsync(10_000)
		expect(ran).toEqual(['a'])
	})

	it('runs different mailboxes separately', async () => {
		const { ran, nudge } = setup()
		nudge('a', 1_000)
		nudge('b', 2_000)
		await vi.advanceTimersByTimeAsync(2_000)
		expect(ran).toEqual(['a', 'b'])
	})

	it('accepts a new nudge for a mailbox after its timer fired', async () => {
		const { ran, nudge } = setup()
		nudge('a', 100)
		await vi.advanceTimersByTimeAsync(100)
		nudge('a', 100)
		await vi.advanceTimersByTimeAsync(100)
		expect(ran).toEqual(['a', 'a'])
	})

	it('logs a failed run, does not throw, and does not retry', async () => {
		const logs: Array<string> = []
		const nudger = makeInMemoryNudger((message) => logs.push(message))
		let calls = 0
		nudger.bind(() => {
			calls++
			return Promise.reject(new Error('table down'))
		})
		const service = Effect.runSync(Layer.build(nudger.layer).pipe(Effect.map((context) => Context.get(context, Nudger)), Effect.scoped))
		Effect.runSync(service.nudge('a', 10))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(calls).toBe(1)
		expect(logs).toHaveLength(1)
		expect(logs[0]).toContain('no retry')
	})

	it('logs a nudge that fires before the handlers are bound', async () => {
		const logs: Array<string> = []
		const nudger = makeInMemoryNudger((message) => logs.push(message))
		const service = Effect.runSync(Layer.build(nudger.layer).pipe(Effect.map((context) => Context.get(context, Nudger)), Effect.scoped))
		Effect.runSync(service.nudge('a', 0))
		await vi.advanceTimersByTimeAsync(0)
		expect(logs[0]).toContain('before the handlers were bound')
	})

	it('stop cancels every waiting timer', async () => {
		const { ran, nudger, nudge } = setup()
		nudge('a', 1_000)
		nudge('b', 1_000)
		nudger.stop()
		expect(nudger.pendingCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(ran).toEqual([])
	})
})
