#!/usr/bin/env bash
# Stage 0. Maps the command in the work order to what the run needs, so one workflow file serves every phase.
#   env: COMMAND, RUNNER_TEMP, GITHUB_OUTPUT (optional)
# Writes "card-status=<board column>" to $GITHUB_OUTPUT. An unknown or unsupported command writes a short message to
# $RUNNER_TEMP/result.md, "fail" to $RUNNER_TEMP/status, and exits 1.
# To add a phase: add a line to the table below and the stage that runs it.
set -uo pipefail
command="${COMMAND:-}"; tmp="${RUNNER_TEMP:?}"

case "$command" in
  research) card_status="Research" ;;
  design|outline|implement)
    echo "The command \`$command\` is not supported yet. Supported: research." > "$tmp/result.md"
    echo fail > "$tmp/status"; exit 1 ;;
  *)
    echo "Unknown command \`$command\`. Supported: research." > "$tmp/result.md"
    echo fail > "$tmp/status"; exit 1 ;;
esac
[ -z "${GITHUB_OUTPUT:-}" ] || echo "card-status=$card_status" >> "$GITHUB_OUTPUT"
echo "command=$command card-status=$card_status"
