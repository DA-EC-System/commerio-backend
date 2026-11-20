// Ghi và kiểm tài liệu CSDL sinh tự động: db/SCHEMA.md, db/schema/<schema>.md, db/VERSIONS.md. Dùng chung cho
// db:docs, db:generate, db:regen, db:ci-check và test/unit/db/docs.test.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MIGRATIONS_DIR } from './journal.ts';
import { buildSchemaModel, renderIndex, renderSchemaFile } from './schema-doc.ts';
import { renderVersions } from './versions.ts';

export const SCHEMA_INDEX = 'db/SCHEMA.md';
export const SCHEMA_DIR = 'db/schema';
export const VERSIONS_FILE = 'db/VERSIONS.md';

export interface RenderedDocs {
  /** Đường dẫn tương đối (dấu `/`) → nội dung. */
  files: Map<string, string>;
  problems: string[];
}

export function renderDocs(root: string): RenderedDocs {
  const dir = join(root, MIGRATIONS_DIR);
  const model = buildSchemaModel(dir, root);
  const files = new Map<string, string>();
  files.set(SCHEMA_INDEX, renderIndex(model));
  for (const schema of model.schemas) files.set(`${SCHEMA_DIR}/${schema}.md`, renderSchemaFile(model, schema));
  files.set(VERSIONS_FILE, renderVersions(dir));
  return { files, problems: model.problems };
}

/** File .md trong db/schema/ không còn schema tương ứng. */
function strayFiles(root: string, files: Map<string, string>): string[] {
  const dir = join(root, SCHEMA_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => `${SCHEMA_DIR}/${f}`)
    .filter((p) => !files.has(p));
}

export interface DocsCheck {
  /** File thiếu, khác nội dung sinh ra, hoặc thừa. */
  stale: string[];
  problems: string[];
}

export function checkDocs(root: string): DocsCheck {
  const { files, problems } = renderDocs(root);
  const stale: string[] = [];
  for (const [path, content] of files) {
    const full = join(root, path);
    if (!existsSync(full) || readFileSync(full, 'utf8') !== content) stale.push(path);
  }
  stale.push(...strayFiles(root, files));
  return { stale, problems };
}

export function writeDocs(root: string): { changed: string[]; problems: string[] } {
  const { files, problems } = renderDocs(root);
  const changed: string[] = [];
  for (const [path, content] of files) {
    const full = join(root, path);
    if (existsSync(full) && readFileSync(full, 'utf8') === content) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    changed.push(path);
  }
  for (const path of strayFiles(root, files)) {
    rmSync(join(root, path));
    changed.push(path);
  }
  return { changed, problems };
}

/** Câu báo lỗi cho người chạy, dùng chung giữa các lệnh. */
export function docsProblemsText(problems: string[]): string {
  return problems.map((p) => `  - ${p}`).join('\n');
}
