import { describe, expect, it } from 'vitest'

import { CARD_COLUMNS, columnRank, isBackwards, nextColumn, type CardEvent, type CardPhase } from '../src/CardStates'

const events: ReadonlyArray<CardEvent> = ['HandedOff', 'Succeeded', 'Failed']
const phases: ReadonlyArray<CardPhase> = ['research', 'design', 'outline', 'implement']

describe('nextColumn', () => {
	it('research: hand-off puts the card in Research', () => {
		expect(nextColumn('research', 'HandedOff')).toBe('Research')
	})

	it('research: a success or a failure leaves the card where it is', () => {
		expect(nextColumn('research', 'Succeeded')).toBeUndefined()
		expect(nextColumn('research', 'Failed')).toBeUndefined()
	})

	it('later phases have no rule yet, for every event', () => {
		for (const phase of phases.filter((p) => p !== 'research')) {
			for (const event of events) expect(nextColumn(phase, event), `${phase}/${event}`).toBeUndefined()
		}
	})

	it('only returns a column from the ordered list', () => {
		for (const phase of phases) {
			for (const event of events) {
				const column = nextColumn(phase, event)
				if (column !== undefined) expect(CARD_COLUMNS).toContain(column)
			}
		}
	})
})

describe('column order', () => {
	it('is Todo, Research, Design, Outline, Implementation, In review, Done', () => {
		expect([...CARD_COLUMNS]).toEqual(['Todo', 'Research', 'Design', 'Outline', 'Implementation', 'In review', 'Done'])
	})

	it('ranks columns left to right and gives -1 for an unknown name', () => {
		expect(columnRank('Todo')).toBe(0)
		expect(columnRank('Done')).toBe(6)
		expect(columnRank('Backlog')).toBe(-1)
	})

	it('treats a move to the same column or to the left as backwards', () => {
		expect(isBackwards('Design', 'Research')).toBe(true)
		expect(isBackwards('Research', 'Research')).toBe(true)
		expect(isBackwards('Todo', 'Research')).toBe(false)
	})

	it('never calls an unknown column backwards', () => {
		expect(isBackwards('Backlog', 'Research')).toBe(false)
		expect(isBackwards('Research', 'Backlog')).toBe(false)
	})
})
