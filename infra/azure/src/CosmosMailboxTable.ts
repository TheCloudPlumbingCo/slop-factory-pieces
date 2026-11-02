/**
 * Cosmos DB `MailboxTable`. One container, partition key `/pk`, where `pk` is the mailbox key. Every item of one
 * mailbox shares that partition, which is what lets a dedup marker and the state be written in one transactional
 * batch. The marker is therefore dedup per mailbox, which is enough because an event always maps to one mailbox.
 * - `state`: `state`, `version`, and while `deliveries.readyAt` is set, `due = true` and `dueAt = readyAt`
 * - `evt#<eventKey>`: dedup marker with a `ttl` (seconds) 30 days ahead (the container's default ttl is -1)
 * - `sub`: subscription marker
 */
import { Effect, Layer, Option, Schema } from 'effect'

import { MailboxState } from './MailboxState'
import { MailboxTable, TableUnavailable, type WriteOutcome } from './MailboxTable'

const DEDUP_TTL_SECONDS = 30 * 24 * 60 * 60

/** One operation of a transactional batch. */
export type BatchOperation =
	| { readonly operationType: 'Create'; readonly resourceBody: Record<string, unknown> }
	| {
			readonly operationType: 'Replace'
			readonly id: string
			readonly resourceBody: Record<string, unknown>
			readonly ifMatch: string
	  }

/** What the table needs from a Cosmos container; `fromCosmosContainer` adapts the real SDK, tests pass a fake. */
export interface CosmosItems {
	/** Point-read one item; `undefined` when it does not exist. */
	readonly read: (
		id: string,
		pk: string,
	) => Promise<{ readonly resource: Record<string, unknown>; readonly etag: string } | undefined>
	/** All-or-nothing batch inside one partition: the HTTP status of each operation, in order. */
	readonly batch: (operations: ReadonlyArray<BatchOperation>, pk: string) => Promise<ReadonlyArray<number>>
	readonly upsert: (item: Record<string, unknown>) => Promise<void>
	/** Delete one item; a missing item is not an error. */
	readonly remove: (id: string, pk: string) => Promise<void>
	/** Delete one item only if its etag still matches; false when it is gone or changed. */
	readonly removeIfMatch: (id: string, pk: string, etag: string) => Promise<boolean>
	/** Partition keys of the mailboxes whose `state` item is due at or before `now`. */
	readonly due: (now: number) => Promise<ReadonlyArray<string>>
}

const unavailable = (error: unknown) =>
	new TableUnavailable({ reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: unavailable })

const isOk = (status: number) => status >= 200 && status < 300

/**
 * Builds a `MailboxTable` over a Cosmos container with partition key `/pk`.
 *
 * @param items - the container's operations
 */
export const makeCosmosMailboxTable = (items: CosmosItems): MailboxTable['Service'] => {
	const read = Effect.fn('CosmosMailboxTable.read')(function* (mailboxKey: string) {
		const found = yield* attempt(() => items.read('state', mailboxKey))
		if (found === undefined) return Option.none()
		const state = yield* Schema.decodeUnknownEffect(MailboxState)(found.resource.state).pipe(Effect.mapError(unavailable))
		return Option.some({ state, version: found.resource.version as number })
	})

	const write = Effect.fn('CosmosMailboxTable.write')(function* (request: {
		readonly state: MailboxState
		readonly expectedVersion: number | null
		readonly newEventKey?: string
	}) {
		const { state, expectedVersion, newEventKey } = request
		const pk = state.mailboxKey
		const encoded = yield* Schema.encodeEffect(MailboxState)(state).pipe(Effect.mapError(unavailable))
		const readyAt = state.deliveries.readyAt
		const body = {
			id: 'state',
			pk,
			// Cosmos stores JSON; the round trip drops `undefined`.
			state: JSON.parse(JSON.stringify(encoded)) as unknown,
			version: (expectedVersion ?? 0) + 1,
			due: readyAt !== null,
			dueAt: readyAt,
		}

		let stateOperation: BatchOperation
		if (expectedVersion === null) {
			stateOperation = { operationType: 'Create', resourceBody: body }
		} else {
			// A replace is conditional on the item's etag, so a writer that lost a race fails instead of overwriting.
			const current = yield* attempt(() => items.read('state', pk))
			if (current === undefined || current.resource.version !== expectedVersion) {
				// A repeated event is a duplicate even when the state also moved on, as the batch below would report.
				const seen = newEventKey !== undefined && (yield* attempt(() => items.read(`evt#${newEventKey}`, pk))) !== undefined
				return (seen ? 'duplicate' : 'conflict') as WriteOutcome
			}
			stateOperation = { operationType: 'Replace', id: 'state', resourceBody: body, ifMatch: current.etag }
		}
		const operations: Array<BatchOperation> =
			newEventKey === undefined
				? [stateOperation]
				: [
						{
							operationType: 'Create',
							resourceBody: { id: `evt#${newEventKey}`, pk, ttl: DEDUP_TTL_SECONDS },
						},
						stateOperation,
					]

		const statuses = yield* attempt(() => items.batch(operations, pk))
		if (statuses.every(isOk)) return 'written' as WriteOutcome
		// The dedup marker is checked first, so a repeated event is a duplicate even if the state also moved on.
		if (newEventKey !== undefined && statuses[0] === 409) return 'duplicate' as WriteOutcome
		const stateStatus = statuses[statuses.length - 1]
		if (stateStatus === 409 || stateStatus === 412) return 'conflict' as WriteOutcome
		return yield* Effect.fail(unavailable(new Error(`batch failed with statuses ${statuses.join(',')}`)))
	})

	const due = Effect.fn('CosmosMailboxTable.due')(function* (now: number) {
		return yield* attempt(() => items.due(now))
	})

	const subscribe = Effect.fn('CosmosMailboxTable.subscribe')(function* (mailboxKey: string) {
		yield* attempt(() => items.upsert({ id: 'sub', pk: mailboxKey }))
	})

	const isSubscribed = Effect.fn('CosmosMailboxTable.isSubscribed')(function* (mailboxKey: string) {
		return (yield* attempt(() => items.read('sub', mailboxKey))) !== undefined
	})

	const unsubscribe = Effect.fn('CosmosMailboxTable.unsubscribe')(function* (mailboxKey: string) {
		yield* attempt(() => items.remove('sub', mailboxKey))
	})

	return MailboxTable.of({ read, write, due, subscribe, isSubscribed, unsubscribe })
}

/** Provides the Cosmos-backed table as the `MailboxTable` service. */
export const CosmosMailboxTableLive = (items: CosmosItems): Layer.Layer<MailboxTable> =>
	Layer.succeed(MailboxTable, makeCosmosMailboxTable(items))
