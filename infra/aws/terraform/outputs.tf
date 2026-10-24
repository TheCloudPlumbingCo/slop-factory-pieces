output "webhook_url" {
  description = "Set this as the GitHub App's webhook URL."
  value       = "${aws_apigatewayv2_api.webhook.api_endpoint}/integrations/github/webhook"
}

output "queue_url" {
  description = "The SQS queue that carries the mailbox nudges."
  value       = aws_sqs_queue.nudges.url
}

output "table_name" {
  description = "The DynamoDB mailbox table."
  value       = aws_dynamodb_table.mailbox.name
}
