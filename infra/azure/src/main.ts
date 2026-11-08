/** The Container App's entry: build the handlers on first use, serve HTTP, and stop cleanly on SIGTERM. */
import { entryPoints } from './Handlers'
import { productionHandlers } from './Production'
import { makeServer, shutdown } from './server'

/** How long an open request may finish after SIGTERM. Container Apps allows 30 s before it kills the process. */
const SHUTDOWN_GRACE_MS = 10_000

const handlers = entryPoints(productionHandlers)
const server = makeServer({
	receiver: handlers.receiver,
	researchSession: handlers.researchSession,
	skillsJson: process.env.SKILLS_JSON,
})

const port = Number(process.env.PORT ?? 8080)
server.listen(port, () => console.log(`broker listening on :${port}`))

process.on('SIGTERM', () => {
	console.log('SIGTERM: stopping; waiting timers are lost')
	void shutdown(server, SHUTDOWN_GRACE_MS).then(() => process.exit(0))
})
