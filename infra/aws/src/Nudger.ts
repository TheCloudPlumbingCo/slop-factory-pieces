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
>()('slop-code-factory-aws/Nudger') {}

/** The longest delay one nudge can carry (the SQS limit, 15 minutes). Longer waits nudge again on arrival. */
export const MAX_NUDGE_DELAY_MS = 900_000

/** How long to wait before nudging a mailbox due at `readyAt`: never negative, never over `MAX_NUDGE_DELAY_MS`. */
export const nudgeDelay = (readyAt: number, now: number): number =>
	Math.min(Math.max(0, readyAt - now), MAX_NUDGE_DELAY_MS)
