/**
 * DynamoDB `MailboxTable`. One table, partition key `pk`:
 * - `mbx#<mailboxKey>`: `state`, `version`, and while `deliveries.readyAt` is set, `due = 'due'` and `dueAt = readyAt`
 * - `evt#<eventKey>`: dedup marker with a `ttl` (epoch seconds) 30 days ahead
 * - `sub#<mailboxKey>`: subscription marker
 * The sparse GSI `due-index` (`due`, `dueAt`) holds only mailboxes that are waiting to be looked at.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import {
	DeleteCommand,
	type DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import { Effect, Layer, Option, Schema } from 'effect'

import { MailboxState } from './MailboxState'
import { MailboxTable, TableUnavailable, type WriteOutcome } from './MailboxTable'

const DEDUP_TTL_SECONDS = 30 * 24 * 60 * 60

/** Where the table lives: its name and the document client that talks to it. */
export type DynamoMailboxTableInput = {
	readonly tableName: string
	readonly client: DynamoDBDocumentClient
}

const unavailable = (error: unknown) =>
	new TableUnavailable({ reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })

/** Runs an SDK call (or any promise-based step); every failure or throw becomes `TableUnavailable`. */
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: unavailable })

/**
 * Runs a write. Success is 'written'; a failure `classify` recognises becomes that outcome; any other
 * failure becomes `TableUnavailable`.
 */
const settle = (run: () => Promise<unknown>, classify: (error: unknown) => WriteOutcome | undefined) =>
	Effect.tryPromise({
		try: () =>
			run().then(
				(): WriteOutcome => 'written',
				(error: unknown) => {
					const outcome = classify(error)
					if (outcome === undefined) throw unavailable(error)
					return outcome
				},
			),
		catch: (error) => (error instanceof TableUnavailable ? error : unavailable(error)),
	})

/** The cancellation code of the transaction item at `index`. */
const reasonCode = (error: TransactionCanceledException, index: number) => error.CancellationReasons?.[index]?.Code

/**
 * Builds a `MailboxTable` over a DynamoDB table that has the `pk` key and the `due-index` GSI.
 *
 * @param input - table name and document client
 */
export const makeDynamoMailboxTable = (input: DynamoMailboxTableInput): MailboxTable['Service'] => {
	const { tableName, client } = input
	const mailboxPk = (mailboxKey: string) => `mbx#${mailboxKey}`
	const subscriptionPk = (mailboxKey: string) => `sub#${mailboxKey}`

	const read = Effect.fn('DynamoMailboxTable.read')(function* (mailboxKey: string) {
		const result = yield* attempt(() =>
			client.send(new GetCommand({ TableName: tableName, Key: { pk: mailboxPk(mailboxKey) }, ConsistentRead: true })),
		)
		if (result.Item === undefined) return Option.none()
		const state = yield* Schema.decodeUnknownEffect(MailboxState)(result.Item.state).pipe(Effect.mapError(unavailable))
		return Option.some({ state, version: result.Item.version as number })
	})

	const write = Effect.fn('DynamoMailboxTable.write')(function* (request: {
		readonly state: MailboxState
		readonly expectedVersion: number | null
		readonly newEventKey?: string
	}) {
		const { state, expectedVersion, newEventKey } = request
		const encoded = yield* Schema.encodeEffect(MailboxState)(state).pipe(Effect.mapError(unavailable))
		const readyAt = state.deliveries.readyAt
		const statePut = {
			TableName: tableName,
			Item: {
				pk: mailboxPk(state.mailboxKey),
				// DynamoDB rejects `undefined`; the JSON round trip drops it.
				state: JSON.parse(JSON.stringify(encoded)) as unknown,
				version: (expectedVersion ?? 0) + 1,
				...(readyAt === null ? {} : { due: 'due', dueAt: readyAt }),
			},
			...(expectedVersion === null
				? { ConditionExpression: 'attribute_not_exists(pk)' }
				: { ConditionExpression: '#version = :expected', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':expected': expectedVersion } }),
		}

		if (newEventKey === undefined) {
			return yield* settle(
				() => client.send(new PutCommand(statePut)),
				(error) => (isRetryableWriteFailure(error) ? 'conflict' : undefined),
			)
		}

		const dedupPut = {
			TableName: tableName,
			Item: { pk: `evt#${newEventKey}`, ttl: Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS },
			ConditionExpression: 'attribute_not_exists(pk)',
		}
		// Dedup first so cancellation reason 0 is the dedup item and reason 1 is the state item.
		return yield* settle(
			() => client.send(new TransactWriteCommand({ TransactItems: [{ Put: dedupPut }, { Put: statePut }] })),
			(error) => {
				if (!(error instanceof TransactionCanceledException)) return undefined
				if (reasonCode(error, 0) === 'ConditionalCheckFailed') return 'duplicate'
				const codes = [reasonCode(error, 0), reasonCode(error, 1)]
				return codes.includes('ConditionalCheckFailed') || codes.includes('TransactionConflict') ? 'conflict' : undefined
			},
		)
	})

	const due = Effect.fn('DynamoMailboxTable.due')(function* (now: number) {
		const keys: Array<string> = []
		let startKey: Record<string, unknown> | undefined
		do {
			const page = yield* attempt(() =>
				client.send(
					new QueryCommand({
						TableName: tableName,
						IndexName: 'due-index',
						KeyConditionExpression: '#due = :due AND dueAt <= :now',
						ExpressionAttributeNames: { '#due': 'due' },
						ExpressionAttributeValues: { ':due': 'due', ':now': now },
						ExclusiveStartKey: startKey,
					}),
				),
			)
			for (const item of page.Items ?? []) keys.push((item.pk as string).slice('mbx#'.length))
			startKey = page.LastEvaluatedKey
		} while (startKey !== undefined)
		return keys
	})

	const subscribe = Effect.fn('DynamoMailboxTable.subscribe')(function* (mailboxKey: string) {
		yield* attempt(() => client.send(new PutCommand({ TableName: tableName, Item: { pk: subscriptionPk(mailboxKey) } })))
	})

	const isSubscribed = Effect.fn('DynamoMailboxTable.isSubscribed')(function* (mailboxKey: string) {
		const result = yield* attempt(() =>
			client.send(new GetCommand({ TableName: tableName, Key: { pk: subscriptionPk(mailboxKey) }, ConsistentRead: true })),
		)
		return result.Item !== undefined
	})

	const unsubscribe = Effect.fn('DynamoMailboxTable.unsubscribe')(function* (mailboxKey: string) {
		yield* attempt(() => client.send(new DeleteCommand({ TableName: tableName, Key: { pk: subscriptionPk(mailboxKey) } })))
	})

	return MailboxTable.of({ read, write, due, subscribe, isSubscribed, unsubscribe })
}

/** A plain Put fails retryably when its condition fails or a running transaction is touching the same item. */
export const isRetryableWriteFailure = (error: unknown) =>
	error instanceof Error && (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionConflictException')

/** Provides the DynamoDB-backed table as the `MailboxTable` service. */
export const DynamoMailboxTableLive = (input: DynamoMailboxTableInput): Layer.Layer<MailboxTable> =>
	Layer.succeed(MailboxTable, makeDynamoMailboxTable(input))
