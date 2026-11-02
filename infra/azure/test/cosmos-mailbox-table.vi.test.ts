import { it } from '@effect/vitest'
import { DeliverySlot, Timestamp } from '@humanlayer/channels-delivery'
import { Effect, Exit } from 'effect'

import { type CosmosItems, makeCosmosMailboxTable } from '../src/CosmosMailboxTable'
import { emptyMailboxState } from '../src/MailboxState'
import { defineMailboxTableContract } from './mailbox-table.contract'
import { makeFakeCosmos } from './support/fake-cosmos'

defineMailboxTableContract(
	'CosmosMailboxTable over a fake container',
	Effect.sync(() => makeCosmosMailboxTable(makeFakeCosmos())),
)

const ready = (mailboxKey: string, readyAt: number | null) => ({
	...emptyMailboxState({ mailboxKey, provider: 'github' }),
	deliveries: DeliverySlot.make({
		active: null,
		readyAt: readyAt === null ? null : Timestamp.make(readyAt),
		retained: [],
	}),
})

it.describe('CosmosMailboxTable (Cosmos specifics)', () => {
	it.effect('a dedup marker is stored in the mailbox partition with a ttl, next to the state', ({ expect }) =>
		Effect.gen(function* () {
			const cosmos = makeFakeCosmos()
			const table = makeCosmosMailboxTable(cosmos)
			yield* table.write({ state: ready('m1', null), expectedVersion: null, newEventKey: 'delivery-1' })
			const stored = cosmos.items('m1')
			expect([...stored.keys()].sort()).toEqual(['evt#delivery-1', 'state'])
			expect(stored.get('evt#delivery-1')?.ttl).toBe(30 * 24 * 60 * 60)
		}),
	)

	it.effect('a writer that read a stale etag gets conflict and nothing changes', ({ expect }) =>
		Effect.gen(function* () {
			const cosmos = makeFakeCosmos()
			const first = makeCosmosMailboxTable(cosmos)
			yield* first.write({ state: ready('m1', null), expectedVersion: null })
			// Another writer lands between this writer's read of the etag and its batch.
			const racing: CosmosItems = {
				...cosmos,
				batch: async (operations, pk) => {
					await cosmos.batch(
						[
							{
								operationType: 'Replace',
								id: 'state',
								resourceBody: { id: 'state', pk, version: 2 },
								ifMatch: (await cosmos.read('state', pk))?.etag ?? '',
							},
						],
						pk,
					)
					return cosmos.batch(operations, pk)
				},
			}
			const outcome = yield* makeCosmosMailboxTable(racing).write({ state: ready('m1', 5), expectedVersion: 1 })
			expect(outcome).toBe('conflict')
			expect(cosmos.items('m1').get('state')?.version).toBe(2)
		}),
	)

	it.effect('a rolled-back batch leaves no dedup marker behind', ({ expect }) =>
		Effect.gen(function* () {
			const cosmos = makeFakeCosmos()
			const table = makeCosmosMailboxTable(cosmos)
			yield* table.write({ state: ready('m1', null), expectedVersion: null })
			const outcome = yield* table.write({ state: ready('m1', null), expectedVersion: 7, newEventKey: 'delivery-2' })
			expect(outcome).toBe('conflict')
			expect(cosmos.items('m1').has('evt#delivery-2')).toBe(false)
		}),
	)

	it.effect('a mailbox leaves the due query when readyAt becomes null', ({ expect }) =>
		Effect.gen(function* () {
			const table = makeCosmosMailboxTable(makeFakeCosmos())
			yield* table.write({ state: ready('m1', 100), expectedVersion: null })
			expect(yield* table.due(1000)).toEqual(['m1'])
			yield* table.write({ state: ready('m1', null), expectedVersion: 1 })
			expect(yield* table.due(1000)).toEqual([])
		}),
	)

	it.effect('an unexpected batch status or a thrown error is TableUnavailable, not a defect', ({ expect }) =>
		Effect.gen(function* () {
			const failing = makeCosmosMailboxTable({ ...makeFakeCosmos(), batch: async () => [500] })
			const throwing = makeCosmosMailboxTable({
				...makeFakeCosmos(),
				read: async () => {
					throw new Error('network down')
				},
			})
			const written = yield* Effect.exit(failing.write({ state: ready('m1', null), expectedVersion: null }))
			const read = yield* Effect.exit(throwing.read('m1'))
			expect(Exit.isFailure(written)).toBe(true)
			expect(JSON.stringify(written)).toContain('TableUnavailable')
			expect(JSON.stringify(written)).not.toContain('Die')
			expect(Exit.isFailure(read)).toBe(true)
			expect(JSON.stringify(read)).toContain('TableUnavailable')
			expect(JSON.stringify(read)).not.toContain('Die')
		}),
	)
})
