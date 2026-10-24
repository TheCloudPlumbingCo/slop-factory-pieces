/**
 * The shared control-layer behaviours (`@slop/core/conformance/suite`) on the AWS store: the real bot over
 * `makeDynamoStorage`, woken by polling or by nudges through a fake queue, over the in-memory table and, when
 * `DYNAMODB_ENDPOINT` is set, over DynamoDB Local.
 */
import { describe, expect, it } from '@effect/vitest'
import { deliveryMailboxKey } from '@humanlayer/channels-delivery'
import { GitHubId, githubDiscussionResourceId } from '@humanlayer/channels-github'
import { botSettings } from '@slop/core'
import { botMention } from '@slop/core/conformance/driver'
import { B12_PULL_REQUEST, defineControlLayerSuite } from '@slop/core/conformance/suite'
import { Effect, type Layer } from 'effect'

import type { MailboxTable } from '../src/MailboxTable'
import { MemoryMailboxTable } from '../src/MemoryMailboxTable'
import { type AwsDriverMode, makeAwsDriver } from './support/aws-driver'
import { dynamoEndpoint, dynamoSkipReason, dynamoTestTableLayer } from './support/dynamo-test-table'

const modes: ReadonlyArray<AwsDriverMode> = ['polling', 'nudge']
const endpoint = dynamoEndpoint

const tables: ReadonlyArray<{ readonly name: string; readonly layer: () => Layer.Layer<MailboxTable> }> = [
	{ name: 'memory table', layer: () => MemoryMailboxTable.layer },
	...(endpoint === undefined ? [] : [{ name: 'DynamoDB Local', layer: () => dynamoTestTableLayer(endpoint) }]),
]

if (endpoint === undefined) console.log(`AWS control layer over DynamoDB Local skipped: ${dynamoSkipReason}`)

for (const table of tables) {
	for (const mode of modes) {
		defineControlLayerSuite(`aws ${mode} over ${table.name}`, makeAwsDriver({ table: table.layer(), mode }))

		describe(`control layer on aws ${mode} over ${table.name}: mailbox keys`, () => {
			it.effect("B12's pull request gets the mailbox key the SDK computes for that pull request", () =>
				Effect.scoped(
					Effect.gen(function* () {
						const driver = yield* makeAwsDriver({ table: table.layer(), mode })
						const { status } = yield* driver.postGitHubMention({
							eventId: 'b12-key',
							kind: 'pr',
							number: B12_PULL_REQUEST,
							author: 'maintainer-1',
							body: `${botMention} review this pull request`,
							signature: 'valid',
						})
						expect(status).toBe(200)
						yield* driver.advance(5_000)
						const starts = yield* driver.agentStarts
						expect(starts).toHaveLength(1)
						/** The AWS driver's repository: installation 100, repository 200. */
						expect(starts[0]?.mailboxKey).toBe(
							deliveryMailboxKey({
								namespace: botSettings.namespace,
								provider: 'github',
								installationId: '100',
								resourceId: githubDiscussionResourceId({
									repositoryId: GitHubId.make(200),
									kind: 'pull-request',
									number: GitHubId.make(B12_PULL_REQUEST),
								}),
							}),
						)
					}),
				),
			)
		})
	}
}

if (endpoint === undefined) {
	describe.skip(`aws control layer over DynamoDB Local (${dynamoSkipReason})`, () => {
		it.effect('skipped', () => Effect.void)
	})
}
