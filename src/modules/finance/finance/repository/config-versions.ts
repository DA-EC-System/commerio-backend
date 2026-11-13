import { and, desc, eq, gte, inArray, isNull, lte, not, notInArray, sql } from 'drizzle-orm';
import { currentCompanyId, getDb } from '../../../../shared/db/client.ts';
import type { ConfigKind, ConfigStatus } from '../domain/config-version.ts';
import { type LedgerKind, type NetLine, NOT_SALES_PROFIT } from '../domain/ledger.ts';
import { isReplaced } from './ledger.ts';
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
  await lockCells([[kind, shopId]]);
}

const cellKey = (kind: ConfigKind, shopId: string | null) => `finance.config:${currentCompanyId()}:${kind}:${shopId ?? '-'}`;

/**
 * Khoá riêng nhiều ô tới hết giao dịch, theo thứ tự khoá đã sắp như `lockCellsShared`: áp một bản nhóm thuế khoá cả
 * `tax_regime` và `tax_rules` (thuế khấu trừ tính từ cả hai) mà không tạo vòng chờ.
 */
export async function lockCells(cells: readonly (readonly [ConfigKind, string | null])[]): Promise<void> {
  for (const key of [...new Set(cells.map(([kind, shopId]) => cellKey(kind, shopId)))].sort())
    await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Khoá chia sẻ các ô (cùng khoá với `lockCell`) tới hết giao dịch, theo thứ tự cố định: ghi sổ theo cấu hình đọc song
 * song được, chỉ chờ khi một phiên bản của ô đang chuyển trạng thái.
 */
export async function lockCellsShared(cells: readonly (readonly [ConfigKind, string | null])[]): Promise<void> {
  for (const key of [...new Set(cells.map(([kind, shopId]) => cellKey(kind, shopId)))].sort()) await getDb().execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`);
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
 * Lãi gộp từ `from` (gồm cả ngày đó) cho chạy thử phiên bản cấu hình: chỉ dòng còn hiệu lực, hiểu "đã thay" như
 * tổng tiền ở sàn (`isReplaced`: có dòng thực tế thay, hoặc dòng ước tính của đơn đã có số quyết toán). Bỏ loại không
 * vào lãi gộp (`NOT_SALES_PROFIT`: khoản ngoài sàn, rút tiền, quảng cáo) theo loại dòng, không theo gian hàng. `revenue` là
 * tổng dòng doanh thu.
 */
export async function sumLedgerSince(from: string, shopId?: string): Promise<{ total: string; revenue: string }> {
  const [row] = await getDb()
    .select({
      total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text`,
      revenue: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.kind} = 'revenue'), 0)::text`,
    })
    .from(ledgerEntries)
    .where(
      and(
        gte(ledgerEntries.occurredOn, from),
        notInArray(ledgerEntries.kind, [...NOT_SALES_PROFIT]),
        shopId ? eq(ledgerEntries.shopId, shopId) : undefined,
        not(isReplaced()),
      ),
    );
  return row!;
}

/** Một nguồn dòng sổ (kiện giao, kiện hoàn) trong khoảng hồi tố, kèm số đã ghi theo nhóm cấu hình (25 §10.4). */
export interface RetroSource {
  sourceId: string;
  orderId: string | null;
  shopId: string | null;
  packageId: string | null;
  /** Ngày phát sinh của nguồn (`occurred_on` của các dòng gốc). */
  day: string;
  /** Doanh thu của kiện (dòng `revenue`), cơ sở tính phí, thuế. */
  revenue: string;
  /** Đã ghi: dòng ước tính thuộc `kinds` cộng điều chỉnh hồi tố trước đó của nguồn do phiên bản thuộc `configKinds`. */
  charged: string;
}

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/**
 * Nguồn `type` có dòng gốc ngày `from`..`to` (gồm hai đầu), lọc gian hàng nếu có. Bỏ dòng `adjustment` khỏi dòng gốc
 * (điều chỉnh mang ngày ghi, không phải ngày phát sinh). Trong `withCompany` của bên gọi (RLS).
 */
export async function retroSources(
  type: 'package' | 'package_return',
  range: { from: string; to: string },
  kinds: readonly LedgerKind[],
  configKinds: readonly ConfigKind[],
  shopId?: string,
): Promise<RetroSource[]> {
  const { rows } = await getDb().execute<RetroSource & Record<string, unknown>>(sql`
    select e.source_id as "sourceId", e.order_id as "orderId", e.shop_id as "shopId", e.package_id as "packageId",
      e.occurred_on::text as "day",
      coalesce(sum(e.amount) filter (where e.kind = 'revenue'), 0)::text as "revenue",
      (coalesce(sum(e.amount) filter (where e.kind in (${list(kinds)})), 0) + coalesce((
        select sum(a.amount) from ${ledgerEntries} a join ${configVersions} c on c.id = a.config_version_id
        where a.kind = 'adjustment' and a.source_type = ${type} and a.source_id = e.source_id and c.kind in (${list(configKinds)})
      ), 0))::text as "charged"
    from ${ledgerEntries} e
    where e.source_type = ${type} and e.kind <> 'adjustment' and e.is_estimate
      and e.occurred_on between ${range.from} and ${range.to}
      ${shopId ? sql`and e.shop_id = ${shopId}` : sql``}
    group by e.source_id, e.order_id, e.shop_id, e.package_id, e.occurred_on
    order by e.occurred_on, e.source_id`);
  return rows;
}

/**
 * Dòng doanh thu, hoàn tiền khách còn hiệu lực từ `from` (chạy thử), kèm mọi dòng doanh thu ước tính của các đơn có
 * dòng đó để chia theo ngày giao (`netRevenuePortions`).
 */
export async function netRevenueLinesSince(from: string, shopId?: string): Promise<{ live: NetLine[]; estimates: NetLine[] }> {
  const cols = {
    id: ledgerEntries.id,
    orderId: ledgerEntries.orderId,
    kind: ledgerEntries.kind,
    amount: ledgerEntries.amount,
    occurredOn: ledgerEntries.occurredOn,
    isEstimate: ledgerEntries.isEstimate,
    replacesEntryId: ledgerEntries.replacesEntryId,
  };
  const live = await getDb()
    .select(cols)
    .from(ledgerEntries)
    .where(
      and(
        gte(ledgerEntries.occurredOn, from),
        inArray(ledgerEntries.kind, ['revenue', 'customer_refund']),
        shopId ? eq(ledgerEntries.shopId, shopId) : undefined,
        not(isReplaced()),
      ),
    );
  const orderIds = [...new Set(live.map((l) => l.orderId).filter((id): id is string => !!id))];
  const estimates = orderIds.length
    ? await getDb()
        .select(cols)
        .from(ledgerEntries)
        .where(and(inArray(ledgerEntries.orderId, orderIds), eq(ledgerEntries.isEstimate, true), eq(ledgerEntries.kind, 'revenue')))
    : [];
  return { live, estimates };
}
