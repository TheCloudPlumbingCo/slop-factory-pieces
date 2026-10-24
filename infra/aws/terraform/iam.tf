data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Every Lambda builds the same runtime on first call, including the SSM config, so all three need this.
data "aws_iam_policy_document" "ssm_read" {
  statement {
    sid       = "ReadConfigParameters"
    actions   = ["ssm:GetParametersByPath"]
    resources = local.ssm_parameter_arns
  }

  dynamic "statement" {
    for_each = var.ssm_kms_key_arn == null ? [] : [var.ssm_kms_key_arn]
    content {
      sid       = "DecryptConfigParameters"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

data "aws_iam_policy_document" "mailbox_read_write" {
  statement {
    sid = "MailboxTable"
    # DynamoMailboxTable sends Get/Put/Delete/Query and TransactWriteItems (the dedup marker + state write). IAM has
    # no TransactWriteItems action: a transaction is authorised by the per-item actions it performs (PutItem here).
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.mailbox.arn,
      "${aws_dynamodb_table.mailbox.arn}/index/due-index",
    ]
  }
}

data "aws_iam_policy_document" "send_nudges" {
  statement {
    sid       = "SendNudges"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.nudges.arn]
  }
}

data "aws_iam_policy_document" "consume_nudges" {
  statement {
    sid       = "ConsumeNudges"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.nudges.arn]
  }
}

# Receiver
resource "aws_iam_role" "receiver" {
  name               = "${local.name}-receiver"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "receiver" {
  source_policy_documents = [
    data.aws_iam_policy_document.ssm_read.json,
    data.aws_iam_policy_document.mailbox_read_write.json,
    data.aws_iam_policy_document.send_nudges.json,
  ]
}

resource "aws_iam_role_policy" "receiver" {
  name   = "access"
  role   = aws_iam_role.receiver.id
  policy = data.aws_iam_policy_document.receiver.json
}

# Processor: the Receiver's access plus consuming the queue (what a Lambda SQS event source mapping needs).
resource "aws_iam_role" "processor" {
  name               = "${local.name}-processor"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "processor" {
  source_policy_documents = [
    data.aws_iam_policy_document.ssm_read.json,
    data.aws_iam_policy_document.mailbox_read_write.json,
    data.aws_iam_policy_document.send_nudges.json,
    data.aws_iam_policy_document.consume_nudges.json,
  ]
}

resource "aws_iam_role_policy" "processor" {
  name   = "access"
  role   = aws_iam_role.processor.id
  policy = data.aws_iam_policy_document.processor.json
}

# Sweep: query the due index and send nudges (plus the SSM read the shared startup needs).
resource "aws_iam_role" "sweep" {
  name               = "${local.name}-sweep"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "sweep" {
  source_policy_documents = [
    data.aws_iam_policy_document.ssm_read.json,
    data.aws_iam_policy_document.send_nudges.json,
  ]

  statement {
    sid       = "QueryDueIndex"
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.mailbox.arn}/index/due-index"]
  }
}

resource "aws_iam_role_policy" "sweep" {
  name   = "access"
  role   = aws_iam_role.sweep.id
  policy = data.aws_iam_policy_document.sweep.json
}

# Logging, scoped to each function's own log group (created in lambda.tf).
locals {
  lambda_role_ids = {
    receiver  = aws_iam_role.receiver.id
    processor = aws_iam_role.processor.id
    sweep     = aws_iam_role.sweep.id
  }
}

data "aws_iam_policy_document" "logs" {
  for_each = aws_cloudwatch_log_group.lambda

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${each.value.arn}:*"]
  }
}

resource "aws_iam_role_policy" "logs" {
  for_each = data.aws_iam_policy_document.logs

  name   = "logs"
  role   = local.lambda_role_ids[each.key]
  policy = each.value.json
}
