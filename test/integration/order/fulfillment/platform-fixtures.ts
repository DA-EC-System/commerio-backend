// Đơn sàn giả cho test đồng bộ kiện (199a, 199b): dựng `PlatformOrder`, nhận đơn trong công ty.
import { randomUUID } from 'node:crypto';
import { ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
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

/** Đơn sàn một kiện; `lines` món, mỗi món một đơn vị (Lazada mỗi món một dòng). */
export function remote(
  v: { variantId: string; sku: string },
  o: { status?: LineStatus; lines?: number; unmapped?: number; placedAt?: Date; orderCutoffAt?: Date | null; holdStock?: boolean } = {},
): PlatformOrder {
  const tag = randomUUID().slice(0, 8);
  const status = o.status ?? 'pending';
  const line = (i: number, mapped: boolean) => ({
    externalLineId: `${tag}-${i}`,
    variantId: mapped ? v.variantId : null,
    sellerSku: mapped ? v.sku : `CHUA-GHEP-${tag}`,
    productName: 'Áo thun',
    unitPrice: '100000',
    sellerDiscount: '0',
    platformDiscount: '0',
    packageCode: `FP-${tag}`,
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

export const withStatus = (o: PlatformOrder, status: LineStatus): PlatformOrder => ({
  ...o,
  rawStatus: status,
  lines: o.lines.map((l) => ({ ...l, status, rawStatus: status })),
});

export async function ingest(companyId: string, o: PlatformOrder) {
  const { orderId } = await withCompany(companyId, () => ingestMarketplaceOrder(o));
  const { rows } = await testPool().query<{ id: string }>('select id from "order".packages where order_id = $1', [orderId]);
  return { orderId, packageId: rows[0]!.id };
}

