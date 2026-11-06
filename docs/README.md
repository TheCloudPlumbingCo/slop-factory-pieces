# Documents

For Information Risk review, start with [Agent Workflow Automation: Identity, Access and Integration Architecture](14-agent-workflow-automation-architecture.md).

For interaction terminology, read [Channel-Based Invocation and Portal Access](15-channel-invocation-and-portal-access.md).

For workflow direction, read the [workflow and portal rationale](10-workflow-and-portal-rationale.md).

| Document | Contents |
|---|---|
| [purpose-and-scope](purpose-and-scope.md) | Goals, non-goals, status |
| [architecture](architecture.md) | Flow, hosts, code layout |
| [conversation-delivery-spec](conversation-delivery-spec.md) | Delivery requirements and acceptance criteria |
| [identity-and-authorization](identity-and-authorization.md) | Who can start the bot |
| [portal-provider-permissions](portal-provider-permissions.md) | Portal app permissions |
| [10-workflow-and-portal-rationale](10-workflow-and-portal-rationale.md) | User needs, workspace ownership, workflow rationale, and open decisions |
| [11-identity-and-integration-risk-review](11-identity-and-integration-risk-review.md) | Identity roles, credential flows, provider permissions, and approval gaps |
| [12-live-integration-permissions](12-live-integration-permissions.md) | Live grants, requested OAuth scopes, repo boundaries, and approval decisions |
| [13-broker-workflow-wiring](13-broker-workflow-wiring.md) | App-authenticated dispatch, runner credentials, and OIDC callbacks |
| [14-agent-workflow-automation-architecture](14-agent-workflow-automation-architecture.md) | IRA access request: each identity's purpose, integration role, permissions, and approval boundaries |
| [15-channel-invocation-and-portal-access](15-channel-invocation-and-portal-access.md) | Plain explanation of channel invocation, the supplementary portal, and their credential roles |


## HTML artifacts

The folder [`artifacts`](artifacts/) holds HTML pages that explain the code.

| File | Contents |
|---|---|
| [effect-channels-as-mail](artifacts/effect-channels-as-mail.html) | Channels explained as a mail system |
| [portal-sso-spec](artifacts/portal-sso-spec.html) | Portal single sign-on reference |
| [show-me-cloudflare-research-dispatch](artifacts/show-me-cloudflare-research-dispatch.html) | Cloudflare research dispatch flow |
