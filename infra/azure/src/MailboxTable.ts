import { Context, type Effect, type Option, Schema } from 'effect'

import type { MailboxState } from './MailboxState'

/** The table could not be reached or answered with an error. */
export class TableUnavailable extends Schema.TaggedError<TableUnavailable>()('TableUnavailable', {
	reason: Schema.String,
}) {}

/** 'conflict': the stored version was not the expected one. 'duplicate': the event key was already seen (wins over 'conflict'). */
export type WriteOutcome = 'written' | 'conflict' | 'duplicate'

/**
 * Where mailbox state lives: one item per mailbox, versioned, with a dedup marker per provider event
 * and a subscription marker per mailbox.
 */
export class MailboxTable extends Context.Service<
	MailboxTable,
	{
		readonly read: (
			mailboxKey: string,
		) => Effect.Effect<Option.Option<{ readonly state: MailboxState; readonly version: number }>, TableUnavailable>
		/**
		 * Store `state` if the stored version is `expectedVersion` (`null`: the mailbox must not exist yet).
		 * With `newEventKey`, the dedup marker and the state are stored atomically; a marker that already
		 * exists returns `'duplicate'` and stores nothing.
		 */
		readonly write: (input: {
			readonly state: MailboxState
			readonly expectedVersion: number | null
			readonly newEventKey?: string
		}) => Effect.Effect<WriteOutcome, TableUnavailable>
		/** Mailbox keys whose `deliveries.readyAt` is at or before `now`. */
		readonly due: (now: number) => Effect.Effect<ReadonlyArray<string>, TableUnavailable>
		readonly subscribe: (mailboxKey: string) => Effect.Effect<void, TableUnavailable>
		readonly isSubscribed: (mailboxKey: string) => Effect.Effect<boolean, TableUnavailable>
		readonly unsubscribe: (mailboxKey: string) => Effect.Effect<void, TableUnavailable>
	}
>()('slop-code-factory-azure/MailboxTable') {}
