# Hàm dùng chung cho workflow migration-regen (.github/workflows/migration-regen.yml). Nạp bằng `source`.

# Tệp do drizzle-kit hoặc db:regen sinh ra: xung đột ở đây thì lấy bản main, db:regen ghi lại.
is_generated() {
  case "$1" in
    db/migrations/* | db/SCHEMA.md | db/VERSIONS.md | db/schema/*.md) return 0 ;;
  esac
  return 1
}

# Các đường dẫn db:regen được phép đổi (cũng là nội dung gói chuyển từ job regen sang job push).
GENERATED_PATHS=(db/migrations db/schema db/SCHEMA.md db/VERSIONS.md)

bot_identity() {
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
}

# merge_main <pr_sha> <main_sha> <out_conflicts_file>
# Đứng ở <pr_sha> (detached), gộp <main_sha>. Xung đột chỉ ở tệp sinh ra thì lấy bản main và commit merge.
# Mã trả về: 0 gộp xong (HEAD là commit merge), 2 xung đột ở tệp khác (đã abort, danh sách ghi vào tệp), 1 lỗi khác.
merge_main() {
  local pr_sha=$1 main_sha=$2 out=$3
  : > "$out"
  git checkout -q --detach "$pr_sha" || return 1
  if git merge -q --no-ff --no-edit -m "Gộp main vào nhánh (tự động, migration-regen)" "$main_sha" > /dev/null 2>&1; then
    return 0
  fi
  local conflicts other=() f
  conflicts=$(git diff --name-only --diff-filter=U)
  if [ -z "$conflicts" ]; then
    git merge --abort 2> /dev/null
    echo "(git merge lỗi nhưng không có tệp xung đột)" > "$out"
    return 1
  fi
  while IFS= read -r f; do
    is_generated "$f" || other+=("$f")
  done <<< "$conflicts"
  if [ ${#other[@]} -gt 0 ]; then
    printf '%s\n' "${other[@]}" > "$out"
    git merge --abort
    return 2
  fi
  while IFS= read -r f; do
    if git cat-file -e "$main_sha:$f" 2> /dev/null; then
      git checkout -q "$main_sha" -- "$f"
    else
      git rm -q -- "$f"
    fi
  done <<< "$conflicts"
  git commit -q --no-edit || return 1
}
