/**
 * The Azure Functions v4 registrations: the Receiver (HTTP), the Processor (Service Bus queue) and the Sweep (timer,
 * every minute). The bundle's entry; `host.json` sets the empty route prefix, so the webhook is served at exactly
 * `/integrations/github/webhook`.
 */
import { app } from '@azure/functions'

import { entryPoints } from '../Handlers'
import { productionHandlers } from '../Production'
import { skillsResponse } from '../Skills'
import { toHttpResult, toWebRequest } from './adapter'

const handlers = entryPoints(productionHandlers)

app.http('receiver', {
	methods: ['POST'],
	authLevel: 'anonymous',
	route: 'integrations/github/webhook',
	handler: async (request) => toHttpResult(await handlers.receiver(await toWebRequest(request))),
})

// The delivery API the runner calls to report progress and finish the task (the Bearer token is the delivery's own).
app.http('deliveries', {
	methods: ['GET', 'POST', 'PUT', 'DELETE'],
	authLevel: 'anonymous',
	route: 'deliveries/{*rest}',
	handler: async (request) => toHttpResult(await handlers.receiver(await toWebRequest(request))),
})

// The runner's calls, each authenticated by a GitHub OIDC token; the broker uses the task password on its behalf. A
// separate top-level route, not `deliveries/...`: that catch-all route is also registered, and a name no other route
// can match avoids relying on route precedence.
app.http('researchSession', {
	methods: ['GET', 'PUT', 'POST'],
	authLevel: 'anonymous',
	route: 'research-session/{id}/{action}',
	handler: async (request) => toHttpResult(await handlers.researchSession(await toWebRequest(request))),
})

// The skills list the runner installs before research; readable only with a delivery's token.
app.http('skills', {
	methods: ['GET'],
	authLevel: 'anonymous',
	route: 'skills',
	handler: async (request) =>
		toHttpResult(
			await skillsResponse(await toWebRequest(request), handlers.receiver, process.env.SKILLS_JSON),
		),
})

// A thrown error fails the invocation and Service Bus delivers the message again, up to the queue's delivery limit.
app.serviceBusQueue('processor', {
	connection: 'NudgeQueueConnection',
	queueName: '%NUDGE_QUEUE_NAME%',
	handler: async (message) => {
		await handlers.processor(message)
	},
})

app.timer('sweep', {
	schedule: '0 * * * * *',
	handler: async () => {
		await handlers.sweep()
	},
})
