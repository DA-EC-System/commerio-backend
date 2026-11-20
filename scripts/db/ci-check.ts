// npm run db:ci-check [-- --base origin/main] [--skip-drift]
// Kiểm migration không cần DB (CI chạy ở mọi PR): journal liền mạch, `when` tăng, snapshot nối đúng cha, schema.ts khớp
// migration, tài liệu schema (db/SCHEMA.md, db/schema/, db/VERSIONS.md) khớp, và (có --base) migration của nhánh đứng
// sau mọi migration trên nhánh gốc, nhánh tối đa một migration sinh từ schema. Xem db/CLAUDE.md.
import { checkDocs } from './lib/docs.ts';
import { schemaDrift, migrationsAtRef } from './lib/drizzle-kit.ts';
import { MIGRATIONS_DIR } from './lib/journal.ts';
import { lintAgainstBase, lintFolder, lintGeneratedPerBranch } from './lib/lint.ts';

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const baseRef = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
const skipDrift = args.includes('--skip-drift');

const FIX = 'Cách sửa: gộp main vào nhánh (git fetch origin && git merge origin/main) rồi chạy `npm run db:regen`, commit lại db/migrations.';

const errors: string[] = lintFolder(MIGRATIONS_DIR);
if (baseRef) {
  const base = migrationsAtRef(baseRef, MIGRATIONS_DIR);
  errors.push(...lintAgainstBase(MIGRATIONS_DIR, base));
  if (errors.length === 0) errors.push(...lintGeneratedPerBranch(MIGRATIONS_DIR, new Set(base.journal.entries.map((e) => e.tag))));
}
const docErrors: string[] = [];
if (errors.length === 0) {
  const docs = checkDocs('.');
  docErrors.push(...docs.problems);
  if (docs.stale.length) docErrors.push(`tài liệu schema chưa khớp (chạy \`npm run db:docs\` rồi commit): ${docs.stale.join(', ')}`);
}

let driftReport = '';
if (!skipDrift && errors.length === 0) {
  const drift = schemaDrift(MIGRATIONS_DIR);
  if (drift.failed) {
    errors.push('drizzle-kit generate lỗi trên bản sao db/migrations (có thể đang hỏi đổi tên cột/bảng: chạy `npm run db:generate` trên máy để trả lời)');
    driftReport = drift.output;
  } else if (drift.newFiles.length > 0) {
    errors.push(`schema.ts và migration lệch nhau: drizzle-kit generate còn sinh ra ${drift.newFiles.map((f) => f.name).join(', ')}`);
    driftReport = drift.newFiles
      .filter((f) => f.content)
      .map((f) => `--- ${f.name}\n${f.content}`)
      .join('\n');
  }
}

if (errors.length > 0) {
  console.error(`Kiểm migration KHÔNG ĐẠT (${errors.length} lỗi):`);
  for (const e of errors) console.error(`  - ${e}`);
  if (driftReport) console.error(`\n${driftReport}`);
  console.error(`\n${FIX}`);
  console.error('Schema đổi mà chưa có migration thì chạy `npm run db:generate -- --name <mo-ta>`.');
  process.exit(1);
}
if (docErrors.length > 0) {
  console.error(`Kiểm tài liệu schema KHÔNG ĐẠT (${docErrors.length} lỗi):`);
  for (const e of docErrors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Kiểm migration đạt${baseRef ? ` (so với ${baseRef})` : ''}${skipDrift ? ', bỏ qua kiểm schema lệch' : ''}.`);
