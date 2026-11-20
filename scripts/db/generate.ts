// npm run db:generate -- --name <mo-ta> [--custom]
// drizzle-kit generate như trước, rồi ghi lại tài liệu schema (db/SCHEMA.md, db/schema/, db/VERSIONS.md) để không quên.
import { drizzleGenerate } from './lib/drizzle-kit.ts';
import { docsProblemsText, writeDocs } from './lib/docs.ts';

const { status } = drizzleGenerate(process.argv.slice(2), { interactive: true });
if (status !== 0) process.exit(status ?? 1);

const { changed, problems } = writeDocs('.');
if (changed.length) console.log(`\nĐã cập nhật tài liệu schema:\n  ${changed.join('\n  ')}`);
if (problems.length) {
  console.error(`\nCần sửa trước khi mở PR (db:ci-check sẽ trượt):\n${docsProblemsText(problems)}`);
  process.exitCode = 1;
}
