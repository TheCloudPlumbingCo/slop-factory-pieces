#!/usr/bin/env bash
# Stage 4b. Asks the agent for a SHORT summary of the research, with diagrams that GitHub renders.
#   env: RUNNER_TEMP, COPILOT_GITHUB_TOKEN, MODEL (optional)
#   in:  $RUNNER_TEMP/status (must say ok) and $RUNNER_TEMP/out.md (the full research)
#   out: $RUNNER_TEMP/summary.md. No file means no summary; publish.sh then posts a short fallback.
# The full research stays in the file in the pull request. This summary goes in the issue comment and the PR body.
# The prompt holds the vendored show-me rules (skills/show-me/SKILL.md). We put the text in the prompt on purpose:
# the CLI would have to find and choose the skill itself, and that is not certain. It never fails the job.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agent.sh
. "$here/agent.sh"
tmp="${RUNNER_TEMP:?}"
skill="$here/../skills/show-me/SKILL.md"
rm -f "$tmp/summary.md" "$tmp/summary.raw.md"

if [ "$(cat "$tmp/status" 2>/dev/null || true)" != ok ] || [ ! -s "$tmp/out.md" ]; then
  echo "No finished research to summarize."; exit 0
fi

# One command-line argument can be about 128 KB on Linux. Keep the research part well under that.
limit=90000
research=$(head -c "$limit" "$tmp/out.md")
cut_note=""
[ "$(wc -c < "$tmp/out.md")" -gt "$limit" ] && cut_note=$'\n\n(The research was cut here to fit. Summarize what you see.)'

prompt=$(cat <<PROMPT
You write a short summary of the research below. It is posted as a GitHub issue comment. The full research is in a file that people can read and comment on, so do not repeat it.

Rules:
- At most about 25 lines in total.
- Line 1: the answer in one sentence.
- Then a few short bullets with the key findings. Cite repo/path:line only when the research does.
- Add at most 2 Mermaid diagrams, each in a fenced block that starts with three backticks and the word mermaid. Use a diagram only if it helps. Each diagram is short and valid: a flowchart or a sequenceDiagram. Put plain words in the labels: no quotes, brackets, parentheses, colons, or semicolons inside a label.
- You may add a diff block, a file tree, or pseudocode when it helps. Do not write HTML. Do not mention a browser.
- Say only what the research says. Add no new claim.
- Never include a token, a password, or a secret.
- Use short sentences. Active voice.
- End with the last bullet. Do not add links or a closing line. The script adds the links.
- Reply with the markdown only.

How to choose a view (from the show-me skill):
$(cat "$skill" 2>/dev/null)

## The research
$research$cut_note
PROMPT
)

if ! agent_ask "$prompt" "$tmp/summary.raw.md" "$tmp/summary.err.log"; then
  echo "::warning::The summary step failed. A short fallback will be posted."; rm -f "$tmp/summary.raw.md"; exit 0
fi
if [ ! -s "$tmp/summary.raw.md" ]; then
  echo "::warning::The summary was empty. A short fallback will be posted."; exit 0
fi
if ! bash "$here/guard-output.sh" "$tmp/summary.raw.md" "${COPILOT_GITHUB_TOKEN:-}"; then
  echo "::warning::The summary looked like it held an access token. It was withheld."; rm -f "$tmp/summary.raw.md"; exit 0
fi
mv "$tmp/summary.raw.md" "$tmp/summary.md"
echo "Summary written ($(wc -c < "$tmp/summary.md") bytes)."
exit 0
