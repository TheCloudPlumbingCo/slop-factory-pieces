# azure/

**Role:** the control layer on Azure, with the same behaviour as `infra/aws`: GitHub webhooks are saved to a Cosmos DB mailbox and processed one mailbox at a time, with the echo agent running inside the Processor.

**Status:** the code passes its tests against fakes (`bun run test`, `bun run typecheck`) and the Terraform passes `terraform validate`. Nothing has been planned, applied or run against real Azure services, and the Cosmos batch calls are untested against a real account.

## How it fits together

The Receiver (HTTP trigger) verifies the webhook through the SDK's routes and saves the event to the Cosmos container, one item per mailbox plus dedup markers, then sends a Service Bus "nudge". The Processor (Service Bus trigger) runs the SDK's mailbox engine for that mailbox, with the echo agent in the same invocation, then nudges again if the mailbox is still due. The Sweep (timer trigger, every minute) nudges every mailbox whose `readyAt` has passed, which recovers a lost nudge. All three live in one Function app (`src/functions/index.ts`).

The mailbox logic (`MailboxState`, `MailboxTransitions`, `MailboxStore`, `Handlers`, `InProcessAgent`) is a copy of `infra/aws/src`. The Azure-specific files are `CosmosMailboxTable`, `CosmosContainer`, `ServiceBusNudger`, `Config`, `Production` and `functions/`. A change to the shared logic has to be made in both folders until it moves into a shared package.

## Configuration

App settings, set by Terraform: `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, `COSMOS_CONTAINER`, `NUDGE_QUEUE_NAME`, `NudgeQueueConnection__fullyQualifiedNamespace`, and the five GitHub settings as Key Vault references (`GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_MENTION_NAME`, `GITHUB_BOT_USER_ID`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`). Terraform does not create the secrets. Create them in the Key Vault with the names `GITHUB-WEBHOOK-SECRET`, `GITHUB-BOT-MENTION-NAME`, `GITHUB-BOT-USER-ID`, `GITHUB-APP-ID`, `GITHUB-PRIVATE-KEY` (dashes, not underscores).

## Deploying

Run from `infra/azure` unless noted. These steps are from the tools' documentation and have not been run.

1. `az login`, and `az account set --subscription <id>`.
2. `cd terraform && terraform init && terraform plan`, read the plan, then `terraform apply`. The azurerm provider tries to register the Azure resource providers on first use; if the plan or apply complains about an unregistered one, register it with `az provider register --namespace <name>`. Variables: `location` (default `southeastasia`), `stage` (default `dev`), `budget_alert_emails` (no budget is created while empty), `monthly_budget_usd`.
3. Note the outputs: `webhook_url`, `key_vault_name`, `function_app_name`.
4. Create the five secrets: `az keyvault secret set --vault-name <key_vault_name> --name GITHUB-WEBHOOK-SECRET --value <value>`, and so on. The Function app reads them by reference, so restart it if it started before they existed.
5. `bun run bundle` builds `dist/app.zip`. Deploy it with `az functionapp deployment source config-zip --resource-group <rg> --name <function_app_name> --src dist/app.zip`, or set `package_path` to `../dist/app.zip` and apply again.
6. In the GitHub App's settings, set the webhook URL to `webhook_url` and the secret to the value of `GITHUB-WEBHOOK-SECRET`. An App has one webhook URL, so one deployment receives its events at a time.
7. Mention the bot on an issue. Expect an acknowledgement, then an echo reply about 5 seconds later.

## Known limits

- The Cosmos table is untested against a real account: the transactional batch with `ifMatch`, the cross-partition `due` query and the per-item `ttl` follow the SDK's types and documentation.
- Dedup markers are stored under the mailbox's partition key, so dedup is per mailbox, not global. That holds while one provider event always maps to one mailbox.
- Azure Functions has no request throttle in front of the Receiver; `max_scale_out` (default 5) bounds the load.
- Linux Consumption is the plan the cost estimate used; Microsoft's plan for it long term was not checked.
- Everything the AWS README lists as a known limit for the shared logic applies here too.
