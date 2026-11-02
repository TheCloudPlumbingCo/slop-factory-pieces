# Basic is enough: it supports queues and scheduled messages, and the design needs nothing it lacks (topics,
# sessions, transactions, duplicate detection). The engine's claim and lease make a duplicate nudge harmless.
resource "azurerm_servicebus_namespace" "main" {
  name                = "sb-${local.compact}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Basic"

  # Keys are off: the Function app signs in with its identity.
  local_auth_enabled = false
}

resource "azurerm_servicebus_queue" "nudges" {
  name         = "nudges"
  namespace_id = azurerm_servicebus_namespace.main.id

  # After 5 failed deliveries the message goes to the queue's built-in dead-letter sub-queue (SQS: maxReceiveCount).
  max_delivery_count = 5

  # The lock is how long a Processor may hold a nudge before it is delivered again (SQS: visibility timeout).
  # Six times the Processor timeout, as on AWS. The Basic tier allows at most five minutes.
  lock_duration = "PT${6 * local.processor_timeout_seconds}S"

  # A nudge only signals timing; one that expires is recovered by the sweep.
  default_message_ttl = "P1D"
}

resource "azurerm_role_assignment" "app_sends" {
  scope                = azurerm_servicebus_queue.nudges.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_linux_function_app.main.identity[0].principal_id
}

resource "azurerm_role_assignment" "app_receives" {
  scope                = azurerm_servicebus_queue.nudges.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_linux_function_app.main.identity[0].principal_id
}
