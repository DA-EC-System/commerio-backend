#!/usr/bin/env bash
# Job `list` của migration-regen: chọn PR cần sinh lại migration, ghi ra GITHUB_OUTPUT.
# Env: GH_TOKEN (đọc PR), REPO (owner/name), BASE_BRANCH, PR_NUMBER (tuỳ chọn, chỉ xét PR này).
# Chọn PR: mở, base = BASE_BRANCH, cùng repo (không fork), không có nhãn no-auto-regen, chưa chứa BASE_BRANCH,
# và có tệp trong db/migrations/ so với điểm rẽ nhánh. Không checkout code, chỉ gọi API.
set -euo pipefail

main_sha=$(gh api "repos/$REPO/commits/$BASE_BRANCH" --jq .sha)
prs=$(gh pr list -R "$REPO" --state open --base "$BASE_BRANCH" --limit 200 \
  --json number,headRefName,headRefOid,isCrossRepository,labels)

candidates=$(jq -c --arg only "${PR_NUMBER:-}" '[.[]
  | select(.isCrossRepository | not)
  | select([.labels[].name] | index("no-auto-regen") | not)
  | select($only == "" or (.number | tostring) == $only)
  | {number, branch: .headRefName, sha: .headRefOid}]' <<< "$prs")

selected='[]'
while IFS= read -r pr; do
  [ -n "$pr" ] || continue
  number=$(jq -r .number <<< "$pr")
  sha=$(jq -r .sha <<< "$pr")
  # behind_by = số commit của main nhánh chưa có; files = tệp nhánh đổi so với điểm rẽ (tối đa 300 tệp đầu).
  cmp=$(gh api "repos/$REPO/compare/$main_sha...$sha" --jq '{behind: .behind_by, mig: ([.files[]?.filename | select(startswith("db/migrations/"))] | length)}')
  behind=$(jq -r .behind <<< "$cmp")
  mig=$(jq -r .mig <<< "$cmp")
  if [ "$behind" = 0 ]; then echo "#$number: đã chứa $BASE_BRANCH, bỏ qua"; continue; fi
  if [ "$mig" = 0 ]; then echo "#$number: không có migration, bỏ qua"; continue; fi
  echo "#$number: cần sinh lại (sau $BASE_BRANCH $behind commit, $mig tệp migration)"
  selected=$(jq -c --argjson pr "$pr" '. + [$pr]' <<< "$selected")
done < <(jq -c '.[]' <<< "$candidates")

{
  echo "main_sha=$main_sha"
  echo "prs=$selected"
  echo "count=$(jq length <<< "$selected")"
} >> "$GITHUB_OUTPUT"
