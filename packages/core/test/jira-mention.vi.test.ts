import { describe, it } from '@effect/vitest'
import { JiraApi, JiraIssueId, JiraIssueRef, JiraMentioned } from '@humanlayer/channels-jira'
import { Effect, Layer, Option, Ref } from 'effect'

import { decideJiraMention, JIRA_ACK_MARKDOWN } from '../src/channels/JiraMention'

const issue = JiraIssueRef.make({
	id: JiraIssueId.make('10042'),
	key: 'ABC-42',
	mailboxKey: 'jira:issue:10042',
})

const mention = (afterMention: string) =>
	JiraMentioned.make({
		issue,
		comment: {
			id: '7001',
			body: `@slopcodebot ${afterMention}`.trim(),
			afterMention,
			author: { accountId: 'person-1', displayName: 'Person One' },
		},
		eventId: 'jira-event-1',
	})

type FetchIssue = JiraApi['Service']['fetchIssue']
type PostComment = JiraApi['Service']['postComment']

interface Recorded {
	readonly fetched: ReadonlyArray<string>
	readonly posted: ReadonlyArray<Parameters<PostComment>[0]>
}

const postedOk: PostComment = () => Effect.succeed({ commentId: '9001' })

const describedIssue: FetchIssue = (key) =>
	Effect.succeed({ key, title: 'Login times out', description: 'After 30 seconds the page hangs.' })

/** Run `decideJiraMention` once against a fake Jira API; return the decision and what was recorded. */
const runDecide = (event: JiraMentioned, options?: Parameters<typeof decideJiraMention>[1]) =>
	Effect.gen(function* () {
		const recorded = yield* Ref.make<Recorded>({ fetched: [], posted: [] })
		const layer = Layer.mock(JiraApi, {
			fetchIssue: (key) =>
				Ref.update(recorded, (current) => ({ ...current, fetched: [...current.fetched, key] })).pipe(
					Effect.andThen(describedIssue(key)),
				),
			postComment: (input) =>
				Ref.update(recorded, (current) => ({ ...current, posted: [...current.posted, input] })).pipe(
					Effect.andThen(postedOk(input)),
				),
		})
		const decision = yield* decideJiraMention(event, options).pipe(Effect.provide(layer))
		return { decision, recorded: yield* Ref.get(recorded) }
	})

describe('decideJiraMention', () => {
	it.effect('with /research: Some with the issue and args as prompt, and posts the 👀 On it comment', ({ expect }) =>
		Effect.gen(function* () {
			const { decision, recorded } = yield* runDecide(mention('/research why is login slow'))
			const request = Option.getOrThrow(decision)
			expect(request.prompt).toBe('Login times out\nAfter 30 seconds the page hangs.\nwhy is login slow')
			expect(request.discussion).toEqual(issue)
			expect(JIRA_ACK_MARKDOWN).toBe('👀 On it')
			expect(recorded.posted).toEqual([{ issueKey: 'ABC-42', markdown: '👀 On it' }])
			expect(recorded.fetched).toEqual(['ABC-42'])
		}),
	)

	it.effect('with an unknown command: None, and posts nothing', ({ expect }) =>
		Effect.gen(function* () {
			const { decision, recorded } = yield* runDecide(mention('/foo'))
			expect(Option.isNone(decision)).toBe(true)
			expect(recorded.posted).toEqual([])
			expect(recorded.fetched).toEqual([])
		}),
	)

	it.effect('when authorize returns false: None, and posts nothing', ({ expect }) =>
		Effect.gen(function* () {
			const { decision, recorded } = yield* runDecide(mention('/research'), {
				authorize: () => Effect.succeed(false),
			})
			expect(Option.isNone(decision)).toBe(true)
			expect(recorded.posted).toEqual([])
			expect(recorded.fetched).toEqual([])
		}),
	)
})
