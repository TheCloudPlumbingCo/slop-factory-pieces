#!/usr/bin/env bash
# Sourced, not run. This is the one place that names the agent. Today it is the Copilot CLI.
# The Copilot SDK runner replaces this file. run-agent.sh and summarize.sh call these two functions only.
#   env: COPILOT_GITHUB_TOKEN (the CLI reads it itself), MODEL (optional; empty means the CLI default)

# Install the agent. Returns 1 when it fails.
agent_install() {
  npm install -g @github/copilot >/dev/null 2>&1
}

# Ask the agent one question.
#   usage: agent_ask <prompt> <out-file> <err-file> [extra agent arguments...]
# The answer goes to <out-file>, the log to <err-file>. Returns the agent's exit code.
agent_ask() {
  local prompt="$1" out="$2" err="$3"; shift 3
  local model_args=(); [ -n "${MODEL:-}" ] && model_args=(--model "$MODEL")
  copilot -p "$prompt" -s --no-ask-user ${model_args[@]+"${model_args[@]}"} "$@" > "$out" 2> "$err"
}
