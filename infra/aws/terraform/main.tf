data "aws_caller_identity" "current" {}

locals {
  name       = "slop-code-factory-${var.stage}"
  ssm_prefix = coalesce(var.ssm_prefix, "/slop-code-factory/${var.stage}")

  # The Processor timeout must exceed the echo agent's 5 s wait plus the engine's leaseMs (10 s).
  # The nudge queue's visibility timeout is derived from it (see queue.tf).
  processor_timeout = 30

  ssm_parameter_arns = [
    "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}",
    "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*",
  ]

  # Every handler reads all three at cold start (see infra/aws/src/Handlers.ts).
  environment = {
    MAILBOX_TABLE   = aws_dynamodb_table.mailbox.name
    NUDGE_QUEUE_URL = aws_sqs_queue.nudges.url
    SSM_PREFIX      = local.ssm_prefix
  }
}
