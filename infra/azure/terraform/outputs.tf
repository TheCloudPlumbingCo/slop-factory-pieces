output "webhook_url" {
  description = "Set this as the GitHub App's webhook URL."
  value       = "https://${azurerm_container_app.main.ingress[0].fqdn}/integrations/github/webhook"
}

output "broker_public_origin" {
  description = "The origin the runner calls back, and the OIDC audience."
  value       = local.broker_public_origin
}

output "key_vault_name" {
  description = "Create the five secrets here (see local.secret_names in main.tf)."
  value       = azurerm_key_vault.main.name
}

output "container_app_name" {
  description = "The Container App that runs the broker."
  value       = azurerm_container_app.main.name
}

output "cosmos_container" {
  description = "The Cosmos DB mailbox container."
  value       = "${azurerm_cosmosdb_account.main.name}/${azurerm_cosmosdb_sql_database.main.name}/${azurerm_cosmosdb_sql_container.mailbox.name}"
}
