import { and, desc, eq, gte, inArray, isNull, lte, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { currentCompanyId, getDb } from '../../../../shared/db/client.ts';
import type { ConfigKind, ConfigStatus } from '../domain/config-version.ts';
import { configVersions, ledgerEntries } from './schema.ts';

export type ConfigRow = typeof configVersions.$inferSelect;

export async function insertConfig(values: typeof configVersions.$inferInsert): Promise<ConfigRow> {
  const [row] = await getDb().insert(configVersions).values(values).returning();
  return row!;
}

/** Một phiên bản; `lock` khoá dòng tới hết giao dịch. */
export async function findConfig(id: string, lock?: 'update'): Promise<ConfigRow | undefined> {
  const query = getDb().select().from(configVersions).where(eq(configVersions.id, id));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

export interface ConfigFilter {
  kind?: ConfigKind;
  shopId?: string;
  status?: ConfigStatus;
}

export function findConfigs(f: ConfigFilter): Promise<ConfigRow[]> {
  return getDb()
    .select()
    .from(configVersions)
    .where(
      and(
        f.kind ? eq(configVersions.kind, f.kind) : undefined,
        f.shopId ? eq(configVersions.shopId, f.shopId) : undefined,
        f.status ? eq(configVersions.status, f.status) : undefined,
      ),
    )
    .orderBy(desc(configVersions.createdAt), desc(configVersions.id));
}

const cellOf = (kind: ConfigKind, shopId: string | null) =>
  and(eq(configVersions.kind, kind), shopId ? eq(configVersions.shopId, shopId) : isNull(configVersions.shopId));

/**
 * Khoá một ô (công ty, loại, gian hàng) tới hết giao dịch: duyệt, áp dụng, huỷ cùng ô chạy lần lượt nên tính lại
 * khoảng ngày không giẫm lên nhau.
 */
export async function lockCell(kind: ConfigKind, shopId: string | null): Promise<void> {
  const key = `finance.config:${currentCompanyId()}:${kind}:${shopId ?? '-'}`;
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Mọi phiên bản của một ô có trạng thái trong `statuses`. */
export function findCell(kind: ConfigKind, shopId: string | null, statuses: readonly ConfigStatus[]): Promise<ConfigRow[]> {
  return getDb()
    .select()
    .from(configVersions)
    .where(and(cellOf(kind, shopId), inArray(configVersions.status, [...statuses])));
}

/**
 * Sửa phiên bản khi trạng thái và `version` còn đúng như lúc đọc; tăng `version`. Trả `undefined` khi đã có người sửa
 * trước (bên gọi trả 409 `version_conflict`).
 */
export async function updateConfig(
  id: string,
  expect: { status: ConfigStatus; version: number },
  values: Partial<
    Pick<
      ConfigRow,
      'status' | 'payload' | 'effectiveFrom' | 'effectiveTo' | 'dryRunResult' | 'statusReason' | 'approvedBy' | 'approvedAt' | 'selfApproved'
    >
  >,
): Promise<ConfigRow | undefined> {
  const [row] = await getDb()
    .update(configVersions)
    .set({ ...values, version: sql`${configVersions.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(configVersions.id, id), eq(configVersions.status, expect.status), eq(configVersions.version, expect.version)))
    .returning();
  return row;
}

/** Đặt ngày kết thúc của bản đang `scheduled`/`active` khi bản khác chen vào sau nó (không đổi trạng thái). */
export async function setEffectiveTo(id: string, effectiveTo: string | null): Promise<void> {
  await getDb()
    .update(configVersions)
    .set({ effectiveTo, version: sql`${configVersions.version} + 1`, updatedAt: sql`now()` })
    .where(eq(configVersions.id, id));
}

/** Bản đã duyệt tới ngày hiệu lực, mọi công ty (việc nền, gọi ngoài `withCompany`). */
export async function findDueScheduledAnyCompany(today: string, limit: number) {
  if (currentCompanyId()) throw new Error('findDueScheduledAnyCompany gọi ngoài withCompany (đọc mọi công ty)');
  return getDb()
    .select({ id: configVersions.id, companyId: configVersions.companyId })
    .from(configVersions)
    .where(and(eq(configVersions.status, 'scheduled'), lte(configVersions.effectiveFrom, today)))
    .orderBy(configVersions.effectiveFrom)
    .limit(limit);
}

/**
 * Tổng sổ tiền từ `from` (gồm cả ngày đó), chỉ dòng còn hiệu lực (dòng ước tính đã có dòng thực tế thay thì bỏ).
 * `revenue` là tổng dòng doanh thu. Dùng cho chạy thử phiên bản cấu hình. #117 thêm loại `withdrawal` (rút về ngân
 * hàng, không vào lãi) thì loại ra ở đây.
 */
export async function sumLedgerSince(from: string, shopId?: string): Promise<{ total: string; revenue: string }> {
  const replacing = alias(ledgerEntries, 'replacing');
  const [row] = await getDb()
    .select({
      total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text`,
      revenue: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.kind} = 'revenue'), 0)::text`,
    })
    .from(ledgerEntries)
    .where(
      and(
        gte(ledgerEntries.occurredOn, from),
        shopId ? eq(ledgerEntries.shopId, shopId) : undefined,
        notExists(getDb().select({ one: sql`1` }).from(replacing).where(eq(replacing.replacesEntryId, ledgerEntries.id))),
      ),
    );
  return row!;
}
