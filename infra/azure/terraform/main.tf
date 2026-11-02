data "azurerm_client_config" "current" {}

# Azure names for storage accounts, Key Vaults and Cosmos accounts are global, so they carry a short random suffix.
resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

locals {
  name = "slop-code-factory-${var.stage}"

  # Letters and digits only, for the resources whose names allow nothing else.
  compact = "slopcf${var.stage}${random_string.suffix.result}"

  # The nudge queue's lock plays the part of the SQS visibility timeout (see servicebus.tf). The Processor's
  # function timeout (host.json) must exceed the echo agent's 5 s wait plus the engine's leaseMs (10 s).
  processor_timeout_seconds = 30

  # Names the code reads. The owner creates these Key Vault secrets before the first request; Terraform does NOT
  # create them (their values are secrets and must stay out of state).
  secret_names = [
    "GITHUB-WEBHOOK-SECRET",
    "GITHUB-BOT-MENTION-NAME",
    "GITHUB-BOT-USER-ID",
    "GITHUB-APP-ID",
    "GITHUB-PRIVATE-KEY",
  ]
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location

  tags = {
    Project = "slop-code-factory"
    Stage   = var.stage
  }
}
