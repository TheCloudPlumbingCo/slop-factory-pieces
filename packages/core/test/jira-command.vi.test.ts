import { describe, it } from '@effect/vitest'
import { Option } from 'effect'

import { parseCommand } from '../src/channels/JiraCommand'

describe('parseCommand', () => {
	it('reads a bare /research as research with empty args', ({ expect }) => {
		expect(parseCommand('/research')).toEqual(Option.some({ name: 'research', args: '' }))
	})

	it('matches the command case-insensitively and trims the args', ({ expect }) => {
		expect(parseCommand('/Research  look at X')).toEqual(Option.some({ name: 'research', args: 'look at X' }))
	})

	it('allows leading whitespace and newlines before the command', ({ expect }) => {
		expect(parseCommand('  \n/RESEARCH\nwhy is login slow')).toEqual(
			Option.some({ name: 'research', args: 'why is login slow' }),
		)
	})

	for (const text of ['hello /research', '/foo', '', '   ', 'research', '/', '/researchers now']) {
		it(`is None for ${JSON.stringify(text)}`, ({ expect }) => {
			expect(parseCommand(text)).toEqual(Option.none())
		})
	}
})
