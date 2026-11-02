// Nhận đơn sàn (#105): kéo định kỳ (channel) gọi `ingestMarketplaceOrder` trong `withCompany`.
// Một đơn một giao dịch: đơn, dòng, kiện, giữ hàng, lịch sử, outbox.
import { Decimal } from 'decimal.js';
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { type PlatformLineStatus, syncPlatformPackages } from '../../fulfillment/index.ts';
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
  shippingAddress: { name: string; phone: string; address: string } | null;
  shippingFee: string;
  cancelRequested: boolean;
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
  }[];
}

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

async function createOrder(o: PlatformOrder): Promise<MarketplaceOrderRow | undefined> {
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
    shippingAddress: o.shippingAddress,
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
  let row = await lockMarketplaceOrder(o.shopId, o.externalOrderId);
  let created = false;
  if (!row) {
    row = await createOrder(o);
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
  if (dirty) {
    await updateOrder(orderId, {
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
