/**
 * The sweep: the safety net for a nudge that never arrived. It re-nudges every mailbox whose `readyAt` has passed,
 * and a nudge for a mailbox with nothing due does nothing.
 */
import { describe, expect, it } from '@effect/vitest'
import { DeliverySlot, Timestamp } from '@humanlayer/channels-delivery'
import { echoReply } from '@slop/core'
import { botMention } from '@slop/core/conformance/driver'
import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'

import { sweep } from '../src/MailboxStore'
import { emptyMailboxState, type MailboxState } from '../src/MailboxState'
import { MailboxTable } from '../src/MailboxTable'
import { MemoryMailboxTable } from '../src/MemoryMailboxTable'
import { makeAzureDriver } from './support/azure-driver'
import { makeFakeQueue } from './support/fake-queue'

const mention = (eventId: string, number: number, text: string) => ({
	eventId,
	kind: 'issue' as const,
	number,
	author: 'maintainer-1',
	body: `${botMention} ${text}`,
	signature: 'valid' as const,
})

const mailboxDueAt = (mailboxKey: string, readyAt: number | null): MailboxState => ({
	...emptyMailboxState({ mailboxKey, provider: 'github' }),
	deliveries: DeliverySlot.make({
		active: null,
		readyAt: readyAt === null ? null : Timestamp.make(readyAt),
		retained: [],
	}),
})

describe('sweep', () => {
	it.effect('an event saved while the nudger fails is nudged by the sweep and then produces one agent start', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const driver = yield* makeAzureDriver({ table: MemoryMailboxTable.layer, mode: 'nudge' })
				/** The process saves the event and dies before its nudge reaches the queue. */
				yield* driver.dropNextNudges(1)
				const { status } = yield* driver.postGitHubMention(mention('sweep-lost-nudge', 31, 'run once'))
				expect(status).toBe(200)
				yield* driver.advance(10_000)
				expect(yield* driver.agentStarts, 'nothing wakes the mailbox without its nudge').toEqual([])

				expect(yield* driver.sweep).toBe(1)
				yield* driver.advance(5_000)
				const starts = yield* driver.agentStarts
				expect(starts).toHaveLength(1)
				expect(starts[0]?.prompt).toBe(`${botMention} run once`)

				/** A later sweep finds the mailbox running, not due, and starts nothing more. */
				yield* driver.sweep
				yield* driver.advance(5_000)
				yield* driver.completeDelivery(starts[0]!.deliveryId)
				yield* driver.advance(5_000)
				yield* driver.sweep
				yield* driver.advance(5_000)
				expect(yield* driver.agentStarts).toHaveLength(1)
				expect((yield* driver.output).comments).toEqual([echoReply(`${botMention} run once`)])
			}),
		),
	)

	it.effect('a nudge for an idle mailbox starts nothing and posts nothing', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const driver = yield* makeAzureDriver({ table: MemoryMailboxTable.layer, mode: 'nudge' })
				yield* driver.postGitHubMention(mention('stale-first', 32, 'one run'))
				yield* driver.advance(5_000)
				const [start] = yield* driver.agentStarts
				yield* driver.completeDelivery(start!.deliveryId)
				yield* driver.advance(5_000)
				const before = yield* driver.output
				expect(before.comments).toEqual([echoReply(`${botMention} one run`)])

				/** Stale nudges: one for the finished mailbox, one for a mailbox that never existed. */
				yield* driver.nudge(start!.mailboxKey)
				yield* driver.nudge('no-such-mailbox')
				yield* driver.advance(5_000)
				expect(yield* driver.agentStarts).toHaveLength(1)
				expect(yield* driver.output).toEqual(before)
			}),
		),
	)

	it.effect('the sweep nudges every mailbox in table.due(now) and none other', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(10_000)
			const table = yield* MemoryMailboxTable.make
			yield* table.write({ state: mailboxDueAt('due-long-ago', 0), expectedVersion: null })
			yield* table.write({ state: mailboxDueAt('due-just-now', 10_000), expectedVersion: null })
			yield* table.write({ state: mailboxDueAt('due-later', 10_001), expectedVersion: null })
			yield* table.write({ state: mailboxDueAt('idle', null), expectedVersion: null })
			const queue = makeFakeQueue()

			const count = yield* sweep(10_000).pipe(
				Effect.provide(Layer.merge(Layer.succeed(MailboxTable, table), queue.nudger)),
			)

			expect(count).toBe(2)
			const pending = yield* queue.pending
			expect([...pending].sort((a, b) => a.mailboxKey.localeCompare(b.mailboxKey))).toEqual([
				{ mailboxKey: 'due-just-now', deliverAt: 10_000 },
				{ mailboxKey: 'due-long-ago', deliverAt: 10_000 },
			])
		}),
	)
})
