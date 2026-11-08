import { CardMover } from '@slop/core'
import { Effect, Layer } from 'effect'

import { githubHeaders, installationToken, type AppCredentials } from './GithubDispatch'

/** Where a failure goes. It holds a message and an error, never a token. */
export type CardLog = (message: string, error?: unknown) => void

const defaultLog: CardLog = (message, error) =>
	error === undefined ? console.log(`github_projects: ${message}`) : console.error(`github_projects: ${message}`, error)

/** Read the workspace's `workspace.json`; it needs only Contents read. */
const READ_PERMISSIONS = { contents: 'read' } as const
/** Move a card; the board is an organisation project, and the issue is read to find its id. */
const MOVE_PERMISSIONS = { issues: 'read', organization_projects: 'write' } as const

interface GraphqlResult<T> {
	readonly data?: T
	readonly errors?: ReadonlyArray<{ readonly message: string }>
}

const makeGraphql =
	(origin: string, fetchImpl: typeof fetch, token: string) =>
	async <T>(query: string, variables: Readonly<Record<string, unknown>>): Promise<T> => {
		const response = await fetchImpl(`${origin}/graphql`, {
			method: 'POST',
			headers: { ...githubHeaders(token), 'content-type': 'application/json' },
			body: JSON.stringify({ query, variables }),
		})
		if (!response.ok) throw new Error(`GitHub GraphQL failed: ${response.status}`)
		const body = (await response.json()) as GraphqlResult<T>
		if (body.errors !== undefined && body.errors.length > 0) {
			throw new Error(`GitHub GraphQL error: ${body.errors.map((error) => error.message).join('; ')}`)
		}
		if (body.data === undefined) throw new Error('GitHub GraphQL answered with no data')
		return body.data
	}

const PROJECT_QUERY = `
  query($owner:String!,$number:Int!){organization(login:$owner){projectV2(number:$number){
    id field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`

const ISSUE_QUERY = `
  query($owner:String!,$repo:String!,$issue:Int!){repository(owner:$owner,name:$repo){issue(number:$issue){
    id projectItems(first:20){nodes{id project{id} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`

const ADD_MUTATION = `
  mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`

const SET_MUTATION = `
  mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{
    projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`

interface ProjectData {
	readonly organization: {
		readonly projectV2: {
			readonly id: string
			readonly field: { readonly id: string; readonly options: ReadonlyArray<{ readonly id: string; readonly name: string }> } | null
		} | null
	} | null
}

interface IssueData {
	readonly repository: {
		readonly issue: {
			readonly id: string
			readonly projectItems: {
				readonly nodes: ReadonlyArray<{
					readonly id: string
					readonly project: { readonly id: string }
					readonly fieldValueByName: { readonly name: string } | null
				}>
			}
		} | null
	} | null
}

/**
 * Put an issue's card in a Status column. This is the Action's old `move-card.sh`, ported:
 * - the card is found on the project; a card that is not there is added first
 * - the column is the project's Status option with that name; a missing name throws
 * - a card whose column is the same or to the right of the target stays (the order is the Status field's option order)
 */
const move = async (
	graphql: ReturnType<typeof makeGraphql>,
	input: { readonly owner: string; readonly repository: string; readonly issueNumber: number; readonly projectNumber: number; readonly column: string },
): Promise<'moved' | 'kept'> => {
	const { owner, repository, issueNumber, projectNumber, column } = input
	const meta = await graphql<ProjectData>(PROJECT_QUERY, { owner, number: projectNumber })
	const project = meta.organization?.projectV2
	if (project === null || project === undefined) throw new Error(`Project ${projectNumber} was not found`)
	if (project.field === null) throw new Error(`Project ${projectNumber} has no Status field`)
	const { field } = project
	const option = field.options.find((candidate) => candidate.name === column)
	if (option === undefined) throw new Error(`Project ${projectNumber} has no Status called '${column}'`)
	const rank = (name: string) => field.options.findIndex((candidate) => candidate.name === name)

	const found = await graphql<IssueData>(ISSUE_QUERY, { owner, repo: repository, issue: issueNumber })
	const issue = found.repository?.issue
	if (issue === null || issue === undefined) throw new Error(`Issue #${issueNumber} was not found`)
	const item = issue.projectItems.nodes.find((node) => node.project.id === project.id)

	let itemId: string
	let current = ''
	if (item === undefined) {
		const added = await graphql<{ readonly addProjectV2ItemById: { readonly item: { readonly id: string } } }>(ADD_MUTATION, {
			project: project.id,
			content: issue.id,
		})
		itemId = added.addProjectV2ItemById.item.id
	} else {
		itemId = item.id
		current = item.fieldValueByName?.name ?? ''
	}

	if (current !== '' && rank(current) >= rank(column)) return 'kept'
	await graphql(SET_MUTATION, { project: project.id, item: itemId, field: field.id, option: option.id })
	return 'moved'
}

/** `workspaces/<workspace>/workspace.json` has `{ "project": <number> }`. Anything else means "no board". */
const parseProjectNumber = (text: string): number | undefined => {
	try {
		const value = (JSON.parse(text) as { readonly project?: unknown }).project
		return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
	} catch {
		return undefined
	}
}

/**
 * The `CardMover` over the GitHub GraphQL API, signed in as the App. Both calls ask for a token with only the
 * permissions they need, and neither fails: a problem is logged and the card stays. It caches nothing.
 *
 * The App needs these permissions: Contents read, Issues read, and the organisation permission Projects write.
 *
 * @param fetchImpl - the HTTP function; tests pass a fake
 */
export const GithubCardMoverLive = (
	credentials: AppCredentials,
	options: { readonly fetchImpl?: typeof fetch; readonly log?: CardLog } = {},
): Layer.Layer<CardMover> => {
	const fetchImpl = options.fetchImpl ?? fetch
	const log = options.log ?? defaultLog
	const origin = credentials.apiOrigin ?? 'https://api.github.com'
	return Layer.succeed(
		CardMover,
		CardMover.of({
			projectNumber: (input) =>
				Effect.promise(async () => {
					try {
						const { token } = await installationToken(credentials, input.installationId, { permissions: READ_PERMISSIONS, fetchImpl })
						const path = `workspaces/${encodeURIComponent(input.workspace)}/workspace.json`
						const response = await fetchImpl(`${origin}/repos/${input.owner}/${input.repository}/contents/${path}`, {
							headers: { ...githubHeaders(token), accept: 'application/vnd.github.raw+json' },
						})
						if (!response.ok) {
							log(`no board: workspace.json answered ${response.status} for ${input.owner}/${input.repository}/${input.workspace}`)
							return undefined
						}
						const number = parseProjectNumber(await response.text())
						if (number === undefined) log(`no board: workspace.json has no project number for ${input.workspace}`)
						return number
					} catch (error) {
						log('no board: could not read workspace.json', error)
						return undefined
					}
				}),
			moveCard: (input) =>
				Effect.promise(async () => {
					try {
						const { token } = await installationToken(credentials, input.installationId, { permissions: MOVE_PERMISSIONS, fetchImpl })
						const outcome = await move(makeGraphql(origin, fetchImpl, token), input)
						log(`card for ${input.owner}/${input.repository}#${input.issueNumber}: ${outcome} (target '${input.column}')`)
					} catch (error) {
						log(`could not move the card for ${input.owner}/${input.repository}#${input.issueNumber}`, error)
					}
				}),
		}),
	)
}
