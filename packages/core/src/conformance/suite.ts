/**
 * The control layer's behaviours, written once against `ControlLayerDriver` so every cloud runs the same list.
 * A cloud's test file calls `defineControlLayerSuite` with its driver; nothing here knows how the driver works.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect, type Scope } from 'effect'

import { echoReply } from '../EchoReply'
import { maintainerOnlyNotice } from '../channels/GithubMention'
import { botMention, type ControlLayerDriver } from './driver'

/** The debounce every deployment uses: a mention runs once its issue has been quiet for this long. */
const DEBOUNCE_MS = 3_000
/** Comfortably past the debounce, whatever the deployment's polling interval. */
const PAST_DEBOUNCE_MS = DEBOUNCE_MS + 2_000
/** Time for saved output (comments, reactions) to reach GitHub. */
const OUTPUT_MS = 5_000
/** How long a handed-off delivery may run before it fails on its own. */
const HANDOFF_TIMEOUT_MS = 10 * 60 * 1_000
/** Long enough for a retried comment post to go through after a few failures. */
const RETRY_WINDOW_MS = 5 * 60 * 1_000

const maintainer = 'maintainer-1'
/**
 * B12's pull request. Issues and pull requests share one number sequence in a repository, so it must not be the
 * number of B12's issue (12). Exported so a driver's own tests can check the mailbox key it gets.
 */
export const B12_PULL_REQUEST = 120

const behaviours = {
	B1: 'B1 The same webhook posted twice while running gives one agent start (req 26)',
	B2: 'B2 The same webhook posted again after the run completed gives no second reply (req 26)',
	B3: 'B3 Two mentions inside 3 s on one issue become one agent start (req 7, 21)',
	B4: 'B4 A second mention on a busy issue waits; it starts only after the first completes (req 25)',
	B5: 'B5 Mentions on two issues both start without waiting for each other (req 25)',
	B6: 'B6 A failed comment post is retried and the echo agent is not started again (req 28)',
	B7: 'B7 An agent that never completes: after the hand-off timeout the delivery fails and the next mention starts (req 22, 27)',
	B8: 'B8 Completing a delivery that already timed out posts nothing (req 22)',
	B9: 'B9 An invalid signature returns an error status and has no reaction, comment or agent start (req 30)',
	B10: 'B10 A mention saved before `restart` is processed after it (req 24)',
	B11: 'B11 An author without write access gets a `-1` reaction and one notice, no agent start (req 13)',
	B12: 'B12 A mention on a pull request starts the agent like an issue (req 5)',
} as const

export type BehaviourId = keyof typeof behaviours

export interface ControlLayerSuiteOptions {
	/** Behaviours this driver cannot observe, each with the reason; they are skipped and the reason printed. */
	readonly skip?: Partial<Record<BehaviourId, string>>
}

type Mention = Parameters<ControlLayerDriver['postGitHubMention']>[0]

/** A valid mention by a maintainer on issue `number`. */
const mention = (eventId: string, number: number, text: string, overrides: Partial<Mention> = {}): Mention => ({
	eventId,
	kind: 'issue',
	number,
	author: maintainer,
	body: `${botMention} ${text}`,
	signature: 'valid',
	...overrides,
})

/** Post a mention and require the deployment to accept it. */
const post = (driver: ControlLayerDriver, input: Mention) =>
	Effect.gen(function* () {
		const { status } = yield* driver.postGitHubMention(input)
		expect(status, `webhook ${input.eventId} should be accepted`).toBe(200)
	})

/** The only agent start so far. */
const onlyStart = (driver: ControlLayerDriver) =>
	Effect.gen(function* () {
		const starts = yield* driver.agentStarts
		expect(starts).toHaveLength(1)
		return starts[0]!
	})

const scenarios: Record<BehaviourId, (driver: ControlLayerDriver) => Effect.Effect<void>> = {
	B1: (driver) =>
		Effect.gen(function* () {
			yield* post(driver, mention('b1-event', 1, 'run the tests'))
			yield* post(driver, mention('b1-event', 1, 'run the tests'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			yield* post(driver, mention('b1-event', 1, 'run the tests'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const start = yield* onlyStart(driver)

			/** A duplicate queued behind the running delivery would start once it completes. */
			yield* driver.completeDelivery(start.deliveryId)
			yield* driver.advance(PAST_DEBOUNCE_MS + OUTPUT_MS)
			expect(yield* driver.agentStarts, 'a redelivered webhook must not start the agent again').toHaveLength(1)
			expect((yield* driver.output).comments).toEqual([echoReply(`${botMention} run the tests`)])
		}),

	B2: (driver) =>
		Effect.gen(function* () {
			const body = 'summarise this issue'
			yield* post(driver, mention('b2-event', 2, body))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const start = yield* onlyStart(driver)
			yield* driver.completeDelivery(start.deliveryId)
			yield* driver.advance(OUTPUT_MS)
			expect((yield* driver.output).comments).toEqual([echoReply(`${botMention} ${body}`)])

			yield* post(driver, mention('b2-event', 2, body))
			yield* driver.advance(PAST_DEBOUNCE_MS + OUTPUT_MS)
			expect(yield* driver.agentStarts).toHaveLength(1)
			expect((yield* driver.output).comments).toEqual([echoReply(`${botMention} ${body}`)])
		}),

	B3: (driver) =>
		Effect.gen(function* () {
			yield* post(driver, mention('b3-first', 3, 'first thought'))
			yield* driver.advance(1_000)
			yield* post(driver, mention('b3-second', 3, 'second thought'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const start = yield* onlyStart(driver)

			/** Merged into one run, not queued behind it: nothing is left to start once the run completes. */
			yield* driver.completeDelivery(start.deliveryId)
			yield* driver.advance(PAST_DEBOUNCE_MS + OUTPUT_MS)
			expect(yield* driver.agentStarts, 'both mentions must have gone into the one run').toHaveLength(1)
			expect((yield* driver.output).comments).toEqual([echoReply(start.prompt)])
		}),

	B4: (driver) =>
		Effect.gen(function* () {
			yield* post(driver, mention('b4-first', 4, 'first request'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const first = yield* onlyStart(driver)

			yield* post(driver, mention('b4-second', 4, 'second request'))
			yield* driver.advance(PAST_DEBOUNCE_MS * 3)
			expect(yield* driver.agentStarts, 'the second mention must wait for the first').toHaveLength(1)

			yield* driver.completeDelivery(first.deliveryId)
			yield* driver.advance(PAST_DEBOUNCE_MS + OUTPUT_MS)
			const starts = yield* driver.agentStarts
			expect(starts).toHaveLength(2)
			expect(starts[1]?.prompt).toBe(`${botMention} second request`)
			expect(starts[1]?.mailboxKey).toBe(first.mailboxKey)
		}),

	B5: (driver) =>
		Effect.gen(function* () {
			yield* post(driver, mention('b5-issue-51', 51, 'look at 51'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const first = yield* onlyStart(driver)

			/** Issue 51 stays busy: its delivery is never completed. */
			yield* post(driver, mention('b5-issue-52', 52, 'look at 52'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const starts = yield* driver.agentStarts
			expect(starts).toHaveLength(2)
			expect(starts[1]?.prompt).toBe(`${botMention} look at 52`)
			expect(starts[1]?.mailboxKey).not.toBe(first.mailboxKey)
		}),

	B6: (driver) =>
		Effect.gen(function* () {
			const body = 'flaky comment please'
			yield* post(driver, mention('b6-event', 6, body))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const start = yield* onlyStart(driver)

			yield* driver.failNextCommentPosts(2)
			yield* driver.completeDelivery(start.deliveryId)
			yield* driver.advance(RETRY_WINDOW_MS)
			const output = yield* driver.output
			expect(output.failedCommentPosts, 'both injected comment post failures must have been hit').toBe(2)
			expect(output.comments).toEqual([echoReply(`${botMention} ${body}`)])
			expect(yield* driver.agentStarts).toHaveLength(1)
		}),

	B7: (driver) =>
		Effect.gen(function* () {
			yield* post(driver, mention('b7-first', 7, 'never finishes'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			yield* onlyStart(driver)

			yield* post(driver, mention('b7-second', 7, 'after the timeout'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			expect(yield* driver.agentStarts, 'the second mention must wait while the first runs').toHaveLength(1)

			yield* driver.advance(HANDOFF_TIMEOUT_MS)
			const starts = yield* driver.agentStarts
			expect(starts).toHaveLength(2)
			expect(starts[1]?.prompt).toBe(`${botMention} after the timeout`)
		}),

	B8: (driver) =>
		Effect.gen(function* () {
			yield* post(driver, mention('b8-event', 8, 'too slow'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const start = yield* onlyStart(driver)
			yield* driver.advance(HANDOFF_TIMEOUT_MS + OUTPUT_MS)
			const before = yield* driver.output

			yield* driver.completeDelivery(start.deliveryId)
			yield* driver.advance(OUTPUT_MS)
			const after = yield* driver.output
			expect(after.comments).toEqual(before.comments)
			expect(after.comments).not.toContain(echoReply(`${botMention} too slow`))
		}),

	B9: (driver) =>
		Effect.gen(function* () {
			const { status } = yield* driver.postGitHubMention(mention('b9-event', 9, 'forged', { signature: 'invalid' }))
			expect(status).toBeGreaterThanOrEqual(400)
			yield* driver.advance(PAST_DEBOUNCE_MS + OUTPUT_MS)
			expect(yield* driver.output).toEqual({ reactions: [], comments: [], failedCommentPosts: 0 })
			expect(yield* driver.agentStarts).toEqual([])
		}),

	B10: (driver) =>
		Effect.gen(function* () {
			yield* post(driver, mention('b10-event', 10, 'survive the restart'))
			yield* driver.restart
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const start = yield* onlyStart(driver)
			expect(start.prompt).toBe(`${botMention} survive the restart`)
		}),

	B11: (driver) =>
		Effect.gen(function* () {
			yield* driver.setAuthorAccess('reader-1', 'read')
			yield* post(driver, mention('b11-first', 11, 'let me in', { author: 'reader-1' }))
			yield* driver.advance(PAST_DEBOUNCE_MS + OUTPUT_MS)
			yield* post(driver, mention('b11-second', 11, 'please', { author: 'reader-1' }))
			yield* driver.advance(PAST_DEBOUNCE_MS + OUTPUT_MS)

			const output = yield* driver.output
			expect(output.reactions).toEqual(['-1', '-1'])
			expect(output.comments).toEqual([maintainerOnlyNotice])
			expect(yield* driver.agentStarts).toEqual([])
		}),

	B12: (driver) =>
		Effect.gen(function* () {
			const body = 'review this pull request'
			yield* post(driver, mention('b12-pr', B12_PULL_REQUEST, body, { kind: 'pr' }))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const start = yield* onlyStart(driver)
			expect(start.prompt).toBe(`${botMention} ${body}`)
			expect((yield* driver.output).reactions).toEqual(['eyes'])

			/** An issue is another discussion than the pull request: it starts while the pull request is busy. */
			yield* post(driver, mention('b12-issue', 12, 'and this issue'))
			yield* driver.advance(PAST_DEBOUNCE_MS)
			const starts = yield* driver.agentStarts
			expect(starts).toHaveLength(2)
			expect(starts[1]?.mailboxKey).not.toBe(start.mailboxKey)

			yield* driver.completeDelivery(start.deliveryId)
			yield* driver.advance(OUTPUT_MS)
			expect((yield* driver.output).comments).toEqual([echoReply(`${botMention} ${body}`)])
		}),
}

/**
 * Define the twelve behaviours as tests against a fresh driver each. `make` builds the driver in the test's scope,
 * which closes when the test ends.
 */
export const defineControlLayerSuite = (
	name: string,
	make: Effect.Effect<ControlLayerDriver, never, Scope.Scope>,
	options: ControlLayerSuiteOptions = {},
): void => {
	describe(`control layer behaviours: ${name}`, () => {
		for (const id of Object.keys(behaviours) as Array<BehaviourId>) {
			const title = behaviours[id]
			const reason = options.skip?.[id]
			if (reason !== undefined) {
				if (reason.trim() === '') throw new Error(`[${name}] skipping ${id} needs a written reason`)
				console.warn(`[${name}] skipping ${id}: ${reason}`)
				it.skip(`${title} [skipped: ${reason}]`, () => {})
				continue
			}
			it.effect(title, () => Effect.scoped(Effect.flatMap(make, scenarios[id])))
		}
	})
}
