#!/usr/bin/env bash
# Stage 5. Shows the result. Runs even when an earlier stage failed.
#   env: WS, ISSUE, WORKSPACE_DIR, PUBLISH_TOKEN (issues: write, pull requests: write on this repo),
#        DEFAULT_BRANCH, RUN_ID (optional), RUNNER_TEMP, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID
# 1. On success, commits the full research document on a branch and opens a pull request. The file is where
#    people read and comment on the research.
# 2. Always posts a comment on the workspace issue:
#    - success with a PR: a SHORT comment (the summary, with diagrams) plus links to the file and the PR.
#      The PR description gets the same short text.
#    - success but no PR: the full result, cut to fit, so the user still gets the answer.
#    - failure: the short failure message.
# The short text is the summary from summarize.sh when it is usable. If not, a short fallback. Never the full text.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="${RUNNER_TEMP:?}"; ws="${WS:?}"; issue="${ISSUE:?}"; dir="${WORKSPACE_DIR:-workspace}"
base="${DEFAULT_BRANCH:-main}"
status=$(cat "$tmp/status" 2>/dev/null || echo fail)
result="$tmp/result.md"
server="${GITHUB_SERVER_URL:-https://github.com}"
run_url="$server/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
max_summary=8000
if [ ! -s "$result" ]; then
  echo "The research workflow failed before it produced a result. See the run: $run_url" > "$result"
fi

# A short templated text: the first heading and the first lines of the research. Used when there is no usable summary.
fallback_text() {
  local out="$tmp/out.md" heading lines
  heading=$(grep -m1 '^#' "$out" 2>/dev/null || true)
  lines=$(head -n 10 "$out" 2>/dev/null || true)
  {
    if [ -n "$heading" ] && ! printf '%s\n' "$lines" | grep -qxF -- "$heading"; then printf '%s\n\n' "$heading"; fi
    printf '%s\n' "$lines" | head -c 2000
    printf '\n\n_The short summary was not available. The full research is in the file._\n'
  } > "$tmp/fallback.md"
  bash "$here/clean-summary.sh" "$tmp/fallback.md"
}

# The text for the comment and the PR description. The summary when it is usable, otherwise the fallback.
short_text() {
  local s="$tmp/summary.md" cleaned
  if [ -s "$s" ] && [ "$(wc -c < "$s")" -le "$max_summary" ] && bash "$here/guard-output.sh" "$s"; then
    cleaned=$(bash "$here/clean-summary.sh" "$s")
    if [ -n "${cleaned//[[:space:]]/}" ]; then printf '%s\n' "$cleaned"; return; fi
  fi
  cleaned=$(fallback_text)
  if [ -n "${cleaned//[[:space:]]/}" ]; then printf '%s\n' "$cleaned"
  else printf 'Research for the `%s` workspace is ready. The full text is in the file.\n' "$ws"; fi
}

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
    short=$(short_text)
    title="research($ws): issue #$issue"
    body="Refs #$issue"$'\n\n'"$short"$'\n\n'"Research written by the agent. Merging this PR approves it."
    url=$(cd "$dir" && GH_TOKEN="$PUBLISH_TOKEN" gh pr create --base "$base" --head "$branch" --title "$title" --body "$body" --label research --label "ws:$ws" 2>/dev/null) \
      || url=$(cd "$dir" && GH_TOKEN="$PUBLISH_TOKEN" gh pr create --base "$base" --head "$branch" --title "$title" --body "$body" 2>/dev/null) \
      || url=$(cd "$dir" && GH_TOKEN="$PUBLISH_TOKEN" gh pr view "$branch" --json url --jq .url 2>/dev/null) \
      || url=""
    if [ -n "$url" ]; then
      printf '%s' "$url" > "$tmp/pr-url"
      file_url="$server/${GITHUB_REPOSITORY:-}/blob/$branch/$file"
      # The comment is the short text and the links. The full research is in the file.
      printf '%s\n\n---\nResearch file: %s\nResearch PR: %s\n' "$short" "$file_url" "$url" > "$result"
    else
      # No PR: the user must still get the answer, so the comment keeps the full text (cut below if it is too long).
      printf '\n\n---\nThe research pull request could not be opened. See the run: %s\n' "$run_url" >> "$result"
    fi
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
