# cloudfare/

**Role:** the broker, deployed on Cloudflare: one Worker with GitHub and Jira providers.

**Contains:**
- Cloudflare wiring only; the cloud-neutral bot logic (mention handling, echo agent, ports, shared behaviour suite) is in `packages/core` (`@slop/core`)
- Ingress Worker: webhook routes `POST /integrations/github/webhook` and `POST /integrations/jira/webhook`, and the delivery API
- Mailbox Durable Object (one per GitHub issue or PR, one per Jira issue)
- `onMentioned` callbacks: GitHub checks access; Jira parses a `/command` (`/research`); both start the AgentSession and `handoff()`
- AgentSession Durable Object (one per discussion); for now it runs the echo agent

**Access control for Jira is open:** any user who can comment on an issue and mention the bot can start a run. A Jira permission check is deferred by the user (`authorizeJiraMention` in `packages/core/src/JiraMention.ts` is the hook).

**Uses:** `@humanlayer/channels-delivery`, `-github`, `-alchemy-cloudflare` (published 0.1.0) and `-jira` (vendored tarball, see below).

**Boundaries:** B1, B2, B3, B4, B6 are the SDK's. B5 (how the callback starts the agent) is defined here. See `../../docs/architecture.md`.

## Configuration

Set these in `.env` (never committed; see `.env.example` for the names). The Worker reads them through Effect `Config`.

- GitHub: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_BOT_MENTION_NAME`, `GITHUB_BOT_USER_ID`.
- Jira: `JIRA_WEBHOOK_SECRET`, `JIRA_BASE_URL` (e.g. `https://your-site.atlassian.net`; only its lowercase host is used, as part of every Jira mailbox key, so do not change it), `JIRA_CLOUD_ID`, `JIRA_API_TOKEN`, `JIRA_BOT_ACCOUNT_ID`. All five are required: the Worker builds the Jira provider at startup, so a missing `JIRA_*` variable stops the whole Worker from starting, GitHub included. There are deliberately no defaults: a default would hide a misconfiguration, or accept webhooks signed with a known secret.
- `JIRA_CLOUD_ID` is the site's cloud id, a UUID: `curl -s https://<site>.atlassian.net/_edge/tenant_info` returns it as `cloudId`. Anything that is not a UUID is rejected at startup.
- `JIRA_API_TOKEN` is the API token of the bot's Atlassian service account. Every Jira call goes to `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...` with `Authorization: Bearer <token>`; Basic auth and the bot's email are not used.

## Deploying

The stack is `alchemy.run.ts`; it deploys the Ingress Worker and its two Durable Objects (mailbox and AgentSession) to Cloudflare. Run every command below from `infra/cloudfare`.

1. Install from the repo root: `bun install`.
2. Create `.env` from `.env.example` and fill in every variable (see Configuration). Alchemy reads `.env` by default; `--env-file <path>` uses another file.
3. Give Alchemy Cloudflare credentials, either way:
   - Interactive: `bunx alchemy profile` and connect Cloudflare when asked.
   - Non-interactive (CI): export `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
4. Once per Cloudflare account, provision what the stack needs (the Cloudflare-hosted state store): `bunx alchemy cloudflare bootstrap`.
5. Preview, then deploy:
   ```sh
   bun run alchemy:plan
   bun run alchemy:deploy
   ```
   The stage defaults to `live_$USER`. Pick another with `ALCHEMY_STAGE` or `--stage <name>`, for example `bunx alchemy deploy --stage prod`. Each stage is a separate deployment.
6. The deploy prints the Worker `url`. Point the providers at it:
   - GitHub App: webhook URL `<url>/integrations/github/webhook`, secret = `GITHUB_WEBHOOK_SECRET`.
   - Jira: system webhook `<url>/integrations/jira/webhook` (see Jira setup).
7. Check it works: mention the bot on a GitHub issue or comment `@<bot> /research hi` on a Jira issue. Expect an acknowledgement, then an echo reply about 5 seconds later.

To change configuration, edit `.env` and run `bun run alchemy:deploy` again. To follow logs, `bunx alchemy logs --tail`. These steps come from the Alchemy CLI and the package scripts; this README's author has not run a deploy from them.

## Jira setup

1. Create an Atlassian service account for the bot, give it access to the Jira projects, and create an API token for it (`JIRA_API_TOKEN`). Comments are posted as this account.
2. Get the cloud id (`JIRA_CLOUD_ID`): `curl -s https://<site>.atlassian.net/_edge/tenant_info`.
3. Get the bot's account id (`JIRA_BOT_ACCOUNT_ID`) through the gateway with the Bearer token: `curl -s -H "Authorization: Bearer $JIRA_API_TOKEN" https://api.atlassian.com/ex/jira/$JIRA_CLOUD_ID/rest/api/3/myself`. It has the form `<digits>:<uuid>`, and `accountType` is `app`.
4. As a Jira admin, add a system webhook: URL `<worker-url>/integrations/jira/webhook`, event `comment_created` (optionally a JQL filter such as `project = ABC`), secret = `JIRA_WEBHOOK_SECRET`.
5. Comment `@<bot> /research <optional text>` on an issue. A mention without a known command is ignored silently.

## What a `/research` mention does on Jira

1. Acknowledge: right after the mention is authorized and its command recognised, the bot comments `👀 On it` on the issue (no mention). This is best effort: if posting fails or takes over 5 seconds, a warning is logged and the run continues. Ignored mentions (no command, unknown command, denied) get no acknowledgement.
2. Work: the AgentSession runs the echo agent, which sets `Working` and then waits `MOCK_WORK_DURATION` (5 seconds, in `packages/core/src/EchoAgent.ts`). The wait stands in for real agent work and goes away when the real agent replaces the echo agent. It applies to GitHub too.
3. Reply: the echo reply is posted as a new comment that starts with an @-mention of the person who asked. The mention comes from the signed webhook's comment author, saved with the delivery; it is never parsed from text, and the reply's text (which quotes the issue) is posted as plain text only.

Jira Cloud's REST API has no comment reactions and no comment threads, so the 👀 reaction and the threaded reply are emulated: the reaction by a separate comment, the reply by a mention of the requester. The bot's own comments (the acknowledgement and the reply) are authored by the bot account and ignored, so they never start another run.

## Repacking the vendored Jira package

`@humanlayer/channels-jira` is installed from a tarball in `vendor/`. To update it:

1. In the SDK checkout, `cd packages/jira && bun pm pack`.
2. Rename the `.tgz` to include the SDK short commit hash, e.g. `humanlayer-channels-jira-0.0.0-85830e9.tgz` (current file in `vendor/`). Always use a fresh filename: bun caches `file:` tarballs by name and would otherwise reuse a stale entry. Move it into `vendor/`, delete the old one, and point `@humanlayer/channels-jira` in both `packages/core/package.json` and `infra/cloudfare/package.json` at `file:../../infra/cloudfare/vendor/<new-file>.tgz`.
3. Run `bun install` from the repo root, then `bun run test` and `bun run typecheck` from either package.

Install layout: `packages/core` and `infra/cloudfare` are bun workspaces. Install with `bun install` from the repo root; both packages share one install and one lockfile (`bun.lock` at the root), then run `bun run test` / `bun run typecheck` from either package directory.

The `file:../../infra/cloudfare/vendor/...` Jira spec in both `package.json` files must stay byte-identical, otherwise bun installs the tarball twice and breaks Effect identity. The root `package-lock.json` belongs to the unrelated copilot-sdk example and is not used by the workspaces.

`infra/cloudfare` depends on `@slop/core` as `"*"` (and `packages/core` has `"version": "0.0.0"`), not `workspace:*`: bun and npm both resolve that range to the local workspace (bun symlinks `node_modules/@slop/core` to `packages/core`), while npm rejects the `workspace:` protocol, which would break `npm install` at the root for the copilot-sdk example. Do not use `file:../../packages/core` either: bun copies a `file:` directory instead of linking it.

## Running locally

Not verified locally. `alchemy.run.ts` uses `Cloudflare.providers()` and `Cloudflare.state()`, so `alchemy dev` needs Cloudflare credentials and touches a Cloudflare account; no fully local, side-effect-free mode was used. Coverage comes from the tests (`bun run test`): `test/jira-seam.vi.test.ts` sends a signed fixture through the provider built from the `JIRA_*` configuration and the SDK's event processor into the real Jira handlers (Jira API and AgentSession faked), and `test/jira-bot.vi.test.ts` covers the handlers.

## Unverified against a live Jira site

Verified on 2026-10-19 against a real site (a real curl): authentication and `myself`. `GET https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/myself` with `Authorization: Bearer <service-account token>` returned 200 with an `accountId` of the form `<digits>:<uuid>`, `accountType: "app"` and the bot's `displayName`. Nothing else has been checked. The SDK package's `ASSUMPTIONS.md` (`packages/jira/` in the SDK checkout) lists what is assumed. None of the following has been checked against a real site:

- Signature: header `X-Hub-Signature` with value `sha256=<hex>`, HMAC-SHA256 over the raw request body bytes, lowercase hex, keyed by the webhook secret. The header is documented; the raw-body input and hex format are assumed. Only `sha256` is accepted.
- `comment_created` payload: `webhookEvent`, `timestamp`, `comment`, `issue` are documented generically; the exact `comment.*` and `issue.fields.summary` layout is assumed from REST API v3, as is `comment.author.accountType` being `app` for bots. No cloud id is in the payload (assumed); the site comes from configuration.
- Comment body: ADF (`version: 1`, `type: "doc"`) is assumed. A string body is read as wiki markup, where a mention is `[~accountid:<id>]` (assumed); it is logged at warn so a mismatch shows up.
- Mention node: `{ type: "mention", attrs: { id, text, accessLevel } }` inline in a paragraph, possibly nested in blockquotes or lists; the command text follows as a separate `text` node. Recalled from the ADF spec, not re-fetched.
- Event id: `comment_created:<comment.id>`, from the signed body. The documented `X-Atlassian-Webhook-Identifier` header is ignored because the signature does not cover it (a replay with a fresh header would start a second run).
- Comment post: `POST /ex/jira/<cloudId>/rest/api/3/issue/{key}/comment` through the gateway with the Bearer token, `{ body: <ADF doc> }`, one paragraph per block. Assumed to work like `myself`; not verified.
- Acknowledgement and reply comments: both go through the same comment post as above (gateway, Bearer token); neither has been posted to a real site.
- Posted mention node: the reply's first paragraph is `{ "type": "mention", "attrs": { "id": "<accountId>", "text": "@<displayName>" } }` followed by a `text` node starting with a space. Not verified that Jira accepts this shape (without `accessLevel`) on a post, renders it as a mention, or notifies the requester.
- Issue fetch: `GET /ex/jira/<cloudId>/rest/api/3/issue/{key}?fields=summary,description` through the gateway with the Bearer token. Not verified.
- Cloudflare/alchemy bundling of the vendored TypeScript tarball is unproven (the package ships `.ts` sources; only `bun run test` and `bun run typecheck` have consumed it).

Behaviour to know: comment posting is at-least-once (Jira has no idempotency key), and mentions within the 3 second debounce window collapse to the last one.

Checks to run when a site is available:

1. Deploy, set the `JIRA_*` variables, and add the system webhook (see Jira setup).
2. Comment `@<bot> /research <text>` on an issue: expect a `👀 On it` comment at once, then, about 5 seconds later, exactly one reply that starts with a mention of you (and notifies you).
3. A mention without a command, an edited comment (`comment_updated`), and a bot-authored reply must each produce nothing.
4. Redeliver the same webhook from Jira: still one reply in total.
5. If any of these fail, compare the real payload and headers with the assumptions above and fix the channel package, not this Worker.
