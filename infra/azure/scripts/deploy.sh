#!/usr/bin/env bash
# Build the broker image, push it to GHCR, and apply the Terraform that runs it on Azure Container Apps.
# Same script for your laptop and for CI. Settings come from terraform/terraform.tfvars and env vars.
#
#   ./scripts/deploy.sh            # build, push, plan, ask, apply
#   ./scripts/deploy.sh --yes      # skip the confirmation (CI sets CI=true, which does the same)
#   ./scripts/deploy.sh --plan     # build, push, plan only; nothing changes in Azure
#
# Needs: docker, terraform, az (logged in), and docker logged in to ghcr.io
#        (laptop: echo $GHCR_TOKEN | docker login ghcr.io -u <you> --password-stdin).
# It does not create the Key Vault secrets. See ../README.md, "Deploying".
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/thecloudplumbingco/slop-broker}"   # must be lowercase
TAG="${TAG:-$(git rev-parse --short HEAD)}"
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

for tool in docker terraform az; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed" >&2; exit 1; }
done

echo "==> Building $IMAGE (linux/amd64, Container Apps does not run arm64 here)"
docker buildx build --platform linux/amd64 -f infra/azure/Dockerfile --tag "$IMAGE" --push "$ROOT"

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
  echo "Make the package public once: GitHub -> the organisation -> Packages -> $(basename "$IMAGE_REPO") -> Package settings -> Change visibility -> Public." >&2
  echo "Then run this script again." >&2
  exit 1
fi

echo "==> Terraform"
cd terraform
terraform init -input=false >/dev/null
tf_vars=(-var "subscription_id=$SUBSCRIPTION_ID" -var "image=$IMAGE")
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

echo "==> Outputs"
terraform output
