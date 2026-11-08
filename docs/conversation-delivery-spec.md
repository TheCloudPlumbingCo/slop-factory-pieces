# Conversation delivery specification

Revision: 1 November 2026.

## Purpose

The broker must retain accepted conversation work across process failures.
It must distinguish callback retries from saved output retries.

This specification describes the reviewed design.
It does not claim that every backend passed every acceptance criterion.

Use **must** for required behavior.
Use **should** for proposed production controls.

## Scope

Include provider authentication, event admission, batching, claim ownership, handoff, output, and wake-up recovery.
Keep agent execution separate from mailbox delivery.

Exclude model reasoning, code quality, and agent checkpoint implementation.
Do not add an Akka deployment through this specification.

## Defined terms

- **Mailbox**: The persistent work record for one logical conversation.
- **Event**: An admitted provider notification.
- **Delivery**: One fixed batch and its lifecycle.
- **Claim**: The current authority to change claimed delivery state.
- **Lease**: The time limit for a claim without renewal.
- **Handoff**: The transition that retains a delivery while an agent performs work.
- **Output operation**: A saved request for a provider action.
- **Nudge**: A request to check a mailbox for eligible work.
- **Settlement**: The recorded delivered, retryable, or permanently failed outcome of an output attempt.

## Model distinctions

Reactive programming composes responses to events.
Reactive Streams controls asynchronous item flow through demand signals.
That flow-control contract does not define persistent conversation delivery.
See [Reactive Streams](https://www.reactive-streams.org/).

Akka processes one actor message handler at a time.
Asynchronous jobs can continue after their handlers return.
An actor therefore needs protocol state to prevent overlapping business jobs.
Use completion messages to update actor state through its behavior.
See [Akka actors](https://doc.akka.io/libraries/akka-core/current/typed/actors.html).
See [asynchronous results](https://doc.akka.io/libraries/akka-core/current/typed/interaction-patterns.html).

Ordinary Akka sends use at-most-once delivery semantics.
Akka preserves ordering per sender–receiver pair.
Persistence requires additional configuration and storage.
Persisted actor state does not make provider effects exactly once.
See [Akka delivery](https://doc.akka.io/libraries/akka-core/current/general/message-delivery-reliability.html).
See [Akka Persistence](https://doc.akka.io/libraries/akka-core/current/typed/persistence.html).

Durable Objects provide object identity, storage, transactions, and an alarm.
External asynchronous operations can permit request interleaving.
Storage transactions and delivery state protect mailbox decisions.
See [Cloudflare coordination](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

Channels supplies conversation admission, batching, handoff, retry, and output rules.
The storage adapter enforces those rules through backend operations.
The application supplies authorization and agent execution.

## Required behavior

### R01 — Admission

The receiver must verify provider authentication before it admits a processable event.

### R02 — Persistence

The store must commit an accepted event before the receiver acknowledges its acceptance.

### R03 — Deduplication

The store must atomically check the event marker and save the accepted event.

### R04 — Mailbox identity

The provider must derive a stable mailbox key for the same logical conversation.

### R05 — Order

The engine must select events in mailbox admission order.

### R06 — Claim ownership

The store must reject state changes from an invalid claim.

### R07 — Batch identity

A callback retry must retain the delivery ID and the fixed event batch.

### R08 — Handoff

The mailbox must retain its active delivery while handed-off work awaits completion or timeout.

### R09 — Output persistence

The delivery API must save accepted output requests before it acknowledges them.

### R10 — Output retry

An output retry must not rerun a completed callback.

### R11 — Wake-up recovery

The host must arrange future processing for due work and recover missed wake-ups under its supported policy.

### R12 — Agent responsibility

The agent host must deduplicate job creation and define job recovery behavior.

### R13 — Token scope

The delivery API must authorize each operation for its delivery.

### R14 — Timeout boundary

A broker timeout must not imply that the agent host stopped the job.

### R15 — Capacity proposal

The deployment should define mailbox limits and an overload response before production expansion.

### R16 — Visibility proposal

The deployment should monitor waiting age, active delivery age, retries, and terminal failures.

## Logical state

| Field | Meaning |
| --- | --- |
| mailboxKey | Identifies one logical conversation. |
| eventId / seen marker | Recognizes repeated admitted provider events. |
| sequence / waiting | Records admission order and waiting events. |
| deliveryId / batchId | Identifies one fixed batch across callback retries. |
| claimId / lease | Authorizes the current processing attempt. |
| stage / attempt | Records lifecycle position and callback attempt count. |
| accessToken | Authorizes delivery operations. Protect this secret. |
| readyAt / failAt | Records future processing and handoff deadlines. |
| operations / terminal | Records requested output and the final delivery outcome. |

These fields describe logical state.
Adapters can use different physical schemas.

## Logical lifecycle

```text
Waiting events → Claimed batch → Callback
Callback → Handed-off delivery → Saved output → Closed delivery
Callback failure → Retry the same batch
Output failure → Retry saved output
Closed delivery → Permit later waiting work
```

A result updates the active delivery.
It does not become a new waiting webhook.
Progress output can run before a terminal result arrives.
A terminal outcome moves the delivery toward closure.
Output settlement can include permanent failures.

The SDK uses Local, Retry, ExternalCleaning, ExternalWaiting, and Finishing for active stages.
Retired identifies the closed-delivery record.

## Atomic boundaries

Commit the seen-event marker with the accepted event.
Check claim ownership during claimed state changes.
Save delivery-API output before acknowledging acceptance.

A provider call occurs outside the mailbox transaction.
A successful post followed by a process failure can produce a duplicate comment.
Do not promise exactly-once external effects.

A job dispatch occurs outside the mailbox transaction.
Use the delivery ID to deduplicate job creation.
The agent host must define its own checkpoint and recovery protocol.
A handoff timeout does not prove that agent execution stopped.

## Wake-up mechanisms

| Host | Persistent state | Wake-up | Repair |
| --- | --- | --- | --- |
| Cloudflare | DO storage | Mailbox alarm | Atomic state and alarm writes; post-processing alarm repair. |
| AWS | DynamoDB | Delayed standard SQS nudge | Periodic overdue-mailbox sweep. |
| Azure | Cosmos DB | In-memory timer in the app | None. A stopped app loses its timers, and the next event for the mailbox wakes it. |
| Self-hosted SQL | Postgres | Engine polling | Operate and supervise the polling process. |

Each DO supports one scheduled alarm.
Cloudflare provides bounded retries when its alarm handler throws.
Channels defines delivery retry policy separately.
See [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

Queue nudges do not define conversation order.
The persistent mailbox and valid claims define eligible work.
A sweep can repair a missed nudge after the mailbox becomes overdue.
Its schedule does not establish a strict response-time bound.

## Current host implementations

Cloudflare defines a Worker, mailbox DO class, and AgentSession DO class.
The AgentSession starts a detached echo task.
It reports through the Worker's service binding.
It does not save agent checkpoints.

AWS runs the SDK engine and echo task inside the Processor Lambda.
The processor waits for echo tasks before returning.
The reviewed API Gateway route exposes the webhook only.

Current Azure production wiring dispatches research commands to GitHub Actions.
Other prompts use the echo fallback.
The research proxy verifies OIDC claims before forwarding permitted result operations.
The broker retains the delivery token internally for that proxy path.
Azure also registers direct delivery routes.
These details supersede the earlier echo-only artifact.

This review checks source wiring.
It does not establish live cloud deployment status.

## Reviewed configuration

| Setting | Value |
| --- | --- |
| GitHub quiet period | 3 seconds |
| GitHub maximum batching wait | 3 seconds |
| Callback lease | 10 seconds |
| Maximum callback attempts | 5 |
| Application handoff timeout | 10 minutes |
| Echo demonstration delay | 5 seconds |
| AWS and Azure sweep | Every minute |
| AWS and Azure event-marker TTL | 30 days |

The engine renews live callback claims.
Expired leases can permit another attempt.
A stale process can still perform external side effects.

## Acceptance criteria

The following criteria describe required verification.
This artifact review does not execute these backend scenarios.

| ID | Requirements | Stimulus | Expected result |
| --- | --- | --- | --- |
| A01 | R02, R03 | Submit the same signed event twice before processing. | Observe one waiting event while its marker remains valid. |
| A02 | R06 | Submit competing claims for one mailbox. | Only one claim can commit as the current owner. |
| A03 | R05, R08 | Admit B while A has an active handoff. | Retain B without starting another delivery. |
| A04 | R07, R12 | Fail a callback attempt before handoff. | Retry the fixed batch and reuse the delivery ID. |
| A05 | R09, R10 | Fail the provider after the delivery API saves completion. | Retry output without rerunning the completed callback. |
| A06 | R11 | Suppress a queue nudge after a successful state write. | Let the sweep discover and re-nudge overdue work. |
| A07 | R14 | Let the handoff deadline expire. | Record a timeout outcome without assuming agent cancellation. |
| A08 | R13 | Use an invalid delivery token. | Reject the request without exposing delivery information. |
| A09 | R12 | Retry remote job creation with the same delivery ID. | Verify the agent host’s own duplicate-job policy. |
| A10 | R15, R16 | Exceed a proposed mailbox capacity threshold. | Verify the selected overload policy and its monitoring. |

## Proposed production controls

Define maximum mailbox size and maximum waiting age.
Choose an overload response for each provider.
Do not assume a failed webhook response causes automatic provider redelivery.

Monitor callback retries separately from output retries.
Track active delivery age and overdue wake-ups.
Report permanent failures without logging delivery tokens.

Define remote dispatch deduplication and reconciliation.
Define job checkpoint and cancellation behavior.
Set service objectives after validating the real backend and agent host.

## Source evidence

- [Shared configuration](../packages/core/src/channels/GithubBot.ts).
- [Handoff](../packages/core/src/Handoff.ts).
- [Cloudflare Worker](../infra/cloudfare/src/Worker.ts).
- [AgentSession](../infra/cloudfare/src/AgentSessionDO.ts).
- [AWS engine host](../infra/aws/src/Handlers.ts).
- [DynamoDB adapter](../infra/aws/src/DynamoMailboxTable.ts).
- [Azure wiring](../infra/azure/src/Production.ts).
- [Azure routes](../infra/azure/src/functions/index.ts).
- [Research dispatch](../infra/azure/src/ResearchAgentSessions.ts).
- [OIDC proxy](../infra/azure/src/OidcProxy.ts).
- [Cosmos adapter](../infra/azure/src/CosmosMailboxTable.ts).

The sibling SDK checkout explains the library implementation.
The application pins published SDK packages and vendors Jira.
The checkout can differ from installed packages.

Review the delivery lifecycle, mailbox processing, Cloudflare alarm, and transaction implementation in that checkout.
Source inspection does not replace backend contract tests or production checks.
