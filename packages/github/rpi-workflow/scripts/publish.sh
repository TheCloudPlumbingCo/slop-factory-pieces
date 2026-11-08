#!/usr/bin/env bash
# Stage 5. Shows the result. Runs even when an earlier stage failed.
#   env: WS, ISSUE, WORKSPACE_DIR, PUBLISH_TOKEN (issues: write, pull requests: write on this repo),
#        DEFAULT_BRANCH, RUN_ID (optional), RUNNER_TEMP, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID
# 1. On success, commits the research document on a branch and opens a pull request.
# 2. Always posts the result, or the failure, as a comment on the workspace issue.
set -uo pipefail
tmp="${RUNNER_TEMP:?}"; ws="${WS:?}"; issue="${ISSUE:?}"; dir="${WORKSPACE_DIR:-workspace}"
base="${DEFAULT_BRANCH:-main}"
status=$(cat "$tmp/status" 2>/dev/null || echo fail)
result="$tmp/result.md"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
if [ ! -s "$result" ]; then
  echo "The research workflow failed before it produced a result. See the run: $run_url" > "$result"
fi

if [ "$status" = ok ] && [ -s "$tmp/out.md" ]; then
  branch="$ws/research/issue-$issue"
  file="workspaces/$ws/research/issue-$issue.md"
  (
    set -e
    cd "$dir"
    git config user.name "slopcodedev[bot]"
    git config user.email "344321808+slopcodedev[bot]@users.noreply.github.com"
    git checkout -q -b "$branch"
    mkdir -p "$(dirname "$file")"
    cp "$tmp/out.md" "$file"
    git add "$file"
    git commit -q -m "research($ws): issue #$issue"
    git push -q --force origin "$branch"
  )
  if [ $? -eq 0 ]; then
    title="research($ws): issue #$issue"
    body="Refs #$issue"$'\n\n'"Research written by the agent. Merging this PR approves it."
    url=$(cd "$dir" && GH_TOKEN="$PUBLISH_TOKEN" gh pr create --base "$base" --head "$branch" --title "$title" --body "$body" --label research --label "ws:$ws" 2>/dev/null) \
      || url=$(cd "$dir" && GH_TOKEN="$PUBLISH_TOKEN" gh pr create --base "$base" --head "$branch" --title "$title" --body "$body" 2>/dev/null) \
      || url=$(cd "$dir" && GH_TOKEN="$PUBLISH_TOKEN" gh pr view "$branch" --json url --jq .url 2>/dev/null) \
      || url=""
    if [ -n "$url" ]; then printf '%s' "$url" > "$tmp/pr-url"; printf '\n\n---\nResearch PR: %s\n' "$url" >> "$result"
    else printf '\n\n---\nThe research pull request could not be opened. See the run: %s\n' "$run_url" >> "$result"; fi
  else
    printf '\n\n---\nThe research branch could not be pushed. See the run: %s\n' "$run_url" >> "$result"
  fi
fi

# GitHub limits a comment to 65,536 characters.
if [ "$(wc -c < "$result")" -gt 60000 ]; then
  head -c 60000 "$result" > "$result.cut"; printf '\n\n(The result was cut. See the run: %s)\n' "$run_url" >> "$result.cut"; mv "$result.cut" "$result"
fi
# The marker lets the next run with the same id see that this one is done (see check-repeat.sh).
if [ -n "${RUN_ID:-}" ]; then printf '\n\n<!-- slopfactory-run:%s -->\n' "$RUN_ID" >> "$result"; fi
GH_TOKEN="$PUBLISH_TOKEN" gh issue comment "$issue" --repo "$GITHUB_REPOSITORY" --body-file "$result" | tail -n 1 > "$tmp/comment-url"
