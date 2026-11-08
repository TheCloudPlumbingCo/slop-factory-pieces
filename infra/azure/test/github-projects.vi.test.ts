import { generateKeyPairSync } from 'node:crypto'

import { CardMover } from '@slop/core'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { GithubCardMoverLive } from '../src/GithubProjects'

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const credentials = { appId: '123', privateKey }

interface Call {
	readonly url: string
	readonly init: RequestInit
	readonly body: Record<string, unknown> | undefined
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const OPTIONS = [
	{ id: 'o-todo', name: 'Todo' },
	{ id: 'o-research', name: 'Research' },
	{ id: 'o-design', name: 'Design' },
]

/** The project answer: id P1, a Status field F1 with the options above. */
const projectAnswer = (options = OPTIONS) => ({
	data: { organization: { projectV2: { id: 'P1', field: { id: 'F1', options } } } },
})

/** The issue answer. `status` is the card's current column on project P1, or `undefined` for "not on the board". */
const issueAnswer = (status: string | undefined, onProject = 'P1') => ({
	data: {
		repository: {
			issue: {
				id: 'I1',
				projectItems: {
					nodes:
						status === undefined
							? []
							: [{ id: 'ITEM1', project: { id: onProject }, fieldValueByName: status === '' ? null : { name: status } }],
				},
			},
		},
	},
})

/**
 * A fake GitHub. Token requests get a token; `/graphql` is answered by `graphql(query, variables)`; a contents read is
 * answered by `contents(path)`. Every call is recorded.
 */
const fakeGithub = (handlers: {
	readonly graphql?: (query: string, variables: Record<string, unknown>) => unknown
	readonly contents?: (path: string) => Response
	readonly tokenStatus?: number
}) => {
	const calls: Array<Call> = []
	const logs: Array<string> = []
	const fetchImpl = (async (url: string, init: RequestInit = {}) => {
		const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
		calls.push({ url, init, body })
		if (url.includes('/access_tokens')) {
			if (handlers.tokenStatus !== undefined && handlers.tokenStatus !== 201) return new Response('nope', { status: handlers.tokenStatus })
			return json({ token: 'ghs_installation' }, 201)
		}
		if (url.endsWith('/graphql')) {
			const { query, variables } = body as { query: string; variables: Record<string, unknown> }
			return json(handlers.graphql?.(query, variables) ?? { data: {} })
		}
		if (url.includes('/contents/')) return handlers.contents?.(url.split('/contents/')[1]!) ?? new Response('', { status: 404 })
		throw new Error(`unexpected url ${url}`)
	}) as unknown as typeof fetch
	return { calls, logs, fetchImpl, log: (message: string, error?: unknown) => void logs.push(error === undefined ? message : `${message} | ${String(error)}`) }
}

const withMover = <A>(github: ReturnType<typeof fakeGithub>, use: (mover: Context.Service.Shape<typeof CardMover>) => Effect.Effect<A>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const layer = GithubCardMoverLive(credentials, { fetchImpl: github.fetchImpl, log: github.log })
			const mover = Context.get(yield* Layer.build(layer), CardMover)
			return yield* use(mover)
		}).pipe(Effect.scoped),
	)

const target = { installationId: 7, owner: 'acme', repository: 'ws', issueNumber: 42, projectNumber: 4 }

/** The graphql handler of a board where the card sits in `status`; records the mutations. */
const board = (status: string | undefined, options = OPTIONS) => {
	const mutations: Array<{ name: string; variables: Record<string, unknown> }> = []
	const graphql = (query: string, variables: Record<string, unknown>) => {
		if (query.includes('addProjectV2ItemById')) {
			mutations.push({ name: 'add', variables })
			return { data: { addProjectV2ItemById: { item: { id: 'ITEM-NEW' } } } }
		}
		if (query.includes('updateProjectV2ItemFieldValue')) {
			mutations.push({ name: 'set', variables })
			return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } } } }
		}
		if (query.includes('projectV2(number')) return projectAnswer(options)
		return issueAnswer(status)
	}
	return { graphql, mutations }
}

describe('projectNumber', () => {
	const ask = { installationId: 7, owner: 'acme', repository: 'ws', workspace: 'be' }

	it('reads workspace.json with a token that holds only Contents read', async () => {
		const github = fakeGithub({ contents: () => new Response('{"repos":[],"project":4}') })
		const number = await withMover(github, (mover) => mover.projectNumber(ask))
		expect(number).toBe(4)
		const tokenCall = github.calls.find((call) => call.url.includes('/access_tokens'))!
		expect(tokenCall.url).toContain('/app/installations/7/access_tokens')
		expect(tokenCall.body).toEqual({ permissions: { contents: 'read' } })
		const read = github.calls.find((call) => call.url.includes('/contents/'))!
		expect(read.url).toContain('/repos/acme/ws/contents/workspaces/be/workspace.json')
		expect((read.init.headers as Record<string, string>).authorization).toBe('Bearer ghs_installation')
	})

	it('answers undefined, and logs, when the file is missing', async () => {
		const github = fakeGithub({ contents: () => new Response('Not Found', { status: 404 }) })
		expect(await withMover(github, (mover) => mover.projectNumber(ask))).toBeUndefined()
		expect(github.logs.join('\n')).toContain('404')
	})

	it('answers undefined when the file has no project number', async () => {
		for (const text of ['{"repos":[]}', '{"project":"4"}', '{"project":0}', 'not json']) {
			const github = fakeGithub({ contents: () => new Response(text) })
			expect(await withMover(github, (mover) => mover.projectNumber(ask)), text).toBeUndefined()
		}
	})

	it('answers undefined, and logs, when GitHub refuses the token', async () => {
		const github = fakeGithub({ tokenStatus: 403 })
		expect(await withMover(github, (mover) => mover.projectNumber(ask))).toBeUndefined()
		expect(github.logs.join('\n')).toContain('could not read workspace.json')
	})
})

describe('moveCard', () => {
	it('asks for a token with Issues read and Projects write, and sets the column of a card on the board', async () => {
		const { graphql, mutations } = board('Todo')
		const github = fakeGithub({ graphql })
		await withMover(github, (mover) => mover.moveCard({ ...target, column: 'Research' }))
		const tokenCall = github.calls.find((call) => call.url.includes('/access_tokens'))!
		expect(tokenCall.body).toEqual({ permissions: { issues: 'read', organization_projects: 'write' } })
		expect(mutations).toEqual([
			{ name: 'set', variables: expect.objectContaining({ project: 'P1', item: 'ITEM1', field: 'F1', option: 'o-research' }) },
		])
		const projectCall = github.calls.find((call) => String(call.body?.query).includes('projectV2(number'))!
		expect(projectCall.body?.variables).toEqual({ owner: 'acme', number: 4 })
	})

	it('adds a card that is not on the board, then sets its column', async () => {
		const { graphql, mutations } = board(undefined)
		const github = fakeGithub({ graphql })
		await withMover(github, (mover) => mover.moveCard({ ...target, column: 'Research' }))
		expect(mutations.map((mutation) => mutation.name)).toEqual(['add', 'set'])
		expect(mutations[0]!.variables).toEqual({ project: 'P1', content: 'I1' })
		expect(mutations[1]!.variables).toMatchObject({ item: 'ITEM-NEW', option: 'o-research' })
	})

	it('sets the column of a card that is on the board with no Status yet', async () => {
		const { graphql, mutations } = board('')
		await withMover(fakeGithub({ graphql }), (mover) => mover.moveCard({ ...target, column: 'Research' }))
		expect(mutations.map((mutation) => mutation.name)).toEqual(['set'])
	})

	it('never moves a card backwards', async () => {
		const { graphql, mutations } = board('Design')
		const github = fakeGithub({ graphql })
		await withMover(github, (mover) => mover.moveCard({ ...target, column: 'Research' }))
		expect(mutations).toEqual([])
		expect(github.logs.join('\n')).toContain('kept')
	})

	it('keeps a card that is already in the column', async () => {
		const { graphql, mutations } = board('Research')
		await withMover(fakeGithub({ graphql }), (mover) => mover.moveCard({ ...target, column: 'Research' }))
		expect(mutations).toEqual([])
	})

	it('ignores a card of the issue on another project', async () => {
		const mutations: Array<string> = []
		const github = fakeGithub({
			graphql: (query) => {
				if (query.includes('addProjectV2ItemById')) return (mutations.push('add'), { data: { addProjectV2ItemById: { item: { id: 'N' } } } })
				if (query.includes('updateProjectV2ItemFieldValue')) return (mutations.push('set'), { data: {} })
				if (query.includes('projectV2(number')) return projectAnswer()
				return issueAnswer('Design', 'OTHER')
			},
		})
		await withMover(github, (mover) => mover.moveCard({ ...target, column: 'Research' }))
		expect(mutations).toEqual(['add', 'set'])
	})

	it('logs, and does not throw, when GraphQL answers with an error', async () => {
		const github = fakeGithub({ graphql: () => ({ errors: [{ message: 'Resource not accessible by integration' }] }) })
		await expect(withMover(github, (mover) => mover.moveCard({ ...target, column: 'Research' }))).resolves.toBeUndefined()
		expect(github.logs.join('\n')).toContain('Resource not accessible by integration')
	})

	it('logs, and does not throw, when the project has no Status of that name', async () => {
		const { graphql, mutations } = board('Todo', [{ id: 'o-todo', name: 'Todo' }])
		const github = fakeGithub({ graphql })
		await withMover(github, (mover) => mover.moveCard({ ...target, column: 'Research' }))
		expect(mutations).toEqual([])
		expect(github.logs.join('\n')).toContain("no Status called 'Research'")
	})

	it('logs, and does not throw, when the token request fails', async () => {
		const github = fakeGithub({ tokenStatus: 422 })
		await expect(withMover(github, (mover) => mover.moveCard({ ...target, column: 'Research' }))).resolves.toBeUndefined()
		expect(github.logs.join('\n')).toContain('could not move the card')
	})

	it('never puts a token in a log line', async () => {
		const github = fakeGithub({ graphql: () => ({ errors: [{ message: 'boom' }] }) })
		await withMover(github, (mover) => mover.moveCard({ ...target, column: 'Research' }))
		expect(github.logs.join('\n')).not.toContain('ghs_installation')
	})
})
