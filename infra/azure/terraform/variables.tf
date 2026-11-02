variable "subscription_id" {
  description = "Azure subscription to deploy into. Leave null to use ARM_SUBSCRIPTION_ID or the Azure CLI's current subscription."
  type        = string
  default     = null
}

variable "location" {
  description = "Azure region to deploy to. Southeast Asia (Singapore) is the counterpart of ap-southeast-1 on AWS."
  type        = string
  default     = "southeastasia"
}

variable "stage" {
  description = "Deployment stage; part of every resource name."
  type        = string
  default     = "dev"
}

variable "package_path" {
  description = <<-EOT
    Path to the zip of the Function app (built by `bun run bundle` in infra/azure, once that exists). Leave null to
    create only the infrastructure and deploy the code separately.
  EOT
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "How long Log Analytics keeps logs. 30 is the lowest value the PerGB2018 tier accepts."
  type        = number
  default     = 30
}

variable "log_daily_cap_gb" {
  description = "Most log data Log Analytics ingests per day; ingestion stops at the cap. A cost guard."
  type        = number
  default     = 1
}

variable "max_scale_out" {
  description = "Most instances the Function app scales out to. Azure has no API Gateway throttle, so this caps what anyone can make the Receiver and the store do."
  type        = number
  default     = 5
}

variable "monthly_budget_usd" {
  description = "Monthly budget for the resource group, in USD. Alerts at 80% and 100% of actual spend."
  type        = number
  default     = 10
}

variable "budget_alert_emails" {
  description = "Addresses that receive budget alerts. With an empty list no budget is created."
  type        = list(string)
  default     = []
}

variable "budget_start_date" {
  description = "First day of a month, as an RFC 3339 timestamp, from which the budget applies."
  type        = string
  default     = "2026-11-01T00:00:00Z"
}

variable "oidc_audience" {
  description = <<-EOT
    The audience the research workflow requests for its GitHub OIDC token: the broker's public origin, such as
    https://func-xyz.azurewebsites.net. It cannot be computed from the Function app's hostname without a Terraform
    cycle. Leave null to let the code use https://$WEBSITE_HOSTNAME, which matches what the workflow sends.
  EOT
  type        = string
  default     = null
}

variable "oidc_allowed_workflow_ref" {
  description = "Comma separated job_workflow_ref values (exact match) whose OIDC tokens may drive a research task."
  type        = string
  default     = "yashodhah/slop-research-spike/.github/workflows/research-broker.yml@refs/heads/main"
}
