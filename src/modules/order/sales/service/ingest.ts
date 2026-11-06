// Nhận đơn sàn (#105): kéo định kỳ (channel) gọi `ingestMarketplaceOrder` trong `withCompany`.
// Một đơn một giao dịch: đơn, dòng, kiện, giữ hàng, lịch sử, outbox.
import { Decimal } from 'decimal.js';
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { logger } from '../../../../shared/logger.ts';
import { type PlatformLineStatus, type PlatformPackageLine, syncPlatformPackages } from '../../fulfillment/index.ts';
import type { OrderFlag, OrderStatus } from '../domain/order.ts';
import {
  insertMarketplaceOrder,
  lockMarketplaceOrder,
  type MarketplaceOrderRow,
  takeNextNumber,
  updateOrder,
  upsertMarketplaceLines,
} from '../repository/orders.ts';

/** Đơn sàn đã chuẩn hoá; `variantId` do channel tra theo listing (null: chưa ghép SKU). Mỗi món một đơn vị. */
export interface PlatformOrder {
  shopId: string;
  externalOrderId: string;
  rawStatus: string;
  paid: boolean;
  isCod: boolean;
  placedAt: Date;
  shipBy: Date | null;
  /** `ward`, `postCode`, `raw` (khoá gốc của sàn) có ở đơn kéo từ #260. */
  shippingAddress: { name: string; phone: string; address: string; ward?: string | null; postCode?: string | null; raw?: Record<string, string> } | null;
  shippingFee: string;
  cancelRequested: boolean;
  /** Thông tin mô tả (#260): kéo lại thì ghi đè, sàn trả null thì giữ giá trị đã lưu; không tính là đơn đổi. Tiền là chuỗi thập phân. */
  info: {
    platformPaymentMethod: string | null;
    buyerNote: string | null;
    shippingFeeOriginal: string | null;
    shippingFeeDiscountSeller: string | null;
    shippingFeeDiscountPlatform: string | null;
  };
  lines: {
    externalLineId: string;
    variantId: string | null;
    sellerSku: string;
    productName: string;
    unitPrice: string;
    sellerDiscount: string;
    platformDiscount: string;
    packageCode: string | null;
    trackingCode: string | null;
    rawStatus: string;
    status: PlatformLineStatus | null;
    info: LineInfo;
    shipping: PlatformPackageLine['shipping'];
  }[];
}

/** Thông tin mô tả của món (#260), ghi vào cột cùng tên của `order_lines`. */
export interface LineInfo {
  thumbnailUrl: string | null;
  attributesLabel: string | null;
  externalSkuId: string | null;
  externalShopSku: string | null;
  externalProductId: string | null;
  paidPrice: string | null;
  taxAmount: string | null;
  shippingAmount: string | null;
  walletCredits: string | null;
  cancelReason: string | null;
  cancelReasonDetail: string | null;
  cancelInitiator: 'buyer' | 'seller' | 'platform' | null;
  cancelKind: 'cancellation' | 'return' | 'refund' | 'failed_delivery' | null;
  reverseOrderId: string | null;
  returnStatus: string | null;
}

/** Tiền mô tả của sàn, 2 chữ số như DB trả về để so được; chuỗi sai dạng thì null kèm cảnh báo, không làm hỏng cả đơn. */
function money2(v: string | null, field: string): string | null {
  if (v === null) return null;
  try {
    const d = new Decimal(v);
    if (d.isFinite()) return d.toFixed(2);
  } catch {
    // rơi xuống cảnh báo
  }
  logger.warn({ field, value: v }, 'Sàn trả chuỗi tiền sai dạng, ghi null');
  return null;
}

/** Cột mô tả của đơn theo bản sàn. */
function orderInfo(o: PlatformOrder) {
  return {
    shippingAddress: o.shippingAddress as unknown,
    platformPaymentMethod: o.info.platformPaymentMethod,
    buyerNote: o.info.buyerNote,
    shippingFeeOriginal: money2(o.info.shippingFeeOriginal, 'shippingFeeOriginal'),
    shippingFeeDiscountSeller: money2(o.info.shippingFeeDiscountSeller, 'shippingFeeDiscountSeller'),
    shippingFeeDiscountPlatform: money2(o.info.shippingFeeDiscountPlatform, 'shippingFeeDiscountPlatform'),
  };
}
type OrderInfo = ReturnType<typeof orderInfo>;

/** Sàn trả null thì giữ giá trị đã lưu (như vận chuyển của kiện, review #261). */
const keepSaved = (info: OrderInfo, saved: OrderInfo): OrderInfo =>
  Object.fromEntries((Object.keys(info) as (keyof OrderInfo)[]).map((k) => [k, info[k] ?? saved[k]])) as OrderInfo;

/** JSON có khoá xếp thứ tự: jsonb trả khoá theo thứ tự khác lúc ghi. */
const canonical = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
        .join(',')}}`
    : JSON.stringify(v ?? null);

const sameInfo = (a: OrderInfo, b: OrderInfo) =>
  (Object.keys(a) as (keyof OrderInfo)[]).every((k) => canonical(a[k]) === canonical(b[k]));

const code = async (prefix: string, docType: string) => `${prefix}-${String(await takeNextNumber(docType)).padStart(6, '0')}`;

const sum = (values: string[]) => values.reduce((a, v) => a.plus(v), new Decimal(0));

function storedFlags(o: Pick<MarketplaceOrderRow, 'needsAttention' | 'cancelRequested' | 'cancelling' | 'platformCancelled'>): OrderFlag[] {
  const flags: OrderFlag[] = [];
  if (o.needsAttention) flags.push('needs_attention');
  if (o.cancelRequested) flags.push('cancel_requested');
  if (o.cancelling) flags.push('cancelling');
  if (o.platformCancelled) flags.push('platform_cancelled');
  return flags;
}

function totals(o: PlatformOrder) {
  const subtotal = sum(o.lines.map((l) => l.unitPrice));
  const sellerDiscount = sum(o.lines.map((l) => l.sellerDiscount));
  const platformDiscount = sum(o.lines.map((l) => l.platformDiscount));
  const total = Decimal.max(0, subtotal.minus(sellerDiscount).minus(platformDiscount).plus(o.shippingFee));
  return { subtotal, sellerDiscount, platformDiscount, total };
}

async function createOrder(o: PlatformOrder, info: OrderInfo): Promise<MarketplaceOrderRow | undefined> {
  const { subtotal, sellerDiscount, platformDiscount, total } = totals(o);
  return insertMarketplaceOrder({
    code: await code('DH', 'order'),
    shopId: o.shopId,
    externalOrderId: o.externalOrderId,
    isCod: o.isCod,
    status: 'unpaid',
    rawMarketplaceStatus: o.rawStatus,
    placedAt: o.placedAt,
    shipBy: o.shipBy,
    ...info,
    subtotal: subtotal.toFixed(2),
    sellerDiscount: sellerDiscount.toFixed(2),
    platformDiscount: platformDiscount.toFixed(2),
    shippingFee: new Decimal(o.shippingFee).toFixed(2),
    total: total.toFixed(2),
  });
}

async function transition(orderId: string, from: OrderStatus | null, to: OrderStatus, action: string) {
  await recordTransition({ entityType: 'orders', entityId: orderId, from, to, action, actorId: null, source: 'marketplace' });
}

export async function ingestMarketplaceOrder(o: PlatformOrder): Promise<{ orderId: string; created: boolean; changed: boolean }> {
  const remoteInfo = orderInfo(o);
  let row = await lockMarketplaceOrder(o.shopId, o.externalOrderId);
  let created = false;
  if (!row) {
    row = await createOrder(o, remoteInfo);
    if (row) created = true;
    // Lần kéo khác vừa tạo cùng đơn: chờ nó commit rồi đi như cập nhật.
    else row = (await lockMarketplaceOrder(o.shopId, o.externalOrderId))!;
  }
  const orderId = row.id;
  if (created) {
    await transition(orderId, null, 'unpaid', 'create');
    await publishEvent({ type: 'sales.order_created', aggregateId: orderId, payload: { orderId, code: row.code, source: 'marketplace', total: totals(o).total.toFixed(2) } });
  }

  const lineIds = await upsertMarketplaceLines(
    orderId,
    o.lines.map((l) => ({
      externalLineId: l.externalLineId,
      variantId: l.variantId,
      externalSku: l.sellerSku,
      sku: l.variantId ? l.sellerSku : null,
      productName: l.productName,
      quantity: 1,
      unitPrice: new Decimal(l.unitPrice).toFixed(2),
      sellerDiscount: new Decimal(l.sellerDiscount).toFixed(2),
      platformDiscount: new Decimal(l.platformDiscount).toFixed(2),
      lineTotal: Decimal.max(0, new Decimal(l.unitPrice).minus(l.sellerDiscount).minus(l.platformDiscount)).toFixed(2),
      ...l.info,
      paidPrice: money2(l.info.paidPrice, 'paidPrice'),
      taxAmount: money2(l.info.taxAmount, 'taxAmount'),
      shippingAmount: money2(l.info.shippingAmount, 'shippingAmount'),
      walletCredits: money2(l.info.walletCredits, 'walletCredits'),
    })),
  );
  const packages = await syncPlatformPackages(
    { id: orderId, shopId: o.shopId, shipBy: o.shipBy },
    o.lines.map((l) => ({
      orderLineId: lineIds.get(l.externalLineId)!,
      variantId: l.variantId,
      quantity: 1,
      packageCode: l.packageCode,
      trackingCode: l.trackingCode,
      status: l.status,
      shipping: l.shipping,
    })),
    () => code('KH', 'package'),
  );

  const next = { ...row };
  if (next.status === 'unpaid' && o.paid) {
    await transition(orderId, 'unpaid', 'processing', 'pay');
    next.status = 'processing';
  }
  const open = next.status === 'unpaid' || next.status === 'processing';
  let cancelled = false;
  if (open && o.lines.length && o.lines.every((l) => l.status === 'cancelled')) {
    if (packages.cancelled.includes('handed_over')) next.platformCancelled = true;
    else if (packages.cancelled.includes('needs_open')) next.cancelling = true;
    else {
      await transition(orderId, next.status, 'cancelled', 'platform_cancel');
      next.status = 'cancelled';
      cancelled = true;
    }
  }
  next.cancelRequested = o.cancelRequested && next.status !== 'cancelled';
  if (packages.unknown || packages.resplit) next.needsAttention = true;
  next.rawMarketplaceStatus = o.rawStatus;
  next.shipBy = o.shipBy;

  // `row` là bản đã lưu (đơn vừa chèn: `unpaid`, chưa cờ): chỉ ghi khi có khác.
  const dirty =
    next.status !== row.status ||
    storedFlags(next).join() !== storedFlags(row).join() ||
    next.rawMarketplaceStatus !== row.rawMarketplaceStatus ||
    next.shipBy?.getTime() !== row.shipBy?.getTime();
  // Thông tin mô tả đổi thì ghi kèm, nhưng không phát sự kiện, không tính là đơn đổi (#260 AC-S1).
  const info = keepSaved(remoteInfo, row);
  const infoDirty = !sameInfo(info, row);
  if (infoDirty && !dirty) await updateOrder(orderId, info);
  if (dirty) {
    await updateOrder(orderId, {
      ...(infoDirty ? info : {}),
      status: next.status,
      rawMarketplaceStatus: next.rawMarketplaceStatus,
      shipBy: next.shipBy,
      needsAttention: next.needsAttention,
      attentionNote: packages.resplit ? 'Sàn chia lại kiện khác lần trước' : packages.unknown ? 'Sàn trả trạng thái app chưa biết' : undefined,
      cancelRequested: next.cancelRequested,
      cancelling: next.cancelling,
      platformCancelled: next.platformCancelled,
      cancelReason: cancelled ? 'Sàn huỷ đơn' : undefined,
    });
  }
  if (cancelled) {
    await publishEvent({ type: 'sales.order_cancelled', aggregateId: orderId, payload: { orderId, code: row.code, source: 'marketplace', by: 'platform' } });
  }
  const changed = created || dirty || packages.changed;
  if (changed) {
    const flags: OrderFlag[] = storedFlags(next);
    if (o.lines.some((l) => !l.variantId)) flags.push('unmapped_sku');
    await publishEvent({
      type: 'sales.order_status_changed',
      aggregateId: orderId,
      payload: { orderId, code: row.code, from: created ? null : row.status, to: next.status, flags },
    });
  }
  return { orderId, created, changed };
}
