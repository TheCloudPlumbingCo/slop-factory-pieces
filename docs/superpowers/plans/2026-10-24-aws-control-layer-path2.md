# AWS Control Layer (Path 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the GitHub control layer on AWS (API Gateway, Lambda, DynamoDB, SQS, Terraform) by reusing the SDK mailbox engine over a new DynamoDB store, and pass the same shared behaviour suite that Cloudflare passes.

**Architecture:** `packages/core` gains the cloud-neutral bot wiring (`handOff`, GitHub provider, `botSettings`). A new workspace `infra/aws` holds a `MailboxTable` port with in-memory and DynamoDB implementations, a `ChannelsStorage` built on it, and three Lambdas (Receiver, Processor, Sweep). After every mailbox write the store sends an SQS nudge delayed to the engine's `readyAt`; the Processor runs the engine for that one mailbox. The echo agent runs inside the Processor.

**Tech Stack:** TypeScript, Effect 4.0.0, Vitest 5.0.1, Bun workspaces, `@humanlayer/channels-*` 0.1.0, AWS SDK v3 (DynamoDB, SQS, SSM), DynamoDB Local (Docker) for tests, Terraform, esbuild for Lambda bundles.

**Spec:** `docs/superpowers/specs/2026-10-24-aws-control-layer-path2-design.md` (supersedes parts of `2026-10-23-aws-control-layer-design.md`). Read both. `docs/superpowers/plans/2026-10-23-core-extraction-and-shared-tests.md` is done except its durable-function spike, which this plan drops.

## Global Constraints

- AWS region `ap-southeast-1`; the owner's existing account. Never run `terraform apply`, change the GitHub App webhook URL, or call AWS with write effect without asking the owner first.
- Cloudflare behaviour must not change; every test in `infra/cloudfare/test` and `packages/core/test` stays green after each task.
- `packages/core` imports no `alchemy`, `@humanlayer/channels-alchemy-cloudflare`, `@cloudflare/*` or `@aws-sdk/*` (`packages/core/test/no-cloud-imports.vi.test.ts` enforces it). `infra/aws` imports none of the Cloudflare packages either.
- Reuse the library's rules. The store never re-implements lease, claim, retry or terminal-reply logic; it calls the functions exported from `@humanlayer/channels-delivery` (`startDeliveryBatch`, `claimFrozenBatch`, `recordDeliveryAttempt`, `renewDeliveryClaim`, `prepareDeliverySlot`, `handOffDeliverySlot`, `claimDeliveryOutput`, `renewDeliveryOutput`, `settleDeliveryOutput`, `applyDeliverySlotMutation`, `readDeliverySlotStatus`, `requestDeliveryInterrupt`, `activeDeliveryWork`).
- Namespace `slop-code-factory`; mailbox key `namespace|provider|installationId|resourceId`, each part `<length>:<text>`; debounce `Debounce {quietPeriodMs: 3000, maxWaitMs: 3000}`; event processing `concurrency: 1, leaseMs: 10_000, maxAttempts: 5` (all from `botSettings`).
- Timer: SQS **standard** queue, per-message delay `max(0, readyAt - now)` capped at 900 s; a sweep rule runs once a minute. FIFO queues are not used.
- Processor Lambda timeout is longer than the 5 s echo wait plus `leaseMs` (this plan sets 30 s).
- The working tree has unrelated changes (`infra/cloudfare/README.md`, the untracked 10-24 spec). Never `git add -A` or `git add .`; add only the files a task names.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Code style: tabs, no semicolons, single quotes, `Effect.fn` for named effects, doc comment on each exported thing (match `packages/core/src`).

## Review Focus

Failure modes the spec implies that no obvious task would test. Each has a test in the task named.

- Two writers race on one mailbox: the loser retries, no event is lost or double-claimed (Task 3, Task 4).
- Crash between saving an event and sending its nudge: the sweep re-sends it, and the run still happens (Task 5).
- A stale or duplicate nudge for an idle mailbox does nothing and posts nothing (Task 5).
- A wake-up further than 15 minutes away: the nudge is capped at 900 s and the next nudge re-arms (Task 5).
- API Gateway delivers the body base64-encoded and header names in mixed case: the signature must still verify against the raw bytes (Task 7).
- A mailbox item too large for DynamoDB: the webhook returns 503 so GitHub redelivers, instead of dropping the event (Task 3).

## File Structure

```text
packages/core/src/
  Handoff.ts           NEW   moved from infra/cloudfare/src; hand-off via the AgentSessions port
  GithubBot.ts         NEW   githubHandlers, makeGitHubProvider, botSettings (moved, no ChannelsCloudflare)
infra/cloudfare/src/
  GithubBot.ts         keeps `bot`; re-exports the moved names so tests do not change
  Handoff.ts           DELETED
infra/aws/                         NEW workspace "slop-code-factory-aws"
  src/MailboxState.ts       state schema (same shape as the Cloudflare adapter's, no alchemy)
  src/MailboxTable.ts       port: read, write (atomic with dedup), due, subscriptions
  src/MemoryMailboxTable.ts in-memory implementation (tests, drivers)
  src/DynamoMailboxTable.ts DynamoDB implementation (one item per mailbox, GSI "due")
  src/Nudger.ts             port + delay rule + SQS implementation
  src/DynamoMailboxStore.ts ChannelsStorage over MailboxTable + Nudger
  src/InProcessAgent.ts     AgentSessions that runs the echo in the Processor, plus drain
  src/Handlers.ts           Receiver, Processor, Sweep Lambda handlers
  src/Config.ts             ConfigProvider from SSM parameters
  test/support/*.ts         fake queue, AWS drivers for the shared suite
  test/*.test.ts
  terraform/                main.tf, variables.tf, outputs.tf, versions.tf
```

### Task 1: Move the bot wiring into `@slop/core`

**Files:**
- Create: `packages/core/src/Handoff.ts`, `packages/core/src/GithubBot.ts`
- Modify: `packages/core/src/index.ts`, `infra/cloudfare/src/GithubBot.ts`, `infra/cloudfare/src/JiraBot.ts` (import path only)
- Delete: `infra/cloudfare/src/Handoff.ts`
- Test: existing `packages/core/test/no-cloud-imports.vi.test.ts`, all of `infra/cloudfare/test`

**Interfaces:**
- Produces (exported from `@slop/core`): `handOff(request: MentionRequest, context: DeliveryContext): Effect<DeliveryHandoff, DeliveryHandoffError, AgentSessions>`, `githubHandlers`, `makeGitHubProvider`, `botSettings` (same bodies and types as today).
- `infra/cloudfare/src/GithubBot.ts` keeps `bot` and re-exports `githubHandlers`, `makeGitHubProvider`, `botSettings` from `@slop/core`, so `Worker.ts`, `DeliveryMailboxDO.ts` and the three tests import unchanged.

- [ ] **Step 1: Run `bun run test` in `packages/core` and `infra/cloudfare`; record both as the green baseline.**
- [ ] **Step 2: Move `handOff` (with `HANDOFF_FAIL_AFTER = '10 minutes'`) to `packages/core/src/Handoff.ts` and `githubHandlers`, `makeGitHubProvider`, `botSettings` plus their helper types to `packages/core/src/GithubBot.ts`. The code is moved, not rewritten; `bot` and the `jira` import stay in the Cloudflare file.**
- [ ] **Step 3: Export both from `packages/core/src/index.ts`; update the `./Handoff` import in `infra/cloudfare/src/JiraBot.ts` to `@slop/core`; re-export the three names from `infra/cloudfare/src/GithubBot.ts`.**
- [ ] **Step 4: Run `bun run test` and `bun run typecheck` in both packages.** Expected: same pass counts as Step 1, including `no-cloud-imports`.
- [ ] **Step 5: Commit** `refactor: move hand-off and GitHub provider wiring into @slop/core` (add only the files above).

### Task 2: `infra/aws` workspace and the `MailboxTable` port with an in-memory table

**Files:**
- Create: `infra/aws/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/MailboxState.ts`, `src/MailboxTable.ts`, `src/MemoryMailboxTable.ts`, `test/mailbox-table.contract.ts`, `test/memory-mailbox-table.vi.test.ts`
- Modify: root `package.json` (`workspaces` gains `infra/aws`)

**Interfaces:**
- Produces in `MailboxState.ts`: `MailboxState` (Schema.Struct with `mailboxKey`, `provider`, `nextSequence`, `waiting`, `deliveries`; fields as in the Cloudflare adapter's `DurableMailboxState`, built from `DeliveryAdmission`, `DeliverySlot`, `MailboxSequence`, `Timestamp`, `emptyDeliverySlot` exported by `@humanlayer/channels-delivery`), `emptyMailboxState(input: { mailboxKey: string; provider: string }): MailboxState`.
- Produces in `MailboxTable.ts`:
  - `class TableUnavailable extends Schema.TaggedError` (`reason: string`)
  - `class MailboxTable extends Context.Service` with:
    - `read(mailboxKey: string): Effect<Option<{ state: MailboxState; version: number }>, TableUnavailable>`
    - `write(input: { state: MailboxState; expectedVersion: number | null; newEventKey?: string }): Effect<'written' | 'conflict' | 'duplicate', TableUnavailable>`. When `newEventKey` is given, the dedup marker and the state are stored in one atomic operation: a marker that already exists returns `'duplicate'` and stores nothing. `expectedVersion: null` means the mailbox must not exist yet.
    - `due(now: number): Effect<ReadonlyArray<string>, TableUnavailable>` (mailbox keys whose `deliveries.readyAt <= now`)
    - `subscribe(mailboxKey)`, `isSubscribed(mailboxKey)`, `unsubscribe(mailboxKey)` (marker items)
- Produces: `defineMailboxTableContract(name: string, make: Effect<MailboxTable, never, Scope>)` in `test/mailbox-table.contract.ts`, run by each implementation's test file.

- [ ] **Step 1: Create the workspace files (`name: slop-code-factory-aws`, private, `type: module`, scripts `test` and `typecheck` like `packages/core`; dependencies copied from `infra/cloudfare` minus alchemy/Cloudflare, plus `@slop/core: "*"`; the same pinned Jira tarball spec byte for byte) and add the workspace; run `bun install` from the repo root.**
- [ ] **Step 2: Write the contract tests** in `test/mailbox-table.contract.ts`, each as its own `it.effect`:
  - `reading a mailbox that was never written returns none`
  - `write with expectedVersion null creates the mailbox at version 1 and a second such write returns 'conflict'`
  - `write with a stale expectedVersion returns 'conflict' and leaves the stored state unchanged`
  - `write with a new event key stores the state; the same key on a later write returns 'duplicate' and stores nothing`
  - `two concurrent writes with the same expectedVersion: exactly one 'written'` (Review Focus: race)
  - `due returns only mailboxes whose readyAt is at or before now`
  - `subscribe, isSubscribed and unsubscribe round trip`
- [ ] **Step 3: Run `bun run test` in `infra/aws`.** Expected: FAIL (no implementation).
- [ ] **Step 4: Implement `MemoryMailboxTable` (a `Layer` over a `Ref`/`SynchronizedRef` of maps) and wire it into `test/memory-mailbox-table.vi.test.ts`.**
- [ ] **Step 5: Run the tests and `bun run typecheck`.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(aws): add infra/aws workspace and MailboxTable port with in-memory table`.

### Task 3: DynamoDB `MailboxTable`

**Files:**
- Create: `infra/aws/src/DynamoMailboxTable.ts`, `infra/aws/test/dynamo-mailbox-table.vi.test.ts`, `infra/aws/docker-compose.yml` (DynamoDB Local on port 8000)
- Modify: `infra/aws/package.json` (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, pinned to the current 3.x)

**Interfaces:**
- Consumes: `MailboxTable`, `defineMailboxTableContract` (Task 2).
- Produces: `makeDynamoMailboxTable(input: { tableName: string; client: DynamoDBDocumentClient }): MailboxTable['Type']`, and `DynamoMailboxTableLive(input): Layer<MailboxTable>`.
- Table shape (this plan's call): partition key `pk` (string). Mailbox item `pk = "mbx#<mailboxKey>"` holds `state` (the encoded `MailboxState`), `version` (number) and, only while `readyAt` is not null, `dueAt = readyAt` and `due = "due"`. Dedup item `pk = "evt#<eventKey>"` with `ttl` (epoch seconds, 30 days). Subscription item `pk = "sub#<mailboxKey>"`. GSI `due-index` on (`due`, `dueAt`), sparse. `write` is `TransactWriteItems` (state put with condition on `version`, plus dedup put with `attribute_not_exists(pk)` when `newEventKey` is given); a `TransactionCanceledException` is mapped to `'conflict'` or `'duplicate'` by its cancellation reasons.

- [ ] **Step 1: Write `dynamo-mailbox-table.vi.test.ts`: run `defineMailboxTableContract` against DynamoDB Local when `DYNAMODB_ENDPOINT` is set (the test creates a uniquely named table and deletes it in a finalizer), skipped with a printed reason otherwise. Add `writing a mailbox item over 400 KB fails with TableUnavailable, not a thrown defect` (Review Focus: item size).**
- [ ] **Step 2: Start DynamoDB Local with `docker compose -f infra/aws/docker-compose.yml up -d` and run `DYNAMODB_ENDPOINT=http://localhost:8000 bun run test` in `infra/aws`.** Expected: FAIL (no implementation).
- [ ] **Step 3: Implement `makeDynamoMailboxTable`. Every SDK error becomes `TableUnavailable` (no defects escape); `due` queries the GSI.**
- [ ] **Step 4: Run the same command.** Expected: PASS, including the concurrent-write test.
- [ ] **Step 5: Commit** `feat(aws): DynamoDB MailboxTable with atomic dedup and conditional writes`.

### Task 4: `DynamoMailboxStore` (the `ChannelsStorage`)

**Files:**
- Create: `infra/aws/src/Nudger.ts` (port and delay rule only), `infra/aws/src/DynamoMailboxStore.ts`, `infra/aws/test/dynamo-mailbox-store.vi.test.ts`

**Interfaces:**
- Consumes: `MailboxTable`, `MailboxState` (Task 2).
- Produces in `Nudger.ts`: `class Nudger extends Context.Service` with `nudge(mailboxKey: string, delayMs: number): Effect<void>` (never fails; failures are logged), `MAX_NUDGE_DELAY_MS = 900_000`, `nudgeDelay(readyAt: number, now: number): number` (`min(max(0, readyAt - now), MAX_NUDGE_DELAY_MS)`).
- Produces in `DynamoMailboxStore.ts`: `makeDynamoStorage(input: { polling: ChannelsStorage['polling']; scope?: string }): ChannelsStorage<never, MailboxTable | Nudger, DeliveryControlBackend>`. It provides `MailboxDelivery`, `MailboxProcessingBackend`, `MailboxSubscriptions` and `DeliveryControlBackend`. With `scope` set, `findReadyMailboxes` looks only at that mailbox key; without it, it uses `MailboxTable.due(now)` and reads each.
- Behaviour: every method is "read the mailbox, apply the library's rule function, conditional write, retry on `'conflict'` up to 5 times, then fail with the engine's `Unavailable` error". Model each method on `MailboxBackendMemory.js` and the Cloudflare adapter's `MailboxProcessingBackend.js` and `MailboxDelivery.js` in `node_modules/@humanlayer/`. `deliver` writes with `newEventKey = namespace|provider|eventId` and `readyAt = now` unless a delivery is active. After every successful write whose state has `deliveries.readyAt !== null`, call `Nudger.nudge(mailboxKey, nudgeDelay(readyAt, now))`.

- [ ] **Step 1: Write failing tests with `MemoryMailboxTable` and a recording `Nudger`** (names are the assertions' subjects):
  - `deliver stores the event and nudges with delay 0`
  - `deliver of the same event id twice reports accepted false the second time and nudges once`
  - `a write that sets readyAt three seconds ahead nudges with delay 3000`
  - `a readyAt over 15 minutes ahead nudges with delay 900000` (Review Focus: cap)
  - `findReadyMailboxes with scope looks only at that key`
  - `two concurrent claimMailbox calls on one mailbox: exactly one gets the batch` (Review Focus: race)
  - `a nudger that fails does not fail the write`
- [ ] **Step 2: Run `bun run test`.** Expected: FAIL.
- [ ] **Step 3: Implement `Nudger.ts` and `DynamoMailboxStore.ts` as specified.**
- [ ] **Step 4: Run `bun run test` and `bun run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(aws): ChannelsStorage over MailboxTable with readyAt nudges`.

### Task 5: Run the shared behaviour suite on the store

**Files:**
- Create: `infra/aws/test/support/aws-driver.ts`, `infra/aws/test/support/fake-queue.ts`, `infra/aws/test/control-layer.vi.test.ts`, `infra/aws/test/sweep.vi.test.ts`

**Interfaces:**
- Consumes: `ControlLayerDriver`, `defineControlLayerSuite` from `@slop/core/conformance/*`; `makeDynamoStorage`; `makeMemoryDriver` at `infra/cloudfare/test/support/memory-driver.ts` as the model (copy its structure; it is not importable across workspaces).
- Produces: `makeAwsDriver(input: { table: Layer<MailboxTable>; mode: 'polling' | 'nudge' }): Effect<ControlLayerDriver, never, Scope>`; `makeFakeQueue(): { nudger: Layer<Nudger>; pending: Effect<ReadonlyArray<{ mailboxKey: string; deliverAt: number }>>; deliverDue: (run: (mailboxKey: string) => Effect<void>) => Effect<number> }`.
- In `'polling'` mode the storage uses `polling: { intervalMs: 100 }` and a no-op nudger. In `'nudge'` mode it uses `polling: 'disabled'`, the fake queue, and a runner that builds `Channels.processingLayer(options, 'disabled')` over a store scoped to the message's key and runs `processReady` until a pass finds no work, at most 20 passes. `advance` steps the `TestClock` by at most 100 ms and calls `deliverDue` after each step. `restart` drops all in-memory processing state and keeps the table and queue.

- [ ] **Step 1: Write `control-layer.vi.test.ts` calling `defineControlLayerSuite('aws polling over memory table', ...)` and `defineControlLayerSuite('aws nudge over memory table', ...)`, plus the same two over `DynamoMailboxTableLive` when `DYNAMODB_ENDPOINT` is set.**
- [ ] **Step 2: Write `sweep.vi.test.ts`:**
  - `an event saved while the nudger fails is nudged by the sweep and then produces one agent start` (Review Focus: crash between save and nudge)
  - `a nudge for an idle mailbox starts nothing and posts nothing` (Review Focus: stale nudge)
  - `the sweep nudges every mailbox in table.due(now) and none other`
- [ ] **Step 3: Run `bun run test`.** Expected: FAIL (driver not implemented).
- [ ] **Step 4: Implement the drivers, the fake queue and `sweep(now): Effect<number>` in `src/DynamoMailboxStore.ts` (sends one nudge per key from `table.due(now)`, delay 0, returns the count).**
- [ ] **Step 5: Run `bun run test`.** Expected: all twelve behaviours B1 to B12 pass in every mode. A failing behaviour means the store or the nudge rule is wrong, not the suite; fix the store.
- [ ] **Step 6: Commit** `test(aws): pass the shared control-layer suite on the DynamoDB store`.

### Task 6: Echo agent inside the Processor

**Files:**
- Create: `infra/aws/src/InProcessAgent.ts`, `infra/aws/test/in-process-agent.vi.test.ts`

**Interfaces:**
- Consumes: `answer`, `AgentSessions`, `DeliveryApi` from `@slop/core`.
- Produces: `makeInProcessAgentSessions: Effect<{ layer: Layer<AgentSessions, never, DeliveryApi>; drain: Effect<void> }>`. `send` forks `answer(message)` in a scope the object owns and returns at once; `drain` waits for every forked answer to finish. A Lambda freezes after returning, so the Processor must call `drain` before it returns.

- [ ] **Step 1: Write failing tests with a fake `DeliveryApi` and the `TestClock`:**
  - `send returns before the echo has completed the delivery`
  - `drain returns only after the 5 second echo wait and the complete call` (advance 5 s while draining)
  - `a send for the same message twice completes the delivery once and ignores DeliveryClosed`
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement `makeInProcessAgentSessions`.**
- [ ] **Step 4: Run `bun run test` and `bun run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(aws): run the echo agent inside the processor with a drain`.

### Task 7: Lambda handlers

**Files:**
- Create: `infra/aws/src/Handlers.ts`, `infra/aws/src/Config.ts`, `infra/aws/src/SqsNudger.ts`, `infra/aws/test/handlers.vi.test.ts`
- Modify: `infra/aws/package.json` (`@aws-sdk/client-sqs`, `@aws-sdk/client-ssm`, `@types/aws-lambda`)

**Interfaces:**
- Consumes: Tasks 3 to 6; `Channels.routesLayer`, `deliveryApiRoutes`, `DeliveryControlLive`, `makeDeliveryClient` from `@humanlayer/channels-delivery` (the in-process delivery client is built as `makeMemoryDriver` builds `inProcess`).
- Produces in `Handlers.ts`: `receiverHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2>`, `processorHandler(event: SQSEvent): Promise<SQSBatchResponse>` (batch size 1; a failure reports that item), `sweepHandler(): Promise<{ nudged: number }>`. `SqsNudger.ts`: `SqsNudgerLive(queueUrl: string): Layer<Nudger>` using `SendMessage` with `DelaySeconds = ceil(delayMs / 1000)` (SQS timers are whole seconds). `Config.ts`: `ssmConfigProvider(prefix: string): Effect<ConfigProvider>` reading every parameter under the prefix (`GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_MENTION_NAME`, `GITHUB_BOT_USER_ID`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`).
- Receiver rule: rebuild the `Request` from the raw body (decode base64 when `isBase64Encoded`) and the headers lower-cased, so the signature verifies against the original bytes.
- Processor rule: build the store scoped to the first record's `mailboxKey`, `polling: 'disabled'`, run `processReady` in a loop of at most 20 passes, call `drain` after each pass.

- [ ] **Step 1: Write failing tests with the memory table, the fake queue, and a fake GitHub API (reuse the pattern in `makeMemoryDriver`):**
  - `receiver returns 200 for a signed mention and queues one nudge`
  - `receiver verifies the signature when the body is base64 encoded and header names are mixed case` (Review Focus)
  - `receiver returns 401 or 403 for a bad signature and queues nothing`
  - `receiver returns 503 when the table is unavailable` (so GitHub redelivers)
  - `processor handles a nudge for an idle mailbox and returns no failures`
  - `SqsNudger rounds a 2500 ms delay up to DelaySeconds 3`
  - `sweepHandler nudges each due mailbox and reports the count`
- [ ] **Step 2: Run `bun run test`.** Expected: FAIL.
- [ ] **Step 3: Implement the handlers, `SqsNudger` and `ssmConfigProvider`. Build the Effect layers once per cold start; build the key-scoped processing per invocation.**
- [ ] **Step 4: Run `bun run test` and `bun run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(aws): receiver, processor and sweep Lambda handlers`.

### Task 8: Bundling and Terraform

**Files:**
- Create: `infra/aws/terraform/{versions,variables,main,outputs}.tf`, `infra/aws/scripts/bundle.ts` (esbuild; one bundle per handler into `infra/aws/dist/`), `infra/aws/.gitignore` (`dist/`, `.terraform/`, `*.tfstate*`)
- Modify: `infra/aws/package.json` (`bundle` script, `esbuild` pinned)

**Interfaces:**
- Produces Terraform inputs: `region` (default `ap-southeast-1`), `stage`, `ssm_prefix`. Outputs: `webhook_url` (`<api>/integrations/github/webhook`), `queue_url`, `table_name`.
- Resources: HTTP API with the webhook route to the Receiver; Receiver, Processor (timeout 30 s, memory per the builder, SQS event source with `batch_size = 1` and `ReportBatchItemFailures`), Sweep Lambdas; standard SQS queue with a DLQ and a visibility timeout the builder sets from the AWS rule for Lambda event sources (check the AWS docs); DynamoDB table (on-demand, TTL on `ttl`, GSI `due-index`); EventBridge Scheduler `rate(1 minute)` to Sweep; IAM least privilege (table, queue, SSM prefix); CloudWatch log groups.

- [ ] **Step 1: Add `bun run bundle` and confirm it produces three files under `dist/`.**
- [ ] **Step 2: Write the Terraform.**
- [ ] **Step 3: Run `terraform -chdir=infra/aws/terraform init -backend=false` then `terraform -chdir=infra/aws/terraform validate`.** Expected: `Success! The configuration is valid.`
- [ ] **Step 4: Run `terraform -chdir=infra/aws/terraform plan` with the owner's AWS credentials only after the owner agrees; save the plan output for the owner.** Expected: only creates, no destroys.
- [ ] **Step 5: Commit** `feat(aws): Terraform for API Gateway, Lambdas, SQS, DynamoDB and the sweep`.

### Task 9: Deploy and live smoke test (owner-gated)

**Files:**
- Create: `infra/aws/README.md` (deploy steps, parameter names, how to switch the GitHub App webhook, how to read logs), `infra/aws/scripts/smoke.md` (the manual checklist below)

- [ ] **Step 1: Ask the owner to approve `terraform apply` for the planned resources; apply only after a yes. Put the five SSM parameters in place (values supplied by the owner, never committed).**
- [ ] **Step 2: Ask the owner to switch the GitHub App's webhook URL to `webhook_url` (and back afterwards).**
- [ ] **Step 3: Smoke checklist, each observed on a test issue:**
  - Mention the bot: 👀 within about 4 s, one echo reply about 5 s later.
  - Redeliver the same webhook from GitHub: no second reply.
  - Two mentions within 3 s: one reply.
  - A user without write access: 👎 and one notice.
  - The Processor log shows a nudge for each `readyAt` and the sweep finding nothing in the normal case.
- [ ] **Step 4: Record the observed results, with timings, in `infra/aws/README.md` under "Verified on AWS"; list anything not observed as unverified.**
- [ ] **Step 5: Commit** `docs(aws): deploy steps and verified smoke results`.

## Self-review notes

- Spec coverage: store (Tasks 2 to 4), nudges and cap (4, 5), sweep (5, 7, 8), echo in the Processor with `drain` and the 30 s timeout (6, 8), Terraform resources (8), shared suite on the new store (5), deploy and verification (9), core extraction of the bot wiring (1). Jira on AWS is out of this plan, as in the spec.
- One refinement of the spec: the spec said the in-process `DeliveryApi` calls the backend directly. This plan reaches the engine's delivery API routes in process, as `makeMemoryDriver` does, because `DeliveryApi` is the generated HTTP client type and this keeps the `/complete` route exercised. Over-the-wire HTTP across processes is still untested, as the spec says.
- The dedup marker and the state write share one `TransactWriteItems`, so a crash cannot mark an event seen without saving it. The spec left the DynamoDB layout to the builder; this is the plan's call.
