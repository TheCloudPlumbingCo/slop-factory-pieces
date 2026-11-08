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

variable "image" {
  description = <<-EOT
    The broker's container image, such as ghcr.io/<owner>/slop-broker:<tag>. `npm run deploy:broker` builds and pushes
    it and passes it here. The image must be public, because the Container App pulls it with no credentials.
  EOT
  type        = string
  default     = "ghcr.io/changeme/slop-broker:latest"
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

variable "max_replicas" {
  description = "Most replicas the Container App scales out to. The claim and lease in Cosmos keep two replicas from doing the same work. A cost guard."
  type        = number
  default     = 2
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

variable "broker_public_origin" {
  description = <<-EOT
    The broker's public origin, such as https://broker.example.com. The workflow asks GitHub for an identity token for
    it. Leave null to use the Container App's default address.
  EOT
  type        = string
  default     = null
}

variable "oidc_allowed_workflow_ref" {
  description = "Comma separated job_workflow_ref values (exact match) whose OIDC tokens may drive a research task."
  type        = string
  default     = "TheCloudPlumbingCo/slop-factory-pieces/.github/workflows/workspace.yml@refs/heads/main"
}
