import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'

import { GITHUB_OIDC_ISSUER, makeOidcVerifier, oidcProxy, parseList } from '../src/OidcProxy'
import { makeCosmosPendingResearch, makeMemoryPendingResearch, type PendingResearchStore } from '../src/PendingResearch'
import { defaultSkills } from '../src/Skills'
import { makeFakeCosmos } from './support/fake-cosmos'

const AUDIENCE = 'https://broker.example'
const WORKFLOW = 'acme/web/.github/workflows/research-broker.yml@refs/heads/main'
const DELIVERY = 'delivery:v1:abc:def'
const NOW = 1_800_000_000_000

let privateKey: CryptoKey
let verify: ReturnType<typeof makeOidcVerifier>

beforeAll(async () => {
	const pair = await generateKeyPair('RS256')
	privateKey = pair.privateKey
	verify = makeOidcVerifier(AUDIENCE, createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] }))
})

interface TokenOptions {
	readonly claims?: JWTPayload
	readonly issuer?: string
	readonly audience?: string
	readonly expiresIn?: number
}

const token = (options: TokenOptions = {}) =>
	new SignJWT({ repository_id: '8', job_workflow_ref: WORKFLOW, ...options.claims })
		.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
		.setIssuer(options.issuer ?? GITHUB_OIDC_ISSUER)
		.setAudience(options.audience ?? AUDIENCE)
		.setIssuedAt()
		.setExpirationTime(options.expiresIn ?? '5m')
		.sign(privateKey)

const pendingRecord = { deliveryId: DELIVERY, repositoryId: '8', installationId: '7', accessToken: 'task-password' }

/** A fake router standing for the delivery API: it accepts only the task password and echoes what it was sent. */
const makeRouter = (status = 200) => {
	const seen: Array<{ url: string; method: string; body: string; authorization: string | null }> = []
	const forward = async (request: Request) => {
		const body = await request.text()
		seen.push({ url: request.url, method: request.method, body, authorization: request.headers.get('authorization') })
		if (request.headers.get('authorization') !== 'Bearer task-password') return new Response('bad password', { status: 401 })
		return new Response(JSON.stringify({ ok: true, echoed: body }), { status, headers: { 'content-type': 'application/json' } })
	}
	return { seen, forward }
}

const setup = async (store: PendingResearchStore = makeMemoryPendingResearch(), routerStatus = 200) => {
	await store.save({ ...pendingRecord, expiresAt: Date.now() + 60_000 })
	const warnings: Array<string> = []
	const router = makeRouter(routerStatus)
	const proxy = oidcProxy({
		verify,
		store,
		forward: router.forward,
		allowedWorkflowRefs: parseList(`other/repo/x.yml@refs/heads/main, ${WORKFLOW}`),
		warn: (reason) => void warnings.push(reason),
	})
	return { store, warnings, router, proxy }
}

const call = (action: string, jwt: string | undefined, options: { id?: string; method?: string; body?: string } = {}) =>
	new Request(`https://broker.example/research-session/${encodeURIComponent(options.id ?? DELIVERY)}/${action}`, {
		method: options.method ?? 'POST',
		headers: { ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }), 'content-type': 'application/json' },
		...(options.method === 'GET' ? {} : { body: options.body ?? '{"markdown":"done"}' }),
	})

const complete = (jwt: string | undefined, id?: string) => call('complete', jwt, id === undefined ? {} : { id })

const expectRefused = async (response: Response) => {
	expect(response.status).toBe(401)
	expect(await response.text()).toBe('Unauthorized')
}

const stored = (store: PendingResearchStore) => store.peek(DELIVERY, Date.now())

describe.each([
	['in-memory store', () => makeMemoryPendingResearch()],
	['cosmos store', () => makeCosmosPendingResearch(makeFakeCosmos())],
])('oidcProxy over the %s', (_name, makeStore) => {
	it('forwards a good token to the delivery API with the password and returns its answer', async () => {
		const { proxy, router } = await setup(makeStore())
		const response = await proxy(call('activity', await token(), { method: 'PUT', body: '{"activity":1}' }))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ok: true, echoed: '{"activity":1}' })
		expect(router.seen).toEqual([
			{
				url: `https://broker.example/deliveries/${encodeURIComponent(DELIVERY)}/activity`,
				method: 'PUT',
				body: '{"activity":1}',
				authorization: 'Bearer task-password',
			},
		])
	})

	it('serves several calls from one record, then deletes it after a successful complete', async () => {
		const store = makeStore()
		const { proxy, router } = await setup(store)
		expect((await proxy(call('activity', await token(), { method: 'PUT' }))).status).toBe(200)
		expect((await proxy(call('skills', await token(), { method: 'GET' }))).status).toBe(200)
		expect((await proxy(call('activity', await token(), { method: 'PUT' }))).status).toBe(200)
		expect(await stored(store)).toBeDefined()
		expect((await proxy(complete(await token()))).status).toBe(200)
		expect(await stored(store)).toBeUndefined()
		expect(router.seen).toHaveLength(3)
		await expectRefused(await proxy(complete(await token())))
	})

	it('deletes the record after a successful fail', async () => {
		const store = makeStore()
		const { proxy } = await setup(store)
		expect((await proxy(call('fail', await token()))).status).toBe(200)
		expect(await stored(store)).toBeUndefined()
	})

	it('keeps the record when the delivery API refuses the complete', async () => {
		const store = makeStore()
		const { proxy } = await setup(store, 409)
		expect((await proxy(complete(await token()))).status).toBe(409)
		expect(await stored(store)).toBeDefined()
	})

	it('serves the skills list without calling the delivery API', async () => {
		const { proxy, router } = await setup(makeStore())
		const response = await proxy(call('skills', await token(), { method: 'GET' }))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual(defaultSkills)
		expect(router.seen).toEqual([])
	})

	it('never puts the password in a response body or header', async () => {
		const { proxy } = await setup(makeStore())
		const responses = [
			await proxy(call('activity', await token(), { method: 'PUT' })),
			await proxy(call('skills', await token(), { method: 'GET' })),
			await proxy(complete(await token())),
		]
		const refused = [await proxy(complete(await token({ claims: { repository_id: '9' } }))), await proxy(complete(undefined))]
		for (const response of [...responses, ...refused]) {
			expect(await response.text()).not.toContain('task-password')
			expect(JSON.stringify([...response.headers])).not.toContain('task-password')
		}
	})

	it.each([
		['wrong audience', () => token({ audience: 'https://elsewhere.example' })],
		['wrong issuer', () => token({ issuer: 'https://evil.example' })],
		['expired token', () => token({ expiresIn: Math.floor(Date.now() / 1000) - 600 })],
		['wrong repository_id', () => token({ claims: { repository_id: '9' } })],
		['numeric repository_id', () => token({ claims: { repository_id: 8 } })],
		['missing repository_id', () => token({ claims: { repository_id: undefined } })],
		['wrong workflow', () => token({ claims: { job_workflow_ref: 'acme/web/.github/workflows/other.yml@refs/heads/main' } })],
		['workflow ref with a longer branch', () => token({ claims: { job_workflow_ref: `${WORKFLOW}-evil` } })],
		['workflow ref that only starts with an allowed one', () => token({ claims: { job_workflow_ref: `${WORKFLOW}/x` } })],
		['not a jwt', async () => 'not-a-jwt'],
	])('refuses %s with 401 and keeps the record', async (_label, make) => {
		const store = makeStore()
		const { proxy, router } = await setup(store)
		await expectRefused(await proxy(complete(await make())))
		expect(router.seen).toEqual([])
		expect(await stored(store)).toBeDefined()
		expect((await proxy(complete(await token()))).status).toBe(200)
	})

	it('refuses an unknown delivery id', async () => {
		const { proxy, router } = await setup(makeStore())
		await expectRefused(await proxy(complete(await token(), 'delivery:v1:nope')))
		expect(router.seen).toEqual([])
	})

	it('refuses an expired record and keeps it out of the router', async () => {
		const store = makeStore()
		await store.save({ ...pendingRecord, expiresAt: Date.now() - 1 })
		const router = makeRouter()
		const proxy = oidcProxy({ verify, store, forward: router.forward, allowedWorkflowRefs: [WORKFLOW] })
		await expectRefused(await proxy(complete(await token())))
		expect(router.seen).toEqual([])
	})
})

describe('oidcProxy refusals', () => {
	it('refuses a token signed by another key', async () => {
		const { proxy } = await setup()
		const other = await generateKeyPair('RS256')
		const forged = await new SignJWT({ repository_id: '8', job_workflow_ref: WORKFLOW })
			.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
			.setIssuer(GITHUB_OIDC_ISSUER)
			.setAudience(AUDIENCE)
			.setExpirationTime('5m')
			.sign(other.privateKey)
		await expectRefused(await proxy(complete(forged)))
	})

	it('refuses a missing or malformed Authorization header', async () => {
		const { proxy } = await setup()
		await expectRefused(await proxy(complete(undefined)))
		const basic = new Request('https://broker.example/research-session/x/complete', {
			method: 'POST',
			headers: { authorization: 'Basic abc' },
		})
		await expectRefused(await proxy(basic))
	})

	it('refuses everything when no workflow ref is allowed', async () => {
		const store = makeMemoryPendingResearch()
		await store.save({ ...pendingRecord, expiresAt: Date.now() + 60_000 })
		const proxy = oidcProxy({ verify, store, forward: makeRouter().forward, allowedWorkflowRefs: parseList('') })
		await expectRefused(await proxy(complete(await token())))
	})

	it('logs a reason without the token and answers every refusal alike', async () => {
		const { proxy, warnings } = await setup()
		const jwt = await token({ claims: { repository_id: '9' } })
		await expectRefused(await proxy(complete(jwt)))
		expect(warnings).toEqual(['repository_id mismatch'])
		expect(warnings.join()).not.toContain(jwt)
	})

	it('answers 404 for a path or method it does not serve', async () => {
		const { proxy } = await setup()
		const jwt = await token()
		expect((await proxy(call('complete', jwt, { method: 'PUT' }))).status).toBe(404)
		expect((await proxy(call('delete', jwt))).status).toBe(404)
	})
})

describe('cosmos pending store', () => {
	it('writes the item with a ttl in a fixed partition', async () => {
		const cosmos = makeFakeCosmos()
		await makeCosmosPendingResearch(cosmos).save({ ...pendingRecord, expiresAt: NOW })
		expect(cosmos.items('pending-research').get(`research:${DELIVERY}`)).toMatchObject({ ttl: 900, repositoryId: '8' })
	})

	it('uses an item id Cosmos accepts: no slash, backslash, question mark or hash', async () => {
		const cosmos = makeFakeCosmos()
		await makeCosmosPendingResearch(cosmos).save({ ...pendingRecord, expiresAt: NOW })
		for (const id of cosmos.items('pending-research').keys()) expect(id).not.toMatch(/[/\\?#]/)
	})

	it('lets only one of two racing takes win', async () => {
		const store = makeCosmosPendingResearch(makeFakeCosmos())
		await store.save({ ...pendingRecord, expiresAt: Date.now() + 60_000 })
		expect((await Promise.all([store.take(DELIVERY), store.take(DELIVERY)])).sort()).toEqual([false, true])
	})
})
