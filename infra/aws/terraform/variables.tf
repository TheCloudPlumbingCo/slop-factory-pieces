variable "region" {
  description = "AWS region to deploy to."
  type        = string
  default     = "ap-southeast-1"
}

variable "stage" {
  description = "Deployment stage; part of every resource name and the default SSM prefix."
  type        = string
  default     = "dev"
}

variable "ssm_prefix" {
  description = <<-EOT
    SSM path under which the Lambdas read their configuration. Defaults to /slop-code-factory/<stage>.
    Terraform does NOT create these parameters (their values are secrets and must stay out of state). The owner
    creates them as SecureString before the first request:
    GITHUB_WEBHOOK_SECRET, GITHUB_BOT_MENTION_NAME, GITHUB_BOT_USER_ID, GITHUB_APP_ID, GITHUB_PRIVATE_KEY.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.ssm_prefix == null || (startswith(var.ssm_prefix, "/") && !endswith(var.ssm_prefix, "/"))
    error_message = "ssm_prefix must start with / and must not end with /."
  }
}

variable "ssm_kms_key_arn" {
  description = "ARN of the customer managed KMS key that encrypts the SecureString parameters. Leave null when they use the default aws/ssm key, which needs no extra permission."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "How long CloudWatch keeps each Lambda's logs."
  type        = number
  default     = 14
}
