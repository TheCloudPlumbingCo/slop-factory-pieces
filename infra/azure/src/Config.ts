import { ConfigProvider, Effect } from 'effect'

/**
 * The bot's configuration from the process environment: `GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_MENTION_NAME`,
 * `GITHUB_BOT_USER_ID`, `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY`. On Azure the platform fills these app settings from
 * Key Vault references, so the code never talks to Key Vault. Values are never logged.
 *
 * @param env - the environment to read; `process.env` by default, tests pass their own
 */
export const envConfigProvider = (env: Readonly<Record<string, string | undefined>> = process.env) =>
	Effect.sync(() => {
		const values: Record<string, string> = {}
		for (const [name, value] of Object.entries(env)) {
			if (value !== undefined) values[name] = value
		}
		return ConfigProvider.fromUnknown(values)
	})
