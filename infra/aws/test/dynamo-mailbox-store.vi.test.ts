import { describe, it } from '@effect/vitest'
import {
	BatchId,
	ClaimWaitingEvents,
	DeliveryAdmission,
	deliveryMailboxKey,
	MailboxDelivery,
	MailboxDeliveryUnavailable,
	MailboxProcessingBackend,
	MailboxProcessingUnavailable,
	Timestamp,
} from '@humanlayer/channels-delivery'
import { Deferred, Effect, Layer, Logger, Option, Ref } from 'effect'

import { makeDynamoStorage } from '../src/DynamoMailboxStore'
import { MailboxTable, TableUnavailable } from '../src/MailboxTable'
import { MemoryMailboxTable } from '../src/MemoryMailboxTable'
import { MAX_NUDGE_DELAY_MS, Nudger } from '../src/Nudger'

type Table = MailboxTable['Service']
type Nudge = { readonly mailboxKey: string; readonly delayMs: number }

const admission = (eventId: string, resourceId = 'acme/repo#1') =>
	DeliveryAdmission.make({
		namespace: 'slop',
		provider: 'github',
		installationId: '1',
		resourceId,
		eventId,
		payload: { eventId },
	})

const keyOf = (resourceId = 'acme/repo#1') => deliveryMailboxKey(admission('any', resourceId))

/** A nudger that remembers every nudge, in order. */
const recordingNudger = Effect.gen(function* () {
	const nudges = yield* Ref.make<ReadonlyArray<Nudge>>([])
	const nudger = Nudger.of({
		nudge: (mailboxKey, delayMs) => Ref.update(nudges, (all) => [...all, { mailboxKey, delayMs }]),
	})
	return { nudges, nudger }
})

/** Run `body` against the store over `table` and `nudger`. Logs are dropped so expected failures stay quiet. */
const withStore = <A, E>(
	input: { readonly table: Table; readonly nudger: Nudger['Service']; readonly scope?: string },
	body: Effect.Effect<A, E, MailboxDelivery | MailboxProcessingBackend>,
) =>
	body.pipe(
		Effect.provide(
			makeDynamoStorage({ polling: 'disabled', ...(input.scope === undefined ? {} : { scope: input.scope }) }).layer.pipe(
				Layer.provide(Layer.mergeAll(Layer.succeed(MailboxTable, input.table), Layer.succeed(Nudger, input.nudger))),
			),
		),
		Effect.provide(Logger.layer([])),
	)

const deliver = (event: DeliveryAdmission) => MailboxDelivery.use((delivery) => delivery.deliver(event))

describe('DynamoMailboxStore', () => {
	it.effect('deliver stores the event and nudges with delay 0', ({ expect }) =>
		Effect.gen(function* () {
			const table = yield* MemoryMailboxTable.make
			const { nudges, nudger } = yield* recordingNudger
			const receipt = yield* withStore({ table, nudger }, deliver(admission('e1')))

			expect(receipt).toMatchObject({ mailboxKey: keyOf(), accepted: true })
			const stored = Option.getOrThrow(yield* table.read(keyOf()))
			expect(stored.state.waiting.map((entry) => entry.admission.eventId)).toEqual(['e1'])
			expect(stored.state.deliveries.readyAt).toBe(0)
			expect(yield* Ref.get(nudges)).toEqual([{ mailboxKey: keyOf(), delayMs: 0 }])
		}),
	)

	it.effect('deliver of the same event id twice reports accepted false the second time and nudges once', ({ expect }) =>
		Effect.gen(function* () {
			const table = yield* MemoryMailboxTable.make
			const { nudges, nudger } = yield* recordingNudger
			const [first, second] = yield* withStore(
				{ table, nudger },
				Effect.all([deliver(admission('e1')), deliver(admission('e1'))]),
			)

			expect(first.accepted).toBe(true)
			expect(second.accepted).toBe(false)
			expect(Option.getOrThrow(yield* table.read(keyOf())).state.waiting).toHaveLength(1)
			expect(yield* Ref.get(nudges)).toHaveLength(1)
		}),
	)

	it.effect('a write that sets readyAt three seconds ahead nudges with delay 3000', ({ expect }) =>
		Effect.gen(function* () {
			const table = yield* MemoryMailboxTable.make
			const { nudges, nudger } = yield* recordingNudger
			yield* withStore(
				{ table, nudger },
				Effect.gen(function* () {
					yield* deliver(admission('e1'))
					yield* MailboxProcessingBackend.use((backend) =>
						backend.deferMailbox({ mailboxKey: keyOf(), until: Timestamp.make(3_000), lastSequenceSeen: 0 }),
					)
				}),
			)

			expect(Option.getOrThrow(yield* table.read(keyOf())).state.deliveries.readyAt).toBe(3_000)
			expect((yield* Ref.get(nudges)).at(-1)).toEqual({ mailboxKey: keyOf(), delayMs: 3_000 })
		}),
	)

	it.effect('a readyAt over 15 minutes ahead nudges with delay 900000', ({ expect }) =>
		Effect.gen(function* () {
			const table = yield* MemoryMailboxTable.make
			const { nudges, nudger } = yield* recordingNudger
			yield* withStore(
				{ table, nudger },
				Effect.gen(function* () {
					yield* deliver(admission('e1'))
					yield* MailboxProcessingBackend.use((backend) =>
						backend.deferMailbox({ mailboxKey: keyOf(), until: Timestamp.make(20 * 60_000), lastSequenceSeen: 0 }),
					)
				}),
			)

			expect((yield* Ref.get(nudges)).at(-1)).toEqual({ mailboxKey: keyOf(), delayMs: 900_000 })
			expect(MAX_NUDGE_DELAY_MS).toBe(900_000)
		}),
	)

	it.effect('findReadyMailboxes with scope looks only at that key', ({ expect }) =>
		Effect.gen(function* () {
			const memory = yield* MemoryMailboxTable.make
			const { nudger } = yield* recordingNudger
			yield* withStore({ table: memory, nudger }, Effect.all([deliver(admission('a1', 'acme/repo#1')), deliver(admission('b1', 'acme/repo#2'))]))
			/** A scoped store must never list the whole table. */
			const table: Table = { ...memory, due: () => Effect.die(new Error('a scoped store called due')) }

			const scoped = yield* withStore(
				{ table, nudger, scope: keyOf('acme/repo#2') },
				MailboxProcessingBackend.use((backend) => backend.findReadyMailboxes),
			)
			const everyone = yield* withStore(
				{ table: memory, nudger },
				MailboxProcessingBackend.use((backend) => backend.findReadyMailboxes),
			)

			expect(scoped.map((ready) => ready.mailboxKey)).toEqual([keyOf('acme/repo#2')])
			expect(scoped[0]?._tag).toBe('WaitingMailbox')
			expect(everyone.map((ready) => ready.mailboxKey).sort()).toEqual([keyOf('acme/repo#1'), keyOf('acme/repo#2')].sort())
		}),
	)

	it.effect('two concurrent claimMailbox calls on one mailbox: exactly one gets the batch', ({ expect }) =>
		Effect.gen(function* () {
			const memory = yield* MemoryMailboxTable.make
			const { nudger } = yield* recordingNudger
			yield* withStore({ table: memory, nudger }, deliver(admission('e1')))

			/** The first two reads wait for each other, so both claims see the same version and race to write. */
			const reads = yield* Ref.make(0)
			const bothRead = yield* Deferred.make<void>()
			const conflicts = yield* Ref.make(0)
			const table: Table = {
				...memory,
				read: (mailboxKey) =>
					Effect.gen(function* () {
						const stored = yield* memory.read(mailboxKey)
						const seen = yield* Ref.updateAndGet(reads, (count) => count + 1)
						if (seen === 2) yield* Deferred.succeed(bothRead, undefined)
						if (seen <= 2) yield* Deferred.await(bothRead)
						return stored
					}),
				write: (input) =>
					memory
						.write(input)
						.pipe(Effect.tap((outcome) => (outcome === 'conflict' ? Ref.update(conflicts, (count) => count + 1) : Effect.void))),
			}
			const claim = (batchId: string) =>
				MailboxProcessingBackend.use((backend) =>
					backend.claimMailbox(
						ClaimWaitingEvents.make({
							mailboxKey: keyOf(),
							upToSequence: 0,
							leaseMs: 30_000,
							batchId: BatchId.make(batchId),
							accessToken: `token-${batchId}`,
						}),
					),
				)

			const results = yield* withStore({ table, nudger }, Effect.all([claim('b1'), claim('b2')], { concurrency: 'unbounded' }))

			expect(results.filter(Option.isSome)).toHaveLength(1)
			expect(yield* Ref.get(conflicts)).toBe(1)
			const stored = Option.getOrThrow(yield* memory.read(keyOf()))
			expect(stored.state.waiting).toHaveLength(0)
			expect(stored.state.deliveries.active).not.toBeNull()
		}),
	)

	it.effect('deliver while a delivery is active leaves readyAt untouched', ({ expect }) =>
		Effect.gen(function* () {
			const table = yield* MemoryMailboxTable.make
			const { nudger } = yield* recordingNudger
			yield* withStore(
				{ table, nudger },
				Effect.gen(function* () {
					yield* deliver(admission('e1'))
					yield* MailboxProcessingBackend.use((backend) =>
						backend.claimMailbox(
							ClaimWaitingEvents.make({
								mailboxKey: keyOf(),
								upToSequence: 0,
								leaseMs: 30_000,
								batchId: BatchId.make('b1'),
								accessToken: 'token',
							}),
						),
					)
				}),
			)
			const claimed = Option.getOrThrow(yield* table.read(keyOf())).state
			expect(claimed.deliveries.active).not.toBeNull()

			const receipt = yield* withStore({ table, nudger }, deliver(admission('e2')))

			expect(receipt.accepted).toBe(true)
			const after = Option.getOrThrow(yield* table.read(keyOf())).state
			expect(after.waiting.map((entry) => entry.admission.eventId)).toEqual(['e2'])
			expect(after.deliveries).toEqual(claimed.deliveries)
		}),
	)

	it.effect('a nudger that fails does not fail the write', ({ expect }) =>
		Effect.gen(function* () {
			const table = yield* MemoryMailboxTable.make
			const nudger = Nudger.of({ nudge: () => Effect.die(new Error('queue down')) })
			const receipt = yield* withStore({ table, nudger }, deliver(admission('e1')))

			expect(receipt.accepted).toBe(true)
			expect(Option.getOrThrow(yield* table.read(keyOf())).state.waiting).toHaveLength(1)
		}),
	)

	it.effect('a table that always conflicts fails claimMailbox with MailboxProcessingUnavailable after 5 writes', ({ expect }) =>
		Effect.gen(function* () {
			const memory = yield* MemoryMailboxTable.make
			const { nudger } = yield* recordingNudger
			yield* withStore({ table: memory, nudger }, deliver(admission('e1')))
			const writes = yield* Ref.make(0)
			const table: Table = { ...memory, write: () => Ref.update(writes, (count) => count + 1).pipe(Effect.as('conflict' as const)) }

			const error = yield* withStore(
				{ table, nudger },
				MailboxProcessingBackend.use((backend) =>
					backend.claimMailbox(
						ClaimWaitingEvents.make({
							mailboxKey: keyOf(),
							upToSequence: 0,
							leaseMs: 30_000,
							batchId: BatchId.make('b1'),
							accessToken: 'token',
						}),
					),
				),
			).pipe(Effect.flip)

			expect(error).toBeInstanceOf(MailboxProcessingUnavailable)
			expect(yield* Ref.get(writes)).toBe(5)
		}),
	)

	it.effect('an unavailable table fails deliver with MailboxDeliveryUnavailable', ({ expect }) =>
		Effect.gen(function* () {
			const memory = yield* MemoryMailboxTable.make
			const { nudges, nudger } = yield* recordingNudger
			const table: Table = { ...memory, read: () => Effect.fail(new TableUnavailable({ reason: 'down' })) }

			const error = yield* withStore({ table, nudger }, deliver(admission('e1'))).pipe(Effect.flip)

			expect(error).toBeInstanceOf(MailboxDeliveryUnavailable)
			expect(yield* Ref.get(nudges)).toEqual([])
		}),
	)
})
