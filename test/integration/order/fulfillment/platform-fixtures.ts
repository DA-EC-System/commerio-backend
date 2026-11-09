// Đơn sàn giả cho test đồng bộ kiện (199a, 199b, 199c): dựng `PlatformOrder`, nhận đơn trong công ty.
import { randomUUID } from 'node:crypto';
import { ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
import type { CancelKind, PackageEvent } from '#src/modules/order/fulfillment/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { noLineInfo, noOrderInfo, noShipping } from '../sales/helpers.ts';

export type LineStatus = NonNullable<PlatformOrder['lines'][number]['status']>;

export async function setup(stock: number | null) {
  const { companyId } = await createCompany();
  const { variantId, sku } = await createVariant(companyId);
  if (stock !== null) await receive(companyId, variantId, stock, 100000);
  return { companyId, variantId, sku };
}

/** Đơn sàn; `lines` món, mỗi món một đơn vị. `packages > 1` chia món lần lượt vào `FP-${tag}-${n}` (spec 199c AC2). */
export function remote(
  v: { variantId: string; sku: string },
  o: { status?: LineStatus; lines?: number; unmapped?: number; packages?: number; placedAt?: Date; orderCutoffAt?: Date | null; holdStock?: boolean } = {},
): PlatformOrder {
  const tag = randomUUID().slice(0, 8);
  const status = o.status ?? 'pending';
  const packages = o.packages ?? 1;
  const line = (i: number, mapped: boolean) => ({
    externalLineId: `${tag}-${i}`,
    variantId: mapped ? v.variantId : null,
    sellerSku: mapped ? v.sku : `CHUA-GHEP-${tag}`,
    productName: 'Áo thun',
    unitPrice: '100000',
    sellerDiscount: '0',
    platformDiscount: '0',
    packageCode: packages > 1 ? `FP-${tag}-${i % packages}` : `FP-${tag}`,
    trackingCode: null,
    rawStatus: status,
    status,
    info: noLineInfo,
    shipping: noShipping,
  });
  const mapped = o.lines ?? 1;
  return {
    shopId: randomUUID(),
    holdStock: o.holdStock ?? true,
    orderCutoffAt: o.orderCutoffAt ?? null,
    externalOrderId: `LZ-${tag}`,
    rawStatus: status,
    paid: true,
    isCod: false,
    placedAt: o.placedAt ?? new Date('2026-11-05T07:00:00Z'),
    shipBy: null,
    shippingAddress: null,
    shippingFee: '0',
    cancelRequested: false,
    info: noOrderInfo,
    lines: [
      ...Array.from({ length: mapped }, (_, i) => line(i, true)),
      ...Array.from({ length: o.unmapped ?? 0 }, (_, i) => line(mapped + i, false)),
    ],
  };
}

/** Đổi trạng thái mọi món; `packageCode` thì chỉ đổi món của kiện đó (spec 199c Review Focus 1). */
export const withStatus = (o: PlatformOrder, status: LineStatus, packageCode?: string): PlatformOrder => ({
  ...o,
  rawStatus: status,
  lines: o.lines.map((l) => (packageCode === undefined || l.packageCode === packageCode ? { ...l, status, rawStatus: status } : l)),
});

/** Hành trình kiện của sàn (spec 199c §5.7); `packageEvents` theo kiện, khớp mã kiện rồi mã vận đơn. */
export const withEvents = (o: PlatformOrder, events: PackageEvent[]): PlatformOrder => ({ ...o, packageEvents: events });

/** Ship cấp đơn của sàn (#260, spec 199c D10) để `reportDelivered` tính tiền. */
export const withShipping = (
  o: PlatformOrder,
  s: { shippingFee: string; shippingFeeOriginal?: string | null; shippingFeeDiscountPlatform?: string | null },
): PlatformOrder => ({
  ...o,
  shippingFee: s.shippingFee,
  info: { ...o.info, shippingFeeOriginal: s.shippingFeeOriginal ?? null, shippingFeeDiscountPlatform: s.shippingFeeDiscountPlatform ?? null },
});

export async function ingest(companyId: string, o: PlatformOrder) {
  const { orderId } = await withCompany(companyId, () => ingestMarketplaceOrder(o));
  const { rows } = await testPool().query<{ id: string }>('select id from "order".packages where order_id = $1', [orderId]);
  return { orderId, packageId: rows[0]!.id };
}



/** Sàn huỷ mọi món với loại huỷ cho trước (`cancellation_reason`; `failed_delivery`: giao không thành, spec 199c D2). */
export const withCancel = (o: PlatformOrder, cancelKind: CancelKind): PlatformOrder => ({
  ...o,
  rawStatus: 'cancelled',
  lines: o.lines.map((l) => ({ ...l, status: 'cancelled', rawStatus: 'cancelled', info: { ...l.info, cancelKind } })),
});
