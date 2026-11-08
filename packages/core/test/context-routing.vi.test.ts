import { describe, it } from '@effect/vitest'
import { Option } from 'effect'

import { jiraProjectKey, parseContextRoutes, routeContext } from '../src/channels/ContextRouting'

const ctm = { repo: 'acme/ceylon-workspace', workspace: 'be', board: 4 }
const abc = { repo: 'acme/other-workspace', workspace: 'fe' }

const mapJson = JSON.stringify({ CTM: ctm, ABC: abc, default: { repo: 'acme/default-workspace', workspace: 'be' } })

const parsed = (json: string) => {
	const result = parseContextRoutes(json)
	if (!result.ok) throw new Error(`expected a valid map: ${result.error}`)
	return result.map
}

describe('jiraProjectKey', () => {
	it('is the part of an issue key before the last dash', ({ expect }) => {
		expect(jiraProjectKey('CTM-12')).toEqual(Option.some('CTM'))
		expect(jiraProjectKey('MY-APP-7')).toEqual(Option.some('MY-APP'))
	})

	for (const key of ['', 'CTM', '-12', 'CTM-', 'CTM-x']) {
		it(`is None for ${JSON.stringify(key)}`, ({ expect }) => {
			expect(jiraProjectKey(key)).toEqual(Option.none())
		})
	}
})

describe('parseContextRoutes', () => {
	it('reads a map of project keys to workspace targets', ({ expect }) => {
		const result = parseContextRoutes(JSON.stringify({ CTM: ctm, ABC: abc }))
		expect(result).toEqual({ ok: true, map: { projects: { CTM: ctm, ABC: abc }, fallback: undefined } })
	})

	it('reads the default entry apart from the projects', ({ expect }) => {
		const map = parsed(mapJson)
		expect(Object.keys(map.projects).sort()).toEqual(['ABC', 'CTM'])
		expect(map.fallback).toEqual({ repo: 'acme/default-workspace', workspace: 'be' })
	})

	const bad: ReadonlyArray<readonly [string, string]> = [
		['not JSON', '{nope'],
		['not an object', '[]'],
		['a repo without owner', JSON.stringify({ CTM: { repo: 'workspace', workspace: 'be' } })],
		['an invalid workspace id', JSON.stringify({ CTM: { repo: 'a/b', workspace: 'Not Valid' } })],
		['a missing workspace', JSON.stringify({ CTM: { repo: 'a/b' } })],
		['a non-integer board', JSON.stringify({ CTM: { repo: 'a/b', workspace: 'be', board: 'four' } })],
		['a zero board', JSON.stringify({ CTM: { repo: 'a/b', workspace: 'be', board: 0 } })],
	]
	for (const [name, json] of bad) {
		it(`rejects ${name}`, ({ expect }) => {
			expect(parseContextRoutes(json).ok).toBe(false)
		})
	}
})

describe('routeContext', () => {
	it('picks the entry for the issue key project', ({ expect }) => {
		expect(routeContext(parsed(mapJson), 'ABC-3')).toEqual(Option.some(abc))
	})

	it('falls back to the default entry for an unmapped project', ({ expect }) => {
		expect(routeContext(parsed(mapJson), 'ZZZ-1')).toEqual(
			Option.some({ repo: 'acme/default-workspace', workspace: 'be' }),
		)
	})

	it('is None for an unmapped project when there is no default', ({ expect }) => {
		expect(routeContext(parsed(JSON.stringify({ CTM: ctm })), 'ZZZ-1')).toEqual(Option.none())
	})

	it('is None for a malformed issue key', ({ expect }) => {
		expect(routeContext(parsed(mapJson), 'nope')).toEqual(Option.none())
	})
})
