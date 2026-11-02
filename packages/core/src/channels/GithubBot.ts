/**
 * The cloud-neutral GitHub wiring: the provider, its callback handlers and the bot settings every host shares.
 */
import {
	DebounceDeliveryMode,
	type DeliveryContext,
	type DeliveryHandoffError,
	type MailboxSubscriptionError,
	type MailboxSubscriptions,
} from '@humanlayer/channels-delivery'
import {
	GitHubBot,
	GitHubId,
	type GitHubApi,
	type GitHubApiError,
	type GitHubCallbackHandlers,
	type GitHubMentioned,
	type GitHubRepositoryRef,
} from '@humanlayer/channels-github'
import { Config, Effect, type Layer, Option } from 'effect'

import { decideGitHubMention, gitHubMentionDiscussion } from './GithubMention'
import { handOff } from '../Handoff'
import { type AgentSessions } from '../Ports'

const githubRepositoryLogAnnotations = (ref: GitHubRepositoryRef) => ({
	'github.owner': ref.owner,
	'github.repository': ref.repository,
	'github.repository_id': ref.repositoryId,
	'github.installation_id': ref.installationId,
})

type HandlerError = GitHubApiError | Config.ConfigError | MailboxSubscriptionError | DeliveryHandoffError
type HandlerRequirements = GitHubApi | AgentSessions | MailboxSubscriptions

/**
 * GitHub App callbacks. An authorized mention hands the delivery to the discussion's AgentSession, which finishes
 * it. Until then the mailbox holds later events back. Mentions require write access or higher.
 *
 * The discussion is deliberately not subscribed: the SDK sends every event of a subscribed discussion, mentions
 * included, to `onSubscribedIssueEvents` / `onSubscribedPrEvents`, which this bot does not define, so later
 * mentions would be ignored as `callback_not_configured`. Subscribe once those handlers exist (multi-turn).
 */
export const githubHandlers = {
	onMentioned: (event: GitHubMentioned, context: DeliveryContext) => {
		const discussion = gitHubMentionDiscussion(event)
		return Effect.gen(function* () {
			const request = yield* decideGitHubMention(event)
			if (Option.isNone(request)) return
			return yield* handOff(request.value, context)
		}).pipe(
			Effect.annotateLogs({
				...githubRepositoryLogAnnotations(discussion.ref),
				'github.discussion_kind': discussion._tag,
				'github.discussion_number': discussion.ref.number,
				'github.event_id': event.trigger.eventId,
				'github.actor': event.trigger.actor.login,
				'delivery.id': context.deliveryId,
			}),
		)
	},
} satisfies GitHubCallbackHandlers<HandlerError, HandlerRequirements>

/**
 * The GitHub provider: webhook secret, debounce, bot identity and handlers from the configuration. The bot uses
 * `GitHubApiLive`; only tests pass `gitHubApi` to put a fake GitHub behind the same provider.
 */
export const makeGitHubProvider = <ApiError = never, ApiRequirements = never>(
	gitHubApi?: Layer.Layer<GitHubApi, ApiError, ApiRequirements>,
) =>
	GitHubBot.make<HandlerError, HandlerRequirements, ApiError, ApiRequirements>({
		webhookSecret: Config.Redacted('GITHUB_WEBHOOK_SECRET'),
		deliveryMode: DebounceDeliveryMode.make({ quietPeriodMs: 3_000, maxWaitMs: 3_000 }),
		bot: Config.all({
			mentionNames: Config.String('GITHUB_BOT_MENTION_NAME').pipe(Config.map((name) => [name])),
			botUserId: Config.schema(GitHubId, 'GITHUB_BOT_USER_ID'),
		}),
		handlers: githubHandlers,
		...(gitHubApi === undefined ? {} : { gitHubApi }),
	})

/** The bot's namespace and event processing, shared by every host that runs it. */
export const botSettings = {
	namespace: 'slop-code-factory',
	eventProcessing: {
		concurrency: 1,
		leaseMs: 10_000,
		maxAttempts: 5,
	},
} as const
