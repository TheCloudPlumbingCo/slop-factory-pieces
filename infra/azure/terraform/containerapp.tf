# One Container App runs the whole broker: the webhook, the delivery API, the runner's calls, and the in-memory timers
# that wake a mailbox. There is no queue and no sweep. See ../README.md, "Known limits".
#
# It scales to zero. The first request after idle waits for a cold start.

# A user-assigned identity, not a system-assigned one. The app reads Key Vault secrets when it is created, so its
# roles must exist before the app does. A system-assigned identity only exists after the app, which would deadlock.
resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${local.name}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
}

resource "azurerm_container_app" "main" {
  name                         = local.app_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  # Secrets are Key Vault references. The platform reads them with the app's identity, so the values never appear
  # here or in state. Terraform does not create the secrets (see local.secret_names in main.tf).
  dynamic "secret" {
    for_each = local.secret_names
    content {
      name                = lower(secret.value)
      identity            = azurerm_user_assigned_identity.app.id
      key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/${secret.value}"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = var.max_replicas

    http_scale_rule {
      name                = "http"
      concurrent_requests = "20"
    }

    container {
      name   = "broker"
      image  = var.image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "PORT"
        value = "8080"
      }
      # DefaultAzureCredential needs this to pick the user-assigned identity.
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.app.client_id
      }
      env {
        name  = "COSMOS_ENDPOINT"
        value = azurerm_cosmosdb_account.main.endpoint
      }
      env {
        name  = "COSMOS_DATABASE"
        value = azurerm_cosmosdb_sql_database.main.name
      }
      env {
        name  = "COSMOS_CONTAINER"
        value = azurerm_cosmosdb_sql_container.mailbox.name
      }
      # The runner calls the broker back at this origin, and asks GitHub for a token for it (the OIDC audience).
      # The address is built from the app name and the environment's domain, so the app does not name itself.
      env {
        name  = "BROKER_PUBLIC_ORIGIN"
        value = local.broker_public_origin
      }
      env {
        name  = "OIDC_ALLOWED_WORKFLOW_REF"
        value = var.oidc_allowed_workflow_ref
      }
      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.main.connection_string
      }

      dynamic "env" {
        for_each = local.secret_names
        content {
          name        = replace(env.value, "-", "_")
          secret_name = lower(env.value)
        }
      }

      startup_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }
    }
  }

  # The identity needs its roles before the app reads the secrets.
  depends_on = [azurerm_role_assignment.app_reads_secrets]
}
