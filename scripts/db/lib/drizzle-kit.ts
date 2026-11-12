// Gọi drizzle-kit và git cho db:ci-check, db:regen.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseJournal, type Journal } from './journal.ts';

const DRIZZLE_KIT = join('node_modules', 'drizzle-kit', 'bin.cjs');
const SCHEMA_GLOB = './src/modules/*/*/repository/schema.ts';

export interface GenerateResult {
  status: number | null;
  output: string;
}

/**
 * `drizzle-kit generate` theo drizzle.config.ts. `interactive` để drizzle-kit hỏi được (đổi tên cột/bảng) khi người chạy
 * ngồi trước máy; không thì stdin đóng và có hạn giờ, để CI không treo.
 */
export function drizzleGenerate(args: string[], opts: { interactive: boolean; cwd?: string }): GenerateResult {
  const result = spawnSync(process.execPath, [DRIZZLE_KIT, 'generate', ...args], {
    cwd: opts.cwd,
    stdio: opts.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: opts.interactive ? undefined : 180_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export interface DriftResult {
  /** File drizzle-kit sinh thêm: có nghĩa là schema.ts và migration lệch nhau. */
  newFiles: { name: string; content: string }[];
  failed: boolean;
  output: string;
}

/**
 * Chạy `drizzle-kit generate` trên bản sao của `dir` trong thư mục tạm, không ghi gì vào repo. drizzle-kit trên Windows
 * ghép sai `--out` tuyệt đối với thư mục hiện tại, nên truyền đường dẫn tương đối.
 */
export function schemaDrift(dir: string): DriftResult {
  const tmp = mkdtempSync(join(tmpdir(), 'commerio-drift-'));
  try {
    const copy = join(tmp, 'migrations');
    cpSync(dir, copy, { recursive: true });
    const before = new Set(readdirSync(copy).concat(readdirSync(join(copy, 'meta')).map((f) => `meta/${f}`)));
    const journalBefore = readFileSync(join(copy, 'meta', '_journal.json'), 'utf8');
    const result = drizzleGenerate(
      ['--dialect', 'postgresql', '--schema', SCHEMA_GLOB, '--out', relative(process.cwd(), copy), '--prefix', 'timestamp', '--breakpoints'],
      { interactive: false },
    );
    const after = readdirSync(copy).concat(readdirSync(join(copy, 'meta')).map((f) => `meta/${f}`));
    const newFiles = after
      .filter((f) => !before.has(f))
      .map((name) => ({ name, content: name.endsWith('.sql') ? readFileSync(join(copy, name), 'utf8') : '' }));
    const journalChanged = readFileSync(join(copy, 'meta', '_journal.json'), 'utf8') !== journalBefore;
    return {
      newFiles: journalChanged && newFiles.length === 0 ? [{ name: 'meta/_journal.json', content: '' }] : newFiles,
      failed: result.status !== 0,
      output: result.output,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function gitOk(args: string[]): boolean {
  return spawnSync('git', args, { stdio: 'ignore' }).status === 0;
}

/** Bộ migration trên một ref git (vd `origin/main`), đọc bằng `git show`, không đụng thư mục làm việc. */
export function migrationsAtRef(ref: string, dir: string) {
  const path = (p: string) => `${ref}:${dir}/${p}`;
  const journal: Journal = parseJournal(git(['show', path('meta/_journal.json')]), `${ref}:${dir}/meta/_journal.json`);
  const files = git(['ls-tree', '-r', '--name-only', ref, '--', `${dir}/`])
    .split('\n')
    .filter(Boolean)
    .map((f) => f.slice(dir.length + 1));
  return {
    ref,
    journal,
    files: new Set(files),
    readSql: (tag: string) => git(['show', path(`${tag}.sql`)]),
    readText: (p: string) => git(['show', path(p)]),
  };
}
