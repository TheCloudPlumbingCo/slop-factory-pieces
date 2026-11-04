import { describe, it } from '@effect/vitest'

import { parseResearchCommand } from '../src/channels/ResearchCommand'

describe('parseResearchCommand', () => {
	it('reads the workspace from --ws', ({ expect }) => {
		expect(parseResearchCommand('@helix /research --ws be', 'helix')).toEqual({
			_tag: 'Research',
			workspace: 'be',
			notes: '',
		})
	})

	it('accepts --ws=<id> and keeps the remaining text as notes', ({ expect }) => {
		expect(parseResearchCommand('@helix /research --ws=ops check the compose file', 'helix')).toEqual({
			_tag: 'Research',
			workspace: 'ops',
			notes: 'check the compose file',
		})
	})

	it('finds --ws anywhere after the command and keeps the notes around it in order', ({ expect }) => {
		expect(parseResearchCommand('@helix /research look at tea sizes --ws be please', 'helix')).toEqual({
			_tag: 'Research',
			workspace: 'be',
			notes: 'look at tea sizes please',
		})
	})

	it('ignores case of the mention and the command, and text before the mention', ({ expect }) => {
		expect(parseResearchCommand('thanks!\n@Helix /RESEARCH --ws be', 'helix')).toEqual({
			_tag: 'Research',
			workspace: 'be',
			notes: '',
		})
	})

	it('asks for a workspace when --ws is missing', ({ expect }) => {
		expect(parseResearchCommand('@helix /research', 'helix')).toEqual({ _tag: 'MissingWorkspace' })
	})

	it('asks for a workspace when --ws has no value', ({ expect }) => {
		expect(parseResearchCommand('@helix /research --ws', 'helix')).toEqual({ _tag: 'MissingWorkspace' })
	})

	for (const bad of ['BE', 'be/ops', '../x', '-be', 'be_1']) {
		it(`rejects workspace id ${JSON.stringify(bad)}`, ({ expect }) => {
			const result = parseResearchCommand(`@helix /research --ws=${bad}`, 'helix')
			expect(result._tag).toBe('InvalidWorkspace')
		})
	}

	for (const text of [
		'@helix hello',
		'@helix /plan --ws be',
		'/research --ws be',
		'@someone-else /research --ws be',
		'@helix-two /research --ws be',
		'',
	]) {
		it(`is not a research command: ${JSON.stringify(text)}`, ({ expect }) => {
			expect(parseResearchCommand(text, 'helix')).toEqual({ _tag: 'NotResearch' })
		})
	}
})
