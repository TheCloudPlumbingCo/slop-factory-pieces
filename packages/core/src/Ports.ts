/**
 * The services the bot's logic needs from the cloud it runs on. Each cloud fills them with a layer of its own
 * (Cloudflare: `AgentSessionsCloudflare` and `DeliveryApiCloudflare`); nothing here names a cloud.
 */
import type { DeliveryClient } from '@humanlayer/channels-delivery'
import { Context, type Effect } from 'effect'

import type { AgentSessionMessage } from './AgentSessionMessage'

/**
 * The agent sessions, addressed by the channel's unique identifier. `send` starts the agent in the
 * background and returns once the message is accepted; the agent finishes the delivery.
 */
export class AgentSessions extends Context.Service<
	AgentSessions,
	{
		readonly getByName: (mailboxKey: string) => {
			readonly send: (input: typeof AgentSessionMessage.Encoded) => Effect.Effect<void>
		}
	}
>()('slop-code-factory/AgentSessions') {}

/** How an agent reports on the deliveries handed to it: the delivery API's client. */
export class DeliveryApi extends Context.Service<DeliveryApi, DeliveryClient>()('slop-code-factory/DeliveryApi') {}
