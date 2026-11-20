// npm run db:docs              ghi db/SCHEMA.md, db/schema/<schema>.md, db/VERSIONS.md từ snapshot và comment schema.ts
// npm run db:docs -- --check   chỉ kiểm: mã thoát 1 nếu tài liệu cũ hoặc có cột tham chiếu chưa khai
// db:generate và db:regen tự chạy bước ghi. Xem db/CLAUDE.md mục "Tài liệu schema và phiên bản".
import { checkDocs, docsProblemsText, writeDocs } from './lib/docs.ts';

if (process.argv.includes('--check')) {
  const { stale, problems } = checkDocs('.');
  if (problems.length) console.error(`Tài liệu schema có lỗi:\n${docsProblemsText(problems)}`);
  if (stale.length) console.error(`Tài liệu chưa khớp schema, chạy npm run db:docs rồi commit:\n  ${stale.join('\n  ')}`);
  if (problems.length || stale.length) process.exit(1);
  console.log('Tài liệu schema khớp.');
} else {
  const { changed, problems } = writeDocs('.');
  console.log(changed.length ? `Đã ghi:\n  ${changed.join('\n  ')}` : 'Tài liệu schema đã khớp, không đổi gì.');
  if (problems.length) {
    console.error(`\nCần sửa (db:ci-check sẽ trượt):\n${docsProblemsText(problems)}`);
    process.exitCode = 1;
  }
}
