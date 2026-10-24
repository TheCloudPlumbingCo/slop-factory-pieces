# AWS control layer, path 2: design

Date: 2026-10-24. Status: draft for approval. Nothing is built. This **supersedes part of** [2026-10-23-aws-control-layer-design](2026-10-23-aws-control-layer-design.md). Everything in that document stays in force except the sections listed under [What changes](#what-changes). Background: [08-aws-control-layer](../../08-aws-control-layer.md). Requirement numbers refer to [03-user-requirements](../../03-user-requirements.md).

Items marked **(call)** are decisions I made and the owner has not confirmed. Items marked **(unverified)** were not checked against code or current docs.

## Intent

Run the same control layer on AWS by reusing the SDK's own mailbox engine (`@humanlayer/channels-delivery`), with a new DynamoDB store and an SQS timer. The agent stays the echo stub. The goal is unchanged: show that Cloudflare and AWS both satisfy the same requirements, and keep the two deployments separate.

## Why this changes the earlier design

On 2026-10-23 the owner chose to write the mailbox rules ourselves ("path 1"), from a description that overstated the SDK's Cloudflare coupling. On 2026-10-24 the owner chose **path 2** after these findings, all from reading the library source in `node_modules/@humanlayer` and the AWS docs:

- Only `channels-alchemy-cloudflare` imports `alchemy`. `channels-delivery`, `channels-github` and `channels-jira` depend only on `effect`.
- A store hands the engine `{ polling, layer }`. The layer provides `MailboxDelivery`, `MailboxProcessingBackend` (10 methods) and `MailboxSubscriptions`, plus `DeliveryControlBackend` for the delivery API.
- Each backend method loads the mailbox record, calls a rule function the library exports (`startDeliveryBatch`, `renewDeliveryClaim`, `settleDeliveryOutput` and others) and saves atomically. The Cloudflare backend is 208 lines.
- Every write sets `deliveries.readyAt`, "when the mailbox next needs processing". Cloudflare sets its alarm to that time. AWS sends an SQS message with that delay.
- A test that passes proves the library's rules, not our copy of them.

## What changes

| Earlier design (10-23) | Now |
|---|---|
| Write the mailbox rules ourselves | Reuse the SDK engine; write a DynamoDB store |
| Split every handler into "decide" and "hand off" (the largest edit and main risk) | **Not needed.** Handlers keep `onMentioned(DeliveryContext)` and `context.handoff()`. `deliveryId` and `accessToken` stay in `AgentSessionMessage`. |
| Lambda durable function for the lifecycle, after a one-day spike | SQS standard queue as the timer **(call)**. No durable function. |
| Own DynamoDB table (`STATE`, `EVT#`, `RUN`, `SEEN#` rows, guessed) | Library's `DurableMailboxState` as one item per mailbox, plus dedup and subscription items |
| Spike on durable functions | Replaced by the findings above. A short spike on the store's concurrency is still listed under [Verification](#verification). |

Unchanged: goals, non-goals, anti-goals, folder layout (`packages/core`, `infra/cloudfare`, `infra/aws`), the shared behaviour test list, GitHub first, Terraform, region `ap-southeast-1`, the single shared GitHub App, and the order of work (core extraction is already done).

## Design

### Flow

```text
GitHub -> API Gateway -> Receiver Lambda -> DynamoDB (save event, readyAt = now)
                              |                    ^
                              +--> SQS nudge ------+--> Processor Lambda
                                    {mailboxKey}          runs the engine for that one mailbox
                                    delay = readyAt-now   after every write: nudge again at readyAt
```

1. **Receiver Lambda.** The engine's webhook routes verify the signature and parse the event. `MailboxDelivery.deliver` saves the event and sets `readyAt = now`. The Receiver sends an SQS message with the mailbox key and no delay, then returns 200.
2. **Processor Lambda**, triggered by SQS. It builds the engine with `polling: 'disabled'` and a backend **scoped to the message's mailbox key**, the same way a Cloudflare Durable Object sees only its own mailbox. It runs `processReady` in a loop until a pass finds no work, up to 20 passes, as the Cloudflare alarm handler does. The engine claims or defers, runs the callback, and posts the reply as a separate output step.
3. **Re-arm after every write.** Any time the store writes a mailbox with `readyAt` not null, it sends a nudge with delay `max(0, readyAt - now)`, capped at 900 s (the SQS limit). Longer waits re-enqueue. This covers the debounce end, lease deadlines, callback retries, and output retries. We never compute these times; the engine does.
4. **Sweep.** An EventBridge Scheduler rule runs once a minute. It finds mailboxes whose `readyAt` is in the past and sends a nudge for each. This covers a lost nudge and a write that did not re-arm. The Cloudflare adapter documents both as real failure modes (`MailboxAlarm.js`).

Why a standard queue **(call)**: FIFO queues do not support per-message delay, and "one at a time per mailbox" is already enforced by the engine's claim and lease. A duplicate or stale nudge finds nothing due and does nothing.

Why not EventBridge Scheduler alone: it fires with 60-second precision, and the bot's debounce is 3 s.

### The store

Implements `ChannelsStorage`: `{ polling: 'disabled', layer }`.

- **Mailbox state:** one DynamoDB item per mailbox key holding the encoded `DurableMailboxState` (`mailboxKey`, `provider`, `nextSequence`, `waiting[]`, `deliveries`). Updates use a version attribute and a conditional write. On a conflict, re-read and re-apply the rule function. This replaces the serial execution a Durable Object gives for free.
- **Dedup:** one item per `eventId` (conditional put). A repeat returns `accepted: false` and the webhook still gets 200. Keep these items long enough that a provider redelivery cannot outlive them; the TTL is the builder's to settle.
- **Subscriptions:** one marker item per mailbox key.
- **`DeliveryControlBackend`:** needed because the echo agent finishes through the delivery API.
- **Rule functions come from the library.** The store never re-implements lease, claim or terminal-reply rules.
- The mailbox key format is unchanged, so keys match Cloudflare's.

Size: about 400 to 500 lines of TypeScript, plus the two Lambdas **(guess)**.

### Agent side (placeholder, to be resolved later)

Decided by the owner on 2026-10-24: the real agent part is out of scope for now, and the echo runs **inside the Processor Lambda**. Under Cloudflare the agent is a Durable Object and the delivery API is a service binding. On AWS for now:

- `AgentSessions.send` runs the echo agent in-process, in the same invocation that ran the callback. It waits `MOCK_WORK_DURATION` (5 s) and then finishes the delivery through the `DeliveryApi` port.
- The `DeliveryApi` port is filled by a direct call on the `DeliveryControlBackend`, not over HTTP. **(call)**

Comments on this placeholder, so nobody mistakes it for the final shape:

- **It is a stand-in, not a design.** The echo's 5 s wait only simulates agent work. A real agent runs for minutes, in its own process, and must not hold the Processor open.
- **The Processor timeout must exceed the 5 s wait plus the lease** (`leaseMs`), or the engine may treat the claim as lost while the echo is still running.
- **What this does not test:** the hand-off across a process boundary and the HTTP delivery API (`/complete`, `/fail`, `accessToken` check). Requirements 18 and 20 are therefore not exercised on AWS until the agent moves out. The `deliveryApi` routes can still be mounted and tested separately.
- **Where it changes later:** only the `AgentSessions` and `DeliveryApi` implementations in `infra/aws`. `@slop/core` and the store do not change.
- **Likely later shape (a guess):** `AgentSessions.send` invokes an Agent Lambda (or another runtime) asynchronously. The agent calls the delivery API over HTTPS with the `accessToken` from `AgentSessionMessage`, served by the engine's `deliveryApi` routes on the same API Gateway.

### Terraform

One HTTP API (webhook route; delivery API routes are optional while the echo runs in-process), Receiver and Processor Lambdas, one SQS standard queue with a dead-letter queue, one DynamoDB table (on-demand), one EventBridge Scheduler rule, secrets in SSM or Secrets Manager, IAM roles, CloudWatch logs. The layout is the builder's to settle.

## Goals, non-goals, anti-goals

Inherited from the 10-23 document. One addition to the anti-goals: **the store must not copy the library's lifecycle rules.** If a rule seems to need changing, change how the store calls the library, or report it to the library's maintainers.

## Constraints

- The echo runs inside the Processor, so the Processor's timeout must be longer than the 5 s wait plus `leaseMs`.
- Delivery from SQS is at least once. Every Processor invocation must be safe to repeat; the claim and lease make it so.
- Reply posting is at least once. GitHub comments have no idempotency key, so a crash between posting and recording it can post twice. The library's output step carries an idempotency key for providers that honour one; GitHub does not.
- One DynamoDB item per mailbox is capped at 400 KB. Waiting payloads plus retained deliveries must stay under it **(unverified, size of retained deliveries not measured)**.
- `maxAttempts`, `leaseMs` and the output retry bounds come from the engine's options (`DEFAULT_OUTPUT_MAX_ATTEMPTS = 8`, output retry 1 s to 5 min). Processor Lambda timeout must be longer than `leaseMs`.
- Only one deployment may receive the GitHub App's webhooks at a time (from the 10-23 document).

## Left to the builder

- DynamoDB item layout, version attribute, and the TTL on dedup items.
- How the store is scoped to one mailbox key per invocation.
- Lambda bundling of Effect code, logging, alarms, timeouts and memory.
- The sweep's query: a secondary index on `readyAt`, or a scan, given test-scale volumes.
- How the shared behaviour tests run against the AWS wiring locally (for example DynamoDB Local), plus a deployed smoke test.
- Terraform state backend and module layout.

## Verification

Before building the whole store, the builder confirms three things in a small throwaway test:

1. Run the engine against a key-scoped in-memory backend and see `processReady` claim, defer and re-arm without scanning other mailboxes.
2. Run two concurrent writers against DynamoDB Local with the conditional write, and confirm the loser retries and the lease/claim rules still hold.
3. Check the real item size of a mailbox after a full echo run, with retained deliveries.

## Unverified

- That `Crypto` and the Effect runtime bundle and run on Lambda without changes.
- Whether pull requests use `kind = issue` in the mailbox key.
- How GitHub handles several mentions in one batch (Jira's README says the callback runs for the last mention).
- The `channels-sql` and `channels-redis` stores named in the SDK README; they would be a useful reference but were not read.
- Cloudflare errors in the last 7 days (13 of 901 requests) were not investigated.
- The earlier document's claim that durable functions are available in `ap-southeast-1` was not re-checked. Under this design it no longer matters.

## Open questions

- Confirmed by the owner on 2026-10-24: SQS standard is the timer, replacing the durable-function approach in the 10-23 document. Revisit only if the engine's wake-up times exceed 15 minutes, or if the design returns to path 1.
- Resolved by the owner on 2026-10-24: the agent part is deferred; the echo runs inside the Processor for now (see [Agent side](#agent-side-placeholder-to-be-resolved-later)).
