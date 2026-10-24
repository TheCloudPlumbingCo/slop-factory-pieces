import {
	GetParametersByPathCommand,
	type GetParametersByPathCommandOutput,
	SSMClient,
} from '@aws-sdk/client-ssm'
import { ConfigProvider, Effect, Schema } from 'effect'

/** The one SSM call the config reader makes; `SSMClient` satisfies it, and tests pass a fake. */
export interface SsmParameterReader {
	readonly send: (command: GetParametersByPathCommand) => Promise<GetParametersByPathCommandOutput>
}

/** SSM could not be read, so the bot's configuration is unknown. */
export class SsmConfigUnavailable extends Schema.TaggedError<SsmConfigUnavailable>()('SsmConfigUnavailable', {
	prefix: Schema.String,
	reason: Schema.String,
}) {}

/** The last segment of a parameter's path: `/slop/prod/GITHUB_APP_ID` is `GITHUB_APP_ID`. */
const lastSegment = (name: string) => name.slice(name.lastIndexOf('/') + 1)

/**
 * The bot's configuration from every SSM parameter directly under `prefix`, decrypted, each named by the last
 * segment of its path (`GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_MENTION_NAME`, `GITHUB_BOT_USER_ID`, `GITHUB_APP_ID`,
 * `GITHUB_PRIVATE_KEY`). Values are never logged.
 *
 * @param prefix - the parameter path, such as `/slop-code-factory/prod`
 * @param client - the SSM client; a default `SSMClient` (region and credentials from the Lambda environment)
 */
export const ssmConfigProvider = Effect.fn('aws.config.ssm')(function* (prefix: string, client?: SsmParameterReader) {
	const ssm: SsmParameterReader = client ?? new SSMClient({})
	const values: Record<string, string> = {}
	let nextToken: string | undefined
	do {
		const token = nextToken
		const page = yield* Effect.tryPromise({
			try: () =>
				ssm.send(
					new GetParametersByPathCommand({
						Path: prefix,
						WithDecryption: true,
						...(token === undefined ? {} : { NextToken: token }),
					}),
				),
			catch: (error) =>
				new SsmConfigUnavailable({
					prefix,
					reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
				}),
		})
		for (const parameter of page.Parameters ?? []) {
			if (parameter.Name !== undefined && parameter.Value !== undefined) {
				values[lastSegment(parameter.Name)] = parameter.Value
			}
		}
		nextToken = page.NextToken
	} while (nextToken !== undefined)
	return ConfigProvider.fromUnknown(values)
})
