/**
 * The `/research --ws <id>` command a GitHub comment gives the bot in a workspace repo: `@helix /research --ws be`.
 * Pure text parsing; checking that the workspace exists in the repo happens elsewhere.
 */

/** A workspace id is the name of a folder under `workspaces/`: lowercase letters, digits and dashes. */
export const workspaceId = /^[a-z0-9][a-z0-9-]*$/

export type ResearchCommand =
	| { readonly _tag: 'Research'; readonly workspace: string; readonly notes: string }
	| { readonly _tag: 'MissingWorkspace' }
	| { readonly _tag: 'InvalidWorkspace'; readonly value: string }
	| { readonly _tag: 'NotResearch' }

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `--ws be`, `--ws=be` or a bare `--ws`, as a whole word. Group 2 or 3 is the value, when there is one. */
const wsFlag = /(^|\s)--ws(?:=(\S*)|\s+(\S+))?(?=\s|$)/

/** What follows `/research`: the workspace from `--ws`, and the rest as notes. */
export type ResearchArgs = Exclude<ResearchCommand, { readonly _tag: 'NotResearch' }>

/** Reads the text after `/research` for the `--ws` flag; whatever is left, minus the flag, is the notes. */
export const readResearchArgs = (afterCommand: string): ResearchArgs => {
	const flag = wsFlag.exec(afterCommand)
	const value = flag?.[2] ?? flag?.[3] ?? ''
	if (value === '') return { _tag: 'MissingWorkspace' }
	if (!workspaceId.test(value)) return { _tag: 'InvalidWorkspace', value }

	const notes = afterCommand
		.replace(wsFlag, ' ')
		.replace(/[ \t]{2,}/g, ' ')
		.trim()
	return { _tag: 'Research', workspace: value, notes }
}

/**
 * Reads a comment body for `@<mentionName> /research ...`. The mention must be the whole name (not `@helix-two`),
 * in any case, anywhere in the comment.
 */
export const parseResearchCommand = (body: string, mentionName: string): ResearchCommand => {
	const mention = new RegExp(`(?:^|[^\\w@/-])@${escapeRegExp(mentionName)}\\s+/research(?![\\w-])([\\s\\S]*)`, 'i')
	const afterCommand = mention.exec(body)?.[1]
	return afterCommand === undefined ? { _tag: 'NotResearch' } : readResearchArgs(afterCommand)
}
