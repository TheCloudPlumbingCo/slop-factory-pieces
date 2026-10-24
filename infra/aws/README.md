# aws/

**Role:** the GitHub control layer on AWS: the same bot behaviour as `../cloudfare`, built from API Gateway, Lambda, DynamoDB, SQS and EventBridge Scheduler.

API Gateway (HTTP API) exposes one route, `POST /integrations/github/webhook`, and passes it to the Receiver Lambda. The Receiver verifies the signature, records the event in the DynamoDB mailbox table (one item per GitHub issue or PR, plus dedup markers) and sends an SQS "nudge" for the mailbox. The Processor Lambda is triggered by the nudge queue, one message at a time, and runs the SDK's mailbox engine for that mailbox, with the echo agent running inside the same invocation. After its passes it re-nudges the mailbox if it is still due at some time. The Sweep Lambda runs every minute from EventBridge Scheduler and nudges every mailbox whose `readyAt` has passed, which recovers a lost nudge. The bot logic itself is shared with the Cloudflare deployment in `packages/core` (`@slop/core`).

## Layout

- `src/lambda/`: the three entry points, `receiver.ts`, `processor.ts`, `sweep.ts`.
- `src/Handlers.ts`: the three handlers as effects, built over services created once per cold start. Reads `MAILBOX_TABLE`, `NUDGE_QUEUE_URL`, `SSM_PREFIX`.
- `src/Config.ts`: reads the bot configuration from SSM.
- `src/MailboxTable.ts`, `DynamoMailboxTable.ts`, `MemoryMailboxTable.ts`, `MailboxState.ts`, `MailboxTransitions.ts`, `DynamoMailboxStore.ts`: the mailbox store (DynamoDB, and an in-memory table used by tests).
- `src/Nudger.ts`, `SqsNudger.ts`: the nudge port, its delay rule, and the SQS implementation.
- `src/InProcessAgent.ts`: runs the echo agent inside the Processor.
- `scripts/bundle.ts`: bundles each Lambda into one CommonJS file in `dist/`. `scripts/smoke.md`: the manual smoke checklist.
- `terraform/`: the infrastructure. `docker-compose.yml`: DynamoDB Local for tests.
- `test/`: the tests.

## Configuration

The Lambdas read their configuration from SSM Parameter Store at cold start: every parameter directly under the prefix, decrypted, each named by the last segment of its path. The default prefix is `/slop-code-factory/<stage>` (stage defaults to `dev`), so by default `/slop-code-factory/dev`. Override it with the Terraform variable `ssm_prefix` (must start with `/` and not end with `/`).

Create these five parameters under the prefix before the first request:

| Parameter | Type |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | SecureString |
| `GITHUB_PRIVATE_KEY` | SecureString |
| `GITHUB_APP_ID` | String or SecureString |
| `GITHUB_BOT_MENTION_NAME` | String or SecureString |
| `GITHUB_BOT_USER_ID` | String or SecureString |

Use SecureString at least for the two secrets. Terraform does not create these parameters, so the secret values never enter Terraform state. If they are encrypted with a customer managed KMS key, set `ssm_kms_key_arn`; with the default `aws/ssm` key, leave it null.

## Running the tests

From `infra/aws` (install once with `bun install` at the repo root):

```
bun run test
bun run typecheck
```

Without `DYNAMODB_ENDPOINT` the suites run against the in-memory table, and the DynamoDB suites are skipped. To run them against DynamoDB Local as well:

```
docker compose up -d
DYNAMODB_ENDPOINT=http://localhost:8000 bun run test
docker compose down
```

## Deploying

The owner approves `terraform plan` and `terraform apply`; they create real resources and cost money. Create the SSM parameters first (see Configuration).

1. Bundle the Lambdas: `bun run bundle` in `infra/aws`. This writes `dist/receiver.js`, `dist/processor.js`, `dist/sweep.js`; Terraform zips them.
2. `cd terraform` and run `terraform init`.
3. Run `terraform plan` and review it. Variables: `region` (default `ap-southeast-1`), `stage` (default `dev`), `ssm_prefix`, `ssm_kms_key_arn`, `log_retention_days` (default 14).
4. Run `terraform apply`.
5. Note the outputs: `webhook_url` (the GitHub App's webhook URL), `queue_url` (the nudge queue), `table_name` (the mailbox table).

Resources are named `slop-code-factory-<stage>` with a suffix: Lambdas `-receiver`, `-processor`, `-sweep`; queues `-nudges` and `-nudges-dlq`.

## Switching the GitHub App webhook

A GitHub App has one webhook URL, so one deployment receives its events at a time.

1. In the App's settings, set the webhook URL to the `webhook_url` output and the webhook secret to the value of `GITHUB_WEBHOOK_SECRET` stored in SSM.
2. Test (see `scripts/smoke.md`).
3. Afterwards switch the URL back to the Cloudflare Worker's `<worker-url>/integrations/github/webhook`, with its own webhook secret.

An event delivered while the URL is being switched goes to the old deployment and is lost to this one. This is accepted for testing.

## Reading logs

Each Lambda has a CloudWatch log group, kept for `log_retention_days`:

- `/aws/lambda/slop-code-factory-<stage>-receiver`
- `/aws/lambda/slop-code-factory-<stage>-processor`
- `/aws/lambda/slop-code-factory-<stage>-sweep`

For example: `aws logs tail /aws/lambda/slop-code-factory-dev-processor --follow`. The code logs failures (a failed record, a failed nudge send, a store write that conflicted too often) and does not log secret values. It does not log a line for each normal nudge; use the queue metrics for that (see `scripts/smoke.md`).

## How it works

- Every webhook becomes a state change in the mailbox item, with a dedup marker written in the same DynamoDB transaction, so a redelivery does nothing a second time.
- When a mailbox has work due at `readyAt`, it is nudged: a message `{ mailboxKey }` on the SQS queue with a delay of `readyAt - now`, never negative and capped at 900 s (the SQS maximum). The queue is a standard queue, not FIFO, because FIFO has no per-message delay. A duplicate nudge is harmless: the engine's claim and lease make it a no-op.
- The Processor takes one message per invocation (timeout 30 s), runs the mailbox passes, and nudges again if the mailbox is still due at some time. A failed record is reported back so SQS delivers it again; after 5 receives it goes to the dead-letter queue.
- A nudge capped at 900 s arrives before `readyAt` and finds nothing due. The sweep covers that case.
- The sweep runs every minute, finds mailboxes whose `readyAt` has passed and nudges them. In the normal case it finds nothing.
- The echo agent runs inside the Processor, waits 5 s, then replies. The delivery API routes are not exposed through API Gateway.

## Known limits

- Reply posting is at least once: GitHub comments have no idempotency key, so a retry after a crash between posting and recording can post twice.
- A nudge for a mailbox due later than 15 minutes is late by up to about a minute (the sweep). The engine's longest wait today is 10 minutes.
- The delivery API is not reachable over HTTP, so requirements 18 and 20 (hand-off over HTTP) are not exercised on AWS.

## Unverified

Nothing here has run on AWS:

- Nothing has been planned or applied.
- The IAM actions have never been exercised.
- The CommonJS bundles were loaded only locally, not on Lambda Node 22 on arm64.
- Duplicate-over-conflict precedence through `CancellationReasons` was shown only on DynamoDB Local.
- A standalone `TransactionConflictException` from `TransactWriteItems` would map to an unavailable error; it was not seen.
- Cold-start time is unmeasured.
- `GitHubApiLive` is untested against real GitHub from Lambda.

## Verified on AWS

Nothing has been verified on AWS yet. To be filled in from the owner's live run (`scripts/smoke.md`): observed results with timings, and what remains unverified.
