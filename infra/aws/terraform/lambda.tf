# The bundles come from `bun run bundle` in infra/aws. Only the .js is zipped; the source map stays local.
data "archive_file" "bundle" {
  for_each = toset(["receiver", "processor", "sweep"])

  type        = "zip"
  source_file = "${path.module}/../dist/${each.key}.js"
  output_path = "${path.module}/../dist/${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = toset(["receiver", "processor", "sweep"])

  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "receiver" {
  function_name    = "${local.name}-receiver"
  role             = aws_iam_role.receiver.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "receiver.handler"
  filename         = data.archive_file.bundle["receiver"].output_path
  source_code_hash = data.archive_file.bundle["receiver"].output_base64sha256
  timeout          = 10
  memory_size      = 512

  environment {
    variables = local.environment
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.logs]
}

resource "aws_lambda_function" "processor" {
  function_name    = "${local.name}-processor"
  role             = aws_iam_role.processor.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "processor.handler"
  filename         = data.archive_file.bundle["processor"].output_path
  source_code_hash = data.archive_file.bundle["processor"].output_base64sha256
  timeout          = local.processor_timeout
  memory_size      = 1024

  environment {
    variables = local.environment
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.logs]
}

resource "aws_lambda_function" "sweep" {
  function_name    = "${local.name}-sweep"
  role             = aws_iam_role.sweep.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "sweep.handler"
  filename         = data.archive_file.bundle["sweep"].output_path
  source_code_hash = data.archive_file.bundle["sweep"].output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = local.environment
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.logs]
}

resource "aws_lambda_event_source_mapping" "processor" {
  event_source_arn        = aws_sqs_queue.nudges.arn
  function_name           = aws_lambda_function.processor.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}
