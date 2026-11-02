output "webhook_url" {
  description = "Set this as the GitHub App's webhook URL. Assumes the Function app's route prefix is empty (host.json)."
  value       = "https://${azurerm_linux_function_app.main.default_hostname}/integrations/github/webhook"
}

output "key_vault_name" {
  description = "Create the five secrets here (see local.secret_names in main.tf)."
  value       = azurerm_key_vault.main.name
}

output "function_app_name" {
  description = "The Function app; deploy the code to it."
  value       = azurerm_linux_function_app.main.name
}

output "queue_name" {
  description = "The Service Bus queue that carries the mailbox nudges."
  value       = "${azurerm_servicebus_namespace.main.name}/${azurerm_servicebus_queue.nudges.name}"
}

output "cosmos_container" {
  description = "The Cosmos DB mailbox container."
  value       = "${azurerm_cosmosdb_account.main.name}/${azurerm_cosmosdb_sql_database.main.name}/${azurerm_cosmosdb_sql_container.mailbox.name}"
}
