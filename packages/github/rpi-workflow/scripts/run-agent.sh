#!/usr/bin/env bash
# Stage 4. Runs the agent over the cloned repos and writes its markdown to $RUNNER_TEMP/out.md.
#   env: WS, INSTRUCTIONS (optional), ISSUE, COPILOT_GITHUB_TOKEN, RUNNER_TEMP, GH_TOKEN and GITHUB_REPOSITORY (to read the issue),
#        MODEL (optional; the Copilot model id. Empty means the CLI default)
# This is the one place that names the agent. Today it is the Copilot CLI. The Copilot SDK runner replaces this file.
# On failure it writes a short message to $RUNNER_TEMP/result.md and "fail" to $RUNNER_TEMP/status, and exits 1.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="${RUNNER_TEMP:?}"; ws="${WS:?}"; issue="${ISSUE:?}"

fail() { printf '%s\n' "$1" > "$tmp/result.md"; echo fail > "$tmp/status"; exit 1; }

[ -n "${COPILOT_GITHUB_TOKEN:-}" ] || fail "The Copilot token is not set up: add the secret COPILOT_GITHUB_TOKEN."
npm install -g @github/copilot >/dev/null 2>&1 || fail "Could not install the Copilot CLI."

prompt=$(bash "$here/build-prompt.sh")

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
