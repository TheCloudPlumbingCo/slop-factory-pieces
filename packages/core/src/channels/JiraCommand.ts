/** Slash commands a Jira comment can give the bot, read from the text after the bot's mention. */
import { Option } from 'effect'

/** Command names the bot answers to. Anything else after a mention is ignored. */
export const jiraCommandNames = ['research'] as const
export type JiraCommandName = (typeof jiraCommandNames)[number]

export type JiraCommand = { readonly name: JiraCommandName; readonly args: string }

const isJiraCommandName = (name: string): name is JiraCommandName =>
	jiraCommandNames.some((known) => known === name)

/** The first whitespace-delimited token, and the rest of the text after it. */
const commandToken = /^\s*(\S+)(?:\s+([\s\S]*))?$/

/**
 * The command at the start of `afterMention`: its first token must be `/<name>` for a known name, in any
 * case; the rest, trimmed, is its args. `None` when there is no token, no slash, or an unknown name.
 */
export const parseCommand = (afterMention: string): Option.Option<JiraCommand> => {
	const match = commandToken.exec(afterMention)
	const token = match?.[1]
	if (token === undefined || !token.startsWith('/')) return Option.none()
	const name = token.slice(1).toLowerCase()
	if (!isJiraCommandName(name)) return Option.none()
	return Option.some({ name, args: (match?.[2] ?? '').trim() })
}
