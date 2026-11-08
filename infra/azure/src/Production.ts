import { CosmosClient } from '@azure/cosmos'
import { DefaultAzureCredential } from '@azure/identity'
import { GitHubApiLive } from '@humanlayer/channels-github'
import { Config, Effect, Redacted } from 'effect'

import { envConfigProvider } from './Config'
import { fromCosmosContainer } from './CosmosContainer'
import { CosmosMailboxTableLive } from './CosmosMailboxTable'
import { dispatchRepositoryEvent } from './GithubDispatch'
import { GithubCardMoverLive } from './GithubProjects'
import { makeHandlers } from './Handlers'
import { makeInMemoryNudger } from './InMemoryNudger'
import { makeInProcessAgentSessions } from './InProcessAgent'
import { makeOidcVerifier, oidcProxy, parseList } from './OidcProxy'
import { makeCosmosPendingResearch } from './PendingResearch'
import { researchAgentSessions } from './ResearchAgentSessions'

/**
 * The production handlers: Cosmos DB and the real GitHub API, named by app settings. The Cosmos client signs in with
 * the Container App's managed identity (`DefaultAzureCredential`); no key is configured. Nudges are timers in this
 * process (`makeInMemoryNudger`), so there is no queue.
 *
 * - `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, `COSMOS_CONTAINER`: the mailbox container
 * - `BROKER_PUBLIC_ORIGIN`: the broker's public origin, such as `https://app.region.azurecontainerapps.io`. The
 *   runner calls it back. Default: `https://$CONTAINER_APP_HOSTNAME`.
 * - `OIDC_AUDIENCE` (default: the broker origin the workflow asks for), `OIDC_ALLOWED_WORKFLOW_REF`: the runner's
 *   OIDC proxy; the second is a comma separated list of exact `job_workflow_ref` values
 * - `GITHUB_*`: the five GitHub settings (see `envConfigProvider`)
 */
export const productionHandlers = Effect.gen(function* () {
	const endpoint = yield* Config.String('COSMOS_ENDPOINT')
	const database = yield* Config.String('COSMOS_DATABASE')
	const container = yield* Config.String('COSMOS_CONTAINER')
	const credential = new DefaultAzureCredential()
	const cosmos = new CosmosClient({ endpoint, aadCredentials: credential })
	const appId = yield* Config.String('GITHUB_APP_ID')
	const privateKey = yield* Config.Redacted('GITHUB_PRIVATE_KEY')
	const host = yield* Config.String('CONTAINER_APP_HOSTNAME').pipe(Config.withDefault('localhost'))
	const brokerOrigin = yield* Config.String('BROKER_PUBLIC_ORIGIN').pipe(Config.withDefault(`https://${host}`))
	const audience = yield* Config.String('OIDC_AUDIENCE').pipe(Config.withDefault(brokerOrigin))
	const allowedWorkflowRefs = parseList(yield* Config.String('OIDC_ALLOWED_WORKFLOW_REF'))
	const items = fromCosmosContainer(cosmos.database(database).container(container))
	const pending = makeCosmosPendingResearch(items)
	const echo = yield* makeInProcessAgentSessions
	const nudger = makeInMemoryNudger()
	const handlers = yield* makeHandlers({
		// `/research` goes to the customer's GitHub Actions workflow; every other prompt keeps the echo agent.
		agentSessions: {
			layer: researchAgentSessions({
				dispatch: (dispatch) =>
					dispatchRepositoryEvent({ appId, privateKey: Redacted.value(privateKey) }, dispatch),
				brokerOrigin,
				pending,
				fallback: echo.layer,
				// The broker owns the card states. The workflow never moves a card.
				cardMover: GithubCardMoverLive({ appId, privateKey: Redacted.value(privateKey) }),
			}),
			drain: echo.drain,
		},
		researchSession: (forward) =>
			oidcProxy({
				verify: makeOidcVerifier(audience),
				store: pending,
				allowedWorkflowRefs,
				forward,
				skillsJson: process.env.SKILLS_JSON,
				warn: (reason) => console.warn(`research-session refused: ${reason}`),
			}),
		table: CosmosMailboxTableLive(items),
		nudger: nudger.layer,
		config: envConfigProvider(),
		gitHubApi: GitHubApiLive,
	})
	// The handlers need the nudger to exist first, and a firing nudge needs the handlers: bind it now.
	nudger.bind((mailboxKey) => Effect.runPromise(handlers.processNudge(mailboxKey)))
	return handlers
})
