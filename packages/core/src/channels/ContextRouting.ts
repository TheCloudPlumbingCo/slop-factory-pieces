/**
 * Which workspace repo a Jira project belongs to. The broker reads this map from its configuration
 * (`JIRA_CONTEXT_ROUTES`, JSON); a Jira `/research` becomes an issue in the repo the map names for the issue's project.
 * One Jira project maps to one workspace repo. The optional `default` entry serves projects without their own entry.
 * Pure parsing and lookup: no I/O.
 */
import { Option } from 'effect'

import { workspaceId } from './ResearchCommand'

/** Where research for a Jira project lands. */
export type WorkspaceTarget = {
	/** The workspace repo, as `owner/name`. */
	readonly repo: string
	/** The default `--ws` value: a folder under `workspaces/` in that repo. */
	readonly workspace: string
	/** The GitHub project number new issues are added to, when there is one. */
	readonly board?: number
}

export type ContextRoutes = {
	readonly projects: Readonly<Record<string, WorkspaceTarget>>
	/** Used for a Jira project with no entry of its own. */
	readonly fallback: WorkspaceTarget | undefined
}

export type ParsedContextRoutes =
	| { readonly ok: true; readonly map: ContextRoutes }
	| { readonly ok: false; readonly error: string }

/** The reserved key of the entry that serves unmapped projects. */
const DEFAULT_KEY = 'default'
const repoName = /^[\w.-]+\/[\w.-]+$/
/** `CTM-12`: the project key is everything before the last dash, and a number follows. */
const issueKey = /^(.+)-\d+$/

/** The Jira project key of an issue key: `CTM-12` is `CTM`. */
export const jiraProjectKey = (key: string): Option.Option<string> => Option.fromNullishOr(issueKey.exec(key)?.[1])

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const readTarget = (name: string, value: unknown): WorkspaceTarget | string => {
	if (!isRecord(value)) return `${name}: expected an object`
	const { repo, workspace, board } = value
	if (typeof repo !== 'string' || !repoName.test(repo)) return `${name}: repo must be "owner/name"`
	if (typeof workspace !== 'string' || !workspaceId.test(workspace)) {
		return `${name}: workspace must be lowercase letters, digits and dashes`
	}
	if (board === undefined) return { repo, workspace }
	if (typeof board !== 'number' || !Number.isInteger(board) || board < 1) {
		return `${name}: board must be a positive integer`
	}
	return { repo, workspace, board }
}

/** Reads the JSON text of the map. The error names the first bad entry; it never echoes the whole text. */
export const parseContextRoutes = (json: string): ParsedContextRoutes => {
	let raw: unknown
	try {
		raw = JSON.parse(json)
	} catch {
		return { ok: false, error: 'not valid JSON' }
	}
	if (!isRecord(raw)) return { ok: false, error: 'expected an object of project keys' }

	const projects: Record<string, WorkspaceTarget> = {}
	let fallback: WorkspaceTarget | undefined
	for (const [name, value] of Object.entries(raw)) {
		const target = readTarget(name, value)
		if (typeof target === 'string') return { ok: false, error: target }
		if (name === DEFAULT_KEY) fallback = target
		else projects[name] = target
	}
	return { ok: true, map: { projects, fallback } }
}

/** The target for an issue key's project, or the default entry, or `None`. A key that is not a Jira issue key gets `None`, even with a default. */
export const routeContext = (map: ContextRoutes, key: string): Option.Option<WorkspaceTarget> =>
	jiraProjectKey(key).pipe(
		Option.flatMap((project) =>
			Option.fromNullishOr(map.projects[project]).pipe(Option.orElse(() => Option.fromNullishOr(map.fallback))),
		),
	)
