/**
 * The shared control-layer behaviours (`@slop/core/conformance/suite`) on the Azure store: the real bot over
 * `makeStorage`, woken by polling or by nudges through a fake queue, over the in-memory table and over the Cosmos
 * table on a fake container.
 */
import { describe, expect, it } from '@effect/vitest'
import { deliveryMailboxKey } from '@humanlayer/channels-delivery'
import { GitHubId, githubDiscussionResourceId } from '@humanlayer/channels-github'
import { botSettings } from '@slop/core'
import { botMention } from '@slop/core/conformance/driver'
import { B12_PULL_REQUEST, defineControlLayerSuite } from '@slop/core/conformance/suite'
import { Effect, Layer } from 'effect'

import { makeCosmosMailboxTable } from '../src/CosmosMailboxTable'
import { MailboxTable } from '../src/MailboxTable'
import { MemoryMailboxTable } from '../src/MemoryMailboxTable'
import { type AzureDriverMode, makeAzureDriver } from './support/azure-driver'
import { makeFakeCosmos } from './support/fake-cosmos'

const modes: ReadonlyArray<AzureDriverMode> = ['polling', 'nudge']

const tables: ReadonlyArray<{ readonly name: string; readonly layer: () => Layer.Layer<MailboxTable> }> = [
	{ name: 'memory table', layer: () => MemoryMailboxTable.layer },
	{ name: 'Cosmos table', layer: () => Layer.sync(MailboxTable, () => makeCosmosMailboxTable(makeFakeCosmos())) },
]

for (const table of tables) {
	for (const mode of modes) {
		defineControlLayerSuite(`azure ${mode} over ${table.name}`, makeAzureDriver({ table: table.layer(), mode }))

		describe(`control layer on azure ${mode} over ${table.name}: mailbox keys`, () => {
			it.effect("B12's pull request gets the mailbox key the SDK computes for that pull request", () =>
				Effect.scoped(
					Effect.gen(function* () {
						const driver = yield* makeAzureDriver({ table: table.layer(), mode })
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
						/** The Azure driver's repository: installation 100, repository 200. */
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
