// Chạy migration có chặn lệch thứ tự (thay `drizzle-kit migrate`), và kiểm chỉ đọc. Xem status.ts vì sao cần.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { hashSql, readJournal } from './journal.ts';
import { blockingMessage, compareWithDb, formatStatus, type AppliedRow, type LocalMigration, type MigrationStatus } from './status.ts';

export interface GuardOptions {
  migrationsFolder: string;
  /** Mặc định giống drizzle: `drizzle.__drizzle_migrations`. Test đổi để không đụng bảng thật. */
  migrationsSchema?: string;
  migrationsTable?: string;
  log?: (line: string) => void;
}

/** Khoá advisory phiên cho cả lần migrate: hai lần deploy chạy cùng lúc thì lần sau chờ. */
const MIGRATE_LOCK_KEY = 'commerio:db-migrate';

export class MigrationOrderError extends Error {
  readonly status: MigrationStatus;
  constructor(status: MigrationStatus) {
    super(blockingMessage(status) ?? 'Không có migration lệch thứ tự.');
    this.name = 'MigrationOrderError';
    this.status = status;
  }
}

function target(opts: GuardOptions): { schema: string; table: string } {
  return { schema: opts.migrationsSchema ?? 'drizzle', table: opts.migrationsTable ?? '__drizzle_migrations' };
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export function readLocalMigrations(folder: string): LocalMigration[] {
  return readJournal(folder).entries.map((entry) => ({
    ...entry,
    hash: hashSql(readFileSync(join(folder, `${entry.tag}.sql`)).toString()),
  }));
}

/** Đọc bảng migration của DB. Không tạo gì: bảng chưa có thì coi như chưa chạy migration nào. */
export async function readAppliedRows(client: pg.ClientBase, opts: GuardOptions): Promise<AppliedRow[]> {
  const { schema, table } = target(opts);
  const qualified = `${quote(schema)}.${quote(table)}`;
  const { rows } = await client.query<{ exists: boolean }>('select to_regclass($1) is not null as exists', [qualified]);
  if (!rows[0]?.exists) return [];
  const result = await client.query<AppliedRow>(`select id, hash, created_at from ${qualified} order by id`);
  return result.rows;
}

/** `db:migrate:check`: chỉ đọc, trong giao dịch READ ONLY. */
export async function inspect(client: pg.ClientBase, opts: GuardOptions): Promise<MigrationStatus> {
  const local = readLocalMigrations(opts.migrationsFolder);
  await client.query('begin transaction read only');
  try {
    return compareWithDb(local, await readAppliedRows(client, opts));
  } finally {
    await client.query('rollback');
  }
}

export { formatStatus };

/**
 * `db:migrate`: dừng (ném MigrationOrderError, không chạy gì) nếu có migration lệch thứ tự; không thì chạy migrator của
 * drizzle-orm như `drizzle-kit migrate` (mọi migration đang chờ trong một giao dịch), rồi kiểm lại không còn gì sót.
 */
export async function migrateGuarded(client: pg.Client, opts: GuardOptions): Promise<MigrationStatus> {
  const log = opts.log ?? ((line: string) => console.log(line));
  await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [MIGRATE_LOCK_KEY]);
  try {
    const before = await inspect(client, opts);
    log(formatStatus(before, false));
    if (blockingMessage(before) !== null) throw new MigrationOrderError(before);
    if (before.pending.length === 0) {
      log('Không có migration mới.');
      return before;
    }
    const { schema, table } = target(opts);
    await migrate(drizzle({ client }), { migrationsFolder: opts.migrationsFolder, migrationsSchema: schema, migrationsTable: table });
    const after = await inspect(client, opts);
    if (blockingMessage(after) !== null) throw new MigrationOrderError(after);
    const missed = after.pending;
    if (missed.length > 0) {
      throw new Error(`Sau khi migrate vẫn còn migration chưa chạy: ${missed.map((m) => m.tag).join(', ')}`);
    }
    log(`Đã chạy ${before.pending.length} migration: ${before.pending.map((m) => m.tag).join(', ')}`);
    return after;
  } finally {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATE_LOCK_KEY]);
  }
}
