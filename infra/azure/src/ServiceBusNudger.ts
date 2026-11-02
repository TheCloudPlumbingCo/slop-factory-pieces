import { Clock, Effect, Layer } from 'effect'

import { Nudger } from './Nudger'

/** The two Service Bus sender calls the nudger makes; `ServiceBusSender` satisfies it, and tests pass a fake. */
export interface NudgeSender {
	readonly sendMessages: (message: { readonly body: string; readonly contentType: string }) => Promise<unknown>
	readonly scheduleMessages: (
		message: { readonly body: string; readonly contentType: string },
		scheduledEnqueueTimeUtc: Date,
	) => Promise<unknown>
}

/**
 * A `Nudger` that sends `{ mailboxKey }` to the nudge queue: at once for a zero delay, otherwise as a scheduled
 * message that appears in the queue after the delay. A failed send is logged and swallowed; the sweep recovers the
 * lost nudge.
 *
 * @param sender - a Service Bus sender for the nudge queue
 */
export const ServiceBusNudgerLive = (sender: NudgeSender): Layer.Layer<Nudger> =>
	Layer.succeed(
		Nudger,
		Nudger.of({
			nudge: Effect.fn('azure.service_bus_nudger.nudge')(function* (mailboxKey: string, delayMs: number) {
				const message = { body: JSON.stringify({ mailboxKey }), contentType: 'application/json' }
				const now = yield* Clock.currentTimeMillis
				yield* Effect.tryPromise(() =>
					delayMs <= 0
						? sender.sendMessages(message)
						: sender.scheduleMessages(message, new Date(now + Math.ceil(delayMs))),
				).pipe(
					Effect.catch((error) => Effect.logWarning('Azure nudge send failed', error)),
					Effect.catchDefect((defect) => Effect.logWarning('Azure nudge send failed', defect)),
					Effect.annotateLogs({ mailboxKey, delayMs }),
				)
			}),
		}),
	)
