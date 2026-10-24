resource "aws_sqs_queue" "nudges_dlq" {
  name                      = "${local.name}-nudges-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum, to leave time to inspect failures
}

# A standard queue, not FIFO: FIFO does not support per-message delay, and the engine's claim and lease already
# make a duplicate nudge harmless.
resource "aws_sqs_queue" "nudges" {
  name = "${local.name}-nudges"

  # AWS requires the source queue's visibility timeout to be at least six times the function timeout (plus the
  # batching window, which is 0 here). See "Configure queue visibility timeout" / "Using Lambda with Amazon SQS":
  # https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
  visibility_timeout_seconds = 6 * local.processor_timeout

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.nudges_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "nudges_dlq" {
  queue_url = aws_sqs_queue.nudges_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.nudges.arn]
  })
}
