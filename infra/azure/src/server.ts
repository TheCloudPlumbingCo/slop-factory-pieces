/**
 * The broker's HTTP server for one Container App. It maps the routes the Functions app served onto the handlers:
 *
 * - `POST /integrations/github/webhook`: the GitHub webhook
 * - `GET|POST|PUT|DELETE /deliveries/...`: the delivery API
 * - `GET|PUT|POST /research-session/{id}/{action}`: the runner's calls, with a GitHub OIDC token
 * - `GET /skills`: the skills list the runner installs
 * - `GET /healthz`: answers 200 for the platform's probes
 *
 * `main.ts` starts it. This file only builds it, so tests can run it on a free port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { type HttpRequestLike, toHttpResult, toWebRequest } from './HttpAdapter'
import { skillsResponse } from './Skills'

/** GitHub sends webhook bodies up to 25 MB. A larger body gets 413. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024

/** What the server needs: each is a function from a web `Request` to a `Response`. */
export interface ServerRoutes {
	readonly receiver: (request: Request) => Promise<Response>
	readonly researchSession: (request: Request) => Promise<Response>
	/** `SKILLS_JSON`; `undefined` serves the default skills. */
	readonly skillsJson?: string | undefined
}

class BodyTooLarge extends Error {}

const readBody = async (request: IncomingMessage): Promise<ArrayBuffer> => {
	const chunks: Array<Buffer> = []
	let size = 0
	for await (const chunk of request) {
		const buffer = chunk as Buffer
		size += buffer.length
		if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
		chunks.push(buffer)
	}
	const body = Buffer.concat(chunks)
	return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
}

/** The request as the adapter wants it. The proxy in front of the app sets `x-forwarded-proto`; the app sees plain HTTP. */
const toRequestLike = (request: IncomingMessage): HttpRequestLike => {
	const forwarded = request.headers['x-forwarded-proto']
	const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
	return {
		url: `${first === 'https' ? 'https' : 'http'}://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`,
		method: request.method ?? 'GET',
		headers: {
			forEach: (callback) => {
				for (const [name, value] of Object.entries(request.headers)) {
					if (value !== undefined) callback(Array.isArray(value) ? value.join(', ') : value, name)
				}
			},
		},
		arrayBuffer: () => readBody(request),
	}
}

type Route = (request: Request) => Promise<Response>

/** The handler for a method and path, or `undefined` for a 404. */
const pick = (routes: ServerRoutes, method: string, pathname: string): Route | undefined => {
	if (pathname === '/integrations/github/webhook') return method === 'POST' ? routes.receiver : undefined
	if (pathname === '/deliveries' || pathname.startsWith('/deliveries/')) {
		return ['GET', 'POST', 'PUT', 'DELETE'].includes(method) ? routes.receiver : undefined
	}
	if (/^\/research-session\/[^/]+\/[^/]+\/?$/.test(pathname)) {
		return ['GET', 'PUT', 'POST'].includes(method) ? routes.researchSession : undefined
	}
	if (pathname === '/skills') {
		return method === 'GET' ? (request) => skillsResponse(request, routes.receiver, routes.skillsJson) : undefined
	}
	return undefined
}

const send = (response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
	response.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers })
	response.end(body)
}

/** Build the server. It does not listen yet. */
export const makeServer = (routes: ServerRoutes, log: (message: string, error?: unknown) => void = console.error): Server =>
	createServer((incoming, outgoing) => {
		void (async () => {
			try {
				const pathname = new URL(incoming.url ?? '/', 'http://localhost').pathname
				const method = incoming.method ?? 'GET'
				if (pathname === '/healthz') {
					return method === 'GET'
						? send(outgoing, 200, 'ok', { 'content-type': 'text/plain' })
						: send(outgoing, 405, 'Method not allowed')
				}
				const route = pick(routes, method, pathname)
				if (route === undefined) return send(outgoing, 404, 'Not found')
				const result = await toHttpResult(await route(await toWebRequest(toRequestLike(incoming))))
				const { 'content-length': _length, 'transfer-encoding': _encoding, ...headers } = result.headers
				send(outgoing, result.status, result.status === 204 || result.status === 205 ? '' : result.body, headers)
			} catch (error) {
				if (error instanceof BodyTooLarge) return send(outgoing, 413, 'Payload too large')
				log('request failed', error)
				if (!outgoing.headersSent) send(outgoing, 500, 'Internal Server Error')
				else outgoing.end()
			}
		})()
	})

/**
 * Stop taking new connections and wait for the open ones to finish, at most `graceMs`. Resolves when the server has
 * closed or the time is up.
 */
export const shutdown = (server: Server, graceMs: number): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, graceMs)
		server.close(() => {
			clearTimeout(timer)
			resolve()
		})
		server.closeIdleConnections()
	})
