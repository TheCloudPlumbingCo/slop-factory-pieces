#!/usr/bin/env bash
# Makes a summary safe to post. Reads a markdown file, writes the cleaned markdown on stdout.
#   usage: clean-summary.sh <file>
# GitHub renders ```mermaid fences. A broken fence would swallow the rest of the comment, so:
#   - a mermaid fence is kept only if it is closed, starts with a known diagram word, and is one of the first 2 kept
#   - a broken or extra mermaid fence is dropped; the text around it stays
#   - any other fence that is not closed is closed at the end
# This is a cheap check. It does not parse Mermaid. A diagram with a wrong label can still fail to render.
set -uo pipefail
awk '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function fence(line,   t) { t = line; sub(/^ ?/, "", t); sub(/^ ?/, "", t); sub(/^ ?/, "", t); return substr(t, 1, 3) == "```" }
function lang(line,   t) { t = line; sub(/^ +/, "", t); sub(/^`+/, "", t); return trim(t) }
function ok_diagram(   i, first) {
  first = ""
  for (i = 1; i <= n; i++) if (trim(body[i]) != "") { first = trim(body[i]); break }
  return first ~ /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|journey|pie|mindmap|timeline|gitGraph)([ \t]|$)/
}
function emit(close_it,   i) {
  print opening
  for (i = 1; i <= n; i++) print body[i]
  if (close_it) print "```"
}
BEGIN { inside = 0; kept = 0; n = 0 }
{
  if (!inside) {
    if (fence($0)) { inside = 1; opening = $0; ismer = (lang($0) == "mermaid"); n = 0; next }
    print; next
  }
  if (fence($0) && lang($0) == "") {
    inside = 0
    if (ismer) {
      if (kept < 2 && ok_diagram()) { emit(1); kept++ }
    } else emit(1)
    next
  }
  body[++n] = $0
}
END {
  if (inside && !ismer) emit(1)
}
' "$1"
