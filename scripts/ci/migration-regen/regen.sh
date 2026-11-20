#!/usr/bin/env bash
# Job `regen` của migration-regen (một PR mỗi lần, matrix). Chạy code của nhánh PR (npm ci, db:regen), nên job này
# KHÔNG có token ghi: checkout với persist-credentials: false, không secret nào trong env.
# Chạy trong thư mục làm việc là bản checkout của repo (đủ lịch sử). Env: PR_SHA, MAIN_SHA, OUT_DIR, LIB.
# Ghi vào OUT_DIR: status (ok | nochange | conflict | merge_failed | regen_failed | check_failed), conflicts, log,
# db.tgz (khi ok: nguyên các thư mục db:regen sinh ra, job push lấy lại đúng các đường dẫn này).
set -uo pipefail
# shellcheck source=lib.sh
source "$LIB"

mkdir -p "$OUT_DIR"
log="$OUT_DIR/log"
: > "$log"
finish() {
  echo "$1" > "$OUT_DIR/status"
  echo "Kết quả: $1"
  exit 0
}

bot_identity
# db:regen và db:ci-check so với origin/main: trỏ nó đúng vào commit main job list đã chọn.
git update-ref refs/remotes/origin/main "$MAIN_SHA"

merge_main "$PR_SHA" "$MAIN_SHA" "$OUT_DIR/conflicts"
case $? in
  0) ;;
  2) cat "$OUT_DIR/conflicts"; finish conflict ;;
  *) cat "$OUT_DIR/conflicts"; finish merge_failed ;;
esac

# Log npm ci để riêng, log chính (đuôi của nó lên bình luận PR) chỉ có db:regen và db:ci-check.
if ! npm ci --no-audit --no-fund > "$OUT_DIR/npm-ci.log" 2>&1; then
  tail -n 80 "$OUT_DIR/npm-ci.log" | tee -a "$log"
  finish regen_failed
fi

# --non-interactive: drizzle-kit không được hỏi đổi tên cột/bảng; hỏi là lỗi, không bao giờ tự trả lời.
echo '$ npm run db:regen -- --base origin/main --non-interactive' >> "$log"
if ! timeout 900 npm run db:regen -- --base origin/main --non-interactive < /dev/null >> "$log" 2>&1; then
  tail -n 120 "$log"
  finish regen_failed
fi
echo '$ npm run db:ci-check -- --base origin/main' >> "$log"
if ! timeout 600 npm run db:ci-check -- --base origin/main < /dev/null >> "$log" 2>&1; then
  tail -n 120 "$log"
  finish check_failed
fi
cat "$log" | tail -n 60

# db:regen chỉ được đổi các tệp sinh ra.
outside=$(git status --porcelain --untracked-files=all | cut -c4- | while IFS= read -r f; do is_generated "$f" || echo "$f"; done)
if [ -n "$outside" ]; then
  printf 'db:regen đổi tệp ngoài migration và tài liệu schema:\n%s\n' "$outside" | tee -a "$log"
  finish regen_failed
fi
if [ -z "$(git status --porcelain --untracked-files=all)" ]; then
  finish nochange
fi
tar -czf "$OUT_DIR/db.tgz" "${GENERATED_PATHS[@]}"
finish ok
