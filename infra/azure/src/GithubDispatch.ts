import { createSign } from 'node:crypto'

/** The GitHub App credentials the dispatcher signs in with (the same App the bot uses). */
export interface AppCredentials {
	readonly appId: string
	/** The App's PEM private key. Literal `\n` sequences are turned into newlines, as Key Vault values often hold them. */
	readonly privateKey: string
	readonly apiOrigin?: string
}

/** A `repository_dispatch` to send to one repository the App is installed on. */
export interface RepositoryDispatch {
	readonly installationId: number
	readonly owner: string
	readonly repository: string
	readonly eventType: string
	readonly clientPayload: Readonly<Record<string, unknown>>
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url')

/** A short-lived JWT that proves we are the App. GitHub allows at most 10 minutes. */
export const appJwt = (credentials: AppCredentials, nowMs: number): string => {
	const nowSeconds = Math.floor(nowMs / 1000)
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
	const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: credentials.appId }))
	const key = credentials.privateKey.replace(/\\n/g, '\n')
	const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key)
	return `${header}.${payload}.${base64url(signature)}`
}

export const githubHeaders = (token: string) => ({
	accept: 'application/vnd.github+json',
	authorization: `Bearer ${token}`,
	'x-github-api-version': '2022-11-28',
	'user-agent': 'slop-code-factory-azure',
})

/** What GitHub answers to an installation token request: the token and the permissions it holds. */
export interface InstallationToken {
	readonly token: string
	readonly permissions?: Readonly<Record<string, string>>
}

/**
 * Get an installation token for the App. Without `permissions` the token has every permission the App holds on the
 * installation, as the dispatch has always used. With `permissions` the token is narrowed to those, such as
 * `{ organization_projects: 'write' }`; GitHub answers 422 when the App does not hold one of them.
 *
 * @param fetchImpl - the HTTP function; tests pass a fake
 */
export const installationToken = async (
	credentials: AppCredentials,
	installationId: number,
	options: {
		readonly permissions?: Readonly<Record<string, string>>
		/** Repository names (not owner/name) the token may reach. Without it the token reaches every repo of the installation. */
		readonly repositories?: ReadonlyArray<string>
		readonly fetchImpl?: typeof fetch
		readonly nowMs?: number
	} = {},
): Promise<InstallationToken> => {
	const fetchImpl = options.fetchImpl ?? fetch
	const origin = credentials.apiOrigin ?? 'https://api.github.com'
	const narrowed = options.permissions !== undefined || options.repositories !== undefined
	const tokenResponse = await fetchImpl(`${origin}/app/installations/${installationId}/access_tokens`, {
		method: 'POST',
		headers: narrowed
			? { ...githubHeaders(appJwt(credentials, options.nowMs ?? Date.now())), 'content-type': 'application/json' }
			: githubHeaders(appJwt(credentials, options.nowMs ?? Date.now())),
		...(narrowed
			? {
					body: JSON.stringify({
						...(options.permissions === undefined ? {} : { permissions: options.permissions }),
						...(options.repositories === undefined ? {} : { repositories: options.repositories }),
					}),
				}
			: {}),
	})
	if (!tokenResponse.ok) {
		throw new Error(`GitHub installation token request failed: ${tokenResponse.status} ${await tokenResponse.text()}`)
	}
	return (await tokenResponse.json()) as InstallationToken
}

/**
 * Send a `repository_dispatch` event: get an installation token for the App, then POST to the repository's
 * `/dispatches` endpoint. GitHub answers 204. Any other answer throws with the status and GitHub's message.
 *
 * @param fetchImpl - the HTTP function; tests pass a fake
 */
export const dispatchRepositoryEvent = async (
	credentials: AppCredentials,
	dispatch: RepositoryDispatch,
	fetchImpl: typeof fetch = fetch,
	nowMs: number = Date.now(),
): Promise<void> => {
	const origin = credentials.apiOrigin ?? 'https://api.github.com'
	const { token, permissions } = await installationToken(credentials, dispatch.installationId, { fetchImpl, nowMs })
	const response = await fetchImpl(`${origin}/repos/${dispatch.owner}/${dispatch.repository}/dispatches`, {
		method: 'POST',
		headers: { ...githubHeaders(token), 'content-type': 'application/json' },
		body: JSON.stringify({ event_type: dispatch.eventType, client_payload: dispatch.clientPayload }),
	})
	if (response.status !== 204) {
		const granted = Object.entries(permissions ?? {})
			.map(([name, level]) => `${name}=${level}`)
			.join(', ')
		throw new Error(
			`GitHub repository dispatch failed: ${response.status} ${await response.text()} | App permissions on this repo: ${granted || 'none listed'}`,
		)
	}
}
