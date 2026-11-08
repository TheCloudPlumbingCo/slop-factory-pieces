#!/usr/bin/env bash
# Move an issue's card on the workspace's GitHub Project to a Status column.
#   usage: move-card.sh <issue-number> <Status name> <project-number>
# Needs GH_TOKEN with the organisation permission "Projects: write". Safe to run twice, and it never moves a card
# backwards (the order is the column order of the Status field).
set -euo pipefail
issue="$1"; status="$2"; number="$3"
owner="${GITHUB_REPOSITORY%%/*}"; repo="${GITHUB_REPOSITORY#*/}"

meta=$(gh api graphql -f owner="$owner" -F number="$number" -f query='
  query($owner:String!,$number:Int!){organization(login:$owner){projectV2(number:$number){
    id field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}')
project_id=$(jq -r '.data.organization.projectV2.id' <<<"$meta")
field_id=$(jq -r '.data.organization.projectV2.field.id' <<<"$meta")
option_id=$(jq -r --arg s "$status" '.data.organization.projectV2.field.options[] | select(.name==$s) | .id' <<<"$meta")
[ -n "$option_id" ] || { echo "Project $number has no Status called '$status'" >&2; exit 1; }
rank() { jq -r --arg s "$1" '[.data.organization.projectV2.field.options[].name] | index($s) // -1' <<<"$meta"; }

found=$(gh api graphql -f owner="$owner" -f repo="$repo" -F issue="$issue" -f query='
  query($owner:String!,$repo:String!,$issue:Int!){repository(owner:$owner,name:$repo){issue(number:$issue){
    id projectItems(first:20){nodes{id project{id} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}')
issue_id=$(jq -r '.data.repository.issue.id' <<<"$found")
item=$(jq -c --arg p "$project_id" '[.data.repository.issue.projectItems.nodes[] | select(.project.id==$p)][0] // empty' <<<"$found")

if [ -z "$item" ]; then
  item_id=$(gh api graphql -f project="$project_id" -f content="$issue_id" -f query='
    mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}' \
    --jq .data.addProjectV2ItemById.item.id)
  current=""
else
  item_id=$(jq -r .id <<<"$item")
  current=$(jq -r '.fieldValueByName.name // ""' <<<"$item")
fi

if [ -n "$current" ] && [ "$(rank "$current")" -ge "$(rank "$status")" ]; then
  echo "Issue #$issue is already at '$current'; not moving it to '$status'."
  exit 0
fi
gh api graphql -f project="$project_id" -f item="$item_id" -f field="$field_id" -f option="$option_id" -f query='
  mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{
    projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}' >/dev/null
echo "Issue #$issue: '${current:-not on the board}' -> '$status'"
