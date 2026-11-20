#!/usr/bin/env bash
# Job `push` của migration-regen: đẩy kết quả lên nhánh PR, bình luận vào PR. Job này KHÔNG chạy code của nhánh PR
# (không npm ci, không node): tự gộp main lại bằng git, rồi chỉ lấy từ gói của job regen đúng các tệp db:regen sinh ra
# (db/migrations, db/schema, db/SCHEMA.md, db/VERSIONS.md), kiểm tên và loại từng mục trong gói trước khi giải nén.
# Env: PRS (JSON từ job list), MAIN_SHA, ARTIFACTS (thư mục tải gói về), RUN_ID, REPO, RUN_URL, LIB,
#      GH_TOKEN (GITHUB_TOKEN, để bình luận), PUSH_TOKEN (PAT, có thể rỗng), FALLBACK_TOKEN (GITHUB_TOKEN).
set -uo pipefail
# shellcheck source=lib.sh
source "$LIB"

MARKER='<!-- migration-regen -->'
main_short=${MAIN_SHA:0:8}
if [ -n "${PUSH_TOKEN:-}" ]; then
  token=$PUSH_TOKEN
  token_kind=pat
else
  token=$FALLBACK_TOKEN
  token_kind=github_token
  echo "::warning::Chưa có secret MIGRATION_BOT_TOKEN: đẩy bằng GITHUB_TOKEN, CI sẽ không tự chạy trên commit mới."
fi
unset PUSH_TOKEN FALLBACK_TOKEN

bot_identity
git fetch -q origin "$MAIN_SHA"
failed=0

# upsert_comment <số PR> <tệp nội dung>: mỗi PR một bình luận của bot, lần sau sửa đè.
upsert_comment() {
  local number=$1 file=$2 id
  id=$(gh api "repos/$REPO/issues/$number/comments" --paginate \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$MARKER\"))) | .id" | head -n 1)
  if [ -n "$id" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$id" -F "body=@$file" > /dev/null
  else
    gh api -X POST "repos/$REPO/issues/$number/comments" -F "body=@$file" > /dev/null
  fi
}

# Đuôi log của job regen (đến từ code nhánh PR): bỏ mã màu, bỏ ``` để không thoát khỏi khối code.
log_tail() {
  [ -f "$1" ] || { echo "(không có log)"; return; }
  tail -n 60 "$1" | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' -e 's/```/ʼʼʼ/g' | cut -c1-300
}

manual_steps() {
  cat << 'EOF'
Làm tay (db/CLAUDE.md mục "Hai nhánh cùng sinh migration"):
```bash
git fetch origin && git merge origin/main   # giải xung đột; _journal.json và tài liệu schema để nguyên
npm run db:regen
npm run db:ci-check -- --base origin/main
git add db/migrations db/SCHEMA.md db/schema db/VERSIONS.md && git commit
```
EOF
}

# Gói từ job regen chỉ được chứa tệp thường hoặc thư mục, nằm trong các đường dẫn sinh ra.
check_archive() {
  local tgz=$1 line name
  while IFS= read -r line; do
    case ${line:0:1} in
      - | d) ;;
      *) echo "mục không phải tệp thường hay thư mục: $line"; return 1 ;;
    esac
  done < <(tar -tvzf "$tgz")
  while IFS= read -r name; do
    case "$name" in
      */../* | ../* | */.. | /*) echo "đường dẫn lạ: $name"; return 1 ;;
      db/migrations/ | db/migrations/meta/ | db/schema/) ;;
      *) is_generated "$name" || { echo "ngoài phạm vi: $name"; return 1; } ;;
    esac
  done < <(tar -tzf "$tgz")
}

process() {
  local number=$1 branch=$2 sha=$3
  local dir="$ARTIFACTS/regen-$number" body status rc
  body=$(mktemp)
  # Tải đúng gói regen-<số PR> của run này (download-artifact giải nén phẳng khi chỉ có một gói, dễ lẫn).
  gh run download "$RUN_ID" -R "$REPO" -n "regen-$number" -D "$dir" > /dev/null 2>&1 || echo "Không tải được gói regen-$number"
  status=$(cat "$dir/status" 2> /dev/null || echo missing)
  echo "::group::#$number ($branch): job regen báo $status"

  merge_main "$sha" "$MAIN_SHA" "$RUNNER_TEMP/conflicts-$number"
  rc=$?
  if [ $rc -eq 2 ]; then
    {
      echo "$MARKER"
      echo "**Không tự gộp được \`main\` (\`$main_short\`) vào nhánh**: xung đột ở tệp ngoài migration và tài liệu schema, cần gộp tay:"
      echo
      sed 's/^/- `/; s/$/`/' "$RUNNER_TEMP/conflicts-$number"
      echo
      manual_steps
      echo
      echo "Chưa đẩy gì lên nhánh. [Log]($RUN_URL)"
    } > "$body"
    upsert_comment "$number" "$body"
    echo "::endgroup::"
    return
  fi
  if [ $rc -ne 0 ]; then
    { echo "$MARKER"; echo "**Gộp \`main\` (\`$main_short\`) lỗi** ngoài xung đột tệp. Chưa đẩy gì. [Log]($RUN_URL)"; echo; manual_steps; } > "$body"
    upsert_comment "$number" "$body"
    failed=1
    echo "::endgroup::"
    return
  fi

  case $status in
    nochange)
      echo "Migration đã đứng sau main, không cần đẩy."
      ;;
    ok)
      local why
      if ! why=$(check_archive "$dir/db.tgz"); then
        echo "::error::#$number: gói của job regen không hợp lệ: $why"
        { echo "$MARKER"; echo "**Không đẩy**: gói kết quả của job sinh lại không hợp lệ ($why). [Log]($RUN_URL)"; echo; manual_steps; } > "$body"
        upsert_comment "$number" "$body"
        failed=1
        echo "::endgroup::"
        return
      fi
      rm -rf "${GENERATED_PATHS[@]}"
      tar -xzf "$dir/db.tgz" --no-same-owner --no-same-permissions
      git add -A -- "${GENERATED_PATHS[@]}"
      if git diff --cached --quiet; then
        echo "Không có thay đổi sau khi lấy gói."
      else
        git commit -q -m "Sinh lại migration sau khi gộp main ($main_short) (tự động, migration-regen)" \
          -m "npm run db:regen -- --base origin/main; db:ci-check đạt. Run: $RUN_URL"
        local new_sha err auth
        new_sha=$(git rev-parse HEAD)
        auth=$(printf 'x-access-token:%s' "$token" | base64 -w0)
        echo "::add-mask::$auth"
        if err=$(git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \
          push -q "https://github.com/$REPO.git" "HEAD:refs/heads/$branch" 2>&1); then
          {
            echo "$MARKER"
            echo "**Đã tự gộp \`main\` (\`$main_short\`) và sinh lại migration**: commit \`${new_sha:0:8}\` trên nhánh. Chạy \`git pull\` trước khi làm tiếp."
            if [ "$token_kind" = github_token ]; then
              echo
              echo "> Commit được đẩy bằng GITHUB_TOKEN nên GitHub không chạy CI cho nó (repo chưa có secret \`MIGRATION_BOT_TOKEN\`). Đóng rồi mở lại PR, hoặc đẩy một commit mới, để CI chạy trên commit này; Re-run run cũ chỉ chạy lại commit cũ."
            fi
            echo
            echo "[Log]($RUN_URL)"
          } > "$body"
          echo "Đã đẩy ${new_sha:0:8} lên $branch"
        else
          err=$(sed "s/$token/***/g" <<< "$err" | tail -n 5)
          {
            echo "$MARKER"
            echo "**Sinh lại xong nhưng không đẩy được lên nhánh**:"
            echo '```'
            echo "$err"
            echo '```'
            if grep -q 'workflow' <<< "$err"; then
              echo "Main có đổi \`.github/workflows\`: token không có quyền workflows."
            else
              echo "Thường là nhánh vừa có commit mới. Lần push main kế tiếp sẽ thử lại, hoặc chạy tay workflow migration-regen với số PR này."
            fi
            echo
            manual_steps
            echo
            echo "[Log]($RUN_URL)"
          } > "$body"
          echo "::warning::#$number: push bị từ chối"
        fi
        upsert_comment "$number" "$body"
      fi
      ;;
    regen_failed | check_failed | conflict | merge_failed | missing)
      local what
      case $status in
        regen_failed) what="\`npm run db:regen\` lỗi (drizzle-kit hỏi đổi tên cột/bảng cũng tính là lỗi, phải trả lời trên máy)" ;;
        check_failed) what="\`npm run db:ci-check\` không đạt sau khi sinh lại" ;;
        missing) what="job sinh lại không trả kết quả (lỗi giữa chừng hoặc quá giờ)" ;;
        *) what="job sinh lại báo \`$status\`" ;;
      esac
      {
        echo "$MARKER"
        echo "**Không tự sinh lại migration được sau khi gộp \`main\` (\`$main_short\`)**: $what. Chưa đẩy gì lên nhánh."
        echo
        echo "<details><summary>Đuôi log</summary>"
        echo
        echo '```'
        log_tail "$dir/log"
        echo '```'
        echo "</details>"
        echo
        manual_steps
        echo
        echo "[Log]($RUN_URL)"
      } > "$body"
      upsert_comment "$number" "$body"
      [ "$status" = missing ] && failed=1
      ;;
    *)
      echo "::error::#$number: trạng thái lạ: $status"
      failed=1
      ;;
  esac
  echo "::endgroup::"
}

while IFS=$'\t' read -r number branch sha; do
  process "$number" "$branch" "$sha"
done < <(jq -r '.[] | [.number, .branch, .sha] | @tsv' <<< "$PRS")

exit $failed
