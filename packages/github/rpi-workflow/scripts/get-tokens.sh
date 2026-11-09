#!/usr/bin/env bash
# Gets the two GitHub tokens this run needs from the broker, so the App private key never reaches the repo.
#   env: BROKER_ORIGIN, DELIVERY_ID (from the dispatch payload),
#        ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (set when the job has id-token: write),
#        READ_TOKEN, PUBLISH_TOKEN (optional; a token given here is used and the broker is not asked),
#        GITHUB_OUTPUT
# Writes the outputs `read` and `publish`. The broker checks the OIDC token (repository, workflow file) before it
# makes a token. Read: contents read. Publish: pull requests and issues write on this repo only.
set -uo pipefail
origin="${BROKER_ORIGIN:-}"; id="${DELIVERY_ID:-}"
out="${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}"

fetch_token() { # $1 = read | publish
  local jwt token
  jwt=$(curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${origin}" 2>/dev/null | jq -r '.value // empty')
  [ -n "$jwt" ] || return 1
  echo "::add-mask::$jwt" >&2
  token=$(curl -fsS -X POST -H "Authorization: Bearer $jwt" \
    "${origin%/}/research-session/${id}/token/$1" 2>/dev/null | jq -r '.token // empty')
  [ -n "$token" ] || return 1
  printf '%s' "$token"
}

for kind in read publish; do
  given="READ_TOKEN"; [ "$kind" = publish ] && given="PUBLISH_TOKEN"
  value="${!given:-}"
  if [ -z "$value" ]; then
    if [ -z "$origin" ] || [ -z "$id" ]; then
      echo "::error::No broker delivery in this run, and no $kind token was given. A manual dispatch must pass the tokens."; exit 1
    fi
    case "$origin" in https://*) ;; *) echo "::error::The broker origin is not https."; exit 1 ;; esac
    if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
      echo "::error::No identity token. The job needs 'id-token: write'."; exit 1
    fi
    value=$(fetch_token "$kind") || { echo "::error::The broker did not give the $kind token."; exit 1; }
  fi
  echo "::add-mask::$value"
  echo "$kind=$value" >> "$out"
done
echo "Got the read and publish tokens."
