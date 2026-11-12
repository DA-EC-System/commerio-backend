// Thư mục migration giả cho test của scripts/db: journal, file .sql, snapshot giống cấu trúc drizzle-kit sinh ra.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_SNAPSHOT_ID, snapshotName } from '../../../../../scripts/db/lib/journal.ts';

export interface FakeMigration {
  tag: string;
  when: number;
  sql?: string;
  /** Nội dung snapshot (schema sau migration). Bỏ trống thì giữ như migration liền trước (migration viết tay). */
  tables?: Record<string, unknown>;
}

const dirs: string[] = [];

export function cleanupFakeDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function snapshotId(tag: string): string {
  return `id-${tag}`;
}

/** Tạo thư mục migration hợp lệ: idx liền, snapshot nối nhau theo thứ tự mảng. */
export function fakeMigrations(list: FakeMigration[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'commerio-fake-mig-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'meta'));
  let prevId = ROOT_SNAPSHOT_ID;
  let tables: Record<string, unknown> = {};
  for (const m of list) {
    tables = m.tables ?? tables;
    writeFileSync(join(dir, `${m.tag}.sql`), m.sql ?? `-- ${m.tag}\n`);
    writeSnapshot(dir, m.tag, { id: snapshotId(m.tag), prevId, tables });
    prevId = snapshotId(m.tag);
  }
  writeJournal(dir, list);
  return dir;
}

export function journalText(list: { tag: string; when: number }[]): string {
  return JSON.stringify(
    {
      version: '7',
      dialect: 'postgresql',
      entries: list.map((m, idx) => ({ idx, version: '7', when: m.when, tag: m.tag, breakpoints: true })),
    },
    null,
    2,
  );
}

export function writeJournal(dir: string, list: { tag: string; when: number }[]): void {
  writeFileSync(join(dir, 'meta', '_journal.json'), journalText(list));
}

export function writeSnapshot(dir: string, tag: string, snapshot: Record<string, unknown>): void {
  writeFileSync(join(dir, 'meta', snapshotName(tag)), JSON.stringify({ version: '7', dialect: 'postgresql', ...snapshot }, null, 2));
}
