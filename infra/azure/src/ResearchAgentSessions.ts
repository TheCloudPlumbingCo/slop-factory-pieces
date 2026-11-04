import { AgentSessionMessage, AgentSessions, DeliveryApi, readResearchArgs, targetOf } from '@slop/core'
import { Context, Effect, Layer, Redacted, Schema } from 'effect'

import type { RepositoryDispatch } from './GithubDispatch'
import { PENDING_TTL_SECONDS, type PendingResearchStore } from './PendingResearch'

/** The `repository_dispatch` event type the customer's workflow listens for. */
export const RESEARCH_EVENT_TYPE = 'slopcodebot-research'

/**
 * The task in a comment like `@slopcodebot /research why does CI fail?`, or `undefined` when the comment is not a
 * research command. The mention may be any `@name`; an empty task still counts and comes back as `''`.
 */
export const researchTask = (prompt: string): string | undefined => {
	const match = /^\s*@\S+\s+\/research(?:\s+([\s\S]*))?$/.exec(prompt)
	return match === null ? undefined : (match[1] ?? '').trim()
}

/** A repository named `<team>-workspace` holds research and plans; there `/research` must name a workspace folder. */
const isWorkspaceRepository = (repository: string) => repository.endsWith('-workspace')

/** GitHub's own answer from a failed dispatch, short enough for a comment. It holds status and message, never a token. */
const describe = (error: unknown): string => {
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
	const text = cause instanceof Error ? cause.message : String(cause)
	return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

/** What the sessions need from the outside world. */
export interface ResearchSessionsOptions {
	/** Send the dispatch to GitHub; throws when GitHub does not accept it. */
	readonly dispatch: (dispatch: RepositoryDispatch) => Promise<void>
	/** The broker's public origin, such as `https://func-x.azurewebsites.net`; the runner calls it back. */
	readonly brokerOrigin: string
	/** Where the task password waits for the runner's OIDC-authenticated calls; it never goes into the dispatch. */
	readonly pending: PendingResearchStore
	/** Who gets every prompt that is not a research command. */
	readonly fallback: Layer.Layer<AgentSessions, never, DeliveryApi>
}

/**
 * Agent sessions that send `/research` comments to a GitHub Actions workflow in the customer's repository, and
 * everything else to the fallback (the echo agent). The runner proves itself with its GitHub OIDC token and the broker
 * (`oidcProxy`) calls the delivery API for it; the task password is neither in the dispatch, which GitHub stores,
 * nor ever sent to the runner. A dispatch GitHub refuses fails the delivery at once, so the
 * discussion sees the error instead of waiting for the hand-off timeout.
 */
export const researchAgentSessions = (options: ResearchSessionsOptions): Layer.Layer<AgentSessions, never, DeliveryApi> =>
	Layer.effect(
		AgentSessions,
		Effect.gen(function* () {
			const api = yield* DeliveryApi
			const fallback = Context.get(
				yield* Layer.build(options.fallback.pipe(Layer.provide(Layer.succeed(DeliveryApi, api)))),
				AgentSessions,
			)
			return AgentSessions.of({
				getByName: (mailboxKey) => ({
					send: Effect.fn('research_agent.send')(function* (input: typeof AgentSessionMessage.Encoded) {
						const task = researchTask(input.prompt)
						if (task === undefined) return yield* fallback.getByName(mailboxKey).send(input)
						const message = yield* Schema.decodeEffect(AgentSessionMessage)(input).pipe(Effect.orDie)
						const ref = 'ref' in message.discussion ? message.discussion.ref : undefined
						const target = targetOf(message)
						const failDelivery = (reason: string) =>
							api.fail({ ...target, payload: { markdown: reason } }).pipe(
								Effect.tapError((error) => Effect.logError('research_agent: could not fail the delivery', error)),
								Effect.ignore,
							)
						if (ref === undefined || !('installationId' in ref) || !('owner' in ref)) {
							return yield* failDelivery('/research works on GitHub issues and pull requests only.')
						}
						let workspace: string | undefined
						let taskText = task
						if (isWorkspaceRepository(ref.repository)) {
							const args = readResearchArgs(task)
							if (args._tag === 'MissingWorkspace') {
								return yield* failDelivery(
									'Name the workspace after /research, for example `/research --ws be how does the tea service call water?`. The workspace is a folder under `workspaces/`.',
								)
							}
							if (args._tag === 'InvalidWorkspace') {
								return yield* failDelivery(
									`\`${args.value}\` is not a workspace id. Use lowercase letters, digits and dashes, for example \`--ws be\`.`,
								)
							}
							workspace = args.workspace
							taskText = args.notes
						} else if (task === '') {
							return yield* failDelivery('Add a task after /research, for example `/research why does CI fail?`.')
						}
						const saved = yield* Effect.tryPromise(() =>
							options.pending.save({
								deliveryId: message.deliveryId,
								repositoryId: String(ref.repositoryId),
								installationId: String(ref.installationId),
								accessToken: Redacted.value(message.accessToken),
								expiresAt: Date.now() + PENDING_TTL_SECONDS * 1000,
							}),
						).pipe(
							Effect.as(true),
							Effect.catch((error) =>
								Effect.logError('research_agent: could not save the pending record', error).pipe(
									Effect.andThen(failDelivery('Could not start the research workflow: the broker could not save its state.')),
									Effect.as(false),
								),
							),
						)
						if (!saved) return
						yield* Effect.tryPromise(() =>
							options.dispatch({
								installationId: Number(ref.installationId),
								owner: ref.owner,
								repository: ref.repository,
								eventType: RESEARCH_EVENT_TYPE,
								clientPayload: {
									task: taskText,
									...(workspace === undefined ? {} : { workspace }),
									issueNumber: Number(ref.number),
									deliveryId: message.deliveryId,
									brokerOrigin: options.brokerOrigin,
								},
							}),
						).pipe(
							Effect.catch((error) =>
								Effect.logError('research_agent: dispatch failed', error).pipe(
									Effect.andThen(Effect.promise(() => options.pending.take(message.deliveryId).catch(() => false))),
									Effect.andThen(failDelivery(`Could not start the research workflow in this repository: ${describe(error)}`)),
								),
							),
						)
					}),
				}),
			})
		}),
	)
