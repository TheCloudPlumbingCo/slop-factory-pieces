# Identity and authorization

## Rules

1. Only allowed people can start the bot.
2. The bot must not give a person more access than the person has.

## Current state

| Area | State |
|---|---|
| GitHub | The mention author needs `write` access or higher. Other authors get a 👎 and one notice. |
| Jira | No check. Any person who can comment can start a run. The hook is `authorizeJiraMention` in `packages/core/src/channels/JiraMention.ts`. |
| Webhook signature | Verified by the SDK on every host. |
| Portal | People sign in with Microsoft Entra. They connect GitHub and Jira with OAuth. Tokens are stored encrypted. |
| Azure research proxy | Verifies OIDC claims before it forwards a result. |

## Not built

- A link between a provider account and an Entra person for bot requests.
- An Entra group check for bot access.
- Narrow tokens for the agent. The agent must not use the full GitHub App token.

Portal app permissions: [portal-provider-permissions](portal-provider-permissions.md).

For implementation evidence and approval gaps, read the [identity integration review](11-identity-and-integration-risk-review.md).

For Information Risk review, read the [formal architecture assessment](14-agent-workflow-automation-architecture.md).
