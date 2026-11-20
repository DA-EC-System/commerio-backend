// Đọc bộ migration Drizzle (`db/migrations`): journal, file SQL, snapshot. Dùng chung cho db:migrate, db:migrate:check,
// db:ci-check, db:regen. Không phụ thuộc DB hay git.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATIONS_DIR = 'db/migrations';
/** `prevId` của snapshot đầu tiên (drizzle-kit). */
export const ROOT_SNAPSHOT_ID = '00000000-0000-0000-0000-000000000000';

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface Snapshot {
  id: string;
  prevId: string;
  [key: string]: unknown;
}

export function journalPath(dir: string): string {
  return join(dir, 'meta', '_journal.json');
}

export function parseJournal(text: string, source = '_journal.json'): Journal {
  let journal: Journal;
  try {
    journal = JSON.parse(text) as Journal;
  } catch {
    throw new Error(`${source} không phải JSON hợp lệ (còn dấu xung đột git?)`);
  }
  if (!Array.isArray(journal.entries)) throw new Error(`${source} thiếu mảng entries`);
  return journal;
}

export function readJournal(dir: string): Journal {
  return parseJournal(readFileSync(journalPath(dir), 'utf8'), journalPath(dir));
}

/** Tên snapshot đi với migration: phần trước dấu `_` đầu tiên của tag (`0003`, `20261111052845`). */
export function snapshotName(tag: string): string {
  return `${tag.slice(0, tag.indexOf('_'))}_snapshot.json`;
}

/** Phần mô tả của tag: `20261111052845_nhan-tu-duyet` → `nhan-tu-duyet`. */
export function slugOf(tag: string): string {
  return tag.slice(tag.indexOf('_') + 1);
}

/** Băm giống drizzle-orm (`readMigrationFiles`): sha256 của nguyên nội dung file .sql. */
export function hashSql(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function listSqlFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

export function listSnapshotFiles(dir: string): string[] {
  const meta = join(dir, 'meta');
  return existsSync(meta) ? readdirSync(meta).filter((f) => f.endsWith('_snapshot.json')).sort() : [];
}

export function readSnapshot(dir: string, file: string): Snapshot {
  return JSON.parse(readFileSync(join(dir, 'meta', file), 'utf8')) as Snapshot;
}

/** Nội dung snapshot bỏ `id`, `prevId`, khoá sắp theo thứ tự: hai snapshot cùng schema thì cùng chuỗi. */
export function snapshotBody(snapshot: Snapshot): string {
  const body: Record<string, unknown> = { ...snapshot };
  delete body.id;
  delete body.prevId;
  return canonicalJson(body);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Phiên bản của migration: vị trí trong journal tính từ 1 (`idx` + 1), viết `V105`. Journal của `main` chỉ thêm vào cuối
 * (db:ci-check kiểm) nên số không đổi sau khi merge; migration trên nhánh mang số tạm, `db:regen` có thể đẩy lên.
 */
export function versionLabel(entry: Pick<JournalEntry, 'idx'>): string {
  return `V${entry.idx + 1}`;
}

export type MigrationKind = 'generated' | 'custom';

/**
 * Loại của từng migration trong journal: `custom` (viết tay bằng `--custom`: RLS, quyền, trigger, dữ liệu) khi snapshot
 * giống hệt snapshot cha, còn lại `generated` (drizzle-kit sinh từ schema.ts). Thiếu snapshot thì coi là `generated`.
 */
export function migrationKinds(dir: string): Map<string, MigrationKind> {
  const entries = readJournal(dir).entries;
  const snapshots = new Map<string, Snapshot>();
  const bodies = new Map<string, string>();
  for (const entry of entries) {
    const file = snapshotName(entry.tag);
    if (!existsSync(join(dir, 'meta', file))) continue;
    const snapshot = readSnapshot(dir, file);
    snapshots.set(entry.tag, snapshot);
    bodies.set(snapshot.id, snapshotBody(snapshot));
  }
  const kinds = new Map<string, MigrationKind>();
  for (const entry of entries) {
    const snapshot = snapshots.get(entry.tag);
    // Migration đầu tiên: cha là snapshot rỗng (chưa có bảng, enum…), vd `0000_mo-rong` chỉ tạo extension là viết tay.
    const parent = snapshot && snapshot.prevId === ROOT_SNAPSHOT_ID ? emptySnapshotBody(snapshot) : snapshot ? bodies.get(snapshot.prevId) : undefined;
    kinds.set(entry.tag, snapshot && parent !== undefined && parent === bodies.get(snapshot.id) ? 'custom' : 'generated');
  }
  return kinds;
}

/** Thân snapshot cùng khuôn với `snapshot` nhưng chưa có đối tượng nào. */
function emptySnapshotBody(snapshot: Snapshot): string {
  const empty: Snapshot = { ...snapshot };
  for (const key of ['tables', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views']) {
    if (key in empty) empty[key] = {};
  }
  return snapshotBody(empty);
}

/** Giờ UTC dễ đọc của `when` (ms). */
export function formatWhen(when: number): string {
  return new Date(when).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
