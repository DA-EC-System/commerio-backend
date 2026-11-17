import { and, asc, count, eq, getTableColumns, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import type { MappedSku } from '../../fulfillment/index.ts';
import type { OrderStatus } from '../domain/order.ts';
import { docCounters, orderLines, orders } from './schema.ts';

export interface MarketplaceOrderRow {
  id: string;
  code: string;
  status: OrderStatus;
  rawMarketplaceStatus: string | null;
  shipBy: Date | null;
  needsAttention: boolean;
  cancelRequested: boolean;
  cancelling: boolean;
  platformCancelled: boolean;
  shippingAddress: unknown;
  platformPaymentMethod: string | null;
  buyerNote: string | null;
  shippingFeeOriginal: string | null;
  shippingFeeDiscountSeller: string | null;
  shippingFeeDiscountPlatform: string | null;
}

const rowColumns = {
  id: orders.id,
  code: orders.code,
  status: orders.status,
  rawMarketplaceStatus: orders.rawMarketplaceStatus,
  shipBy: orders.shipBy,
  needsAttention: orders.needsAttention,
  cancelRequested: orders.cancelRequested,
  cancelling: orders.cancelling,
  platformCancelled: orders.platformCancelled,
  shippingAddress: orders.shippingAddress,
  platformPaymentMethod: orders.platformPaymentMethod,
  buyerNote: orders.buyerNote,
  shippingFeeOriginal: orders.shippingFeeOriginal,
  shippingFeeDiscountSeller: orders.shippingFeeDiscountSeller,
  shippingFeeDiscountPlatform: orders.shippingFeeDiscountPlatform,
};

/** Cột mô tả của dòng sàn (#260): kéo lại thì ghi đè, sàn trả null thì giữ giá trị đã lưu; biến thể, số lượng, tiền gốc giữ như lúc tạo. */
const LINE_INFO_COLUMNS = [
  'thumbnailUrl',
  'attributesLabel',
  'externalSkuId',
  'externalShopSku',
  'externalProductId',
  'paidPrice',
  'taxAmount',
  'shippingAmount',
  'walletCredits',
  'cancelReason',
  'cancelReasonDetail',
  'cancelInitiator',
  'cancelKind',
  'reverseOrderId',
  'returnStatus',
] as const;

/** Đơn sàn theo mã đơn sàn, khoá dòng tới hết giao dịch. */
export async function lockMarketplaceOrder(shopId: string, externalOrderId: string): Promise<MarketplaceOrderRow | undefined> {
  const [row] = await getDb()
    .select(rowColumns)
    .from(orders)
    .where(and(eq(orders.shopId, shopId), eq(orders.externalOrderId, externalOrderId)))
    .for('update');
  return row;
}

/** Đơn theo id, khoá dòng tới hết giao dịch; không có (hoặc công ty khác, RLS) thì `undefined`. */
export async function lockOrderRow(id: string): Promise<MarketplaceOrderRow | undefined> {
  const [row] = await getDb().select(rowColumns).from(orders).where(eq(orders.id, id)).for('update');
  return row;
}

/** Mọi dòng của đơn đã ghi huỷ đủ (`cancelled_qty = quantity`, spec 205 §5.10), và đơn có dòng. */
export async function allLinesCancelled(orderId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ lines: count(), open: sql<number>`count(*) filter (where ${orderLines.cancelledQty} <> ${orderLines.quantity})`.mapWith(Number) })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId));
  return !!row && row.lines > 0 && row.open === 0;
}

/** Dòng chưa ghép SKU: không biến thể và không "không quản tồn" (spec 237). */
export const unmappedLine = (t: typeof orderLines): SQL => sql`${t.variantId} is null and not ${t.stockUntracked}`;

/** Đơn có dòng chưa ghép SKU (cờ `unmapped_sku` của sự kiện đổi trạng thái). */
export async function hasUnmappedLines(orderId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(and(eq(orderLines.orderId, orderId), unmappedLine(orderLines)))
    .limit(1);
  return !!row;
}

/**
 * Dòng chưa ghép của các đơn thuộc gian hàng mang SKU người bán này (spec 237 §5.4, P1: PR 1 chỉ áp dòng chưa ghép), mọi
 * trạng thái đơn; khoá dòng đơn theo id tăng (P4: khoá dòng đơn trước kiện, như luồng nhận đơn).
 */
export async function lockUnmappedLinesOfShopSku(shopId: string, sellerSku: string): Promise<{ id: string; orderId: string }[]> {
  const db = getDb();
  return db
    .select({ id: orderLines.id, orderId: orderLines.orderId })
    .from(orderLines)
    .where(
      and(
        eq(orderLines.externalSku, sellerSku),
        unmappedLine(orderLines),
        inArray(orderLines.orderId, db.select({ id: orders.id }).from(orders).where(eq(orders.shopId, shopId))),
      ),
    )
    .orderBy(asc(orderLines.id))
    .for('update');
}

/** Ghi ghép lên dòng đơn: biến thể (kèm `sku` = SKU người bán, như lúc nhận đơn) hoặc "không quản tồn" (`sku` null). */
export async function setOrderLineSku(ids: readonly string[], to: MappedSku, sellerSku: string): Promise<void> {
  if (!ids.length) return;
  const variant = to.kind === 'variant';
  await getDb()
    .update(orderLines)
    .set({
      variantId: variant ? to.variantId : null,
      stockUntracked: !variant,
      sku: variant ? sellerSku : null,
      version: sql`${orderLines.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(orderLines.id, [...ids]));
}

/** Đơn theo id, không khoá (đọc cờ lưu để phát sự kiện). */
export async function findOrderRows(ids: readonly string[]): Promise<MarketplaceOrderRow[]> {
  if (!ids.length) return [];
  return getDb().select(rowColumns).from(orders).where(inArray(orders.id, [...ids])).orderBy(asc(orders.id));
}

/** Chèn đơn sàn; đơn đã có (lần kéo khác vừa chèn) thì trả `undefined`. */
export async function insertMarketplaceOrder(
  values: Omit<typeof orders.$inferInsert, 'companyId' | 'source'>,
): Promise<MarketplaceOrderRow | undefined> {
  const [row] = await getDb()
    .insert(orders)
    .values({ ...values, companyId: requireCompanyId('insertMarketplaceOrder'), source: 'marketplace' })
    .onConflictDoNothing()
    .returning(rowColumns);
  return row;
}

export async function updateOrder(id: string, patch: Partial<typeof orders.$inferInsert>): Promise<void> {
  await getDb()
    .update(orders)
    .set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: sql`now()` })
    .where(eq(orders.id, id));
}

/** Dòng đơn đã lưu theo mã món sàn: id và ghép SKU (spec 237). */
export interface StoredLine {
  id: string;
  variantId: string | null;
  stockUntracked: boolean;
}

/**
 * Chèn dòng đơn sàn chưa có (theo mã món sàn); dòng đã có chỉ cập nhật cột mô tả khi khác, sàn trả null thì giữ giá
 * trị đã lưu (không tăng `version` nếu không đổi). Trả mọi dòng theo mã món với ghép **đã lưu**: dòng đã có giữ biến thể,
 * `stock_untracked` cũ (đổi ghép của đơn đã về là việc của `applySkuMapping`, spec 237 D14).
 */
export async function upsertMarketplaceLines(
  orderId: string,
  lines: readonly Omit<typeof orderLines.$inferInsert, 'companyId' | 'orderId'>[],
): Promise<Map<string, StoredLine>> {
  const db = getDb();
  if (lines.length) {
    const companyId = requireCompanyId('upsertMarketplaceLines');
    const cols = getTableColumns(orderLines);
    const own = (k: (typeof LINE_INFO_COLUMNS)[number]) => sql`${orderLines}.${sql.identifier(cols[k].name)}`;
    const next = (k: (typeof LINE_INFO_COLUMNS)[number]) => sql`coalesce(excluded.${sql.identifier(cols[k].name)}, ${own(k)})`;
    await db
      .insert(orderLines)
      .values(lines.map((l) => ({ ...l, companyId, orderId })))
      .onConflictDoUpdate({
        target: [orderLines.orderId, orderLines.externalLineId],
        set: {
          ...Object.fromEntries(LINE_INFO_COLUMNS.map((k) => [k, next(k)])),
          version: sql`${orderLines.version} + 1`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`(${sql.join(LINE_INFO_COLUMNS.map(own), sql`, `)}) is distinct from (${sql.join(LINE_INFO_COLUMNS.map(next), sql`, `)})`,
      });
  }
  const rows = await db
    .select({ id: orderLines.id, externalLineId: orderLines.externalLineId, variantId: orderLines.variantId, stockUntracked: orderLines.stockUntracked })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId));
  return new Map(rows.map(({ externalLineId, ...r }) => [externalLineId ?? '', r]));
}

/** Dòng của đơn đã ghi huỷ đủ (`cancelled_qty = quantity`, spec 205 §5.10). */
export async function cancelledLineIds(orderId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(and(eq(orderLines.orderId, orderId), sql`${orderLines.cancelledQty} = ${orderLines.quantity}`));
  return new Set(rows.map((r) => r.id));
}

/**
 * Ghi huỷ đủ cho các dòng đơn sàn đã huỷ mà fulfillment đã gỡ, đánh dấu chờ bỏ hoặc huỷ cùng kiện (spec 205 §5.10).
 * Dòng đã ghi thì bỏ qua (kéo lại không tăng `version`). Chỉ luồng nhận đơn gọi; trigger `order_lines_line_total` kiểm
 * lúc commit.
 */
export async function markLinesCancelled(orderLineIds: readonly string[]): Promise<void> {
  if (!orderLineIds.length) return;
  await getDb()
    .update(orderLines)
    .set({ cancelledQty: sql`${orderLines.quantity}`, version: sql`${orderLines.version} + 1`, updatedAt: sql`now()` })
    .where(and(inArray(orderLines.id, [...new Set(orderLineIds)]), sql`${orderLines.cancelledQty} <> ${orderLines.quantity}`));
}

/** Số tiếp theo của bộ đếm mã (`order`, `package`) trong công ty của giao dịch. */
export async function takeNextNumber(docType: string): Promise<number> {
  const [row] = await getDb()
    .insert(docCounters)
    .values({ companyId: requireCompanyId('takeNextNumber'), docType, nextNumber: 2 })
    .onConflictDoUpdate({
      target: [docCounters.companyId, docCounters.docType, docCounters.period],
      set: { nextNumber: sql`${docCounters.nextNumber} + 1` },
    })
    .returning({ n: sql<number>`${docCounters.nextNumber} - 1` });
  return Number(row!.n);
}

/** Sửa đơn khi còn đúng `version`, tăng `version`; không trúng dòng thì trả false để bên gọi báo 409. */
export async function updateOrderAt(id: string, version: number, patch: Partial<typeof orders.$inferInsert>): Promise<boolean> {
  const rows = await getDb()
    .update(orders)
    .set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(orders.id, id), eq(orders.version, version)))
    .returning({ id: orders.id });
  return rows.length > 0;
}

/**
 * Đơn `processing` có kiện và mọi kiện đã dừng, **mọi công ty**, cho việc nền tự hoàn tất: gọi ngoài `withCompany`
 * (role chủ bảng). Hạn trả hàng, yêu cầu trả mở kiểm tiếp trong `withCompany` của từng đơn.
 *
 * Đơn Đang huỷ (`cancelling`): còn kiện chờ mở thì kiện đó chưa dừng nên đơn tự bị loại. Mọi kiện đã dừng mà còn kiện
 * không huỷ (kiện hoá ra đã bàn giao) thì đi theo "Sàn huỷ đơn khi đã có kiện bàn giao" (25 §8.2): hoàn tất được, kể cả
 * khi lượt kéo đơn chưa chạy lại để gỡ cờ. Mọi kiện đều huỷ thì đơn phải sang `cancelled` (25 §8.2), không hoàn tất.
 */
export async function findCompletionCandidates(): Promise<{ id: string; companyId: string }[]> {
  return getDb()
    .select({ id: orders.id, companyId: orders.companyId })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'processing'),
        sql`(not ${orders.cancelling} or exists (select 1 from "order".packages p where p.order_id = ${orders.id} and p.status <> 'cancelled'))`,
        sql`exists (select 1 from "order".packages p where p.order_id = ${orders.id})`,
        sql`not exists (select 1 from "order".packages p where p.order_id = ${orders.id}
              and p.status not in ('delivered', 'returned', 'lost', 'cancelled'))`,
      ),
    );
}

/** Đơn chưa xong: một vị từ cho `openOrders` của ngắt, `orders` của 409 và `pendingOrderCount` (§18.7.1), để không lệch. */
const OPEN = notInArray(orders.status, ['completed', 'cancelled']);

/** Số đơn của gian hàng chưa `completed` hoặc `cancelled` (#207). Gọi trong `withCompany`. */
export async function countOpenOrdersOfShop(shopId: string): Promise<number> {
  requireCompanyId('countOpenOrdersOfShop');
  const [row] = await getDb()
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), OPEN));
  return row!.n;
}

/**
 * Số đơn chưa xong và số đơn đặt từ `placedSince` (theo `placed_at`) của nhiều gian hàng, một câu cho cả danh sách
 * (Documents/21 §18.7.1). Gian hàng không có đơn không có trong Map. Gọi trong `withCompany`.
 */
export async function orderCountsOfShops(shopIds: readonly string[], placedSince: Date): Promise<Map<string, { open: number; placed: number }>> {
  requireCompanyId('orderCountsOfShops');
  if (shopIds.length === 0) return new Map();
  const rows = await getDb()
    .select({
      shopId: orders.shopId,
      open: sql<number>`(count(*) filter (where ${OPEN}))::int`,
      placed: sql<number>`(count(*) filter (where ${orders.placedAt} >= ${placedSince}))::int`,
    })
    .from(orders)
    .where(inArray(orders.shopId, [...shopIds]))
    .groupBy(orders.shopId);
  return new Map(rows.map((r) => [r.shopId!, { open: r.open, placed: r.placed }]));
}

/** Tối đa `limit` đơn chưa xong của gian hàng, cũ nhất trước theo lúc đặt (chưa có thì lúc tạo) (§18.7.8). */
export async function oldestOpenOrdersOfShop(shopId: string, limit: number): Promise<{ id: string; code: string; externalOrderId: string | null }[]> {
  requireCompanyId('oldestOpenOrdersOfShop');
  return getDb()
    .select({ id: orders.id, code: orders.code, externalOrderId: orders.externalOrderId })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), OPEN))
    .orderBy(sql`coalesce(${orders.placedAt}, ${orders.createdAt})`, asc(orders.code))
    .limit(limit);
}

/**
 * Số món bán ra của từng SKU trong `days` ngày gần nhất, không tính đơn huỷ và phần dòng đã huỷ (gợi ý ngưỡng tồn,
 * #242). SKU không bán được thì không có trong kết quả. Chạy trong `withCompany`.
 */
export async function soldQtyByVariant(variantIds: readonly string[], days: number): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .select({
      variantId: orderLines.variantId,
      qty: sql<number>`sum(${orderLines.quantity} - ${orderLines.cancelledQty})::int`,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(
      and(
        inArray(orderLines.variantId, [...variantIds]),
        notInArray(orders.status, ['cancelled']),
        sql`coalesce(${orders.placedAt}, ${orders.createdAt}) >= now() - make_interval(days => ${days})`,
      ),
    )
    .groupBy(orderLines.variantId);
  return new Map(rows.filter((r) => r.variantId && r.qty > 0).map((r) => [r.variantId!, r.qty]));
}
