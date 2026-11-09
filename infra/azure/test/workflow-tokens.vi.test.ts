import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { makeWorkflowTokenMinter } from '../src/WorkflowTokens'

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const pending = {
	deliveryId: 'd',
	repositoryId: '8',
	installationId: '7',
	owner: 'acme',
	repository: 'web',
	accessToken: 'task-password',
	expiresAt: 0,
}

const run = async (kind: 'read' | 'publish') => {
	const calls: Array<{ url: string; body: unknown }> = []
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body as string) })
		return new Response(JSON.stringify({ token: 'ghs_x' }), { status: 201 })
	}) as unknown as typeof fetch
	const result = await makeWorkflowTokenMinter({ appId: '123', privateKey }, fetchImpl)(kind, pending)
	return { calls, result }
}

describe('workflow tokens', () => {
	it('mints a contents read token for the installation', async () => {
		const { calls, result } = await run('read')
		expect(result).toEqual({ token: 'ghs_x' })
		expect(calls).toEqual([{ url: 'https://api.github.com/app/installations/7/access_tokens', body: { permissions: { contents: 'read' } } }])
	})

	it('mints a publish token limited to the one repository', async () => {
		const { calls } = await run('publish')
		expect(calls[0]!.body).toEqual({ permissions: { pull_requests: 'write', issues: 'write' }, repositories: ['web'] })
	})
})
