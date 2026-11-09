import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'

import type { PendingResearchStore } from './PendingResearch'
import { skillsListResponse } from './Skills'
import type { MintWorkflowToken, WorkflowTokenKind } from './WorkflowTokens'

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const GITHUB_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`

/** Checks signature, issuer, audience and exp/nbf of a GitHub OIDC token; throws when any fails. */
export type OidcVerifier = (jwt: string) => Promise<JWTPayload>

/**
 * @param audience - the value the runner asked for; the token's `aud` must equal it
 * @param keys - GitHub's JWKS by default (cached and refetched by jose); tests pass a local set
 */
export const makeOidcVerifier = (
	audience: string,
	keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(GITHUB_JWKS_URL)),
): OidcVerifier => {
	return async (jwt) => {
		const { payload } = await jwtVerify(jwt, keys, { issuer: GITHUB_OIDC_ISSUER, audience, algorithms: ['RS256'] })
		return payload
	}
}

export interface OidcProxyOptions {
	readonly verify: OidcVerifier
	readonly store: PendingResearchStore
	/** Allowed `job_workflow_ref` values; each must equal the claim exactly. */
	readonly allowedWorkflowRefs: ReadonlyArray<string>
	/** The broker's own router (the SDK delivery API lives on it); it receives the stored task password. */
	readonly forward: (request: Request) => Promise<Response>
	/** `SKILLS_JSON`; `undefined` serves the default skills. */
	readonly skillsJson?: string | undefined
	/** Makes the GitHub tokens a workflow asks for at `token/read` and `token/publish`. Without it those routes answer 404. */
	readonly mintToken?: MintWorkflowToken
	readonly now?: () => number
	/** Where the reason for a refusal goes; never a token. */
	readonly warn?: (reason: string) => void
}

/** Split a comma separated setting into trimmed, non-empty values. */
export const parseList = (value: string): ReadonlyArray<string> =>
	value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '')

const unauthorized = () => new Response('Unauthorized', { status: 401 })

/** The delivery API call each proxy action stands for. */
const ACTIONS = {
	activity: { method: 'PUT', finishes: false },
	skills: { method: 'GET', finishes: false },
	complete: { method: 'POST', finishes: true },
	fail: { method: 'POST', finishes: true },
} as const
type Action = keyof typeof ACTIONS

type Route =
	| { readonly deliveryId: string; readonly action: Action }
	| { readonly deliveryId: string; readonly action: 'token'; readonly kind: WorkflowTokenKind }

const parsePath = (url: string): Route | undefined => {
	const pathname = new URL(url).pathname
	const tokenMatch = /^\/research-session\/([^/]+)\/token\/(read|publish)\/?$/.exec(pathname)
	const match = /^\/research-session\/([^/]+)\/(activity|skills|complete|fail)\/?$/.exec(pathname)
	if (tokenMatch === null && match === null) return undefined
	try {
		if (tokenMatch !== null) {
			return { deliveryId: decodeURIComponent(tokenMatch[1]!), action: 'token', kind: tokenMatch[2] as WorkflowTokenKind }
		}
		return { deliveryId: decodeURIComponent(match![1]!), action: match![2] as Action }
	} catch {
		return undefined
	}
}

/**
 * `research-session/{deliveryId}/{activity|skills|complete|fail}`: the runner proves itself with a GitHub OIDC token
 * on every call and the broker acts on its behalf with the task password, which never leaves the broker. Every auth
 * refusal is the same bare 401 (the reason goes to `warn`) and leaves the record alone. The record serves many calls;
 * a forwarded `complete` or `fail` that succeeds deletes it, otherwise it expires by ttl.
 */
export const oidcProxy =
	(options: OidcProxyOptions) =>
	async (request: Request): Promise<Response> => {
		const warn = options.warn ?? (() => {})
		const now = options.now ?? Date.now
		const refuse = (reason: string) => (warn(reason), unauthorized())
		const route = parsePath(request.url)
		if (route === undefined) return new Response('Not found', { status: 404 })
		if (route.action === 'token' ? request.method !== 'POST' || options.mintToken === undefined : request.method !== ACTIONS[route.action].method) {
			return new Response('Not found', { status: 404 })
		}
		const { deliveryId } = route
		const header = request.headers.get('authorization')
		const jwt = header !== null && /^Bearer\s+\S+$/i.test(header) ? header.split(/\s+/)[1]! : undefined
		if (jwt === undefined) return refuse('missing bearer token')

		let claims: JWTPayload
		try {
			claims = await options.verify(jwt)
		} catch (error) {
			// jose error names the failed check and never carries the token.
			return refuse(`token rejected: ${error instanceof Error ? error.name : 'unknown'}`)
		}
		let pending
		try {
			pending = await options.store.peek(deliveryId, now())
		} catch {
			return refuse('pending store unavailable')
		}
		if (pending === undefined) return refuse('unknown or expired delivery')
		if (typeof claims.repository_id !== 'string' || claims.repository_id !== pending.repositoryId) {
			return refuse('repository_id mismatch')
		}
		const workflowRef = claims.job_workflow_ref
		if (typeof workflowRef !== 'string' || !options.allowedWorkflowRefs.includes(workflowRef)) {
			return refuse('job_workflow_ref not allowed')
		}

		if (route.action === 'token') {
			// The record stays: the workflow asks for both tokens, and `complete` or `fail` ends it.
			try {
				const { token } = await options.mintToken!(route.kind, pending)
				return new Response(JSON.stringify({ token }), { status: 200, headers: { 'content-type': 'application/json' } })
			} catch (error) {
				// GitHub's message can name a permission; it never holds a token.
				warn(`token not issued: ${error instanceof Error ? error.message : 'unknown'}`)
				return new Response('Token not issued', { status: 502 })
			}
		}
		const { action } = route
		if (action === 'skills') return skillsListResponse(options.skillsJson)

		const target = new URL(`/deliveries/${encodeURIComponent(deliveryId)}/${action}`, request.url)
		const contentType = request.headers.get('content-type')
		const forwarded = await options.forward(
			new Request(target, {
				method: request.method,
				headers: {
					authorization: `Bearer ${pending.accessToken}`,
					...(contentType === null ? {} : { 'content-type': contentType }),
				},
				body: new Uint8Array(await request.arrayBuffer()),
			}),
		)
		// Copy only status, content type and body: nothing else of the internal response reaches the runner.
		const body = await forwarded.text()
		if (ACTIONS[action].finishes && forwarded.status >= 200 && forwarded.status < 300) {
			await options.store.take(deliveryId).catch(() => false)
		}
		const forwardedType = forwarded.headers.get('content-type')
		return new Response(forwarded.status === 204 || forwarded.status === 205 ? null : body, {
			status: forwarded.status,
			headers: forwardedType === null ? {} : { 'content-type': forwardedType },
		})
	}
