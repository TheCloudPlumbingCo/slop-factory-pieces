/**
 * The `ChannelsStorage` over a `MailboxTable`: the SDK mailbox engine's store on AWS.
 *
 * Every change reads the mailbox, applies the library's lifecycle rule (see `MailboxTransitions` and
 * `DeliveryLifecycle`), and writes it back only if nobody wrote it in between. A lost race re-reads and
 * re-applies, a bounded number of times. This stands in for the serial execution a Durable Object
 * gives the Cloudflare adapter for free. After each stored write that leaves the mailbox due at some
 * time, the `Nudger` is asked to wake processing then.
 */
import {
	applyDeliverySlotMutation,
	type ChannelsStorage,
	DEFAULT_RETRY_AFTER_MS,
	DeliveryControlBackend,
	DeliveryControlUnavailable,
	DeliveryNotFound,
	DeliveryPreparationConflict,
	DeliveryReceipt,
	type DeliverySlot,
	deliveryMailboxKey,
	handOffDeliverySlot,
	MailboxDelivery,
	MailboxDeliveryUnavailable,
	MailboxProcessingBackend,
	MailboxProcessingClaimLost,
	MailboxProcessingUnavailable,
	MailboxSubscriptionAlreadyExistsResult,
	MailboxSubscriptionCreatedResult,
	MailboxSubscriptionError,
	type MailboxSubscriptionOperation,
	MailboxSubscriptions,
	makeDeliveryId,
	prepareDeliverySlot,
	readDeliverySlotStatus,
	recordDeliveryAttempt,
	renewDeliveryClaim,
	renewDeliveryOutput,
	settleDeliveryOutput,
} from '@humanlayer/channels-delivery'
import { Array as Arr, Clock, Context, Effect, Layer, Match, Option, Random } from 'effect'

import { emptyMailboxState, MailboxState } from './MailboxState'
import { MailboxTable, type TableUnavailable } from './MailboxTable'
import {
	admitTransition,
	claimOutputTransition,
	claimTransition,
	deferTransition,
	describeReadyMailbox,
	type MailboxStep,
} from './MailboxTransitions'
import { Nudger, nudgeDelay } from './Nudger'

/** How many times one change is tried against a mailbox other writers keep changing. */
export const MAX_WRITE_ATTEMPTS = 5

const REASON = 'dynamodb_unavailable'

const processingUnavailable = () => new MailboxProcessingUnavailable({ reason: REASON })
const deliveryUnavailable = () => new MailboxDeliveryUnavailable({ reason: REASON })
const controlUnavailable = () => new DeliveryControlUnavailable({ reason: REASON })
const subscriptionUnavailable = (operation: MailboxSubscriptionOperation) => () =>
	new MailboxSubscriptionError({ operation, reason: REASON })

const claimLost = (claim: { readonly mailboxKey: string; readonly claimId: string }) =>
	new MailboxProcessingClaimLost({ mailboxKey: claim.mailboxKey, claimId: claim.claimId })

const makeClaimId = Effect.gen(function* () {
	const now = yield* Clock.currentTimeMillis
	return `${now}-${Math.abs(yield* Random.nextInt)}`
})

/** Log a table failure, typed or a defect, then narrow it to the calling service's own error. */
const fromTable =
	<U>(message: string, unavailable: () => U) =>
	<A>(effect: Effect.Effect<A, TableUnavailable>): Effect.Effect<A, U> =>
		effect.pipe(
			Effect.catchTag('TableUnavailable', (error) =>
				Effect.logError(message, error).pipe(Effect.andThen(Effect.fail(unavailable()))),
			),
			Effect.catchDefect((defect) => Effect.logError(message, defect).pipe(Effect.andThen(Effect.fail(unavailable())))),
		)

/** A lifecycle change to the deliveries alone, as the library's rule functions return it. */
type DeliveriesChange<A, E> = (current: MailboxState) => Effect.Effect<{ readonly slot: DeliverySlot; readonly value: A }, E>

const makeServices = (scope: string | undefined) =>
	Effect.gen(function* () {
		const table = yield* MailboxTable
		const nudger = yield* Nudger

		/** After a stored write: wake processing when the mailbox is next due. A failing nudger only logs. */
		const nudgeAfterWrite = (state: MailboxState) =>
			Effect.gen(function* () {
				const { readyAt } = state.deliveries
				if (readyAt === null) return
				const now = yield* Clock.currentTimeMillis
				yield* nudger
					.nudge(state.mailboxKey, nudgeDelay(readyAt, now))
					.pipe(Effect.catchDefect((defect) => Effect.logWarning('AWS mailbox nudge failed', defect)))
			})

		/**
		 * Apply `transition` to the stored mailbox and store its result with a conditional write. On a
		 * conflict the mailbox is re-read and the transition re-applied, up to `MAX_WRITE_ATTEMPTS` times.
		 * A missing mailbox runs `onMissing`, or starts from `create`. With `newEventKey`, a write that
		 * finds the key already seen stores nothing and returns `onDuplicate`.
		 */
		const transactMailbox = <A, E, U>(input: {
			readonly mailboxKey: string
			readonly message: string
			readonly unavailable: () => U
			readonly onMissing: (() => Effect.Effect<A, E>) | { readonly create: MailboxState }
			readonly transition: (current: MailboxState) => Effect.Effect<MailboxStep<A>, E>
			readonly newEventKey?: string
			readonly onDuplicate?: () => A
		}): Effect.Effect<A, E | U> => {
			const narrow = fromTable(input.message, input.unavailable)
			/** One try: some(result) when finished, none when another writer won and the change must be redone. */
			const attempt: Effect.Effect<Option.Option<A>, E | U> = Effect.gen(function* () {
				const stored = yield* narrow(table.read(input.mailboxKey))
				if (Option.isNone(stored) && typeof input.onMissing === 'function') {
					return Option.some(yield* input.onMissing())
				}
				const current = Option.isSome(stored)
					? stored.value.state
					: (input.onMissing as { readonly create: MailboxState }).create
				const expectedVersion = Option.isSome(stored) ? stored.value.version : null
				const { result, next } = yield* input.transition(current)
				if (Option.isNone(next)) return Option.some(result)
				const outcome = yield* narrow(
					table.write({
						state: next.value,
						expectedVersion,
						...(input.newEventKey === undefined ? {} : { newEventKey: input.newEventKey }),
					}),
				)
				if (outcome === 'duplicate' && input.onDuplicate !== undefined) return Option.some(input.onDuplicate())
				if (outcome !== 'written') return Option.none()
				yield* nudgeAfterWrite(next.value)
				return Option.some(result)
			})
			const loop = (tries: number): Effect.Effect<A, E | U> =>
				attempt.pipe(
					Effect.flatMap(
						Option.match({
							onSome: (result) => Effect.succeed(result),
							onNone: () =>
								tries < MAX_WRITE_ATTEMPTS
									? loop(tries + 1)
									: Effect.logError(input.message, `write conflicted ${MAX_WRITE_ATTEMPTS} times`).pipe(
											Effect.annotateLogs({ mailboxKey: input.mailboxKey }),
											Effect.andThen(Effect.fail(input.unavailable())),
										),
						}),
					),
				)
			return loop(1)
		}

		/** A change to a claimed batch's deliveries. A missing mailbox is a lost claim, as is a refused claim. */
		const changeClaimedDeliveries = <A, E>(
			message: string,
			claim: { readonly mailboxKey: string; readonly claimId: string },
			change: DeliveriesChange<A, E>,
		) =>
			transactMailbox<A, E | MailboxProcessingClaimLost, MailboxProcessingUnavailable>({
				mailboxKey: claim.mailboxKey,
				message,
				unavailable: processingUnavailable,
				onMissing: () => Effect.fail(claimLost(claim)),
				transition: (current) =>
					change(current).pipe(
						Effect.map(({ slot, value }) => ({
							result: value,
							next: Option.some(MailboxState.make({ ...current, deliveries: slot })),
						})),
					),
			})

		const delivery = MailboxDelivery.of({
			deliver: Effect.fn('delivery.aws.deliver')(function* (admission) {
				const now = yield* Clock.currentTimeMillis
				const mailboxKey = deliveryMailboxKey(admission)
				const accepted = yield* transactMailbox({
					mailboxKey,
					message: 'AWS mailbox admission failed',
					unavailable: deliveryUnavailable,
					onMissing: { create: emptyMailboxState({ mailboxKey, provider: admission.provider }) },
					transition: (current) =>
						Effect.succeed({ result: true, next: Option.some(admitTransition(current, admission, now)) }),
					newEventKey: `${admission.namespace}|${admission.provider}|${admission.eventId}`,
					onDuplicate: () => false,
				})
				return DeliveryReceipt.make({ mailboxKey, accepted })
			}),
		})

		const processing = MailboxProcessingBackend.of({
			findReadyMailboxes: Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const narrow = fromTable('AWS mailbox look failed', processingUnavailable)
				/** A scoped store sees only its own mailbox, as a Durable Object does. */
				const keys = scope === undefined ? yield* narrow(table.due(now)) : [scope]
				const found = yield* Effect.forEach(keys, (key) => narrow(table.read(key)), { concurrency: 10 })
				return found.flatMap((stored) => (Option.isSome(stored) ? describeReadyMailbox(stored.value.state, now) : []))
			}).pipe(Effect.withSpan('delivery.aws.find_ready_mailboxes')),
			claimMailbox: Effect.fn('delivery.aws.claim_mailbox')(function* (claim) {
				const now = yield* Clock.currentTimeMillis
				const claimId = yield* makeClaimId
				return yield* transactMailbox({
					mailboxKey: claim.mailboxKey,
					message: 'AWS mailbox claim failed',
					unavailable: processingUnavailable,
					onMissing: () => Effect.succeedNone,
					transition: (current) => Effect.succeed(claimTransition({ current, claim, claimId, now })),
				})
			}),
			deferMailbox: Effect.fn('delivery.aws.defer_mailbox')(function* (input) {
				yield* transactMailbox({
					mailboxKey: input.mailboxKey,
					message: 'AWS mailbox deferral failed',
					unavailable: processingUnavailable,
					onMissing: () => Effect.void,
					transition: (current) => Effect.succeed(deferTransition(current, input)),
				})
			}),
			renewClaim: Effect.fn('delivery.aws.renew_claim')(function* (renewal) {
				const now = yield* Clock.currentTimeMillis
				yield* changeClaimedDeliveries('AWS mailbox claim renewal failed', renewal, (current) =>
					renewDeliveryClaim(current.deliveries, { ...renewal, now }).pipe(
						Effect.map((slot) => ({ slot, value: undefined })),
						Effect.catchTag('ClaimNotOwned', () => Effect.fail(claimLost(renewal))),
					),
				)
			}),
			recordProcessingAttemptResult: Effect.fn('delivery.aws.record_processing_attempt_result')(function* (input) {
				const retryAfterMs = Match.value(input.result).pipe(
					Match.tag('RetryableFailure', ({ retryAfterMs }) => retryAfterMs ?? DEFAULT_RETRY_AFTER_MS),
					Match.orElse(() => null),
				)
				yield* changeClaimedDeliveries('AWS mailbox result recording failed', input.claim, (current) =>
					recordDeliveryAttempt(current.deliveries, {
						claimId: input.claim.claimId,
						retryAfterMs,
						now: input.finishedAt,
						hasWaiting: Arr.isReadonlyArrayNonEmpty(current.waiting),
					}).pipe(
						Effect.map((slot) => ({ slot, value: undefined })),
						Effect.catchTag('ClaimNotOwned', () => Effect.fail(claimLost(input.claim))),
					),
				)
			}),
			prepareDelivery: Effect.fn('delivery.aws.prepare_delivery')(function* (input) {
				return yield* changeClaimedDeliveries('AWS mailbox delivery preparation failed', input, (current) =>
					prepareDeliverySlot(current.deliveries, input).pipe(
						Effect.map(({ slot, prepared }) => ({ slot, value: prepared })),
						Effect.catchTags({
							ClaimNotOwned: () => Effect.fail(claimLost(input)),
							PreparationMismatch: ({ batchId }) =>
								Effect.fail(
									new DeliveryPreparationConflict({
										deliveryId: makeDeliveryId({ mailboxKey: input.mailboxKey, batchId }),
									}),
								),
						}),
					),
				)
			}),
			handOffDelivery: Effect.fn('delivery.aws.hand_off_delivery')(function* (input) {
				yield* changeClaimedDeliveries('AWS mailbox handoff failed', input, (current) =>
					handOffDeliverySlot(current.deliveries, input).pipe(
						Effect.map((slot) => ({ slot, value: undefined })),
						Effect.catchTag('ClaimNotOwned', () => Effect.fail(claimLost(input))),
					),
				)
			}),
			claimDeliveryOutput: Effect.fn('delivery.aws.claim_delivery_output')(function* (claim) {
				const now = yield* Clock.currentTimeMillis
				const claimId = yield* makeClaimId
				return yield* transactMailbox({
					mailboxKey: claim.mailboxKey,
					message: 'AWS delivery output claim failed',
					unavailable: processingUnavailable,
					onMissing: () => Effect.succeedNone,
					transition: (current) => Effect.succeed(claimOutputTransition({ current, claim, claimId, now })),
				})
			}),
			renewDeliveryOutput: Effect.fn('delivery.aws.renew_delivery_output')(function* (renewal) {
				const now = yield* Clock.currentTimeMillis
				yield* changeClaimedDeliveries('AWS delivery output renewal failed', renewal, (current) =>
					renewDeliveryOutput(current.deliveries, { ...renewal, now }).pipe(
						Effect.map((slot) => ({ slot, value: undefined })),
						Effect.catchTag('ClaimNotOwned', () => Effect.fail(claimLost(renewal))),
					),
				)
			}),
			settleDeliveryOutput: Effect.fn('delivery.aws.settle_delivery_output')(function* (input) {
				yield* changeClaimedDeliveries('AWS delivery output settlement failed', input, (current) =>
					settleDeliveryOutput(current.deliveries, {
						...input,
						now: input.settledAt,
						hasWaiting: Arr.isReadonlyArrayNonEmpty(current.waiting),
					}).pipe(
						Effect.map((slot) => ({ slot, value: undefined })),
						Effect.catchTag('ClaimNotOwned', () => Effect.fail(claimLost(input))),
					),
				)
			}),
		})

		const subscriptionCall = (operation: MailboxSubscriptionOperation) =>
			fromTable('AWS mailbox subscription operation failed', subscriptionUnavailable(operation))

		const subscriptions = MailboxSubscriptions.of({
			/** Check, then mark. Two racing subscribes may both report `Created`; the marker is stored once either way. */
			subscribe: Effect.fn('delivery.aws.subscriptions.subscribe')(function* ({ mailboxKey }) {
				const call = subscriptionCall('subscribe')
				if (yield* call(table.isSubscribed(mailboxKey))) return MailboxSubscriptionAlreadyExistsResult.make({})
				yield* call(table.subscribe(mailboxKey))
				return MailboxSubscriptionCreatedResult.make({})
			}),
			isSubscribed: ({ mailboxKey }) =>
				subscriptionCall('is_subscribed')(table.isSubscribed(mailboxKey)).pipe(
					Effect.withSpan('delivery.aws.subscriptions.is_subscribed'),
				),
			unsubscribe: ({ mailboxKey }) =>
				subscriptionCall('unsubscribe')(table.unsubscribe(mailboxKey)).pipe(
					Effect.withSpan('delivery.aws.subscriptions.unsubscribe'),
				),
		})

		const control = DeliveryControlBackend.of({
			readDeliveryStatus: Effect.fn('delivery.aws.read_delivery_status')(function* (input) {
				const now = yield* Clock.currentTimeMillis
				const stored = yield* fromTable('AWS delivery status read failed', controlUnavailable)(
					table.read(input.reference.mailboxKey),
				)
				if (Option.isNone(stored)) return yield* new DeliveryNotFound()
				return yield* readDeliverySlotStatus(stored.value.state.deliveries, { ...input, now })
			}),
			applyDeliveryMutation: Effect.fn('delivery.aws.apply_delivery_mutation')(function* (input) {
				const now = yield* Clock.currentTimeMillis
				return yield* transactMailbox({
					mailboxKey: input.reference.mailboxKey,
					message: 'AWS delivery mutation failed',
					unavailable: controlUnavailable,
					onMissing: () => Effect.fail(new DeliveryNotFound()),
					transition: (current) =>
						applyDeliverySlotMutation(current.deliveries, {
							...input,
							now,
							hasWaiting: Arr.isReadonlyArrayNonEmpty(current.waiting),
						}).pipe(
							Effect.map(({ slot, receipt }) => ({
								result: receipt,
								next: Option.some(MailboxState.make({ ...current, deliveries: slot })),
							})),
						),
				})
			}),
		})

		return Context.make(MailboxDelivery, delivery).pipe(
			Context.add(MailboxProcessingBackend, processing),
			Context.add(MailboxSubscriptions, subscriptions),
			Context.add(DeliveryControlBackend, control),
		)
	})

/**
 * The safety net for lost nudges: nudge, with no delay, every mailbox whose `readyAt` is at or before `now`.
 * Run periodically; a nudge for a mailbox with nothing to do finds no work and changes nothing.
 *
 * @returns how many mailboxes were nudged
 */
export const sweep = Effect.fn('delivery.aws.sweep')(function* (now: number) {
	const table = yield* MailboxTable
	const nudger = yield* Nudger
	const keys = yield* table.due(now)
	yield* Effect.forEach(keys, (key) => nudger.nudge(key, 0), { discard: true })
	return keys.length
})

/**
 * The engine's store over `MailboxTable`, waking processing through `Nudger`.
 *
 * @param input.polling - how the engine wakes processing; AWS wakes it with nudges, so `'disabled'`
 * @param input.scope - one mailbox key: `findReadyMailboxes` then looks only at that mailbox, as a
 * Processor invocation for one nudge does. Without it, every mailbox due now is reported.
 */
export const makeDynamoStorage = (input: {
	readonly polling: ChannelsStorage['polling']
	readonly scope?: string
}): ChannelsStorage<never, MailboxTable | Nudger, DeliveryControlBackend> => ({
	polling: input.polling,
	layer: Layer.effectContext(makeServices(input.scope)),
})
