#!/usr/bin/env bash
# Stage 6. Tells the broker the run ended, so the broker can reply on the channel the comment came from.
#   env: BROKER_ORIGIN, DELIVERY_ID (from the dispatch payload), WS, ISSUE, RUNNER_TEMP,
#        ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (set when the job has id-token: write),
#        GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID
# The workflow knows nothing about the channel. It sends a status and links. Runs even when an earlier stage failed.
# It never fails the job: a missed report must not hide a good result. The broker has the pending record expire.
set -uo pipefail
origin="${BROKER_ORIGIN:-}"; id="${DELIVERY_ID:-}"
if [ -z "$origin" ] || [ -z "$id" ]; then
  echo "No broker delivery in this run (a manual dispatch). No report sent."; exit 0
fi
case "$origin" in https://*) ;; *) echo "::warning::The broker origin is not https. No report sent."; exit 0 ;; esac
if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
  echo "::warning::No identity token. The job needs 'id-token: write'. No report sent."; exit 0
fi

tmp="${RUNNER_TEMP:?}"; ws="${WS:-}"; issue="${ISSUE:-}"
status=$(cat "$tmp/status" 2>/dev/null || echo fail)
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
comment_url=$(cat "$tmp/comment-url" 2>/dev/null || true)
pr_url=$(cat "$tmp/pr-url" 2>/dev/null || true)

if [ "$status" = ok ]; then
  action=complete
  md="Research for the \`$ws\` workspace is done."
  [ -n "$comment_url" ] && md="$md"$'\n\n'"Result: $comment_url"
  [ -n "$pr_url" ] && md="$md"$'\n'"Research PR: $pr_url"
else
  action=fail
  md="Research for the \`$ws\` workspace failed."$'\n\n'"Run: $run_url"
  [ -n "$comment_url" ] && md="$md"$'\n'"Details: $comment_url"
fi
jq -n --arg markdown "$md" '{markdown: $markdown}' > "$tmp/report.json"

jwt=$(curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${origin}" 2>/dev/null | jq -r '.value // empty')
if [ -z "$jwt" ]; then echo "::warning::Could not get an identity token. No report sent."; exit 0; fi
echo "::add-mask::$jwt"

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $jwt" -H "Content-Type: application/json" \
  --data-binary "@$tmp/report.json" \
  "${origin%/}/research-session/${id}/${action}" 2>/dev/null || echo 000)
case "$code" in
  2*) echo "Reported '$action' to the broker (HTTP $code)." ;;
  *)  echo "::warning::The broker did not accept the report (HTTP $code)." ;;
esac
exit 0
