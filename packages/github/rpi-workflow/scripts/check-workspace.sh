#!/usr/bin/env bash
# Stage 1. Checks that the workspace named in the work order exists in the workspace repo checkout.
#   env: WS (workspace id), WORKSPACE_DIR (checkout path), RUNNER_TEMP (where status and result go)
# On a problem it writes a short message to $RUNNER_TEMP/result.md, writes "fail" to $RUNNER_TEMP/status, and exits 1.
set -uo pipefail
ws="${WS:-}"; dir="${WORKSPACE_DIR:-workspace}"; tmp="${RUNNER_TEMP:?RUNNER_TEMP is not set}"

problem=""
if ! [[ "$ws" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  problem="\`$ws\` is not a valid workspace id. Use lowercase letters, digits and dashes."
elif [ ! -f "$dir/workspaces/$ws/workspace.json" ]; then
  have=$(ls "$dir/workspaces" 2>/dev/null | tr '\n' ' ')
  problem="There is no workspace \`$ws\` in this repository. Available: ${have:-none}"
fi

if [ -n "$problem" ]; then
  echo "$problem" > "$tmp/result.md"
  echo fail > "$tmp/status"
  exit 1
fi
