#!/usr/bin/env bash
# Stage 3. Downloads every repo listed in the workspace's workspace.json, read-only, into ./repos/<name>.
#   env: WS, WORKSPACE_DIR, READ_TOKEN (contents: read on those repos)
#        CLONE_BASE (optional; default https://x-access-token:$READ_TOKEN@github.com; tests point it at local repos)
# The .git folder is removed, so the agent sees files only and cannot push.
set -euo pipefail
ws="${WS:?}"; dir="${WORKSPACE_DIR:-workspace}"
base="${CLONE_BASE:-https://x-access-token:${READ_TOKEN:?READ_TOKEN is not set}@github.com}"

mkdir -p repos
jq -r '.repos[]' "$dir/workspaces/$ws/workspace.json" | while read -r repo; do
  git clone --quiet --depth 1 "$base/${repo}.git" "repos/${repo#*/}"
  rm -rf "repos/${repo#*/}/.git"
done
ls repos
