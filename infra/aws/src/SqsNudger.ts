import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { Effect, Layer } from 'effect'

import { Nudger } from './Nudger'

/** The one SQS call the nudger makes; `SQSClient` satisfies it, and tests pass a fake. */
export interface SqsMessageSender {
	readonly send: (command: SendMessageCommand) => Promise<unknown>
}

/** The longest delay SQS accepts on one message, in seconds. */
const MAX_DELAY_SECONDS = 900

/** SQS timers count whole seconds, so a delay is rounded up: a nudge never arrives before its mailbox is due. */
const delaySeconds = (delayMs: number) => Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.ceil(delayMs / 1000)))

/**
 * A `Nudger` that sends `{ mailboxKey }` to the nudge queue with the delay rounded up to whole seconds. A failed
 * send is logged and swallowed; the sweep recovers the lost nudge.
 *
 * @param queueUrl - the nudge queue the Processor reads
 * @param client - the SQS client; a default `SQSClient` (region and credentials from the Lambda environment)
 */
export const SqsNudgerLive = (queueUrl: string, client?: SqsMessageSender): Layer.Layer<Nudger> =>
	Layer.sync(Nudger, () => {
		const sqs: SqsMessageSender = client ?? new SQSClient({})
		return Nudger.of({
			nudge: Effect.fn('aws.sqs_nudger.nudge')(function* (mailboxKey: string, delayMs: number) {
				yield* Effect.tryPromise(() =>
					sqs.send(
						new SendMessageCommand({
							QueueUrl: queueUrl,
							MessageBody: JSON.stringify({ mailboxKey }),
							DelaySeconds: delaySeconds(delayMs),
						}),
					),
				).pipe(
					Effect.catch((error) => Effect.logWarning('AWS nudge send failed', error)),
					Effect.catchDefect((defect) => Effect.logWarning('AWS nudge send failed', defect)),
					Effect.annotateLogs({ mailboxKey, delayMs }),
				)
			}),
		})
	})
