data "azurerm_client_config" "current" {}

# Azure names for Key Vaults and Cosmos accounts are global, so they carry a short random suffix.
resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

locals {
  name = "slop-code-factory-${var.stage}"

  # Letters and digits only, for the resources whose names allow nothing else.
  compact = "slopcf${var.stage}${random_string.suffix.result}"

  # Set here, and not read from the app, so the app can know its own address without a Terraform cycle.
  app_name = "ca-${local.compact}"

  # The broker's public address: the app name and the environment's default domain. A variable can override it, for a
  # custom domain.
  broker_public_origin = coalesce(var.broker_public_origin, "https://${local.app_name}.${azurerm_container_app_environment.main.default_domain}")

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
