// Truy vấn của lượt phân hàng (spec 199b §5.3). Trạng thái, ngày lập của đơn đọc bằng SQL thô `"order".orders`: cùng
// schema `order` nhưng fulfillment không import sales. Khoá kiện theo `code` tăng dần (cùng `lockDeferredPackages`).
import { and, asc, eq, inArray, notInArray, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { type AllocationCandidate, DISMANTLE_NOTE, type ReclaimCandidate, type SealedHolder, type StockLine } from '../domain/allocation.ts';
import { planLinesOf } from './packages.ts';
import { type OpenPurpose, packageLines, packages } from './schema.ts';

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

/**
 * Kiện có dòng chờ bỏ (món sàn đã huỷ, spec 205 §5.10): kiện mang cờ `stocktake` mà sàn huỷ thêm một món thì giữ mục đích
 * `stocktake` nhưng vẫn phải mở để bỏ dòng đó, nên lượt phân hàng không gỡ cờ, không giữ hàng cho nó.
 */
const hasPendingDrop = sql`exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id} and ${packageLines.pendingDropQty} > 0)`;

/**
 * Cờ Cần mở `stocktake` mà lượt phân hàng được tự gỡ (spec #238 §5.5): không có dòng chờ bỏ (còn phải mở để bỏ dòng),
 * không có báo cáo thất lạc chờ người thứ hai xác nhận (Thành chốt ở review #366: gỡ cờ thì `updatePackage` xoá báo cáo
 * và mã khiếu nại theo D21, tức hệ thống bỏ qua bước duyệt). Chưa gồm `needs_open`: bên dùng tự ghép.
 */
const stocktakeAutoClearable = sql`(${packages.openPurpose} = 'stocktake' and not ${hasPendingDrop} and ${packages.lostReportedBy} is null)`;

/**
 * Kiện chờ thay (spec #238 §5.6, D9): có dòng mà cùng dòng đơn đang có dòng chờ bỏ ở kiện khác đang đóng. Suy ra, không
 * lưu cờ: kiện cũ mở xong, bị xác nhận mất, hay rời kho thì kiện thay tự thành ứng viên. Tra theo index
 * `package_lines(order_line_id)`.
 */
const awaitingReplacement = sql`exists (select 1 from ${packageLines} nl
  join ${packageLines} ol on ol.order_line_id = nl.order_line_id and ol.package_id <> nl.package_id and ol.pending_drop_qty > 0
  join ${packages} op on op.id = ol.package_id and op.status in ('packed', 'awaiting_pickup')
  where nl.package_id = ${packages.id})`;

/**
 * Kiện còn là kiện chờ thay trong `ids` (cùng điều kiện với lượt phân hàng): chưa báo sẵn sàng, chưa quét bàn giao được
 * vì hàng của nó còn trong kiện cũ chờ dỡ (spec #238 D9, D28; review #393). Đọc không khoá: kiện cũ mở xong thì lần sau
 * qua; một kiện đã có không thể thành kiện chờ thay về sau (kiện thay chỉ sinh lúc lập).
 */
export async function awaitingReplacementIds(ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await getDb().select({ id: packages.id }).from(packages).where(and(inArray(packages.id, [...ids]), awaitingReplacement));
  return rows.map((r) => r.id);
}

/**
 * Ứng viên giữ hàng (spec 199b §5.2), trừ lọc gian hàng chờ kiểm kê (service lọc). Kiện chờ mở vì kiểm kê (`stocktake`)
 * vẫn là ứng viên: giữ được hàng là lúc cờ của nó gỡ (spec #238 §5.5); trừ khi kiện có dòng chờ bỏ hay báo thất lạc treo.
 * Kiện chờ thay không là ứng viên: hàng của nó còn nằm trong kiện cũ chờ dỡ.
 */
const candidateWhere = and(
  sql`(${packages.status} = 'backordered' or (${packages.status} in ('packed', 'awaiting_pickup')
       and not exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id} and ${packageLines.reservedQty} > 0)))`,
  sql`not exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id}
       and ${packageLines.variantId} is null and not ${packageLines.stockUntracked})`,
  sql`(${packages.needsOpen} = false or ${stocktakeAutoClearable})`,
  sql`${orderStatus} <> 'cancelled'`,
  sql`not ${awaitingReplacement}`,
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

// Chỉ dòng có biến thể (dòng "không quản tồn" không giữ, spec 237).
const variantLines = <T extends { variantId: string | null }>(lines: T[]) => lines.filter((l) => l.variantId) as T[];
const linesOf = (lines: { variantId: string | null; quantity: number }[]) =>
  variantLines(lines).map((l) => ({ variantId: l.variantId!, quantity: l.quantity }));
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

/** Kiện đang giữ thật (dòng có `reserved_qty`) một SKU thuộc `variantIds`. */
const holdsVariant = (variantIds: readonly string[]) =>
  sql`exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id}
       and ${packageLines.reservedQty} > 0 and ${inArray(packageLines.variantId, [...variantIds])})`;

/**
 * Kiện đã đóng (`packed`, `awaiting_pickup`) đang giữ một SKU thuộc `variantIds`; khoá `FOR UPDATE` cùng lúc khoá ứng viên
 * lấy lại, trước khi đổi tồn (thứ tự khoá spec 199b §5.10). Đơn huỷ vẫn lấy: hàng vẫn nằm trong kiện.
 */
export async function lockSealedHolders(variantIds: readonly string[]): Promise<SealedHolder[]> {
  if (!variantIds.length) return [];
  const rows = await getDb()
    .select({ id: packages.id, needsAttention: packages.needsAttention, needsOpen: packages.needsOpen })
    .from(packages)
    .where(and(inArray(packages.status, ['packed', 'awaiting_pickup']), holdsVariant(variantIds)))
    .orderBy(asc(packages.code))
    .for('update');
  const lines = await planLinesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lines: heldOf(lines.get(r.id)!) }));
}

/** Kiện đã đóng mang cờ kiểm kê: dạng mới (Cần mở `stocktake`) và/hoặc dạng cũ (Cần xử lý `DISMANTLE_NOTE`). */
export interface StocktakeFlagged {
  id: string;
  /** Cờ Cần mở `stocktake`. */
  stocktake: boolean;
  /** Cờ dạng cũ, gắn trước #238 PR 2. */
  legacy: boolean;
  /** Phần đang giữ thật. */
  lines: StockLine[];
}

/**
 * Kiện đã đóng mang cờ kiểm kê (Cần mở `stocktake`, hoặc dạng cũ Cần xử lý `DISMANTLE_NOTE`), đang giữ một SKU thuộc
 * `variantIds`; khoá `FOR UPDATE`, theo `code`. Lượt phân hàng xét tự gỡ cờ khi tồn đã đủ (spec #238 §5.5). Kiện có dòng
 * chờ bỏ hay báo thất lạc treo không tính cờ `stocktake` (`stocktakeAutoClearable`).
 */
export async function lockStocktakeFlagged(variantIds: readonly string[]): Promise<StocktakeFlagged[]> {
  if (!variantIds.length) return [];
  // `coalesce`: `open_purpose`, `flag_note` null thì so sánh ra NULL.
  const stocktake = sql<boolean>`coalesce(${packages.needsOpen} and ${stocktakeAutoClearable}, false)`;
  const legacy = sql<boolean>`coalesce(${packages.needsAttention} and ${packages.flagNote} = ${DISMANTLE_NOTE}, false)`;
  const rows = await getDb()
    .select({ id: packages.id, stocktake, legacy })
    .from(packages)
    .where(and(inArray(packages.status, ['packed', 'awaiting_pickup']), or(stocktake, legacy), holdsVariant(variantIds)))
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
  needsOpen: boolean;
  openPurpose: OpenPurpose | null;
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

/** Kiện không có dòng biến thể nào (toàn dòng "không quản tồn", spec 237 D10): giữ không qua cổng tồn. */
const noVariantLine = sql`not exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id} and ${packageLines.variantId} is not null)`;

/**
 * Ứng viên giữ hàng có dòng thuộc `variantIds`, trừ kiện của `excludeShopIds`; khoá `FOR UPDATE`. `orderId`: chỉ kiện của
 * đơn đó (kiện vừa hết chờ thay khi kho mở kiện cũ, spec #238 D26), gồm cả kiện toàn dòng "không quản tồn" của đơn (không
 * còn gì để giữ, lượt theo SKU không bao giờ tìm thấy nó).
 */
export async function lockAllocationCandidates(
  variantIds: readonly string[],
  excludeShopIds: readonly string[] = [],
  opts: { orderId?: string } = {},
): Promise<LockedAllocationCandidate[]> {
  if (!variantIds.length && !opts.orderId) return [];
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
      needsOpen: packages.needsOpen,
      openPurpose: packages.openPurpose,
      orderCreatedAt,
    })
    .from(packages)
    .where(
      and(
        candidateWhere,
        opts.orderId
          ? and(eq(packages.orderId, opts.orderId), variantIds.length ? or(hasVariant(variantIds), noVariantLine) : noVariantLine)
          : hasVariant(variantIds),
        excludeShopIds.length ? or(isNull(packages.shopId), notInArray(packages.shopId, [...excludeShopIds])) : undefined,
      ),
    )
    .orderBy(asc(packages.code))
    .for('update');
  const lines = await planLinesOf(rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r,
    lines: linesOf(lines.get(r.id)!),
    // Chỉ dòng có biến thể giữ hàng; dòng "không quản tồn" giữ `reserved_qty = 0` (spec 237).
    lineIds: variantLines(lines.get(r.id)!).map((l) => l.id),
  }));
}
