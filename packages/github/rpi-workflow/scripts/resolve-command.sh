#!/usr/bin/env bash
# Stage 0. Checks the command in the work order, so one workflow file serves every phase.
#   env: COMMAND, RUNNER_TEMP
# An unknown or unsupported command writes a short message to $RUNNER_TEMP/result.md, "fail" to $RUNNER_TEMP/status,
# and exits 1. The board column is not decided here: the broker owns the card states.
# To add a phase: add a line to the table below and the stage that runs it.
set -uo pipefail
command="${COMMAND:-}"; tmp="${RUNNER_TEMP:?}"

case "$command" in
  research) ;;
  design|outline|implement)
    echo "The command \`$command\` is not supported yet. Supported: research." > "$tmp/result.md"
    echo fail > "$tmp/status"; exit 1 ;;
  *)
    echo "Unknown command \`$command\`. Supported: research." > "$tmp/result.md"
    echo fail > "$tmp/status"; exit 1 ;;
esac
echo "command=$command"
