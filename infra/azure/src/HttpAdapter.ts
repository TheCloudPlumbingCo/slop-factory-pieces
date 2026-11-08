/** The parts of an incoming HTTP request the Receiver needs; `server.ts` fills them from Node's request, tests pass a plain object. */
export interface HttpRequestLike {
	readonly url: string
	readonly method: string
	readonly headers: { forEach: (callback: (value: string, name: string) => void) => void }
	readonly arrayBuffer: () => Promise<ArrayBuffer>
}

/** What the server writes back. */
export interface HttpResult {
	readonly status: number
	readonly headers: Record<string, string>
	readonly body: string
}

/** A web `Request` with the original body bytes (never re-serialized) and lower-cased headers. */
export const toWebRequest = async (request: HttpRequestLike): Promise<Request> => {
	const headers = new Headers()
	request.headers.forEach((value, name) => headers.set(name.toLowerCase(), value))
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	return new Request(request.url, {
		method: request.method,
		headers,
		...(hasBody ? { body: new Uint8Array(await request.arrayBuffer()) } : {}),
	})
}

/** The status, headers and text body of a web `Response`. */
export const toHttpResult = async (response: Response): Promise<HttpResult> => {
	const headers: Record<string, string> = {}
	response.headers.forEach((value, name) => {
		headers[name] = value
	})
	return { status: response.status, headers, body: await response.text() }
}
