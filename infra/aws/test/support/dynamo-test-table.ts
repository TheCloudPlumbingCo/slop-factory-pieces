/**
 * A throwaway DynamoDB table for tests against DynamoDB Local (`DYNAMODB_ENDPOINT`): uniquely named, with the
 * sparse `due-index`, and deleted when the scope closes.
 */
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { Effect, Layer } from 'effect'

import { makeDynamoMailboxTable } from '../../src/DynamoMailboxTable'
import { MailboxTable } from '../../src/MailboxTable'

/** The DynamoDB Local endpoint, or undefined when the Dynamo tests should be skipped. */
export const dynamoEndpoint: string | undefined = process.env.DYNAMODB_ENDPOINT

/** Printed when the Dynamo Local runs are skipped. */
export const dynamoSkipReason =
	'DYNAMODB_ENDPOINT is not set (docker compose -f infra/aws/docker-compose.yml up -d, then DYNAMODB_ENDPOINT=http://localhost:8000)'

/** Create a uniquely named table with the `due-index` GSI; it is deleted when the scope closes. */
export const makeTestTable = Effect.fn('makeTestTable')(function* (endpointUrl: string) {
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

/** The `MailboxTable` over a fresh test table, deleted when the layer's scope closes. */
export const dynamoTestTableLayer = (endpointUrl: string): Layer.Layer<MailboxTable> =>
	Layer.effect(MailboxTable, Effect.map(makeTestTable(endpointUrl), makeDynamoMailboxTable))
