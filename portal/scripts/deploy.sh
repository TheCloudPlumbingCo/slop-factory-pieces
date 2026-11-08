#!/usr/bin/env bash
# Build the portal image, push it to GHCR, and apply the Terraform that runs it on Azure Container Apps.
# Same script for your laptop and for CI. Everything comes from env vars, nothing is hard-coded to a machine.
#
#   ./scripts/deploy.sh            # build, push, plan, ask, apply
#   ./scripts/deploy.sh --yes      # skip the confirmation (CI sets CI=true, which does the same)
#   ./scripts/deploy.sh --plan     # build, push, plan only
#
# Needs: docker, terraform, az (logged in), and docker logged in to ghcr.io
#        (laptop: echo $GHCR_TOKEN | docker login ghcr.io -u <you> --password-stdin).
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/yashodhah/portal-poc}"           # must be lowercase
TAG="${TAG:-$(git rev-parse --short HEAD)}"
APP_CLIENT_ID="${APP_CLIENT_ID:-$(grep '^AUTH_MICROSOFT_ENTRA_ID_ID=' .env.local 2>/dev/null | cut -d= -f2 || true)}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
IMAGE="$IMAGE_REPO:$TAG"

MODE=apply
ASSUME_YES="${CI:-}"
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=true ;;
    --plan) MODE=plan ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Pass the provider settings in .env.local to Terraform (they become Container App env vars/secrets).
# Read one KEY=value line at a time; the file is never sourced, so nothing in it can run as code.
envval() { grep -m1 "^$1=" .env.local 2>/dev/null | cut -d= -f2- || true; }
export TF_VAR_github_auth_mode="${TF_VAR_github_auth_mode:-$(envval GITHUB_AUTH_MODE)}"
export TF_VAR_github_client_id="${TF_VAR_github_client_id:-$(envval GITHUB_CLIENT_ID)}"
export TF_VAR_github_client_secret="${TF_VAR_github_client_secret:-$(envval GITHUB_CLIENT_SECRET)}"
export TF_VAR_atlassian_client_id="${TF_VAR_atlassian_client_id:-$(envval ATLASSIAN_CLIENT_ID)}"
export TF_VAR_atlassian_client_secret="${TF_VAR_atlassian_client_secret:-$(envval ATLASSIAN_CLIENT_SECRET)}"
export TF_VAR_atlassian_scopes="${TF_VAR_atlassian_scopes:-$(envval ATLASSIAN_SCOPES)}"
export TF_VAR_token_encryption_key="${TF_VAR_token_encryption_key:-$(envval TOKEN_ENCRYPTION_KEY)}"
[ -n "$TF_VAR_github_auth_mode" ] || unset TF_VAR_github_auth_mode   # blank falls back to the Terraform default

[ -n "$APP_CLIENT_ID" ] || { echo "APP_CLIENT_ID is not set and .env.local has no AUTH_MICROSOFT_ENTRA_ID_ID" >&2; exit 1; }

echo "==> Building $IMAGE (linux/amd64, Container Apps does not run arm64 here)"
docker buildx build --platform linux/amd64 --tag "$IMAGE" --push .

echo "==> Checking the image can be pulled anonymously (Container Apps pulls it with no credentials)"
repo_path="${IMAGE_REPO#ghcr.io/}"
status=000
if anon_token="$(curl -fsS "https://ghcr.io/token?scope=repository:${repo_path}:pull" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)" && [ -n "$anon_token" ]; then
  status="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $anon_token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${repo_path}/manifests/${TAG}")"
else
  status=401
fi
if [ "$status" != 200 ]; then
  echo "The image is not public (anonymous pull returned HTTP $status)." >&2
  echo "Make the package public once: GitHub -> your profile -> Packages -> $(basename "$IMAGE_REPO") -> Package settings -> Change visibility -> Public." >&2
  echo "Then run this script again." >&2
  exit 1
fi

echo "==> Terraform"
cd terraform
terraform init -input=false >/dev/null
tf_vars=(-var "subscription_id=$SUBSCRIPTION_ID" -var "app_client_id=$APP_CLIENT_ID" -var "image=$IMAGE")
terraform plan -input=false -out=tfplan "${tf_vars[@]}"

if [ "$MODE" = plan ]; then
  echo "Plan only. Nothing applied."
  exit 0
fi

if [ -z "$ASSUME_YES" ]; then
  read -r -p "Apply this plan? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) false ;; esac || { echo "Not applied."; exit 1; }
fi

terraform apply -input=false tfplan
echo
echo "Portal URL: $(terraform output -raw portal_url)"
