terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    azuread = { source = "hashicorp/azuread", version = "~> 3.0" }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}
provider "azuread" {}

variable "subscription_id" { type = string }
variable "location" {
  type    = string
  default = "southeastasia"
}
variable "app_client_id" {
  description = "Client ID of the slop-portal-poc app registration"
  type        = string
}
variable "image" {
  description = "PUBLIC portal image, e.g. ghcr.io/<you>/portal-poc:1. Empty = placeholder image for the first apply."
  type        = string
  default     = ""
}

data "azuread_client_config" "me" {}
data "azuread_application" "portal" { client_id = var.app_client_id }

resource "azurerm_resource_group" "rg" {
  name     = "rg-portal-poc"
  location = var.location
}

# The identity the portal uses instead of a client secret.
resource "azurerm_user_assigned_identity" "portal" {
  name                = "id-portal-poc"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
}

# Entra trusts tokens issued to that identity as proof of being the app registration.
resource "azuread_application_federated_identity_credential" "portal_mi" {
  application_id = data.azuread_application.portal.id
  display_name   = "portal-poc-managed-identity"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://login.microsoftonline.com/${data.azuread_client_config.me.tenant_id}/v2.0"
  subject        = azurerm_user_assigned_identity.portal.principal_id
}

resource "azurerm_container_app_environment" "env" {
  name                = "cae-portal-poc"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location

  # Azure adds a default "Consumption" profile; don't let Terraform try to remove it.
  lifecycle { ignore_changes = [workload_profile] }
}

locals {
  app_name = "portal-poc"
  app_url  = "https://${local.app_name}.${azurerm_container_app_environment.env.default_domain}"
}

resource "azurerm_container_app" "portal" {
  name                         = local.app_name
  resource_group_name          = azurerm_resource_group.rg.name
  container_app_environment_id = azurerm_container_app_environment.env.id
  revision_mode                = "Single"

  lifecycle { ignore_changes = [workload_profile_name] }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.portal.id]
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = 1
    container {
      name   = "portal"
      image  = var.image != "" ? var.image : "mcr.microsoft.com/k8se/quickstart:latest"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "AZURE_MI_CLIENT_ID"
        value = azurerm_user_assigned_identity.portal.client_id
      }
      env {
        name  = "AUTH_MICROSOFT_ENTRA_ID_ID"
        value = var.app_client_id
      }
      env {
        name  = "AUTH_MICROSOFT_ENTRA_ID_ISSUER"
        value = "https://login.microsoftonline.com/${data.azuread_client_config.me.tenant_id}/v2.0"
      }
      env {
        name  = "AUTH_URL"
        value = local.app_url
      }
      env {
        name  = "AUTH_TRUST_HOST"
        value = "true"
      }
      env {
        name  = "AUTH_SECRET"
        value = random_password.auth_secret.result
      }
    }
  }
}

resource "random_password" "auth_secret" {
  length  = 48
  special = false
}

# Keeps localhost for dev and adds the deployed callback. Replaces the redirect URIs set by az.
resource "azuread_application_redirect_uris" "web" {
  application_id = data.azuread_application.portal.id
  type           = "Web"
  redirect_uris = [
    "http://localhost:3000/api/auth/callback/microsoft-entra-id",
    "${local.app_url}/api/auth/callback/microsoft-entra-id",
  ]
}

output "portal_url" { value = local.app_url }
