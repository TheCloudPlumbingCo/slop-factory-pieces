/**
 * The board card states, owned by the broker. The workflow never names a column: it reports only that a run ended.
 * The broker looks up what to do in `nextColumn`. To add a phase or an event rule, change the table below and nothing else.
 */
import { Context, type Effect } from 'effect'

/** The Status columns of a workspace board, left to right. A card never moves to a column on its left. */
export const CARD_COLUMNS = ['Todo', 'Research', 'Design', 'Outline', 'Implementation', 'In review', 'Done'] as const
export type CardColumn = (typeof CARD_COLUMNS)[number]

/** What a command does to a card. Only `research` exists today. */
export type CardPhase = 'research' | 'design' | 'outline' | 'implement'

/** What happened to a handed-off task. */
export type CardEvent = 'HandedOff' | 'Succeeded' | 'Failed'

/**
 * The next column for a phase and an event, or `undefined` for "leave the card where it is".
 * Research: the card is in Research while the run works. A success or a failure does not move it. A person moves it to
 * Design by merging the research pull request (the workspace repository's `board-sync.yml` does that).
 */
const TABLE: Readonly<Partial<Record<CardPhase, Readonly<Partial<Record<CardEvent, CardColumn>>>>>> = {
	research: { HandedOff: 'Research' },
}

export const nextColumn = (phase: CardPhase, event: CardEvent): CardColumn | undefined => TABLE[phase]?.[event]

/** The position of a column in `CARD_COLUMNS`, or -1 for a name that is not in it. */
export const columnRank = (column: string): number => CARD_COLUMNS.indexOf(column as CardColumn)

/** True when moving from `current` to `target` goes left. An unknown name is never backwards. */
export const isBackwards = (current: string, target: string): boolean => {
	const from = columnRank(current)
	const to = columnRank(target)
	return from !== -1 && to !== -1 && from >= to
}

/** What the mover needs to find a card. */
export interface CardTarget {
	readonly installationId: number
	readonly owner: string
	readonly repository: string
	readonly issueNumber: number
}

/**
 * The project board, as the broker's logic needs it. Neither method fails: an implementation logs its own failures,
 * because a card that does not move must never fail a delivery.
 *
 * - `projectNumber`: the board number in `workspaces/<workspace>/workspace.json`, or `undefined` when there is none.
 * - `moveCard`: put the issue's card in `column`. A card already at `column` or to its right stays. A card that is not on the board is added first.
 */
export class CardMover extends Context.Service<
	CardMover,
	{
		readonly projectNumber: (input: {
			readonly installationId: number
			readonly owner: string
			readonly repository: string
			readonly workspace: string
		}) => Effect.Effect<number | undefined>
		readonly moveCard: (input: CardTarget & { readonly projectNumber: number; readonly column: string }) => Effect.Effect<void>
	}
>()('slop-code-factory/CardMover') {}
