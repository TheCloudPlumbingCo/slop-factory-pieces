import { CosmosClient } from '@azure/cosmos'
import { DefaultAzureCredential } from '@azure/identity'
import { ServiceBusClient } from '@azure/service-bus'
import { GitHubApiLive } from '@humanlayer/channels-github'
import { Config, Effect, Redacted } from 'effect'

import { envConfigProvider } from './Config'
import { fromCosmosContainer } from './CosmosContainer'
import { CosmosMailboxTableLive } from './CosmosMailboxTable'
import { dispatchRepositoryEvent } from './GithubDispatch'
import { makeHandlers } from './Handlers'
import { makeInProcessAgentSessions } from './InProcessAgent'
import { makeOidcVerifier, oidcProxy, parseList } from './OidcProxy'
import { makeCosmosPendingResearch } from './PendingResearch'
import { researchAgentSessions } from './ResearchAgentSessions'
import { ServiceBusNudgerLive } from './ServiceBusNudger'

/**
 * The production handlers: Cosmos DB, Service Bus and the real GitHub API, named by app settings. Both clients sign
 * in with the Function app's managed identity (`DefaultAzureCredential`); no key is configured.
 *
 * - `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, `COSMOS_CONTAINER`: the mailbox container
 * - `NudgeQueueConnection__fullyQualifiedNamespace`, `NUDGE_QUEUE_NAME`: the queue the nudges go to and the
 *   Processor reads
 * - `OIDC_AUDIENCE` (default: the broker origin the workflow asks for), `OIDC_ALLOWED_WORKFLOW_REF`: the runner's
 *   OIDC proxy; the second is a comma separated list of exact `job_workflow_ref` values
 * - `GITHUB_*`: the five GitHub settings (see `envConfigProvider`)
 */
export const productionHandlers = Effect.gen(function* () {
	const endpoint = yield* Config.String('COSMOS_ENDPOINT')
	const database = yield* Config.String('COSMOS_DATABASE')
	const container = yield* Config.String('COSMOS_CONTAINER')
	const namespace = yield* Config.String('NudgeQueueConnection__fullyQualifiedNamespace')
	const queueName = yield* Config.String('NUDGE_QUEUE_NAME')
	const credential = new DefaultAzureCredential()
	const cosmos = new CosmosClient({ endpoint, aadCredentials: credential })
	const sender = new ServiceBusClient(namespace, credential).createSender(queueName)
	const appId = yield* Config.String('GITHUB_APP_ID')
	const privateKey = yield* Config.Redacted('GITHUB_PRIVATE_KEY')
	const host = yield* Config.String('WEBSITE_HOSTNAME').pipe(Config.withDefault('localhost'))
	const brokerOrigin = yield* Config.String('BROKER_PUBLIC_ORIGIN').pipe(Config.withDefault(`https://${host}`))
	const audience = yield* Config.String('OIDC_AUDIENCE').pipe(Config.withDefault(brokerOrigin))
	const allowedWorkflowRefs = parseList(yield* Config.String('OIDC_ALLOWED_WORKFLOW_REF'))
	const items = fromCosmosContainer(cosmos.database(database).container(container))
	const pending = makeCosmosPendingResearch(items)
	const echo = yield* makeInProcessAgentSessions
	return yield* makeHandlers({
		// `/research` goes to the customer's GitHub Actions workflow; every other prompt keeps the echo agent.
		agentSessions: {
			layer: researchAgentSessions({
				dispatch: (dispatch) =>
					dispatchRepositoryEvent({ appId, privateKey: Redacted.value(privateKey) }, dispatch),
				brokerOrigin,
				pending,
				fallback: echo.layer,
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
		nudger: ServiceBusNudgerLive(sender),
		config: envConfigProvider(),
		gitHubApi: GitHubApiLive,
	})
})
