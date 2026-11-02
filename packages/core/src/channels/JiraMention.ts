/**
 * Deciding a Jira mention, cloud-neutral: a comment that mentions the bot with a known `/command` is acknowledged
 * with a `👀 On it` comment and becomes a request for the issue's AgentSession. Mentions without a known command,
 * or denied by the access policy, are ignored silently (no acknowledgement, no reply, no agent run).
 */
import { JiraApi, type JiraIssueInfo, type JiraMentioned } from '@humanlayer/channels-jira'
import { Effect, Option, Predicate } from 'effect'

import type { MentionRequest } from '../AgentSessionMessage'
import { parseCommand } from './JiraCommand'

/**
 * Whether the mention's author may invoke the bot. Access control is deferred: anyone who can comment on the
 * issue may, for now. A Jira permission check replaces this later.
 */
export const authorizeJiraMention = (_event: JiraMentioned): Effect.Effect<boolean> => Effect.succeed(true)

/** Lines of text, without the missing or empty ones, as one string. */
const joinText = (lines: ReadonlyArray<string | null>) =>
	lines.filter(Predicate.isNotNull).filter((line) => line.length > 0).join('\n')

/** What the agent is asked: the issue's title and description (or just its key if they are unknown) and the args. */
export const jiraPrompt = (input: {
	readonly issueKey: string
	readonly issue: Option.Option<JiraIssueInfo>
	readonly args: string
}): string =>
	Option.match(input.issue, {
		onNone: () => joinText([`Jira issue ${input.issueKey}`, input.args]),
		onSome: (issue) => joinText([issue.title, issue.description, input.args]),
	})

const FETCH_ISSUE_TIMEOUT = '5 seconds'
const ACK_TIMEOUT = '5 seconds'
/** Jira has no comment reactions, so the acknowledgement is a comment of its own. */
export const JIRA_ACK_MARKDOWN = '👀 On it'

export type JiraMentionOptions = {
	/** The access policy, swappable in tests; `authorizeJiraMention` by default. */
	readonly authorize?: (event: JiraMentioned) => Effect.Effect<boolean>
}

/** The request to hand to the issue's AgentSession, or `None` when denied or without a known command. */
export const decideJiraMention = (
	event: JiraMentioned,
	options: JiraMentionOptions = {},
): Effect.Effect<Option.Option<MentionRequest>, never, JiraApi> =>
	Effect.gen(function* () {
		const authorize = options.authorize ?? authorizeJiraMention
		if (!(yield* authorize(event))) {
			yield* Effect.logWarning('Jira mention denied by the access policy')
			return Option.none()
		}
		const command = parseCommand(event.comment.afterMention)
		if (Option.isNone(command)) {
			yield* Effect.logInfo('Jira mention without a known command; ignoring')
			return Option.none()
		}

		const api = yield* JiraApi
		/** Best effort: a failed or hung acknowledgement is logged and never blocks the run. */
		yield* api.postComment({ issueKey: event.issue.key, markdown: JIRA_ACK_MARKDOWN }).pipe(
			Effect.timeout(ACK_TIMEOUT),
			Effect.catch((error) => Effect.logWarning('Could not acknowledge the Jira mention; continuing', error)),
			Effect.asVoid,
		)
		/** A hung fetch must not stall the run: after the timeout the prompt has the comment alone. */
		const issue = yield* api.fetchIssue(event.issue.key).pipe(
			Effect.timeout(FETCH_ISSUE_TIMEOUT),
			Effect.map(Option.some),
			Effect.catch((error) =>
				Effect.logWarning('Could not fetch the Jira issue; prompting with the comment alone', error).pipe(
					Effect.as(Option.none<JiraIssueInfo>()),
				),
			),
		)
		yield* Effect.logInfo('Jira command received').pipe(Effect.annotateLogs({ 'jira.command': command.value.name }))
		return Option.some({
			prompt: jiraPrompt({ issueKey: event.issue.key, issue, args: command.value.args }),
			discussion: event.issue,
		})
	})
