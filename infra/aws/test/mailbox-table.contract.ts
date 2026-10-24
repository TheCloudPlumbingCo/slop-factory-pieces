import { it } from '@effect/vitest'
import { DeliverySlot, Timestamp } from '@humanlayer/channels-delivery'
import { Effect, Option, type Scope } from 'effect'

import { emptyMailboxState, type MailboxState } from '../src/MailboxState'
import type { MailboxTable } from '../src/MailboxTable'

type Table = MailboxTable['Service']

const stateReadyAt = (mailboxKey: string, readyAt: number | null): MailboxState => ({
	...emptyMailboxState({ mailboxKey, provider: 'github' }),
	deliveries: DeliverySlot.make({
		active: null,
		readyAt: readyAt === null ? null : Timestamp.make(readyAt),
		retained: [],
	}),
})

/** The behaviour every `MailboxTable` must have; each implementation's test file runs it. */
export const defineMailboxTableContract = (name: string, make: Effect.Effect<Table, never, Scope.Scope>) => {
	const run = <A, E>(body: (table: Table) => Effect.Effect<A, E>) => Effect.scoped(Effect.flatMap(make, body))

	it.describe(`${name} (MailboxTable contract)`, () => {
		it.effect('reading a mailbox that was never written returns none', ({ expect }) =>
			run((table) =>
				Effect.gen(function* () {
					expect(Option.isNone(yield* table.read('github:acme/repo#1'))).toBe(true)
				}),
			),
		)

		it.effect(
			"write with expectedVersion null creates the mailbox at version 1 and a second such write returns 'conflict'",
			({ expect }) =>
				run((table) =>
					Effect.gen(function* () {
						const state = emptyMailboxState({ mailboxKey: 'm1', provider: 'github' })
						expect(yield* table.write({ state, expectedVersion: null })).toBe('written')
						const read = yield* table.read('m1')
						expect(Option.map(read, (item) => item.version)).toEqual(Option.some(1))
						expect(yield* table.write({ state, expectedVersion: null })).toBe('conflict')
					}),
				),
		)

		it.effect("write with a stale expectedVersion returns 'conflict' and leaves the stored state unchanged", ({ expect }) =>
			run((table) =>
				Effect.gen(function* () {
					const first = emptyMailboxState({ mailboxKey: 'm1', provider: 'github' })
					yield* table.write({ state: first, expectedVersion: null })
					expect(yield* table.write({ state: { ...first, nextSequence: 1 }, expectedVersion: 1 })).toBe('written')
					expect(yield* table.write({ state: { ...first, nextSequence: 99 }, expectedVersion: 1 })).toBe('conflict')
					const read = yield* table.read('m1')
					expect(Option.map(read, (item) => [item.state.nextSequence, item.version])).toEqual(Option.some([1, 2]))
				}),
			),
		)

		it.effect(
			"write with a new event key stores the state; the same key on a later write returns 'duplicate' and stores nothing",
			({ expect }) =>
				run((table) =>
					Effect.gen(function* () {
						const first = emptyMailboxState({ mailboxKey: 'm1', provider: 'github' })
						expect(yield* table.write({ state: first, expectedVersion: null, newEventKey: 'evt-1' })).toBe('written')
						const outcome = yield* table.write({
							state: { ...first, nextSequence: 1 },
							expectedVersion: 1,
							newEventKey: 'evt-1',
						})
						expect(outcome).toBe('duplicate')
						const read = yield* table.read('m1')
						expect(Option.map(read, (item) => [item.state.nextSequence, item.version])).toEqual(Option.some([0, 1]))
					}),
				),
		)

		it.effect("a repeated event key returns 'duplicate' even when expectedVersion is stale, and stores nothing", ({ expect }) =>
			run((table) =>
				Effect.gen(function* () {
					const first = emptyMailboxState({ mailboxKey: 'm1', provider: 'github' })
					yield* table.write({ state: first, expectedVersion: null, newEventKey: 'e' })
					yield* table.write({ state: { ...first, nextSequence: 1 }, expectedVersion: 1 })
					const outcome = yield* table.write({
						state: { ...first, nextSequence: 99 },
						expectedVersion: 1,
						newEventKey: 'e',
					})
					expect(outcome).toBe('duplicate')
					const read = yield* table.read('m1')
					expect(Option.map(read, (item) => [item.state.nextSequence, item.version])).toEqual(Option.some([1, 2]))
				}),
			),
		)

		it.effect("a conflicting write with a new event key stores no marker, so the key can be used by a later valid write", ({ expect }) =>
			run((table) =>
				Effect.gen(function* () {
					const first = emptyMailboxState({ mailboxKey: 'm1', provider: 'github' })
					yield* table.write({ state: first, expectedVersion: null })
					const stale = yield* table.write({ state: { ...first, nextSequence: 1 }, expectedVersion: 7, newEventKey: 'e2' })
					expect(stale).toBe('conflict')
					const retry = yield* table.write({ state: { ...first, nextSequence: 1 }, expectedVersion: 1, newEventKey: 'e2' })
					expect(retry).toBe('written')
				}),
			),
		)

		it.effect("ten concurrent writes with the same expectedVersion: exactly one 'written', nine 'conflict'", ({ expect }) =>
			run((table) =>
				Effect.gen(function* () {
					const first = emptyMailboxState({ mailboxKey: 'm1', provider: 'github' })
					yield* table.write({ state: first, expectedVersion: null })
					const outcomes = yield* Effect.all(
						Array.from({ length: 10 }, (_, index) =>
							table.write({ state: { ...first, nextSequence: index + 1 }, expectedVersion: 1 }),
						),
						{ concurrency: 'unbounded' },
					)
					expect(outcomes.filter((outcome) => outcome === 'written')).toHaveLength(1)
					expect(outcomes.filter((outcome) => outcome === 'conflict')).toHaveLength(9)
				}),
			),
		)

		it.effect('due returns only mailboxes whose readyAt is at or before now', ({ expect }) =>
			run((table) =>
				Effect.gen(function* () {
					yield* table.write({ state: stateReadyAt('past', 100), expectedVersion: null })
					yield* table.write({ state: stateReadyAt('exact', 200), expectedVersion: null })
					yield* table.write({ state: stateReadyAt('future', 300), expectedVersion: null })
					yield* table.write({ state: stateReadyAt('idle', null), expectedVersion: null })
					expect([...(yield* table.due(200))].sort()).toEqual(['exact', 'past'])
				}),
			),
		)

		it.effect('subscribe, isSubscribed and unsubscribe round trip', ({ expect }) =>
			run((table) =>
				Effect.gen(function* () {
					expect(yield* table.isSubscribed('m1')).toBe(false)
					yield* table.subscribe('m1')
					expect(yield* table.isSubscribed('m1')).toBe(true)
					yield* table.unsubscribe('m1')
					expect(yield* table.isSubscribed('m1')).toBe(false)
				}),
			),
		)
	})
}
