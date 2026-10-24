/**
 * The Jira provider: a comment that mentions the bot with a known `/command` is decided in `@slop/core`
 * (`decideJiraMention`: access policy, command, `👀 On it` acknowledgement, prompt), then the delivery is handed to
 * the issue's AgentSession. Mentions without a known command, or denied by the access policy, are ignored silently.
 */
import {
	DebounceDeliveryMode,
	type DeliveryContext,
	type DeliveryHandoffError,
} from '@humanlayer/channels-delivery'
import {
	JiraAccountId,
	JiraBot,
	type JiraApi,
	type JiraCallbackHandlers,
	type JiraMentioned,
} from '@humanlayer/channels-jira'
import { Config, Effect, Option, Schema } from 'effect'

import { type AgentSessions, decideJiraMention, handOff, type JiraMentionOptions } from '@slop/core'

type HandlerError = DeliveryHandoffError
type HandlerRequirements = JiraApi | AgentSessions

/** Builds the Jira callbacks; `authorize` is the access policy, swappable in tests. */
export const makeJiraHandlers = (options: JiraMentionOptions = {}) => ({
	onMentioned: (event: JiraMentioned, context: DeliveryContext) =>
		Effect.gen(function* () {
			const request = yield* decideJiraMention(event, options)
			if (Option.isNone(request)) return
			return yield* handOff(request.value, context)
		}).pipe(
			Effect.annotateLogs({
				'jira.issue_key': event.issue.key,
				'jira.issue_id': event.issue.id,
				'jira.comment_id': event.comment.id,
				'jira.event_id': event.eventId,
				'jira.actor': event.comment.author.accountId,
				'delivery.id': context.deliveryId,
			}),
		),
}) satisfies JiraCallbackHandlers<HandlerError, HandlerRequirements>

export const jiraHandlers = makeJiraHandlers()

/**
 * Reads five variables: `JIRA_WEBHOOK_SECRET`, `JIRA_BASE_URL` (the site, used only for the mailbox key) and
 * `JIRA_BOT_ACCOUNT_ID` here, and `JIRA_CLOUD_ID` and `JIRA_API_TOKEN` in the SDK's default `JiraApiLive`, which
 * calls the Atlassian API gateway with the service account's token as a Bearer token.
 */
export const jira = JiraBot.make<HandlerError, HandlerRequirements>({
	webhookSecret: Config.Redacted('JIRA_WEBHOOK_SECRET'),
	deliveryMode: DebounceDeliveryMode.make({ quietPeriodMs: 3_000, maxWaitMs: 3_000 }),
	bot: Config.all({ accountId: Config.schema(JiraAccountId, 'JIRA_BOT_ACCOUNT_ID') }),
	/** The site's host is the installation id in each issue's mailbox key, so it must not change. */
	site: Config.schema(Schema.URLFromString, 'JIRA_BASE_URL').pipe(Config.map((url) => url.host)),
	handlers: jiraHandlers,
})
