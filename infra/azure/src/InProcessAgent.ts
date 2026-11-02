import { Effect, FiberSet, Layer, Schema, Scope } from 'effect'

import { AgentSessionMessage, AgentSessions, answer, DeliveryApi } from '@slop/core'

/**
 * The echo agent running inside the Processor's own process. `send` forks `answer(message)` into a fiber set owned
 * by this object and returns at once; `drain` waits until every forked answer has finished, including answers
 * started while it waits. A Function instance may be frozen once it returns, so the Processor must `drain` before returning.
 *
 * Like the Durable Object, `send` dies on a message that does not decode or whose discussion mailbox key is not the
 * one addressed. A defect inside a forked answer is logged, never rethrown through `drain`.
 */
export const makeInProcessAgentSessions = Effect.gen(function* () {
	const scope = yield* Scope.make()
	const fibers = yield* FiberSet.make<void, never>().pipe(Scope.provide(scope))

	const layer = Layer.effect(
		AgentSessions,
		Effect.gen(function* () {
			const api = yield* DeliveryApi
			return AgentSessions.of({
				getByName: (mailboxKey) => ({
					send: Effect.fn('in_process_agent.send')(function* (input: typeof AgentSessionMessage.Encoded) {
						const message = yield* Schema.decodeEffect(AgentSessionMessage)(input).pipe(Effect.orDie)
						if (message.discussion.mailboxKey !== mailboxKey) {
							return yield* Effect.die(new Error('AgentSession message does not match this mailbox key'))
						}
						yield* FiberSet.run(
							fibers,
							answer(message).pipe(
								Effect.provideService(DeliveryApi, api),
								Effect.catchCause((cause) => Effect.logError('in_process_agent: the echo agent failed', cause)),
							),
						)
					}),
				}),
			})
		}),
	)

	return { layer, drain: FiberSet.awaitEmpty(fibers) }
})
