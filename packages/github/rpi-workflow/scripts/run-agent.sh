#!/usr/bin/env bash
# Stage 4. Runs the agent over the cloned repos and writes its markdown to $RUNNER_TEMP/out.md.
#   env: WS, TASK, ISSUE, COPILOT_GITHUB_TOKEN, RUNNER_TEMP, GH_TOKEN (to read the issue when TASK is empty),
#        MODEL (optional; the Copilot model id. Empty means the CLI default)
# This is the one place that names the agent. Today it is the Copilot CLI. The Copilot SDK runner replaces this file.
# On failure it writes a short message to $RUNNER_TEMP/result.md and "fail" to $RUNNER_TEMP/status, and exits 1.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="${RUNNER_TEMP:?}"; ws="${WS:?}"; task="${TASK:-}"; issue="${ISSUE:?}"

fail() { printf '%s\n' "$1" > "$tmp/result.md"; echo fail > "$tmp/status"; exit 1; }

[ -n "${COPILOT_GITHUB_TOKEN:-}" ] || fail "The Copilot token is not set up: add the secret COPILOT_GITHUB_TOKEN."
npm install -g @github/copilot >/dev/null 2>&1 || fail "Could not install the Copilot CLI."

if [ -z "$task" ]; then
  task=$(gh issue view "$issue" --repo "$GITHUB_REPOSITORY" --json title,body --jq '"\(.title)\n\n\(.body)"')
fi
prompt="You are doing read-only research for the '$ws' workspace. Its repositories are cloned under ./repos/ (one folder each). Do not modify any file. Reply with markdown only: a one-line answer first, then the evidence as bullets that each cite repo/path:line, then an 'Affected repos' list, then 'Open questions'. Task: ${task}"

model_args=(); [ -n "${MODEL:-}" ] && model_args=(--model "$MODEL")
copilot -p "$prompt" -s --no-ask-user ${model_args[@]+"${model_args[@]}"} \
  --allow-tool='shell(cat:*)' --allow-tool='shell(ls:*)' --allow-tool='shell(grep:*)' \
  --allow-tool='shell(find:*)' > "$tmp/out.md" 2> "$tmp/err.log"
code=$?
if [ $code -ne 0 ] || [ ! -s "$tmp/out.md" ]; then
  { echo "Research did not produce output (exit $code). Last lines of the log:"; echo '```'; tail -n 30 "$tmp/err.log"; echo '```'; } > "$tmp/result.md"
  echo fail > "$tmp/status"; exit 1
fi
if ! bash "$here/guard-output.sh" "$tmp/out.md" "$COPILOT_GITHUB_TOKEN"; then
  fail "The research output was withheld because it contained something that looks like an access token."
fi
cp "$tmp/out.md" "$tmp/result.md"
echo ok > "$tmp/status"
