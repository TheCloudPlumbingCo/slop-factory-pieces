import { generateKeyPairSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { appJwt, dispatchRepositoryEvent, installationToken } from '../src/GithubDispatch'

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const credentials = { appId: '123', privateKey }

interface Call {
	readonly url: string
	readonly init: RequestInit
}

/** A fake fetch that records calls and answers each in turn. */
const fakeFetch = (answers: ReadonlyArray<Response>) => {
	const calls: Array<Call> = []
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init })
		return answers[calls.length - 1]!
	}) as unknown as typeof fetch
	return { calls, fetchImpl }
}

const dispatch = {
	installationId: 7,
	owner: 'acme',
	repository: 'web',
	eventType: 'slopcodebot-research',
	clientPayload: { task: 'why does CI fail?' },
}

describe('appJwt', () => {
	it('signs a three-part token naming the App, valid for under ten minutes', () => {
		const jwt = appJwt(credentials, 1_700_000_000_000)
		const [header, payload, signature] = jwt.split('.')
		expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
		const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { iss: string; iat: number; exp: number }
		expect(claims.iss).toBe('123')
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
		expect(signature!.length).toBeGreaterThan(100)
	})

	it('accepts a key whose newlines are written as backslash-n', () => {
		const escaped = { appId: '123', privateKey: privateKey.replace(/\n/g, '\\n') }
		expect(appJwt(escaped, 1_700_000_000_000).split('.')).toHaveLength(3)
	})
})

describe('dispatchRepositoryEvent', () => {
	it('gets an installation token, then posts the dispatch with it', async () => {
		const { calls, fetchImpl } = fakeFetch([
			new Response(JSON.stringify({ token: 'inst-token' }), { status: 201 }),
			new Response(null, { status: 204 }),
		])
		await dispatchRepositoryEvent(credentials, dispatch, fetchImpl, 1_700_000_000_000)
		expect(calls[0]!.url).toBe('https://api.github.com/app/installations/7/access_tokens')
		// The dispatch asks for the App's full permissions, as it always did: no body on the token request.
		expect(calls[0]!.init.body).toBeUndefined()
		expect(calls[1]!.url).toBe('https://api.github.com/repos/acme/web/dispatches')
		expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer inst-token')
		expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
			event_type: 'slopcodebot-research',
			client_payload: { task: 'why does CI fail?' },
		})
	})

	it('throws with GitHub status when the installation token is refused', async () => {
		const { fetchImpl } = fakeFetch([new Response('Not Found', { status: 404 })])
		await expect(dispatchRepositoryEvent(credentials, dispatch, fetchImpl)).rejects.toThrow(/404/)
	})

	it('throws when the dispatch is not accepted', async () => {
		const { fetchImpl } = fakeFetch([
			new Response(JSON.stringify({ token: 't', permissions: { issues: 'write', metadata: 'read' } }), { status: 201 }),
			new Response('Resource not accessible by integration', { status: 403 }),
		])
		await expect(dispatchRepositoryEvent(credentials, dispatch, fetchImpl)).rejects.toThrow(
			/403.*not accessible.*issues=write, metadata=read/,
		)
	})
})

describe('installationToken', () => {
	it('narrows the token to the permissions asked for', async () => {
		const { calls, fetchImpl } = fakeFetch([new Response(JSON.stringify({ token: 'narrow' }), { status: 201 })])
		const result = await installationToken(credentials, 7, {
			permissions: { organization_projects: 'write' },
			fetchImpl,
			nowMs: 1_700_000_000_000,
		})
		expect(result.token).toBe('narrow')
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ permissions: { organization_projects: 'write' } })
		expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json')
	})

	it('throws with the status when GitHub refuses the narrower permissions', async () => {
		const { fetchImpl } = fakeFetch([new Response('permissions not granted', { status: 422 })])
		await expect(installationToken(credentials, 7, { permissions: { organization_projects: 'write' }, fetchImpl })).rejects.toThrow(/422/)
	})
})
