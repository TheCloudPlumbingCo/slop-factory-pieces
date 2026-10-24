import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { it } from '@effect/vitest'
import { DeliverySlot, Timestamp } from '@humanlayer/channels-delivery'
import { Effect, Exit, type Scope } from 'effect'

import { makeDynamoMailboxTable } from '../src/DynamoMailboxTable'
import { emptyMailboxState } from '../src/MailboxState'
import { defineMailboxTableContract } from './mailbox-table.contract'

const endpoint = process.env.DYNAMODB_ENDPOINT

/** A uniquely named table with the sparse `due-index`, deleted when the scope closes. */
const makeTestTable = Effect.fn('makeTestTable')(function* (endpointUrl: string) {
	const tableName = `mailbox-test-${crypto.randomUUID()}`
	const raw = new DynamoDBClient({
		endpoint: endpointUrl,
		region: 'ap-southeast-1',
		credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
	})
	const client = DynamoDBDocumentClient.from(raw)
	yield* Effect.acquireRelease(
		Effect.promise(() =>
			raw.send(
				new CreateTableCommand({
					TableName: tableName,
					BillingMode: 'PAY_PER_REQUEST',
					AttributeDefinitions: [
						{ AttributeName: 'pk', AttributeType: 'S' },
						{ AttributeName: 'due', AttributeType: 'S' },
						{ AttributeName: 'dueAt', AttributeType: 'N' },
					],
					KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
					GlobalSecondaryIndexes: [
						{
							IndexName: 'due-index',
							KeySchema: [
								{ AttributeName: 'due', KeyType: 'HASH' },
								{ AttributeName: 'dueAt', KeyType: 'RANGE' },
							],
							Projection: { ProjectionType: 'ALL' },
						},
					],
				}),
			),
		),
		() => Effect.promise(() => raw.send(new DeleteTableCommand({ TableName: tableName }))).pipe(Effect.ignore),
	)
	return { tableName, client }
})

if (endpoint === undefined) {
	console.log('DynamoMailboxTable tests skipped: DYNAMODB_ENDPOINT is not set (docker compose -f infra/aws/docker-compose.yml up -d)')
	it.describe.skip('DynamoMailboxTable (needs DYNAMODB_ENDPOINT)', () => {
		it.effect('skipped', () => Effect.void)
	})
} else {
	defineMailboxTableContract(
		'DynamoMailboxTable',
		Effect.map(makeTestTable(endpoint), (input) => makeDynamoMailboxTable(input)),
	)

	it.describe('DynamoMailboxTable (DynamoDB specifics)', () => {
		const withTable = <A, E>(body: (input: Effect.Success<ReturnType<typeof makeTestTable>>) => Effect.Effect<A, E, Scope.Scope>) =>
			Effect.scoped(Effect.flatMap(makeTestTable(endpoint), body))

		it.effect('writing a mailbox item over 400 KB fails with TableUnavailable, not a thrown defect', ({ expect }) =>
			withTable((input) =>
				Effect.gen(function* () {
					const table = makeDynamoMailboxTable(input)
					const huge = { ...emptyMailboxState({ mailboxKey: 'big', provider: 'github' }), provider: 'x'.repeat(450_000) }
					const exit = yield* Effect.exit(table.write({ state: huge, expectedVersion: null }))
					expect(Exit.isFailure(exit)).toBe(true)
					expect(JSON.stringify(exit)).toContain('TableUnavailable')
					expect(JSON.stringify(exit)).not.toContain('Die')
				}),
			),
		)

		it.effect('a mailbox leaves the due-index when readyAt becomes null', ({ expect }) =>
			withTable((input) =>
				Effect.gen(function* () {
					const table = makeDynamoMailboxTable(input)
					const ready = {
						...emptyMailboxState({ mailboxKey: 'm1', provider: 'github' }),
						deliveries: DeliverySlot.make({ active: null, readyAt: Timestamp.make(100), retained: [] }),
					}
					yield* table.write({ state: ready, expectedVersion: null })
					expect(yield* table.due(1000)).toEqual(['m1'])
					const idle = { ...ready, deliveries: DeliverySlot.make({ active: null, readyAt: null, retained: [] }) }
					yield* table.write({ state: idle, expectedVersion: 1 })
					expect(yield* table.due(1000)).toEqual([])
					const items = yield* Effect.promise(() => input.client.send(new ScanCommand({ TableName: input.tableName })))
					const item = items.Items?.find((candidate) => candidate.pk === 'mbx#m1')
					expect(item).toBeDefined()
					expect(item).not.toHaveProperty('due')
					expect(item).not.toHaveProperty('dueAt')
				}),
			),
		)

		it.effect('the dedup marker carries a ttl about 30 days ahead', ({ expect }) =>
			withTable((input) =>
				Effect.gen(function* () {
					const table = makeDynamoMailboxTable(input)
					yield* table.write({
						state: emptyMailboxState({ mailboxKey: 'm1', provider: 'github' }),
						expectedVersion: null,
						newEventKey: 'evt-1',
					})
					const items = yield* Effect.promise(() => input.client.send(new ScanCommand({ TableName: input.tableName })))
					const marker = items.Items?.find((candidate) => candidate.pk === 'evt#evt-1')
					const days = ((marker?.ttl as number) - Date.now() / 1000) / 86_400
					expect(days).toBeGreaterThan(29.9)
					expect(days).toBeLessThan(30.1)
				}),
			),
		)

		it.effect('racing event-keyed and keyless writes: exactly one written, the rest conflict, never TableUnavailable', ({ expect }) =>
			withTable((input) =>
				Effect.gen(function* () {
					const table = makeDynamoMailboxTable(input)
					for (let round = 0; round < 10; round++) {
						const first = emptyMailboxState({ mailboxKey: `m${round}`, provider: 'github' })
						yield* table.write({ state: first, expectedVersion: null })
						const outcomes = yield* Effect.all(
							Array.from({ length: 10 }, (_, index) =>
								table
									.write({
										state: { ...first, nextSequence: index + 1 },
										expectedVersion: 1,
										...(index % 2 === 0 ? { newEventKey: `e${round}-${index}` } : {}),
									})
									.pipe(Effect.result),
							),
							{ concurrency: 'unbounded' },
						)
						const values = outcomes.map((outcome) => (outcome._tag === 'Success' ? outcome.success : 'unavailable'))
						expect(values.filter((value) => value === 'written')).toHaveLength(1)
						expect(values.filter((value) => value === 'conflict')).toHaveLength(9)
					}
				}),
			),
		)

		it.effect('an unreachable table fails with TableUnavailable', ({ expect }) =>
			withTable((input) =>
				Effect.gen(function* () {
					const table = makeDynamoMailboxTable({ ...input, tableName: 'does-not-exist' })
					const exit = yield* Effect.exit(table.read('m1'))
					expect(JSON.stringify(exit)).toContain('TableUnavailable')
				}),
			),
		)
	})
}
