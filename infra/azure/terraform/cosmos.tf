# Layout is the same as the DynamoDB table (see infra/aws/src/DynamoMailboxTable.ts): partition key `pk`, one item
# per mailbox, dedup items carrying a `ttl` (seconds). Cosmos indexes every property, so the `due` / `dueAt` pair
# the sweep queries needs no secondary index.
resource "azurerm_cosmosdb_account" "main" {
  name                = "cosmos-${local.compact}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  # Pay per request, like DynamoDB on-demand. Keys are off: the Function app signs in with its identity.
  local_authentication_enabled = false

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = azurerm_resource_group.main.location
    failover_priority = 0
  }
}

resource "azurerm_cosmosdb_sql_database" "main" {
  name                = "slop"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main.name
}

resource "azurerm_cosmosdb_sql_container" "mailbox" {
  name                  = "mailbox"
  resource_group_name   = azurerm_resource_group.main.name
  account_name          = azurerm_cosmosdb_account.main.name
  database_name         = azurerm_cosmosdb_sql_database.main.name
  partition_key_paths   = ["/pk"]
  partition_key_version = 2

  # -1 switches expiry on without expiring anything by default: only items that carry their own `ttl` expire.
  default_ttl = -1
}

# Data-plane access: the built-in "Cosmos DB Built-in Data Contributor" role.
resource "azurerm_cosmosdb_sql_role_assignment" "app" {
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main.name
  role_definition_id  = "${azurerm_cosmosdb_account.main.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = azurerm_linux_function_app.main.identity[0].principal_id
  scope               = azurerm_cosmosdb_account.main.id
}
