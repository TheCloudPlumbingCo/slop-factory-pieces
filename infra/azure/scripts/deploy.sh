#!/usr/bin/env bash
# Build the broker bundle and apply the Terraform that runs it on Azure Functions.
# Same script for your laptop and for CI. Settings come from terraform/terraform.tfvars and env vars.
#
#   ./scripts/deploy.sh            # bundle, plan, ask, apply
#   ./scripts/deploy.sh --yes      # skip the confirmation (CI sets CI=true, which does the same)
#   ./scripts/deploy.sh --plan     # bundle and plan only; nothing changes in Azure
#
# Needs: bun, terraform, az (logged in). Terraform uploads dist/app.zip because package_path points at it.
# It does not create the Key Vault secrets. See ../README.md, "Deploying".
set -euo pipefail

cd "$(dirname "$0")/.."

MODE=apply
ASSUME_YES="${CI:-}"
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=true ;;
    --plan) MODE=plan ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

for tool in bun terraform az; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed" >&2; exit 1; }
done

echo "==> Bundling the broker"
bun run bundle
[ -s dist/app.zip ] || { echo "dist/app.zip was not built" >&2; exit 1; }

echo "==> Terraform"
cd terraform
terraform init -input=false >/dev/null
terraform plan -input=false -out=tfplan

if [ "$MODE" = plan ]; then
  echo "Plan only. Nothing applied."
  exit 0
fi

if [ -z "$ASSUME_YES" ]; then
  read -r -p "Apply this plan? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) false ;; esac || { echo "Not applied."; exit 1; }
fi
terraform apply -input=false tfplan

echo "==> Outputs"
terraform output
