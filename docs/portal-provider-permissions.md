# Portal: GitHub and Jira app permissions

What `portal-poc` needs from the GitHub App, the GitHub OAuth App and the Atlassian (Jira) OAuth app. Derived from `portal-poc/lib/providers/github.ts` and `jira.ts`. Update this page whenever those files change what they request.

## Callback URLs (all three apps)

The portal builds the redirect URI as `<AUTH_URL>/api/connect/<provider>/callback`, so each app must list exactly that value.

| App | Callback URL |
| --- | --- |
| GitHub (App or OAuth App) | `https://slopfac.portal.yashodh.space/api/connect/github/callback`<br>`http://localhost:3000/api/connect/github/callback` (local dev) |
| Atlassian (Jira) | `https://slopfac.portal.yashodh.space/api/connect/jira/callback`<br>The console accepts only one URL, so use a separate app for localhost. |

## GitHub App (`GITHUB_AUTH_MODE=app`, default)

GitHub Settings, Developer settings, GitHub Apps. A GitHub App has no OAuth scopes. Access comes from the permissions below, limited to the repos where the app is installed. The portal signs users in with the user-to-server OAuth flow with PKCE S256.

### Repository permissions

| Permission | Access | Why | Status |
| --- | --- | --- | --- |
| Metadata | Read-only | Mandatory for every GitHub App. Lets the portal list repositories (`/user/installations/{id}/repositories`). | Required |
| Pull requests | Read-only | The review-requests list searches `is:pr review-requested:@me` through `/search/issues`. | Required, verify |
| Contents | Read-only | Lets the agent read code later. The portal does not call it today. | Optional |

> **Verify:** the earlier README listed only Metadata and Contents. The review-requests code calls the search API, which very likely needs Pull requests (read) for a GitHub App user token. This has not been tested against a real app. If the list comes back empty, check this permission first.

### Account permissions

None.

### Settings

| Setting | Value |
| --- | --- |
| Callback URLs | Both URLs in the table above (a GitHub App accepts several) |
| Expire user authorization tokens | Enabled (the portal refreshes them) |
| Request user authorization (OAuth) during installation | Off |
| Webhook | Active unticked |
| Where can this app be installed | Your choice. The portal lists only repos from installations the signed-in user can access. |
| Credentials | Client ID (not App ID) into `GITHUB_CLIENT_ID`, a generated client secret into `GITHUB_CLIENT_SECRET` |

After creating the app, install it on each organisation or account whose repos should be selectable. Changing permissions later makes GitHub ask for approval on each installation.

## GitHub OAuth App (`GITHUB_AUTH_MODE=oauth`)

GitHub Settings, Developer settings, OAuth Apps. Access is controlled by scopes that the portal requests at sign-in.

| Scope | Why | Status |
| --- | --- | --- |
| `repo` | Lists every repo the user can reach, private included, through `/user/repos`, and lets `/search/issues` see private pull requests. This scope also grants read and write access to code. | Required |
| `read:user` | Requested today. The portal only reads the login from `/user`, which probably works without it. Not confirmed, so it is left in. | Probably redundant |

| Setting | Value |
| --- | --- |
| Authorization callback URL | One URL only: `https://slopfac.portal.yashodh.space/api/connect/github/callback` |
| Credentials | Client ID and secret into `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` |

> **Organisation approval:** organisations that restrict third-party OAuth apps hide their repos until an owner approves the app. OAuth tokens do not expire. Public repos only would need just `public_repo`, but the code does not request that.

## Jira (Atlassian OAuth 2.0, 3LO)

developer.atlassian.com/console/myapps, create an OAuth 2.0 integration. The portal only reads: it searches issues through `GET /rest/api/3/search/jql` and reads the signed-in profile.

### Scopes requested by default (`DEFAULT_SCOPES`)

| Scope | API to enable in the console | Why |
| --- | --- | --- |
| `read:issue-details:jira` | Jira API (granular) | Issue search results |
| `read:audit-log:jira` | Jira API (granular) | Listed by Atlassian for issue search |
| `read:avatar:jira` | Jira API (granular) | Listed by Atlassian for issue search |
| `read:field-configuration:jira` | Jira API (granular) | Listed by Atlassian for issue search |
| `read:issue-meta:jira` | Jira API (granular) | Listed by Atlassian for issue search |
| `read:me` | User identity API | `GET /me` for the account label |
| `offline_access` | Requested in the authorize URL, nothing to enable | Issues a refresh token. Atlassian rotates it on every refresh. |

> **Beta and failure mode:** the granular scopes are in Beta. If the app lacks any scope the portal asks for, Atlassian answers 400 on the authorize call. The classic alternative is `read:jira-work` (plus `read:me` and `offline_access`); set it with `ATLASSIAN_SCOPES` without a code change.

### Settings

| Setting | Value |
| --- | --- |
| Callback URL | One URL only (see the table at the top) |
| Distribution | Set to Sharing before people outside your own account can connect |
| Credentials | Client ID and secret into `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` |
| Site | The portal uses the first site returned by `accessible-resources` |

## Keeping this current

- GitHub scopes and modes: `portal-poc/lib/providers/github.ts`.
- Jira scopes: `DEFAULT_SCOPES` in `portal-poc/lib/providers/jira.ts` and the `ATLASSIAN_SCOPES` override.
- Callback host: `custom_domain` in `portal-poc/terraform/main.tf`.
- The separate channel GitHub App (`channels/github-app/README.md`: Issues and Pull requests read and write) is a different app and is not covered here.
