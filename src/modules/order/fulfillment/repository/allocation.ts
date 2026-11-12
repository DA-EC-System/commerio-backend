// Truy vấn của lượt phân hàng (spec 199b §5.3). Trạng thái, ngày lập của đơn đọc bằng SQL thô `"order".orders`: cùng
// schema `order` nhưng fulfillment không import sales. Khoá kiện theo `code` tăng dần (cùng `lockDeferredPackages`).
import { and, asc, eq, inArray, notInArray, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { AllocationCandidate, ReclaimCandidate, SealedHolder } from '../domain/allocation.ts';
import { planLinesOf } from './packages.ts';
import { packageLines, packages } from './schema.ts';

/** Hai lượt phân hàng của cùng công ty chạy nối nhau, tới hết giao dịch. */
export async function takeAllocationLock(companyId: string): Promise<void> {
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`fulfillment.allocation:${companyId}`}, 0))`);
}

const orderStatus = sql<string>`(select o.status::text from "order".orders o where o.id = ${packages.orderId})`;
const orderCreatedAt = sql<Date>`(select o.created_at from "order".orders o where o.id = ${packages.orderId})`.mapWith(
  (v: string | Date) => new Date(v),
);
const hasVariant = (variantIds: readonly string[]) =>
  sql`exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id} and ${inArray(packageLines.variantId, [...variantIds])})`;

/** Ứng viên giữ hàng (spec 199b §5.2), trừ lọc gian hàng chờ kiểm kê (service lọc). */
const candidateWhere = and(
  sql`(${packages.status} = 'backordered' or (${packages.status} in ('packed', 'awaiting_pickup')
       and not exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id} and ${packageLines.reservedQty} > 0)))`,
  sql`not exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id} and ${packageLines.variantId} is null)`,
  eq(packages.needsOpen, false),
  sql`${orderStatus} <> 'cancelled'`,
);

/**
 * SKU còn liên quan tới phân hàng (lượt `{ all: true }`): của kiện đang giữ (`reserved`, và kiện đã đóng để lượt do phiếu
 * kiểm kê thấy SKU chỉ còn kiện đóng giữ) và của ứng viên giữ hàng.
 */
export async function variantsInPlay(): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ variantId: packageLines.variantId })
    .from(packageLines)
    .innerJoin(packages, eq(packages.id, packageLines.packageId))
    .where(
      and(
        sql`${packageLines.variantId} is not null`,
        sql`(${packages.status} in ('reserved', 'packed', 'awaiting_pickup') or (${candidateWhere}))`,
      ),
    );
  return rows.map((r) => r.variantId!).sort();
}

const linesOf = (lines: { variantId: string | null; quantity: number }[]) => lines.map((l) => ({ variantId: l.variantId!, quantity: l.quantity }));
/** Phần đang giữ thật của kiện: chỉ dòng có `reserved_qty`, đúng số đó (không nhả phần giữ của kiện khác). */
const heldOf = (lines: { variantId: string | null; reservedQty: number }[]) =>
  lines.filter((l) => l.variantId && l.reservedQty > 0).map((l) => ({ variantId: l.variantId!, quantity: l.reservedQty }));

export type LockedReclaimCandidate = ReclaimCandidate & { orderId: string };

/** Kiện `reserved` của đơn `unpaid`/`processing` có dòng thuộc `variantIds`; khoá `FOR UPDATE`. */
export async function lockReclaimCandidates(variantIds: readonly string[]): Promise<LockedReclaimCandidate[]> {
  if (!variantIds.length) return [];
  const rows = await getDb()
    .select({ id: packages.id, orderId: packages.orderId, reservedAt: packages.reservedAt, orderStatus })
    .from(packages)
    .where(and(eq(packages.status, 'reserved'), sql`${orderStatus} in ('unpaid', 'processing')`, hasVariant(variantIds)))
    .orderBy(asc(packages.code))
    .for('update');
  const lines = await planLinesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, orderStatus: r.orderStatus as 'unpaid' | 'processing', lines: heldOf(lines.get(r.id)!) }));
}

/**
 * Kiện đã đóng (`packed`, `awaiting_pickup`) đang giữ một SKU thuộc `variantIds`; khoá `FOR UPDATE` cùng lúc khoá ứng viên
 * lấy lại, trước khi đổi tồn (thứ tự khoá spec 199b §5.10). Đơn huỷ vẫn lấy: hàng vẫn nằm trong kiện.
 */
export async function lockSealedHolders(variantIds: readonly string[]): Promise<SealedHolder[]> {
  if (!variantIds.length) return [];
  const rows = await getDb()
    .select({ id: packages.id, needsAttention: packages.needsAttention })
    .from(packages)
    .where(
      and(
        inArray(packages.status, ['packed', 'awaiting_pickup']),
        sql`exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id}
             and ${packageLines.reservedQty} > 0 and ${inArray(packageLines.variantId, [...variantIds])})`,
      ),
    )
    .orderBy(asc(packages.code))
    .for('update');
  const lines = await planLinesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lines: heldOf(lines.get(r.id)!) }));
}

export type LockedAllocationCandidate = AllocationCandidate & {
  orderId: string;
  shopId: string | null;
  needsAttention: boolean;
  flagNote: string | null;
  lineIds: string[];
};

/** Gian hàng của các ứng viên giữ hàng, đọc không khoá: lọc gian hàng chờ kiểm kê trước khi khoá kiện. */
export async function allocationShops(variantIds: readonly string[]): Promise<string[]> {
  if (!variantIds.length) return [];
  const rows = await getDb()
    .selectDistinct({ shopId: packages.shopId })
    .from(packages)
    .where(and(candidateWhere, hasVariant(variantIds), sql`${packages.shopId} is not null`));
  return rows.map((r) => r.shopId!);
}

/** Ứng viên giữ hàng có dòng thuộc `variantIds`, trừ kiện của `excludeShopIds`; khoá `FOR UPDATE`. */
export async function lockAllocationCandidates(
  variantIds: readonly string[],
  excludeShopIds: readonly string[] = [],
): Promise<LockedAllocationCandidate[]> {
  if (!variantIds.length) return [];
  const rows = await getDb()
    .select({
      id: packages.id,
      code: packages.code,
      status: packages.status,
      shipBy: packages.shipBy,
      orderId: packages.orderId,
      shopId: packages.shopId,
      needsAttention: packages.needsAttention,
      flagNote: packages.flagNote,
      orderCreatedAt,
    })
    .from(packages)
    .where(
      and(
        candidateWhere,
        hasVariant(variantIds),
        excludeShopIds.length ? or(isNull(packages.shopId), notInArray(packages.shopId, [...excludeShopIds])) : undefined,
      ),
    )
    .orderBy(asc(packages.code))
    .for('update');
  const lines = await planLinesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lines: linesOf(lines.get(r.id)!), lineIds: lines.get(r.id)!.map((l) => l.id) }));
}
