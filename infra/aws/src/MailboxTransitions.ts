/**
 * Pure changes to one stored mailbox, ported from the Cloudflare adapter's `MailboxProcessingBackend`
 * and `MailboxDelivery`. The lifecycle rules themselves are the library's `DeliveryLifecycle` functions;
 * these only pick which rule to call and what the store returns.
 */
import {
	activeDeliveryWork,
	type ClaimDeliveryOutput,
	type ClaimedDeliveryOutput,
	type ClaimedMailboxBatch,
	claimDeliveryOutput,
	claimFrozenBatch,
	type ClaimMailbox,
	type DeferMailbox,
	type DeliveryAdmission,
	DeliveryAdmissionBatch,
	OutputReadyMailbox,
	type ReadyMailbox,
	RecoverableMailbox,
	requestDeliveryInterrupt,
	startDeliveryBatch,
	Timestamp,
	toClaimedDeliveryOutput,
	toClaimedMailboxBatch,
	WaitingMailbox,
} from '@humanlayer/channels-delivery'
import { Array as Arr, Match, Option } from 'effect'

import { MailboxState } from './MailboxState'

/** What one change returns to its caller, and the mailbox to store (none: store nothing). */
export type MailboxStep<A> = { readonly result: A; readonly next: Option.Option<MailboxState> }

/** A change that stores nothing. */
export const unchanged = <A>(result: A): MailboxStep<A> => ({ result, next: Option.none() })

const toBatch = (entries: MailboxState['waiting']) => {
	const [first, ...rest] = entries.map(({ admission }) => admission)
	return first === undefined ? null : DeliveryAdmissionBatch.make([first, ...rest])
}

const isDue = (current: MailboxState, now: number) =>
	current.deliveries.readyAt !== null && current.deliveries.readyAt <= now

/** The mailbox as `findReadyMailboxes` reports it: nothing when it is not due or has nothing to do. */
export const describeReadyMailbox = (current: MailboxState, now: number): ReadonlyArray<ReadyMailbox> => {
	if (!isDue(current, now)) return []
	if (current.deliveries.active !== null) {
		return activeDeliveryWork(current.deliveries.active) === 'Output'
			? [OutputReadyMailbox.make({ mailboxKey: current.mailboxKey })]
			: [RecoverableMailbox.make({ mailboxKey: current.mailboxKey })]
	}
	const first = current.waiting[0]
	const last = current.waiting.at(-1)
	if (first === undefined || last === undefined) return []
	return [
		WaitingMailbox.make({
			mailboxKey: current.mailboxKey,
			provider: current.provider,
			waiting: {
				count: current.waiting.length,
				firstSequence: first.sequence,
				firstArrivedAt: first.arrivedAt,
				lastSequence: last.sequence,
				lastArrivedAt: last.arrivedAt,
			},
		}),
	]
}

/**
 * Append one admitted event. An interrupting event marks the active delivery in the same write. A
 * mailbox with an active delivery is woken by that delivery ending, not by new events.
 */
export const admitTransition = (current: MailboxState, admission: DeliveryAdmission, now: number): MailboxState => {
	const deliveries = admission.interrupt === true ? requestDeliveryInterrupt(current.deliveries, now) : current.deliveries
	return MailboxState.make({
		...current,
		nextSequence: current.nextSequence + 1,
		waiting: [...current.waiting, { sequence: current.nextSequence, arrivedAt: Timestamp.make(now), admission }],
		deliveries: deliveries.active === null ? { ...deliveries, readyAt: Timestamp.make(now) } : deliveries,
	})
}

/** Freeze a new batch from the waiting events, or take over the frozen batch. None when the mailbox is not due. */
export const claimTransition = (input: {
	readonly current: MailboxState
	readonly claim: ClaimMailbox
	readonly claimId: string
	readonly now: number
}): MailboxStep<Option.Option<ClaimedMailboxBatch>> => {
	const { current, claim, claimId, now } = input
	if (current.mailboxKey !== claim.mailboxKey || !isDue(current, now)) return unchanged(Option.none())
	return Match.value(claim).pipe(
		Match.tagsExhaustive({
			ClaimWaitingEvents: ({ upToSequence, batchId, accessToken, leaseMs }) => {
				const admissions = toBatch(current.waiting.filter(({ sequence }) => sequence <= upToSequence))
				if (admissions === null) return unchanged(Option.none())
				const started = startDeliveryBatch(current.deliveries, { batchId, accessToken, admissions, claimId, leaseMs, now })
				if (started === null) return unchanged(Option.none())
				return {
					result: Option.some(toClaimedMailboxBatch({ mailboxKey: current.mailboxKey, active: started.claimed, claimId })),
					next: Option.some(
						MailboxState.make({
							...current,
							waiting: current.waiting.filter(({ sequence }) => sequence > upToSequence),
							deliveries: started.slot,
						}),
					),
				}
			},
			ClaimFrozenBatch: ({ leaseMs }): MailboxStep<Option.Option<ClaimedMailboxBatch>> => {
				const { slot, claimed } = claimFrozenBatch(current.deliveries, {
					claimId,
					leaseMs,
					now,
					hasWaiting: Arr.isReadonlyArrayNonEmpty(current.waiting),
				})
				return {
					result:
						claimed === null
							? Option.none()
							: Option.some(toClaimedMailboxBatch({ mailboxKey: current.mailboxKey, active: claimed, claimId })),
					next: Option.some(MailboxState.make({ ...current, deliveries: slot })),
				}
			},
		}),
	)
}

/** Take the next due output operation under a new lease. None when nothing is due. */
export const claimOutputTransition = (input: {
	readonly current: MailboxState
	readonly claim: ClaimDeliveryOutput
	readonly claimId: string
	readonly now: number
}): MailboxStep<Option.Option<ClaimedDeliveryOutput>> => {
	const { current, claim, claimId, now } = input
	if (current.mailboxKey !== claim.mailboxKey) return unchanged(Option.none())
	const { slot, claimed } = claimDeliveryOutput(current.deliveries, {
		claimId,
		leaseMs: claim.leaseMs,
		now,
		idempotencyKey: claim.idempotencyKey,
	})
	if (claimed === null) return unchanged(Option.none())
	return {
		result: Option.some(toClaimedDeliveryOutput({ mailboxKey: current.mailboxKey, claimId, ...claimed })),
		next: Option.some(MailboxState.make({ ...current, deliveries: slot })),
	}
}

/** Put an idle mailbox off until `until`, unless a newer event arrived since the caller looked. */
export const deferTransition = (current: MailboxState, input: DeferMailbox): MailboxStep<void> => {
	const seenLatest = current.waiting.at(-1)?.sequence === input.lastSequenceSeen
	if (current.mailboxKey !== input.mailboxKey || current.deliveries.active !== null || !seenLatest) {
		return unchanged(undefined)
	}
	return {
		result: undefined,
		next: Option.some(MailboxState.make({ ...current, deliveries: { ...current.deliveries, readyAt: input.until } })),
	}
}
