/**
 * The bot: its providers (GitHub here, Jira from `./JiraBot`), callback and event processing settings.
 * The Worker and the Durable Object both build their half from this one value.
 */
import { ChannelsCloudflare } from '@humanlayer/channels-alchemy-cloudflare'

import { botSettings, makeGitHubProvider } from '@slop/core'
import { jira } from './JiraBot'

export { botSettings, githubHandlers, makeGitHubProvider } from '@slop/core'

const github = makeGitHubProvider()

export const bot = ChannelsCloudflare.make({
	...botSettings,
	providers: [github, jira],
})
