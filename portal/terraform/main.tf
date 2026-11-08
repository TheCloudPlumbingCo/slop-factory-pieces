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
variable "github_auth_mode" {
  description = "How the portal connects to GitHub: \"app\" (GitHub App) or \"oauth\" (OAuth App)."
  type        = string
  default     = "app"
  validation {
    condition     = contains(["app", "oauth"], var.github_auth_mode)
    error_message = "github_auth_mode must be \"app\" or \"oauth\"."
  }
}
variable "github_client_id" {
  type    = string
  default = ""
}
variable "github_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}
variable "atlassian_client_id" {
  type    = string
  default = ""
}
variable "atlassian_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}
variable "atlassian_scopes" {
  description = "Space-separated Jira scopes. Empty uses the portal's read-only defaults."
  type        = string
  default     = ""
}
variable "token_encryption_key" {
  description = "Base64 32-byte key. Leave empty and Terraform generates one that stays the same between applies."
  type        = string
  default     = ""
  sensitive   = true
}
variable "custom_domain" {
  description = "Stable hostname for the portal, e.g. slopfac.portal.yashodh.space. Empty = use the Azure default host."
  type        = string
  default     = ""
}
variable "custom_domain_dns_ready" {
  description = "Set true only after the CNAME and asuid TXT records exist; binds the domain and switches app_url to it."
  type        = bool
  default     = false
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
  app_name     = "portal-poc"
  default_host = "${local.app_name}.${azurerm_container_app_environment.env.default_domain}"
  bind_domain  = var.custom_domain != "" && var.custom_domain_dns_ready
  app_url      = "https://${local.bind_domain ? var.custom_domain : local.default_host}"
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

  secret {
    name  = "token-encryption-key"
    value = local.token_encryption_key
  }
  dynamic "secret" {
    for_each = local.github_enabled ? [1] : []
    content {
      name  = "github-client-secret"
      value = var.github_client_secret
    }
  }
  dynamic "secret" {
    for_each = local.atlassian_enabled ? [1] : []
    content {
      name  = "atlassian-client-secret"
      value = var.atlassian_client_secret
    }
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
        name  = "GITHUB_AUTH_MODE"
        value = var.github_auth_mode
      }
      env {
        name        = "TOKEN_ENCRYPTION_KEY"
        secret_name = "token-encryption-key"
      }
      dynamic "env" {
        for_each = local.github_enabled ? { GITHUB_CLIENT_ID = var.github_client_id } : {}
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.github_enabled ? [1] : []
        content {
          name        = "GITHUB_CLIENT_SECRET"
          secret_name = "github-client-secret"
        }
      }
      dynamic "env" {
        for_each = local.atlassian_enabled ? { ATLASSIAN_CLIENT_ID = var.atlassian_client_id } : {}
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.atlassian_enabled ? [1] : []
        content {
          name        = "ATLASSIAN_CLIENT_SECRET"
          secret_name = "atlassian-client-secret"
        }
      }
      dynamic "env" {
        for_each = var.atlassian_scopes != "" ? [1] : []
        content {
          name  = "ATLASSIAN_SCOPES"
          value = var.atlassian_scopes
        }
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

# Stable key for encrypting stored provider tokens when none is supplied.
resource "random_id" "token_key" {
  byte_length = 32
}

locals {
  token_encryption_key = var.token_encryption_key != "" ? var.token_encryption_key : random_id.token_key.b64_std
  # A provider's secret exists on the app only when both of its values were given.
  github_enabled    = var.github_client_id != "" && var.github_client_secret != ""
  atlassian_enabled = var.atlassian_client_id != "" && var.atlassian_client_secret != ""
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

# Stable hostname: free managed certificate, validated through the CNAME record.
resource "azurerm_container_app_environment_managed_certificate" "portal" {
  count                        = local.bind_domain ? 1 : 0
  name                         = "cert-portal"
  container_app_environment_id = azurerm_container_app_environment.env.id
  domain_control_validation    = "CNAME"
  subject_name                 = var.custom_domain
}

resource "azurerm_container_app_custom_domain" "portal" {
  count                                    = local.bind_domain ? 1 : 0
  name                                     = var.custom_domain
  container_app_id                         = azurerm_container_app.portal.id
  container_app_environment_certificate_id = azurerm_container_app_environment_managed_certificate.portal[0].id
  certificate_binding_type                 = "SniEnabled"
}

output "portal_url" { value = local.app_url }

# DNS records to create at the DNS host before setting custom_domain_dns_ready = true.
output "dns_records" {
  value = var.custom_domain == "" ? null : {
    cname = { name = var.custom_domain, value = azurerm_container_app.portal.ingress[0].fqdn }
    txt   = { name = "asuid.${var.custom_domain}", value = azurerm_container_app.portal.custom_domain_verification_id }
  }
}
