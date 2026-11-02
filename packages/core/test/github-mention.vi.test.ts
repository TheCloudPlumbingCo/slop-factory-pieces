import { describe, it } from '@effect/vitest'
import {
	type GitHubAccessLevel,
	GitHubApi,
	GitHubContent,
	GitHubDiscussionRef,
	GitHubEventId,
	GitHubId,
	GitHubIssue,
	GitHubIssueComment,
	GitHubIssueCommentCreated,
	GitHubIssueMentioned,
	GitHubIssueRef,
	GitHubParticipant,
	GitHubReactionTarget,
	type GitHubReactionRequest,
} from '@humanlayer/channels-github'
import { ConfigProvider, Effect, Layer, Option, Ref } from 'effect'

import { decideGitHubMention, maintainerOnlyNotice } from '../src/channels/GithubMention'

const repository = {
	installationId: GitHubId.make(100),
	repositoryId: GitHubId.make(200),
	owner: 'acme',
	repository: 'web',
}
const issue = GitHubIssue.make({
	ref: GitHubIssueRef.make({ ...repository, number: GitHubId.make(42) }),
	mailboxKey: 'github:issue:42',
})
const issueDiscussion = GitHubDiscussionRef.cases.Issue.make({ ref: issue.ref })
const person = GitHubParticipant.make({ id: GitHubId.make(1), login: 'user-1', type: 'User' })
const botAuthor = GitHubParticipant.make({ id: GitHubId.make(999), login: 'agent[bot]', type: 'Bot' })

const commentRecord = (discussion: GitHubDiscussionRef, author: GitHubParticipant, body: string, id: number) =>
	GitHubIssueComment.make({
		ref: { discussion, id: GitHubId.make(id) },
		body,
		url: `https://github.com/acme/web/issues/42#issuecomment-${id}`,
		author,
	})

const eventId = GitHubEventId.make('mention-by-user-1')

const issueComment = GitHubIssueCommentCreated.make({
	issue,
	actor: person,
	eventId,
	comment: commentRecord(issueDiscussion, person, '@agent why does CI fail?', 1),
})
const event = GitHubIssueMentioned.make({ issue, trigger: issueComment, events: [issueComment] })
const target = GitHubReactionTarget.cases.Comment.make({ comment: issueComment.comment.ref })

interface Recorded {
	readonly reactions: ReadonlyArray<GitHubReactionRequest>
	readonly posts: ReadonlyArray<{ readonly discussion: GitHubDiscussionRef; readonly content: GitHubContent }>
	readonly comments: ReadonlyArray<GitHubIssueComment>
}

/** Run `decideGitHubMention` `times` times against one fake GitHub; return each decision and what was recorded. */
const runDecide = (access: GitHubAccessLevel, times = 1) =>
	Effect.gen(function* () {
		const recorded = yield* Ref.make<Recorded>({ reactions: [], posts: [], comments: [] })
		const post = (discussion: GitHubDiscussionRef, content: GitHubContent) =>
			Ref.modify(recorded, (current) => {
				const comment = commentRecord(discussion, botAuthor, content.markdown, 500 + current.posts.length)
				return [
					comment,
					{ ...current, posts: [...current.posts, { discussion, content }], comments: [...current.comments, comment] },
				] as const
			})
		const layer = Layer.mergeAll(
			ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_BOT_USER_ID: '999' })),
			Layer.mock(GitHubApi, {
				fetchUserAccess: () => Effect.succeed(access),
				addReaction: (input) =>
					Ref.update(recorded, (current) => ({ ...current, reactions: [...current.reactions, input] })),
				listIssueComments: () => Ref.get(recorded).pipe(Effect.map((current) => current.comments)),
				listPullRequestComments: () => Ref.get(recorded).pipe(Effect.map((current) => current.comments)),
				postIssueComment: ({ issue: ref, content }) =>
					post(GitHubDiscussionRef.cases.Issue.make({ ref }), content),
				postPullRequestComment: ({ pullRequest: ref, content }) =>
					post(GitHubDiscussionRef.cases.PullRequest.make({ ref }), content),
			}),
		)
		const decisions = []
		for (let i = 0; i < times; i++) {
			decisions.push(yield* decideGitHubMention(event).pipe(Effect.provide(layer)))
		}
		return { decisions, recorded: yield* Ref.get(recorded) }
	})

describe('decideGitHubMention', () => {
	it.effect('with write access: Some with the comment body as prompt, and the 👀 reaction', ({ expect }) =>
		Effect.gen(function* () {
			const { decisions, recorded } = yield* runDecide('write')
			const [decision] = decisions
			expect(Option.isSome(decision!)).toBe(true)
			const request = Option.getOrThrow(decision!)
			expect(request.prompt).toBe('@agent why does CI fail?')
			expect(request.discussion.mailboxKey).toBe(issue.mailboxKey)
			expect(recorded.reactions).toEqual([{ target, reaction: 'eyes' }])
			expect(recorded.posts).toEqual([])
		}),
	)

	it.effect('with read access: None, a 👎 reaction, and the notice posted once across two mentions', ({ expect }) =>
		Effect.gen(function* () {
			const { decisions, recorded } = yield* runDecide('read', 2)
			expect(decisions.every(Option.isNone)).toBe(true)
			expect(recorded.reactions).toEqual([
				{ target, reaction: '-1' },
				{ target, reaction: '-1' },
			])
			expect(recorded.posts).toEqual([
				{ discussion: issueDiscussion, content: { markdown: maintainerOnlyNotice } },
			])
		}),
	)
})
