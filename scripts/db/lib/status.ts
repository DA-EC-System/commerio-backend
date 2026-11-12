// So migration trong journal với bảng `drizzle.__drizzle_migrations` của một DB. Hàm thuần, không I/O.
//
// Vì sao cần: migrator của drizzle-orm (pg-core/dialect.js, hàm `migrate`) chỉ đọc dòng mới nhất
//   select id, hash, created_at from ... order by created_at desc limit 1
// rồi chỉ chạy migration thoả
//   if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
// với `folderMillis` là `when` trong journal. Migration có `when` nhỏ hơn hoặc bằng migration mới nhất đã chạy bị bỏ qua
// mà không báo gì. Ở đây gọi chúng là "lệch thứ tự".
import { formatWhen, type JournalEntry } from './journal.ts';

/** Một dòng của `drizzle.__drizzle_migrations`. `created_at` là bigint nên pg trả về chuỗi. */
export interface AppliedRow {
  id: number;
  hash: string;
  created_at: string | number | null;
}

export interface LocalMigration extends JournalEntry {
  /** sha256 của file .sql, giống drizzle-orm. */
  hash: string;
}

export interface MigrationStatus {
  applied: LocalMigration[];
  /** Chưa chạy, `when` lớn hơn migration mới nhất trên DB: lần migrate tới sẽ chạy. */
  pending: LocalMigration[];
  /** Chưa chạy nhưng `when` ≤ migration mới nhất trên DB: drizzle sẽ bỏ qua im lặng. */
  outOfOrder: LocalMigration[];
  /** Dòng trên DB không khớp migration nào trong journal (chạy từ nhánh khác, hoặc migration đã sinh lại). */
  unknownRows: AppliedRow[];
  /** Khớp theo `when` nhưng hash khác: file .sql bị sửa sau khi đã chạy. */
  hashChanged: LocalMigration[];
  /** Chưa chạy theo `when` nhưng trùng hash một dòng đã có: có vẻ đã chạy dưới tên khác (vd sau db:regen), drizzle sẽ chạy lại. */
  sameHashOtherWhen: LocalMigration[];
  /** Dòng có `created_at` NULL: drizzle xếp NULL lên đầu khi `order by created_at desc`, coi là 0 và chạy lại mọi migration. */
  nullRows: AppliedRow[];
  /** `created_at` lớn nhất trên DB, null nếu chưa chạy gì. */
  lastAppliedAt: number | null;
}

/**
 * Migration coi là đã chạy khi và chỉ khi có dòng cùng `created_at` với `when` (drizzle ghi đúng `when` vào cột này và
 * cũng chỉ xét cột này, không nhìn hash). Hash chỉ để báo: khớp `when` mà khác hash vào `hashChanged`, khớp hash mà khác
 * `when` vào `sameHashOtherWhen`.
 */
export function compareWithDb(local: LocalMigration[], rows: AppliedRow[]): MigrationStatus {
  const byWhen = new Map<number, AppliedRow>();
  const byHash = new Map<string, AppliedRow>();
  for (const row of rows) {
    if (row.created_at !== null) byWhen.set(Number(row.created_at), row);
    byHash.set(row.hash, row);
  }
  const nullRows = rows.filter((row) => row.created_at === null);
  const lastAppliedAt = rows.reduce<number | null>((max, row) => {
    if (row.created_at === null) return max;
    const at = Number(row.created_at);
    return max === null || at > max ? at : max;
  }, null);

  const matched = new Set<AppliedRow>();
  const status: MigrationStatus = { applied: [], pending: [], outOfOrder: [], unknownRows: [], hashChanged: [], sameHashOtherWhen: [], nullRows, lastAppliedAt };
  for (const migration of local) {
    const row = byWhen.get(migration.when);
    if (!row && byHash.has(migration.hash)) status.sameHashOtherWhen.push(migration);
    if (row) {
      matched.add(row);
      status.applied.push(migration);
      if (row.hash !== migration.hash) status.hashChanged.push(migration);
    } else if (lastAppliedAt !== null && migration.when <= lastAppliedAt) {
      status.outOfOrder.push(migration);
    } else {
      status.pending.push(migration);
    }
  }
  status.unknownRows = rows.filter((row) => !matched.has(row));
  return status;
}

/** Báo cáo dạng chữ cho người đọc; `full` liệt kê cả migration đã chạy. */
export function formatStatus(status: MigrationStatus, full: boolean): string {
  const lines: string[] = [];
  const item = (m: LocalMigration): string => `  ${m.tag}  (when ${m.when}, ${formatWhen(m.when)})`;
  const last = status.lastAppliedAt === null ? 'chưa có' : `${status.lastAppliedAt} (${formatWhen(status.lastAppliedAt)})`;
  lines.push(`Migration mới nhất đã chạy trên DB: ${last}`);
  lines.push(`Đã chạy: ${status.applied.length}`);
  if (full) lines.push(...status.applied.map(item));
  lines.push(`Chưa chạy: ${status.pending.length}`);
  lines.push(...status.pending.map(item));
  lines.push(`Lệch thứ tự (drizzle sẽ bỏ qua im lặng): ${status.outOfOrder.length}`);
  lines.push(...status.outOfOrder.map(item));
  if (status.hashChanged.length > 0) {
    lines.push(`Cảnh báo: file .sql khác bản đã chạy (sửa sau khi chạy?): ${status.hashChanged.length}`);
    lines.push(...status.hashChanged.map(item));
  }
  if (status.sameHashOtherWhen.length > 0) {
    lines.push(`Cảnh báo: trùng nội dung một migration đã chạy dưới tên khác (sau db:regen?), drizzle sẽ chạy lại: ${status.sameHashOtherWhen.length}`);
    lines.push(...status.sameHashOtherWhen.map(item));
    lines.push('  DB local thì xoá DB rồi db:migrate lại; DB dùng chung thì xem db/CLAUDE.md.');
  }
  if (status.nullRows.length > 0) {
    lines.push(`LỖI: dòng thiếu created_at (drizzle sẽ chạy lại mọi migration): ${status.nullRows.map((r) => `id ${r.id}`).join(', ')}`);
  }
  if (status.unknownRows.length > 0) {
    lines.push(`Cảnh báo: dòng trên DB không khớp migration nào trong journal: ${status.unknownRows.length}`);
    lines.push(
      ...status.unknownRows.map((r) => {
        const at = r.created_at === null ? 'null' : `${r.created_at} (${formatWhen(Number(r.created_at))})`;
        return `  id ${r.id}, created_at ${at}, hash ${r.hash.slice(0, 12)}…`;
      }),
    );
  }
  return lines.join('\n');
}

/** Lý do phải dừng (lệch thứ tự, dòng thiếu created_at), null nếu chạy được. */
export function blockingMessage(status: MigrationStatus): string | null {
  const parts: string[] = [];
  if (status.nullRows.length > 0) {
    parts.push(
      [
        ...status.nullRows.map((r) => `DỪNG: dòng id ${r.id} thiếu created_at trong drizzle.__drizzle_migrations.`),
        'drizzle xếp dòng NULL là mới nhất (order by created_at desc), coi là 0 và sẽ chạy lại mọi migration.',
        'Không có gì được chạy. Cách sửa: update dòng đó đặt created_at = when của migration tương ứng (db/CLAUDE.md).',
      ].join('\n'),
    );
  }
  if (status.outOfOrder.length > 0) parts.push(outOfOrderMessage(status));
  return parts.length > 0 ? parts.join('\n\n') : null;
}

export function outOfOrderMessage(status: MigrationStatus): string {
  return [
    `DỪNG: ${status.outOfOrder.length} migration chưa chạy nhưng sinh trước migration mới nhất đã chạy trên DB.`,
    'drizzle sẽ bỏ qua các file này mà không báo lỗi:',
    ...status.outOfOrder.map((m) => `  db/migrations/${m.tag}.sql`),
    'Không có gì được chạy. Cách sửa:',
    '  - Migration chưa merge vào main (chạy từ máy trên nhánh): gộp main vào nhánh rồi `npm run db:regen`.',
    '  - Migration đã ở main mà DB này bỏ sót: chạy tay nội dung file trên DB rồi ghi dòng vào',
    '    drizzle.__drizzle_migrations (hash, created_at = when ở trên), xem db/CLAUDE.md mục "Migration bị bỏ sót".',
  ].join('\n');
}
