# portal-poc

Next.js 15 prototype portal. Sign-in is Microsoft Entra (Auth.js). GitHub and Jira can be connected per user with real OAuth; research triggering, the pipeline board and workspaces are still simulated.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in the values below
npm run dev                  # http://localhost:3000
npm test                     # unit tests (mocked fetch)
```

`PROTOTYPE_NO_AUTH=1 npm run dev` skips sign-in and uses sample data for everything.

A provider is "live" only when `PROTOTYPE_NO_AUTH` is unset, its client id and secret are set, and `TOKEN_ENCRYPTION_KEY` is set. Otherwise that provider's Connect button and pickers fall back to the sample data.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | Entra sign-in (already in use). |
| `AUTH_URL` | Public origin of the app. Set when deployed; used to build OAuth callback URLs. Locally the request host is used. |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored provider tokens. 32 bytes, base64. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub App OAuth credentials. |
| `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` | Atlassian OAuth 2.0 (3LO) credentials. |

Generate the encryption key (keep it out of git; losing it makes stored connections unreadable and users must reconnect):

```bash
openssl rand -base64 32
```

## Stable hostname

The portal is served at `https://slopfac.portal.yashodh.space` (Terraform variable `custom_domain`), so the callback URLs below do not change when the Container Apps environment is recreated. Setup: `terraform apply -var custom_domain=slopfac.portal.yashodh.space`, create the `CNAME` and `asuid` `TXT` records from `terraform output dns_records` at the DNS host, then apply again with `-var custom_domain_dns_ready=true`. The managed-certificate flow has not been run against Azure yet.

Scopes and permissions for GitHub and Jira are listed in `../docs/portal-provider-permissions.md`.

## Register the GitHub App

GitHub Settings > Developer settings > GitHub Apps > New GitHub App.

- Callback URLs (add both):
  - `http://localhost:3000/api/connect/github/callback`
  - `https://slopfac.portal.yashodh.space/api/connect/github/callback`
- Expire user authorization tokens: leave enabled (the portal refreshes them).
- Request user authorization (OAuth) during installation: not needed. Webhook: untick Active.
- Repository permissions: Metadata (read-only) is mandatory. Pull requests (read-only) is needed for the review-requests list (not yet verified against a real app). Contents (read-only) is optional, for the agent to read code later. Full list: `../docs/portal-provider-permissions.md`.
- Where can this app be installed: choose per your needs.
- Create the app, generate a client secret, copy the Client ID (not the App ID) and the secret into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
- Install the app on the organisations/accounts whose repos should be selectable. The portal lists only repos from installations the signed-in user can access.

## Register the Atlassian OAuth app

developer.atlassian.com/console/myapps > Create > OAuth 2.0 integration.

- Authorization > OAuth 2.0 (3LO) > Callback URL (the console may accept only one URL; if so, register one app per environment):
  - `http://localhost:3000/api/connect/jira/callback`
  - `https://slopfac.portal.yashodh.space/api/connect/jira/callback`
- Permissions > add Jira API, then configure the granular scopes `read:issue-details:jira`, `read:audit-log:jira`, `read:avatar:jira`, `read:field-configuration:jira`, `read:issue-meta:jira` (what Atlassian's API spec lists for issue search, state Beta) plus `read:me` under the User identity API. The classic `read:jira-work` also works if your console offers it; then set `ATLASSIAN_SCOPES="read:jira-work read:me offline_access"`. `offline_access` is requested at sign-in and gives the refresh token.
- Settings > copy Client ID and Secret into `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET`.
- Distribution: set to Sharing before people outside your own account can connect.

## How it works

- Every connection is keyed by the Entra `oid` from the ID token (exposed as `session.oid`).
- `GET /api/connect/{github|jira}/start` creates a random `state` (and a PKCE verifier for GitHub), stores them in an encrypted HTTP-only cookie bound to the user's `oid`, and redirects to the provider. `/callback` verifies it, exchanges the code, stores the encrypted tokens and returns to `/settings`. `POST /disconnect` deletes the stored tokens.
- Tokens are stored through the `TokenStore` interface in `lib/tokens.ts`. The local implementation writes encrypted files to `.data/` (git-ignored). Replace it with a Cosmos implementation for the deployed app; the container filesystem is not durable.
- Data endpoints use the caller's own token: `GET /api/connections`, `GET /api/github/repos`, `GET /api/jira/issues?q=`.

## Known limits

- Disconnect deletes the stored tokens but does not revoke them at GitHub or Atlassian.
- Jira uses the first site returned by `accessible-resources`.
- Token refresh is not locked across instances; with several replicas two refreshes can race (Atlassian rotates refresh tokens, so one user may have to reconnect).


## GitHub mode flag: `GITHUB_AUTH_MODE`

One deployment uses one GitHub mode, so you can deploy each and compare. Switch by changing the flag and the client ID/secret, then redeploy. Connections made under the other mode stop working and the user reconnects in Settings.

| | `app` (default) | `oauth` |
|---|---|---|
| What you register | A GitHub App | A GitHub OAuth App |
| Repos the portal can list | Only repos where the App is installed | Every repo the user can access, private included |
| Scope asked | App permissions (Metadata and Contents, read) | `read:user repo` |
| Token lifetime | Expires (8 hours by default) and refreshes | Does not expire |
| Repo listing call | `/user/installations/{id}/repositories` | `/user/repos` |
| PKCE sent | Yes | No (not verified for OAuth Apps) |

### Register a GitHub OAuth App (for `GITHUB_AUTH_MODE=oauth`)

1. GitHub, Settings, Developer settings, OAuth Apps, New OAuth App.
2. Authorization callback URL: `<deployed URL>/api/connect/github/callback`.
3. Generate a client secret. Put the client ID and secret in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
4. Set `GITHUB_AUTH_MODE=oauth`.

These registration steps are from memory, not checked against the current GitHub docs. An organisation that restricts third-party OAuth apps will hide its repos until an owner approves the app.
