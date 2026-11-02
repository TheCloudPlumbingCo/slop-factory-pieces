#!/usr/bin/env bash
# Tear down everything Terraform created for the portal on Azure (resource group, Container App and environment,
# managed identity, the federated credential and the redirect-URI list on the Entra app).
#
#   ./scripts/destroy.sh          # show what will be destroyed, then ask y or n
#   ./scripts/destroy.sh --yes    # no question (CI sets CI=true, which does the same)
#
# It does NOT delete: the Entra app registration itself, the test users, the image on GHCR, or the local
# Terraform state file (kept so a destroy that stops half-way can be run again).
set -euo pipefail

cd "$(dirname "$0")/.."

ASSUME_YES="${CI:-}"
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

APP_CLIENT_ID="${APP_CLIENT_ID:-$(grep -m1 '^AUTH_MICROSOFT_ENTRA_ID_ID=' .env.local 2>/dev/null | cut -d= -f2 || true)}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
[ -n "$APP_CLIENT_ID" ] || { echo "APP_CLIENT_ID is not set and .env.local has no AUTH_MICROSOFT_ENTRA_ID_ID" >&2; exit 1; }

cd terraform
terraform init -input=false >/dev/null
tf_vars=(-var "subscription_id=$SUBSCRIPTION_ID" -var "app_client_id=$APP_CLIENT_ID")

echo "==> What will be destroyed"
terraform plan -destroy -input=false -no-color "${tf_vars[@]}" | grep -E '^\s*# .* will be destroyed|^Plan:' || true
echo
echo "Note: the Entra app's Web redirect-URI list is managed by Terraform, so destroying it also removes the"
echo "localhost URI from the app registration. The app registration and the test users stay."

if [ -z "$ASSUME_YES" ]; then
  read -r -p "Destroy all of this? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "Nothing destroyed."; exit 1 ;; esac
fi

terraform destroy -input=false -auto-approve "${tf_vars[@]}"
echo
echo "Destroyed. To bring it back: TAG=<tag> ./scripts/deploy.sh"
