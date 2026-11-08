#!/usr/bin/env bash
# Stage -1. Skips a run the workflow has already done for the same run id.
#   env: RUN_ID (from the dispatch payload; empty means no check), ISSUE, GITHUB_REPOSITORY, GH_TOKEN (issues: read),
#        GITHUB_OUTPUT
# publish.sh ends its issue comment with <!-- slopfactory-run:RUN_ID -->. If a comment by a bot already holds that
# marker, an earlier run for this id finished (well or not), so this run stops. Output: skip=true or skip=false.
# It never fails the job: if GitHub cannot be read, the run goes on. A double run is better than no run.
# Not covered: two runs for one id that overlap. The concurrency group in workspace.yml makes the second wait, so it
# sees the marker. A new comment from the user has a new id and always runs.
set -uo pipefail
out="${GITHUB_OUTPUT:-/dev/stdout}"
run_id="${RUN_ID:-}"
if [ -z "$run_id" ]; then
  echo "skip=false" >> "$out"; echo "No run id in the payload. No repeat check."; exit 0
fi
marker="<!-- slopfactory-run:$run_id -->"
if bodies=$(gh api "repos/${GITHUB_REPOSITORY:?}/issues/${ISSUE:?}/comments" --paginate \
    --jq '.[] | select(.user.type == "Bot") | .body' 2>/dev/null); then
  if printf '%s\n' "$bodies" | grep -qF -- "$marker"; then
    echo "skip=true" >> "$out"
    echo "Run id $run_id was already done for issue #$ISSUE. Skipping this repeat."
    exit 0
  fi
else
  echo "::warning::Could not read the issue comments. The repeat check is skipped."
fi
echo "skip=false" >> "$out"
exit 0
