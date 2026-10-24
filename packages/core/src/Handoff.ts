/**
 * The hand-off: what a decided mention becomes on a cloud. The request is sent to the discussion's
 * AgentSession with the delivery to finish, then the SDK delivery is handed off so the agent can complete it.
 */
import type { DeliveryContext, DeliveryHandoff, DeliveryHandoffError } from '@humanlayer/channels-delivery'
import { Effect, Schema } from 'effect'

import { AgentSessionMessage, type MentionRequest } from './AgentSessionMessage'
import { AgentSessions } from './Ports'

/** Fail a lost agent's delivery soon, so it cannot hold back the discussion's mailbox for the default day. */
const HANDOFF_FAIL_AFTER = '10 minutes'

export const handOff = (
	request: MentionRequest,
	context: DeliveryContext,
): Effect.Effect<DeliveryHandoff, DeliveryHandoffError, AgentSessions> =>
	Effect.gen(function* () {
		const message = yield* Schema.encodeEffect(AgentSessionMessage)(
			AgentSessionMessage.make({
				prompt: request.prompt,
				discussion: request.discussion,
				deliveryId: context.deliveryId,
				accessToken: context.accessToken,
			}),
		).pipe(Effect.orDie)
		const agentSessions = yield* AgentSessions
		yield* agentSessions.getByName(request.discussion.mailboxKey).send(message)
		return yield* context.handoff({ failAfter: HANDOFF_FAIL_AFTER })
	})
