// npm run db:regen [-- --base origin/main] [--dry-run]
// Sinh lại migration của nhánh để chúng đứng sau mọi migration của main: lấy journal của main, xoá migration nhánh đã sinh,
// chạy drizzle-kit generate, chép lại nguyên nội dung migration viết tay thành migration --custom mới (giữ thứ tự, giữ
// slug). Chạy sau khi đã gộp main vào nhánh. Xem db/CLAUDE.md.
import { drizzleGenerate, git, gitOk, migrationsAtRef } from './lib/drizzle-kit.ts';
import { MIGRATIONS_DIR } from './lib/journal.ts';
import { applyRegen, planRegen } from './lib/regen.ts';

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const baseRef = baseIndex >= 0 ? args[baseIndex + 1]! : 'origin/main';
const dryRun = args.includes('--dry-run');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!gitOk(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])) fail(`Không thấy ${baseRef}. Chạy git fetch origin trước.`);
const merging = gitOk(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
const containsBase =
  gitOk(['merge-base', '--is-ancestor', baseRef, 'HEAD']) || (merging && gitOk(['merge-base', '--is-ancestor', baseRef, 'MERGE_HEAD']));
if (!containsBase) fail(`Nhánh chưa gộp ${baseRef}. Chạy git merge ${baseRef} (giải xung đột schema.ts) rồi chạy lại db:regen.`);

const journalFile = `${MIGRATIONS_DIR}/meta/_journal.json`;
const unmerged = git(['diff', '--name-only', '--diff-filter=U'])
  .split('\n')
  .filter((f) => f && f !== journalFile);
if (unmerged.length > 0) fail(`Còn xung đột chưa giải (trừ _journal.json, db:regen tự lấy bản của ${baseRef}):\n  ${unmerged.join('\n  ')}`);

const base = migrationsAtRef(baseRef, MIGRATIONS_DIR);
const plan = planRegen(MIGRATIONS_DIR, base.files);
if (plan.migrations.length === 0) {
  console.log(`Nhánh không có migration nào ngoài ${baseRef}.`);
  process.exit(0);
}

console.log(`Migration của nhánh (so với ${baseRef}):`);
for (const m of plan.migrations) console.log(`  ${m.tag}  ${m.kind === 'custom' ? 'viết tay' : 'sinh từ schema'}`);
console.log('Sẽ sinh lại theo thứ tự:');
for (const s of plan.steps) {
  console.log(s.kind === 'custom' ? `  --custom ${s.from.slug}  (chép nguyên ${s.from.tag}.sql)` : `  generate ${s.name}  (thay ${s.from.map((m) => m.tag).join(', ')})`);
}
if (dryRun) {
  for (const w of plan.warnings) console.warn(`Cảnh báo: ${w}`);
  process.exit(0);
}

const result = applyRegen(MIGRATIONS_DIR, plan, {
  baseJournal: base.readText('meta/_journal.json'),
  generate: (kind, name) => {
    const { status } = drizzleGenerate(kind === 'custom' ? ['--custom', '--name', name] : ['--name', name], { interactive: true });
    if (status !== 0) fail(`drizzle-kit generate lỗi (mã ${status}). db/migrations đang dở: git checkout -- db/migrations để quay lại.`);
  },
  waitNextSecond: () => {
    const second = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === second) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  },
});

console.log('\nĐã sinh lại:');
for (const r of result.renamed) console.log(`  ${r.from.join(', ')}  →  ${r.to}`);
for (const w of result.warnings) console.warn(`Cảnh báo: ${w}`);
if (result.errors.length > 0) {
  console.error('Bộ migration sau khi sinh lại vẫn lỗi:');
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\nTiếp theo: xem lại file mới, chạy npm run db:ci-check -- --base ' + baseRef + ', rồi git add db/migrations và commit.');
if (result.warnings.length > 0) process.exitCode = 1;
