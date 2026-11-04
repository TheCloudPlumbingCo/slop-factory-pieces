# Purpose and scope

## Purpose

Show how a comment on GitHub or Jira starts a long-running agent, and how the agent's answer returns to the comment.

## Goals

- Run the same bot behavior on Cloudflare, AWS, and Azure.
- Keep the bot logic in `packages/core`. Do not import cloud code there.
- Keep the agent apart from the broker. Only the delivery API connects them.

## Non-goals

- A useful agent. The agent is an echo stub.
- Code review or development work.
- Production hardening.

## Status

| Part | State |
|---|---|
| Cloudflare broker | Built. Tests pass. |
| AWS control layer | Built. Tests pass. |
| Azure control layer | Tests pass against fakes. Not deployed. |
| Portal prototype | Sign-in and account connection work. Other parts are simulated. |
| Real agent (Pi) | Not built. |
