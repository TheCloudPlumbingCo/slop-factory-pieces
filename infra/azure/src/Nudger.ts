import { Context, type Effect } from 'effect'

/**
 * Wakes processing for one mailbox later, such as by sending a delayed queue message.
 *
 * `nudge` never fails: an implementation logs its own failures. A lost nudge is recovered by the
 * periodic sweep of mailboxes whose `readyAt` has passed.
 */
export class Nudger extends Context.Service<
	Nudger,
	{
		readonly nudge: (mailboxKey: string, delayMs: number) => Effect.Effect<void>
	}
>()('slop-code-factory-azure/Nudger') {}

/**
 * The longest delay one nudge can carry (15 minutes, kept from the AWS nudger; Service Bus has no such limit). A mailbox due later is nudged at this cap; that
 * nudge arrives before `readyAt` and finds nothing due, and the once-a-minute sweep wakes the mailbox after `readyAt`
 * has passed (at most about a minute late). The engine's longest wait today is the 10-minute hand-off timeout, so this
 * does not arise in practice.
 */
export const MAX_NUDGE_DELAY_MS = 900_000

/** How long to wait before nudging a mailbox due at `readyAt`: never negative, never over `MAX_NUDGE_DELAY_MS`. */
export const nudgeDelay = (readyAt: number, now: number): number =>
	Math.min(Math.max(0, readyAt - now), MAX_NUDGE_DELAY_MS)
