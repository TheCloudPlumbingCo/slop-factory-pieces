/**
 * In-memory `MailboxTable`, for tests and local development. Everything is lost when the process stops.
 * It must pass the same contract as the DynamoDB table.
 */
import { Effect, Layer, Option, Ref } from 'effect'

import type { MailboxState } from './MailboxState'
import { MailboxTable } from './MailboxTable'

type Store = {
	readonly mailboxes: ReadonlyMap<string, { readonly state: MailboxState; readonly version: number }>
	readonly eventKeys: ReadonlySet<string>
	readonly subscriptions: ReadonlySet<string>
}

const make: Effect.Effect<MailboxTable['Service']> = Effect.gen(function* () {
	const store = yield* Ref.make<Store>({ mailboxes: new Map(), eventKeys: new Set(), subscriptions: new Set() })

	return MailboxTable.of({
		read: (mailboxKey) =>
			Ref.get(store).pipe(Effect.map((current) => Option.fromNullishOr(current.mailboxes.get(mailboxKey)))),
		write: ({ state, expectedVersion, newEventKey }) =>
			Ref.modify(store, (current): readonly ['written' | 'conflict' | 'duplicate', Store] => {
				if (newEventKey !== undefined && current.eventKeys.has(newEventKey)) return ['duplicate', current]
				const stored = current.mailboxes.get(state.mailboxKey)
				if ((stored?.version ?? null) !== expectedVersion) return ['conflict', current]
				return [
					'written',
					{
						...current,
						mailboxes: new Map([...current.mailboxes, [state.mailboxKey, { state, version: (stored?.version ?? 0) + 1 }]]),
						eventKeys: newEventKey === undefined ? current.eventKeys : new Set([...current.eventKeys, newEventKey]),
					},
				]
			}),
		due: (now) =>
			Ref.get(store).pipe(
				Effect.map((current) =>
					[...current.mailboxes.values()]
						.filter(({ state }) => state.deliveries.readyAt !== null && state.deliveries.readyAt <= now)
						.map(({ state }) => state.mailboxKey),
				),
			),
		subscribe: (mailboxKey) =>
			Ref.update(store, (current) => ({ ...current, subscriptions: new Set([...current.subscriptions, mailboxKey]) })),
		isSubscribed: (mailboxKey) => Ref.get(store).pipe(Effect.map((current) => current.subscriptions.has(mailboxKey))),
		unsubscribe: (mailboxKey) =>
			Ref.update(store, (current) => ({
				...current,
				subscriptions: new Set([...current.subscriptions].filter((key) => key !== mailboxKey)),
			})),
	})
})

/** `make` builds a fresh empty table per call; `layer` provides one as the `MailboxTable` service. */
export const MemoryMailboxTable = {
	make,
	layer: Layer.effect(MailboxTable, make),
}
