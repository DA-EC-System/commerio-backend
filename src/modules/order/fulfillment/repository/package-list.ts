// Danh sách kiện theo tab cho kho (Documents/21 §19.2, spec 199a §5.5). Lọc, đếm, phân trang bằng SQL. Lọc theo đơn
// (đơn `processing`, mã đơn, nguồn) dùng SQL thô `"order".orders`: cùng schema `order` nhưng fulfillment không import
// bảng của sales (luật `module-con-chi-qua-index`).
import { and, asc, count, eq, ilike, inArray, or, type SQL, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { PACKAGE_TABS, type PackageStatus, type PackageTab } from '../domain/package.ts';
import { attachViewLines, type PackageViewRow } from './packages.ts';
import { packages } from './schema.ts';

export interface PackageFilter {
  search?: string | undefined;
  source?: 'marketplace' | 'inbox' | 'manual' | undefined;
  shopId?: string | undefined;
}

const STATUSES_OF: Record<Exclude<PackageTab, 'needs_open'>, readonly PackageStatus[]> = {
  backordered: ['backordered'],
  reserved: ['reserved'],
  packed: ['packed'],
  awaiting_pickup: ['awaiting_pickup'],
  shipping: ['in_transit', 'self_delivering'],
  delivery_failed: ['delivery_failed'],
  returning: ['returning'],
};

const orderWhere = (condition: SQL) => sql`exists (select 1 from "order".orders o where o.id = ${packages.orderId} and ${condition})`;

/** `%`, `_`, `\` trong từ khoá khớp đúng chữ. */
const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function packageTabCondition(tab: PackageTab): SQL {
  if (tab === 'needs_open') return eq(packages.needsOpen, true);
  const status = inArray(packages.status, [...STATUSES_OF[tab]]);
  // Kiện đã giữ hàng của đơn chưa trả thì chưa đóng gói được: tab "Đã giữ hàng" chỉ gồm đơn đang xử lý.
  return tab === 'reserved' ? and(status, orderWhere(sql`o.status = 'processing'`))! : status;
}

function filterCondition(f: PackageFilter): SQL | undefined {
  const pattern = f.search ? containsPattern(f.search) : undefined;
  return and(
    pattern
      ? or(ilike(packages.code, pattern), ilike(packages.trackingCode, pattern), orderWhere(sql`o.code ilike ${pattern}`))
      : undefined,
    f.source ? orderWhere(sql`o.source = ${f.source}`) : undefined,
    f.shopId ? eq(packages.shopId, f.shopId) : undefined,
  );
}

/** Một trang kiện của tab, `ship_by` sớm trước (null cuối), rồi mã kiện; kèm dòng và tổng số. */
export async function findPackagePage(
  f: PackageFilter & { tab: PackageTab; limit: number; offset: number },
): Promise<{ rows: PackageViewRow[]; total: number }> {
  const where = and(packageTabCondition(f.tab), filterCondition(f));
  const db = getDb();
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(packages)
      .where(where)
      // Drizzle 0.45 chỉ có `.nullsLast()` ở khai báo index: viết thẳng SQL.
      .orderBy(sql`${packages.shipBy} asc nulls last`, asc(packages.code))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: count() }).from(packages).where(where),
  ]);
  return { rows: await attachViewLines(rows), total: Number(total!.n) };
}

/** Số kiện mỗi tab theo bộ lọc (không theo tab), một câu; chỉ quét kiện ở trạng thái của tab hoặc chờ mở. */
export async function countPackageTabs(f: PackageFilter): Promise<Record<PackageTab, number>> {
  const all = [...new Set(Object.values(STATUSES_OF).flat())];
  const [row] = await getDb()
    .select(
      Object.fromEntries(
        PACKAGE_TABS.map((tab) => [tab, sql<number>`(count(*) filter (where ${packageTabCondition(tab)}))::int`.mapWith(Number)]),
      ) as Record<PackageTab, SQL<number>>,
    )
    .from(packages)
    .where(and(or(inArray(packages.status, all), eq(packages.needsOpen, true)), filterCondition(f)));
  return row as Record<PackageTab, number>;
}

/** Kiện theo id kèm dòng; id không thấy (công ty khác, RLS) vắng mặt. */
export async function findPackagesByIds(ids: readonly string[]): Promise<PackageViewRow[]> {
  if (!ids.length) return [];
  return attachViewLines(await getDb().select().from(packages).where(inArray(packages.id, [...ids])));
}
