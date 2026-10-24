# Smoke checklist (AWS)

Run by the owner after `terraform apply` and after switching the GitHub App's webhook URL to the `webhook_url` output (see `../README.md`). Use a test issue in a repository where the App is installed. Observe each item and record it in the table at the end.

Where to look:

- GitHub: the issue's comments and reactions.
- CloudWatch: `/aws/lambda/slop-code-factory-<stage>-receiver`, `-processor`, `-sweep`.
- SQS: queues `slop-code-factory-<stage>-nudges` and `-nudges-dlq` (messages available, in flight, sent, deleted).
- DynamoDB: table `slop-code-factory-<stage>` (the `table_name` output), the mailbox item for the issue.

## Checks

1. **Mention the bot.** Comment `@<bot>` on the test issue. Expect a 👀 reaction within about 4 s and one echo reply about 5 s after that. Look at the issue, and at the processor log group for errors (there should be none).
2. **Redelivery.** In the GitHub App's "Advanced" tab, "Recent deliveries", redeliver the webhook from check 1. Expect no second reply and no second reaction. The receiver should return success; the mailbox item is unchanged.
3. **Two mentions within 3 s.** Post two mentions quickly. Expect one reply.
4. **No write access.** Mention the bot from an account without write access to the repository. Expect a 👎 reaction and one notice comment, and no run: no echo reply and no processor error.
5. **Bad signature.** `curl -i -X POST <webhook_url> -H 'content-type: application/json' -H 'x-hub-signature-256: sha256=00' -d '{}'`. Expect 401 or the SDK's error status, not 2xx. Nothing is queued: the nudges queue shows no new message sent.
6. **Nudges and sweep.** After check 1, look at the nudges queue metrics (sent, received, deleted) and the processor invocations: each `readyAt` produced a nudge that was processed. The sweep log group shows an invocation every minute that finds nothing in the normal case. The dead-letter queue stays empty. The code does not log each normal nudge, so use queue metrics and processor invocation counts.
7. **Run finished.** Some time after the reply, read the issue's mailbox item in DynamoDB: `readyAt` is null (idle). No further nudges are queued: the nudges queue drains to zero available and zero in flight, and the dead-letter queue is empty.

## Results

Left blank for the owner.

| Item | Observed | Timing | Notes |
| --- | --- | --- | --- |
| 1 Mention | | | |
| 2 Redelivery | | | |
| 3 Two mentions | | | |
| 4 No write access | | | |
| 5 Bad signature | | | |
| 6 Nudges and sweep | | | |
| 7 Run finished | | | |
