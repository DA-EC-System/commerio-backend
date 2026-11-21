// npm run db:erd                 dựng ERD tương tác từ migration và schema.ts hiện tại, ghi .erd/commerio-erd.html, mở trình duyệt
// npm run db:erd -- --no-open    chỉ ghi file
// Cùng nguồn với db/SCHEMA.md (db/CLAUDE.md mục "Tài liệu schema và phiên bản"). Có migration mới: git pull rồi chạy lại.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildErdData, layoutErd, renderErdPage } from './lib/erd.ts';
import { MIGRATIONS_DIR } from './lib/journal.ts';
import { buildSchemaModel } from './lib/schema-doc.ts';

const OUT_DIR = '.erd';
const OUT_FILE = `${OUT_DIR}/commerio-erd.html`;

function commit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'db/migrations', 'src/modules'], { encoding: 'utf8' }).trim();
    return dirty ? `${sha} (có thay đổi chưa commit)` : sha;
  } catch {
    return 'không rõ';
  }
}

function open(file: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore' })
    .on('error', () => console.log(`Không mở được trình duyệt, mở tay file: ${file}`))
    .unref();
}

const model = buildSchemaModel(MIGRATIONS_DIR, '.');
if (model.problems.length) console.warn(`Cảnh báo (db:docs cũng sẽ báo):\n  - ${model.problems.join('\n  - ')}\n`);
const data = buildErdData(model, commit());
const layout = await layoutErd(data);
const template = readFileSync(new URL('./erd/page.html', import.meta.url), 'utf8');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, renderErdPage(template, data, layout));
const full = resolve(OUT_FILE);
console.log(`ERD ${data.source.version} (${data.tables.length} bảng): ${full}`);
if (!process.argv.includes('--no-open')) open(full);
