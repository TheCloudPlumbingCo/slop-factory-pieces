/**
 * Deciding a GitHub mention, cloud-neutral: the access check with its reactions and maintainer notice, then the
 * prompt. Each cloud hands the resulting request to an AgentSession its own way.
 */
import {
	GitHubApi,
	GitHubContent,
	GitHubDiscussionRef,
	GitHubId,
	GitHubReaction,
	GitHubReactionTarget,
	hasGitHubAccess,
	type GitHubApiError,
	type GitHubMentioned,
} from '@humanlayer/channels-github'
import { Config, Effect, Match, Option, Predicate } from 'effect'

import type { MentionRequest } from '../AgentSessionMessage'

export const maintainerOnlyNotice =
	'This agent can only be invoked by maintainers (users with write access or higher to this repository).'

/** The issue or pull request a mention happened in. */
export const gitHubMentionDiscussion = (event: GitHubMentioned) =>
	Match.value(event).pipe(
		Match.tagsExhaustive({
			GitHubIssueMentioned: ({ issue }) => issue,
			GitHubPrMentioned: ({ pullRequest }) => pullRequest,
		}),
	)

/**
 * check if a user has mention access. if so, send eyes when we start working.
 * If not, send a thumbs down - AND, if not posted already in the issue/pr, a comment indicating it can only be used by maintainers
 */
export const respondToMentionAccess = Effect.fn('bot.github.respondToMentionAccess')(function* (
	event: GitHubMentioned,
) {
	const discussion = gitHubMentionDiscussion(event)
	const access = yield* discussion.fetchUserAccess(event.trigger.actor.login).pipe(
		Effect.catchIf(
			(error) => error.reason === 'not_found',
			(error) =>
				Effect.logInfo('GitHub could not resolve the mention author; denying access', error).pipe(
					Effect.as('none' as const),
				),
		),
	)
	const allowed = hasGitHubAccess({ access, minimum: 'write' })
	const target = Match.value(event.trigger).pipe(
		Match.tagsExhaustive({
			GitHubIssueOpened: ({ issue }) =>
				GitHubReactionTarget.cases.Discussion.make({
					discussion: GitHubDiscussionRef.cases.Issue.make({ ref: issue.ref }),
				}),
			GitHubPrOpened: ({ pullRequest }) =>
				GitHubReactionTarget.cases.Discussion.make({
					discussion: GitHubDiscussionRef.cases.PullRequest.make({ ref: pullRequest.ref }),
				}),
			GitHubIssueCommentCreated: ({ comment }) =>
				GitHubReactionTarget.cases.Comment.make({ comment: comment.ref }),
			GitHubPrCommentCreated: ({ comment }) => GitHubReactionTarget.cases.Comment.make({ comment: comment.ref }),
			GitHubPrReviewCommentCreated: ({ comment }) =>
				GitHubReactionTarget.cases.Comment.make({ comment: comment.ref }),
		}),
	)
	const api = yield* GitHubApi
	yield* api.addReaction({ target, reaction: GitHubReaction.make(allowed ? 'eyes' : '-1') })
	if (allowed) return true

	yield* Effect.logWarning('Bot mention denied: the author lacks write access').pipe(
		Effect.annotateLogs({ actor: event.trigger.actor.login, access }),
	)
	const botUserId = yield* Config.schema(GitHubId, 'GITHUB_BOT_USER_ID')
	const comments = yield* discussion.listComments()
	const alreadyNotified = comments.some(
		(comment) => comment.author?.id === botUserId && comment.body === maintainerOnlyNotice,
	)
	if (!alreadyNotified) yield* discussion.postComment(GitHubContent.make({ markdown: maintainerOnlyNotice }))
	return false
})

/** Lines of text, without the missing ones, as one string. */
const joinText = (lines: ReadonlyArray<string | null>) => lines.filter(Predicate.isNotNull).join('\n')

/** What the agent is asked: the comment that mentioned the bot, or the title and description of what was opened. */
export const mentionPrompt = (event: GitHubMentioned): string =>
	Match.value(event.trigger).pipe(
		Match.tagsExhaustive({
			GitHubIssueOpened: ({ title, body }) => joinText([title, body]),
			GitHubPrOpened: ({ title, body }) => joinText([title, body]),
			GitHubIssueCommentCreated: ({ comment }) => comment.body,
			GitHubPrCommentCreated: ({ comment }) => comment.body,
			GitHubPrReviewCommentCreated: ({ comment }) => comment.body,
		}),
	)

/** The request to hand to the discussion's AgentSession, or `None` when the author lacks write access. */
export const decideGitHubMention = (
	event: GitHubMentioned,
): Effect.Effect<Option.Option<MentionRequest>, GitHubApiError | Config.ConfigError, GitHubApi> =>
	Effect.gen(function* () {
		if (!(yield* respondToMentionAccess(event))) return Option.none()

		yield* Effect.logInfo('Authorized mention received')
		return Option.some({ prompt: mentionPrompt(event), discussion: gitHubMentionDiscussion(event) })
	})
