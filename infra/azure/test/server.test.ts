/** The HTTP server, on a free port, over fake handlers. */
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { makeServer, MAX_BODY_BYTES, shutdown, type ServerRoutes } from '../src/server'

const servers: Array<ReturnType<typeof makeServer>> = []

const start = async (overrides: Partial<ServerRoutes> = {}) => {
	const seen: Array<{ readonly route: string; readonly url: string; readonly method: string; readonly body: string; readonly headers: Headers }> = []
	const record = (route: string, status: number) => async (request: Request) => {
		seen.push({ route, url: request.url, method: request.method, body: await request.text(), headers: request.headers })
		return new Response(`${route}-reply`, { status, headers: { 'x-from': route } })
	}
	const routes: ServerRoutes = {
		receiver: record('receiver', 200),
		researchSession: record('research', 200),
		...overrides,
	}
	const logs: Array<string> = []
	const server = makeServer(routes, (message) => logs.push(message))
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	return { base, seen, logs, server }
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => shutdown(server, 1_000)))
})

describe('makeServer', () => {
	it('answers GET /healthz with 200', async () => {
		const { base } = await start()
		const response = await fetch(`${base}/healthz`)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('ok')
	})

	it('sends the webhook to the receiver with the exact body bytes and lower-case headers', async () => {
		const { base, seen } = await start()
		const body = '{"text":"ça 🚀"}'
		const response = await fetch(`${base}/integrations/github/webhook`, {
			method: 'POST',
			headers: { 'X-GitHub-Event': 'issue_comment', 'content-type': 'application/json' },
			body,
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('x-from')).toBe('receiver')
		expect(await response.text()).toBe('receiver-reply')
		expect(seen).toHaveLength(1)
		expect(seen[0]?.body).toBe(body)
		expect(seen[0]?.headers.get('x-github-event')).toBe('issue_comment')
		expect(seen[0]?.method).toBe('POST')
	})

	it('only accepts POST on the webhook path', async () => {
		const { base, seen } = await start()
		expect((await fetch(`${base}/integrations/github/webhook`)).status).toBe(404)
		expect(seen).toEqual([])
	})

	it('sends /deliveries/... to the receiver for GET, POST, PUT and DELETE', async () => {
		const { base, seen } = await start()
		for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
			const response = await fetch(`${base}/deliveries/d-1/complete`, { method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) })
			expect(response.status).toBe(200)
		}
		expect(seen.map(({ route }) => route)).toEqual(['receiver', 'receiver', 'receiver', 'receiver'])
		expect(seen[0]?.url).toContain('/deliveries/d-1/complete')
	})

	it('sends /research-session/{id}/{action} to the research proxy', async () => {
		const { base, seen } = await start()
		const response = await fetch(`${base}/research-session/d-1/complete`, { method: 'POST', body: '{"markdown":"done"}' })
		expect(response.status).toBe(200)
		expect(seen[0]?.route).toBe('research')
		expect(seen[0]?.body).toBe('{"markdown":"done"}')
		expect((await fetch(`${base}/research-session/d-1/complete`, { method: 'DELETE' })).status).toBe(404)
		expect((await fetch(`${base}/research-session/d-1`, { method: 'POST' })).status).toBe(404)
	})

	it('builds an https URL when the proxy sets x-forwarded-proto', async () => {
		const { base, seen } = await start()
		await fetch(`${base}/research-session/d-1/fail`, { method: 'POST', headers: { 'x-forwarded-proto': 'https' } })
		expect(seen[0]?.url.startsWith('https://')).toBe(true)
	})

	it('serves /skills: 401 without a delivery token, the default skills with one the receiver accepts', async () => {
		const { base } = await start()
		expect((await fetch(`${base}/skills`)).status).toBe(401)
		const ok = await fetch(`${base}/skills?deliveryId=d-1`, { headers: { authorization: 'Bearer t' } })
		expect(ok.status).toBe(200)
		expect(Array.isArray(await ok.json())).toBe(true)
	})

	it('returns 404 for an unknown path', async () => {
		const { base } = await start()
		expect((await fetch(`${base}/nope`)).status).toBe(404)
	})

	it('returns 500 and logs when a handler throws', async () => {
		const { base, logs } = await start({ receiver: () => Promise.reject(new Error('boom')) })
		const response = await fetch(`${base}/integrations/github/webhook`, { method: 'POST', body: '{}' })
		expect(response.status).toBe(500)
		expect(logs).toContain('request failed')
	})

	it('returns 204 with no body', async () => {
		const { base } = await start({ receiver: () => Promise.resolve(new Response(null, { status: 204 })) })
		const response = await fetch(`${base}/deliveries/d-1`, { method: 'DELETE' })
		expect(response.status).toBe(204)
		expect(await response.text()).toBe('')
	})

	it('returns 413 for a body over the limit', async () => {
		const { base } = await start()
		const response = await fetch(`${base}/integrations/github/webhook`, { method: 'POST', body: new Uint8Array(MAX_BODY_BYTES + 1) })
		expect(response.status).toBe(413)
	})
})

describe('shutdown', () => {
	it('lets an open request finish, then closes', async () => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => (release = resolve))
		const { base, server } = await start({
			receiver: async () => {
				await gate
				return new Response('late', { status: 200 })
			},
		})
		const pending = fetch(`${base}/deliveries/d-1`)
		await new Promise((resolve) => setTimeout(resolve, 50))
		const closing = shutdown(server, 5_000)
		release()
		expect(await (await pending).text()).toBe('late')
		await closing
		expect(server.listening).toBe(false)
	})

	it('gives up after the grace time', async () => {
		const { base, server } = await start({ receiver: () => new Promise<Response>(() => {}) })
		void fetch(`${base}/deliveries/d-1`).catch(() => {})
		await new Promise((resolve) => setTimeout(resolve, 50))
		const started = Date.now()
		await shutdown(server, 150)
		expect(Date.now() - started).toBeLessThan(2_000)
	})
})
