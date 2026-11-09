import { installationToken, type AppCredentials } from './GithubDispatch'
import type { PendingResearch } from './PendingResearch'

/** The two tokens a research workflow may ask the broker for. The App private key never leaves the broker. */
export type WorkflowTokenKind = 'read' | 'publish'

/**
 * Read: contents read on the repositories of the installation, to download the workspace's repos.
 * Publish: pull requests and issues write on the one repository the workflow runs in.
 */
const GRANTS = {
	read: { permissions: { contents: 'read' } },
	publish: { permissions: { pull_requests: 'write', issues: 'write' } },
} as const

/** Make a token for a verified workflow run. `fetchImpl` is for tests. */
export type MintWorkflowToken = (kind: WorkflowTokenKind, pending: PendingResearch) => Promise<{ readonly token: string }>

export const makeWorkflowTokenMinter =
	(credentials: AppCredentials, fetchImpl?: typeof fetch): MintWorkflowToken =>
	async (kind, pending) => {
		const { token } = await installationToken(credentials, Number(pending.installationId), {
			permissions: GRANTS[kind].permissions,
			...(kind === 'publish' ? { repositories: [pending.repository] } : {}),
			...(fetchImpl === undefined ? {} : { fetchImpl }),
		})
		return { token }
	}
