#!/usr/bin/env bash
# Builds the agent's prompt on stdout.
#   env: WS, ISSUE, INSTRUCTIONS (optional extra text from the comment), GH_TOKEN, GITHUB_REPOSITORY
# The input is the issue (title and body) plus the optional instructions. The instructions add to the issue; they never
# replace it.
set -uo pipefail
ws="${WS:?}"; issue="${ISSUE:?}"; instructions="${INSTRUCTIONS:-}"

context=$(gh issue view "$issue" --repo "$GITHUB_REPOSITORY" --json title,body --jq '"Title: \(.title)\n\n\(.body)"') || context=""

cat <<PROMPT
You are doing read-only research for the '$ws' workspace. Its repositories are cloned under ./repos/ (one folder each). Do not modify any file. Reply with markdown only: a one-line answer first, then the evidence as bullets that each cite repo/path:line, then an 'Affected repos' list, then 'Open questions'.

## Issue #$issue
${context:-"(The issue could not be read.)"}
PROMPT
if [ -n "${instructions//[[:space:]]/}" ]; then
  printf '\n## Additional instructions\n%s\n' "$instructions"
fi
