#!/usr/bin/env bash
# Exits 1 when a file looks like it holds an access token. Used before the agent's text is shown to anyone.
#   usage: guard-output.sh <file> [secret-to-look-for]
set -uo pipefail
file="$1"; secret="${2:-}"
if grep -qE '(github_pat_|ghp_|ghu_|gho_|ghs_|ghr_)[A-Za-z0-9_]{20,}' "$file"; then exit 1; fi
if [ -n "$secret" ] && grep -qF -- "$secret" "$file"; then exit 1; fi
exit 0
