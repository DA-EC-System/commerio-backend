import { and, asc, count, eq, getTableColumns, gt, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
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
  attentionNote: string | null;
  cancelRequested: boolean;
  cancelPending: boolean;
  platformCancelled: boolean;
  cancelReason: string | null;
  shippingAddress: unknown;
  platformPaymentMethod: string | null;
  buyerNote: string | null;
  shippingFeeOriginal: string | null;
  shippingFeeDiscountSeller: string | null;
  shippingFeeDiscountPlatform: string | null;
  returnWindowEndsAt: Date | null;
}

const rowColumns = {
  id: orders.id,
  code: orders.code,
  status: orders.status,
  rawMarketplaceStatus: orders.rawMarketplaceStatus,
  shipBy: orders.shipBy,
  needsAttention: orders.needsAttention,
  attentionNote: orders.attentionNote,
  cancelRequested: orders.cancelRequested,
  cancelPending: orders.cancelPending,
  platformCancelled: orders.platformCancelled,
  cancelReason: orders.cancelReason,
  shippingAddress: orders.shippingAddress,
  platformPaymentMethod: orders.platformPaymentMethod,
  buyerNote: orders.buyerNote,
  shippingFeeOriginal: orders.shippingFeeOriginal,
  shippingFeeDiscountSeller: orders.shippingFeeDiscountSeller,
  shippingFeeDiscountPlatform: orders.shippingFeeDiscountPlatform,
  returnWindowEndsAt: orders.returnWindowEndsAt,
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

/**
 * Cờ Đang huỷ (`cancelling`) suy ra lúc đọc, chỉ cho huỷ **cả đơn** (Documents/25 §8.2 "Như dòng trên"): đơn còn mở và
 * đã gửi lệnh huỷ cả đơn chờ sàn (`cancel_pending`), hoặc sàn đã huỷ cả đơn mà còn kiện chưa huỷ đang chờ mở để huỷ (mở
 * để huỷ cả kiện, hay dòng chờ bỏ). "Sàn đã huỷ cả đơn": mọi dòng đã huỷ hết, hoặc cờ Sàn đã huỷ (sàn huỷ mọi món khi có
 * kiện đã rời kho: dòng của kiện đó giữ `cancelled_qty = 0`, 25 §8.2 "cờ Đang huỷ gỡ khi không còn kiện chờ mở"). Kho
 * mở hết kiện đó thì cờ tự hết; không lưu nên không kẹt (test đêm 18/11/2026, DH-B03). Huỷ một phần món (25 §8.3 Huỷ
 * dòng, KH-B09) không bật cờ đơn: kiện mang cờ chờ mở, đơn chạy tiếp. Kiện chờ mở vì kiểm kê hay chia lại không tính.
 */
export const cancellingSql = sql<boolean>`(${orders.status} in ('unpaid', 'processing') and (${orders.cancelPending} or (
  (${orders.platformCancelled}
    or not exists (select 1 from "order".order_lines ol where ol.order_id = ${orders.id} and ol.cancelled_qty < ol.quantity))
  and exists (
    select 1 from "order".packages p
    where p.order_id = ${orders.id} and p.status <> 'cancelled' and p.needs_open
      and (p.open_purpose = 'cancel' or (p.open_purpose = 'edit' and exists (
        select 1 from "order".package_lines pl where pl.package_id = p.id and pl.pending_drop_qty > 0)))))))`;

/** Cờ Đang huỷ suy ra của một đơn (`cancellingSql`), đọc trong giao dịch của bên gọi (thấy cả ghi chưa commit). */
export async function isCancelling(orderId: string): Promise<boolean> {
  const [row] = await getDb().select({ v: cancellingSql }).from(orders).where(eq(orders.id, orderId));
  return row?.v === true;
}

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

/** Người, lý do huỷ của các dòng đã huỷ (`cancelled_qty > 0`) của đơn, đọc trong giao dịch của bên gọi. */
export async function cancelledLineInfo(orderId: string) {
  return getDb()
    .select({ cancelledQty: orderLines.cancelledQty, cancelReason: orderLines.cancelReason, cancelInitiator: orderLines.cancelInitiator })
    .from(orderLines)
    .where(and(eq(orderLines.orderId, orderId), gt(orderLines.cancelledQty, 0)));
}

/**
 * Tính lại tiền của đơn khi sàn huỷ món (test đêm 18/11/2026, KH-B09): còn món chưa huỷ thì tạm tính, giảm giá, tổng chỉ
 * gồm dòng chưa huỷ hết; mọi món đã huỷ thì về tiền theo mọi món (giá trị đơn đã huỷ), dù sàn huỷ cùng lúc hay lần lượt
 * từng món. Phí ship giữ nguyên. Chỉ đơn có món đã huỷ; không đổi thì không ghi. Migration `*_dang-huy-du-lieu` dùng
 * cùng công thức.
 */
export async function recomputeTotals(orderId: string): Promise<boolean> {
  const rows = await getDb().execute(sql`
    with s as (
      select (case when bool_and(l.cancelled_qty = l.quantity) then sum(l.unit_price * l.quantity)
                   else sum(l.unit_price * (l.quantity - l.cancelled_qty)) end)::numeric(18, 2) as subtotal,
             (case when bool_and(l.cancelled_qty = l.quantity) then sum(l.seller_discount)
                   else coalesce(sum(l.seller_discount) filter (where l.cancelled_qty < l.quantity), 0) end)::numeric(18, 2) as seller_discount,
             (case when bool_and(l.cancelled_qty = l.quantity) then sum(l.platform_discount)
                   else coalesce(sum(l.platform_discount) filter (where l.cancelled_qty < l.quantity), 0) end)::numeric(18, 2) as platform_discount
      from "order".order_lines l
      where l.order_id = ${orderId}
      having bool_or(l.cancelled_qty > 0)
    )
    update "order".orders o
    set subtotal = s.subtotal, seller_discount = s.seller_discount, platform_discount = s.platform_discount,
        total = greatest(0, s.subtotal - s.seller_discount - s.platform_discount + o.shipping_fee),
        version = o.version + 1, updated_at = now()
    from s
    where o.id = ${orderId}
      and (o.subtotal, o.seller_discount, o.platform_discount) is distinct from (s.subtotal, s.seller_discount, s.platform_discount)
    returning o.id`);
  return rows.rows.length > 0;
}

/**
 * Bỏ thông tin huỷ cũ của món sàn nay không huỷ (test đêm 18/11/2026, DH-B04). Chỉ dòng chưa ghi huỷ (`cancelled_qty = 0`),
 * loại `cancellation` hoặc trống (trả hàng, hoàn tiền, giao không thành giữ nguyên).
 * - `clear`: khách không còn xin huỷ (Sale đã từ chối) và sàn không còn báo người huỷ, lý do: dòng mang yêu cầu của khách
 *   (`cancel_initiator = buyer`) bỏ người, lý do, loại. Cột mô tả giữ giá trị khi sàn trả null (#260) nên phải xoá riêng.
 * - `keepRequest`: món sàn còn báo người huỷ (đang xin huỷ): chỉ bỏ loại `cancellation` adapter cũ ghi nhầm.
 */
export async function clearStaleLineCancel(orderId: string, lines: { clear: readonly string[]; keepRequest: readonly string[] }): Promise<void> {
  const db = getDb();
  const stale = and(eq(orderLines.orderId, orderId), eq(orderLines.cancelledQty, 0), sql`(${orderLines.cancelKind} is null or ${orderLines.cancelKind} = 'cancellation')`);
  if (lines.clear.length) {
    await db
      .update(orderLines)
      .set({ cancelKind: null, cancelInitiator: null, cancelReason: null, cancelReasonDetail: null, version: sql`${orderLines.version} + 1`, updatedAt: sql`now()` })
      .where(
        and(
          stale,
          inArray(orderLines.externalLineId, [...lines.clear]),
          eq(orderLines.cancelInitiator, 'buyer'),
        ),
      );
  }
  if (lines.keepRequest.length) {
    await db
      .update(orderLines)
      .set({ cancelKind: null, version: sql`${orderLines.version} + 1`, updatedAt: sql`now()` })
      .where(and(stale, inArray(orderLines.externalLineId, [...lines.keepRequest]), eq(orderLines.cancelKind, 'cancellation')));
  }
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
 * Dòng đơn của gian hàng mang SKU người bán này cần áp ghép `to` (spec 237 §5.4, D3, D27), khoá theo id tăng (P4: khoá
 * dòng đơn trước kiện, như luồng nhận đơn):
 * - dòng chưa ghép, mọi trạng thái đơn (cờ phải tắt ở mọi đơn; kiện bàn giao bắt buộc của đơn đã hoàn tất vẫn trừ);
 * - dòng đã ghép khác `to` của đơn `unpaid`, `processing` (đổi ghép; đơn đã dừng không có gì đổi);
 * - dòng đơn của đơn `unpaid`, `processing` có dòng kiện mang dấu chờ đổi ghép, kể cả khi đã bằng `to` (D27: đổi về như
 *   cũ phải tới được dấu để xoá). `"order".package_lines` cùng schema, đọc bằng SQL thô (sales không import fulfillment).
 */
export async function lockLinesToRemap(
  shopId: string,
  sellerSku: string,
  to: MappedSku,
): Promise<{ id: string; orderId: string; variantId: string | null; stockUntracked: boolean }[]> {
  const db = getDb();
  const differs =
    to.kind === 'variant'
      ? sql`(${orderLines.variantId} is distinct from ${to.variantId}::uuid or ${orderLines.stockUntracked})`
      : sql`not ${orderLines.stockUntracked}`;
  const remapPending = sql`exists (select 1 from "order".package_lines pl where pl.order_line_id = ${orderLines.id} and pl.remap_pending)`;
  const openOrders = db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), inArray(orders.status, ['unpaid', 'processing'])));
  return db
    .select({ id: orderLines.id, orderId: orderLines.orderId, variantId: orderLines.variantId, stockUntracked: orderLines.stockUntracked })
    .from(orderLines)
    .where(
      and(
        eq(orderLines.externalSku, sellerSku),
        inArray(orderLines.orderId, db.select({ id: orders.id }).from(orders).where(eq(orders.shopId, shopId))),
        or(unmappedLine(orderLines), and(inArray(orderLines.orderId, openOrders), or(differs, remapPending))),
      ),
    )
    .orderBy(asc(orderLines.id))
    .for('update');
}

/**
 * Khoá đơn rồi dòng đơn, theo id tăng (mở kiện đơn sàn áp lại ghép, spec 237 D21: dòng đơn trước khoá phân hàng). Đơn
 * trước dòng như lượt nhận đơn (`lockMarketplaceOrder` rồi upsert dòng theo thứ tự món sàn trả): chỉ khoá dòng theo id
 * thì lệch thứ tự với upsert đó và khoá chéo (`40P01`) khi lượt kéo nhận lại đơn đúng lúc kho mở kiện (review PR 2).
 */
export async function lockOrderLinesById(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const db = getDb();
  await db
    .select({ id: orders.id })
    .from(orders)
    .where(inArray(orders.id, db.select({ id: orderLines.orderId }).from(orderLines).where(inArray(orderLines.id, [...ids]))))
    .orderBy(asc(orders.id))
    .for('update');
  await db
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(inArray(orderLines.id, [...ids]))
    .orderBy(asc(orderLines.id))
    .for('update');
}

/** Ghi ghép lên dòng đơn: biến thể (kèm `sku` = SKU người bán `external_sku`, như lúc nhận đơn) hoặc "không quản tồn" (`sku` null). */
export async function setOrderLineSku(ids: readonly string[], to: MappedSku): Promise<void> {
  if (!ids.length) return;
  const variant = to.kind === 'variant';
  await getDb()
    .update(orderLines)
    .set({
      variantId: variant ? to.variantId : null,
      stockUntracked: !variant,
      sku: variant ? sql`${orderLines.externalSku}` : null,
      version: sql`${orderLines.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(orderLines.id, [...ids]));
}

/** Dòng đơn theo id (đơn chứa nó), không khoá. */
export async function findOrderLinesByIds(ids: readonly string[]): Promise<{ id: string; orderId: string }[]> {
  if (!ids.length) return [];
  return getDb().select({ id: orderLines.id, orderId: orderLines.orderId }).from(orderLines).where(inArray(orderLines.id, [...ids]));
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

type OrderPatch = Partial<Omit<typeof orders.$inferInsert, 'legacyCancelling'>>;

export async function updateOrder(id: string, patch: OrderPatch): Promise<void> {
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
    .set({ cancelledQty: sql`${orderLines.quantity}`, cancelledAt: sql`coalesce(${orderLines.cancelledAt}, now())`, version: sql`${orderLines.version} + 1`, updatedAt: sql`now()` })
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
export async function updateOrderAt(id: string, version: number, patch: OrderPatch): Promise<boolean> {
  const rows = await getDb()
    .update(orders)
    .set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(orders.id, id), eq(orders.version, version)))
    .returning({ id: orders.id });
  return rows.length > 0;
}

/**
 * Đơn `processing` có kiện và mọi kiện đã dừng, **mọi công ty**, cho việc nền khép đơn: gọi ngoài `withCompany` (role
 * chủ bảng). Hạn trả hàng, yêu cầu trả mở, COD, bước khép (hoàn tất hay huỷ vì mọi kiện đã huỷ) kiểm tiếp trong
 * `withCompany` của công ty. Lật trang theo `id` tăng (`afterId` là `id` cuối trang trước, null là trang đầu), mỗi trang
 * `limit` đơn.
 *
 * Đơn Đang huỷ còn kiện chờ mở thì kiện đó chưa dừng nên đơn tự bị loại. Mọi kiện đều huỷ (kể cả còn `cancel_pending`)
 * thì vào danh sách để bước khép xét (#236 PR 3, spec 5.4): huỷ khi mọi món đã huỷ, không thì giữ.
 */
export async function findCompletionCandidates(afterId: string | null, limit: number): Promise<{ id: string; companyId: string }[]> {
  return getDb()
    .select({ id: orders.id, companyId: orders.companyId })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'processing'),
        afterId ? gt(orders.id, afterId) : undefined,
        sql`exists (select 1 from "order".packages p where p.order_id = ${orders.id})`,
        sql`not exists (select 1 from "order".packages p where p.order_id = ${orders.id}
              and p.status not in ('delivered', 'returned', 'lost', 'cancelled'))`,
      ),
    )
    .orderBy(asc(orders.id))
    .limit(limit);
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
