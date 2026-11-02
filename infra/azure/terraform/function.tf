# One Function app holds the three functions: receiver (HTTP trigger), processor (Service Bus trigger) and sweep
# (timer trigger). AWS has three Lambdas with one role each; here they share one identity, which is the usual
# shape on Azure and keeps a single storage account and plan.

# The Functions runtime keeps its own state (timer leases, trigger bookmarks) here. The Consumption plan also keeps
# the code's file share here and needs the account key to mount it, so this one account keeps its key.
resource "azurerm_storage_account" "functions" {
  name                     = "st${local.compact}"
  location                 = azurerm_resource_group.main.location
  resource_group_name      = azurerm_resource_group.main.name
  account_tier             = "Standard"
  account_replication_type = "LRS"

  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
}

# Classic Linux Consumption: pay per execution with a monthly free grant, the plan the cost estimate used.
resource "azurerm_service_plan" "main" {
  name                = "asp-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  os_type             = "Linux"
  sku_name            = "Y1"
}

resource "azurerm_linux_function_app" "main" {
  name                = "func-${local.compact}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  service_plan_id     = azurerm_service_plan.main.id

  storage_account_name       = azurerm_storage_account.functions.name
  storage_account_access_key = azurerm_storage_account.functions.primary_access_key

  functions_extension_version = "~4"
  https_only                  = true
  zip_deploy_file             = var.package_path

  identity {
    type = "SystemAssigned"
  }

  site_config {
    app_scale_limit                        = var.max_scale_out
    application_insights_connection_string = azurerm_application_insights.main.connection_string

    application_stack {
      node_version = "22"
    }
  }

  # Every function reads all of these at cold start. Secrets are Key Vault references: the platform resolves them
  # with the app's identity, so the values never appear here or in state. A reference to a secret that does not
  # exist yet fails until the owner creates it. The app's identity gets its roles after the app exists, so the
  # first resolution can fail briefly; the platform retries.
  app_settings = merge(
    {
      COSMOS_ENDPOINT                               = azurerm_cosmosdb_account.main.endpoint
      COSMOS_DATABASE                               = azurerm_cosmosdb_sql_database.main.name
      COSMOS_CONTAINER                              = azurerm_cosmosdb_sql_container.mailbox.name
      NUDGE_QUEUE_NAME                              = azurerm_servicebus_queue.nudges.name
      NudgeQueueConnection__fullyQualifiedNamespace = "${azurerm_servicebus_namespace.main.name}.servicebus.windows.net"
      OIDC_ALLOWED_WORKFLOW_REF                     = var.oidc_allowed_workflow_ref
    },
    # The app cannot reference its own hostname here (a cycle), so the audience comes from a variable. Unset, the
    # code falls back to https://$WEBSITE_HOSTNAME, which is what the workflow asks for.
    var.oidc_audience == null ? {} : { OIDC_AUDIENCE = var.oidc_audience },
    {
      for name in local.secret_names :
      replace(name, "-", "_") => "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.main.name};SecretName=${name})"
    },
  )
}
