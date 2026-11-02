import { DeliveryAdmission, DeliverySlot, emptyDeliverySlot, MailboxSequence, Timestamp } from '@humanlayer/channels-delivery'
import { Schema } from 'effect'

/** One event waiting in the mailbox for a later batch. */
export const WaitingAdmission = Schema.Struct({
	sequence: MailboxSequence,
	arrivedAt: Timestamp,
	admission: DeliveryAdmission,
})

/**
 * The one mailbox a store item holds.
 *
 * @property waiting - events not yet claimed, oldest first
 * @property deliveries - the active delivery and recently finished ones. Its `readyAt` is when
 * processing should next look at this mailbox.
 */
export const MailboxState = Schema.Struct({
	mailboxKey: Schema.NonEmptyString,
	provider: Schema.NonEmptyString,
	nextSequence: MailboxSequence,
	waiting: Schema.Array(WaitingAdmission),
	deliveries: DeliverySlot,
})
export type MailboxState = typeof MailboxState.Type

/** A mailbox with no waiting events and an empty delivery slot. */
export const emptyMailboxState = (mailbox: { readonly mailboxKey: string; readonly provider: string }): MailboxState =>
	MailboxState.make({
		mailboxKey: mailbox.mailboxKey,
		provider: mailbox.provider,
		nextSequence: 0,
		waiting: [],
		deliveries: emptyDeliverySlot,
	})
