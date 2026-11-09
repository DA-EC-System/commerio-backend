import { randomUUID } from 'node:crypto';
import type { HandoverSource } from '#src/modules/order/fulfillment/domain/handover.ts';
import type { PackageStatus } from '#src/modules/order/fulfillment/domain/package.ts';
import { stockOf } from '#src/modules/product/index.ts';
import { reserve } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

export interface SeedLine {
  variantId: string | null;
  quantity: number;
  /** Dòng đã giữ hàng: gọi `reserve` thật để `stock_levels.reserved` khớp. */
  reserved?: boolean;
  /** Dòng đã trừ (spec 199c §5.3): chèn `unit_cost` và `stock_deducted = true`. */
  unitCost?: string;
}

/**
 * Một đơn sàn và một kiện ở trạng thái cho trước, chèn thẳng bằng role chủ bảng (đóng gói, chờ lấy là #239). Dòng có
 * `variantId` null dùng dòng đơn của biến thể đầu tiên có trong `lines` (dòng chưa ghép SKU).
 */
export async function seedPackage(
  companyId: string,
  p: {
    status: PackageStatus;
    lines: readonly SeedLine[];
    handoverSource?: HandoverSource | null;
    handedOverAt?: Date | null;
    pickupConfirmedAt?: Date | null;
    deliveredAt?: Date | null;
    shopId?: string;
    orderStatus?: 'unpaid' | 'processing' | 'cancelled';
    /** Lúc đơn về app (`orders.created_at`), cho thứ tự "đơn kéo về trước" của phân hàng. */
    orderCreatedAt?: Date;
    cancelling?: boolean;
    shipBy?: Date | null;
    trackingCode?: string | null;
    needsOpen?: boolean;
    /** Mặc định: lúc seed nếu có dòng `reserved`, null nếu không. */
    reservedAt?: Date | null;
  },
): Promise<{ packageId: string; orderId: string; orderCode: string; packageCode: string; lineIds: string[] }> {
  const firstVariant = p.lines.find((l) => l.variantId)?.variantId;
  if (!firstVariant) throw new Error('seedPackage: cần ít nhất một dòng có variantId');
  const order = await createOrder(companyId, {
    source: 'marketplace',
    lines: p.lines.map((l) => ({ variantId: l.variantId ?? firstVariant, quantity: l.quantity, unitPrice: 100000 })),
  });
  const db = testPool();
  await db.query(
    `update "order".orders set status = $2, cancelling = $3, shop_id = coalesce($4, shop_id), created_at = coalesce($5, created_at) where id = $1`,
    [order.orderId, p.orderStatus ?? 'processing', p.cancelling ?? false, p.shopId ?? null, p.orderCreatedAt ?? null],
  );
  const { rows: orderLines } = await db.query<{ id: string }>(
    'select id from "order".order_lines where order_id = $1 order by created_at, id',
    [order.orderId],
  );
  const out = !['backordered', 'reserved', 'packed', 'awaiting_pickup', 'cancelled'].includes(p.status);
  const packageCode = `KH-${randomUUID().slice(0, 8)}`;
  const shop = await db.query<{ shop_id: string }>('select shop_id from "order".orders where id = $1', [order.orderId]);
  const pkg = await db.query<{ id: string }>(
    `insert into "order".packages (company_id, code, order_id, shop_id, status, handed_over_at, handover_source,
       pickup_confirmed_at, delivered_at, ship_by, tracking_code, needs_open, open_purpose, reserved_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    [
      companyId,
      packageCode,
      order.orderId,
      shop.rows[0]!.shop_id,
      p.status,
      p.handedOverAt !== undefined ? p.handedOverAt : out ? new Date() : null,
      p.handoverSource !== undefined ? p.handoverSource : out ? 'scan' : null,
      p.pickupConfirmedAt ?? null,
      p.deliveredAt ?? null,
      p.shipBy ?? null,
      p.trackingCode ?? null,
      p.needsOpen ?? false,
      p.needsOpen ? 'cancel' : null,
      p.reservedAt !== undefined ? p.reservedAt : p.lines.some((l) => l.reserved) ? new Date() : null,
    ],
  );
  const packageId = pkg.rows[0]!.id;
  const lineIds: string[] = [];
  for (const [i, l] of p.lines.entries()) {
    const { rows } = await db.query<{ id: string }>(
      `insert into "order".package_lines (company_id, package_id, order_line_id, variant_id, quantity, reserved_qty, unit_cost, stock_deducted)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [companyId, packageId, orderLines[i]!.id, l.variantId, l.quantity, l.reserved ? l.quantity : 0, l.unitCost ?? null, l.unitCost != null],
    );
    lineIds.push(rows[0]!.id);
  }
  const held = p.lines.filter((l) => l.reserved && l.variantId);
  if (held.length) {
    const { reserved } = await withCompany(companyId, () =>
      reserve(packageId, held.map((l) => ({ variantId: l.variantId!, quantity: l.quantity }))),
    );
    if (!reserved) throw new Error('seedPackage: không đủ tồn để giữ hàng cho kiện');
  }
  return { packageId, orderId: order.orderId, orderCode: order.code, packageCode, lineIds };
}

/** Tồn của một biến thể (đọc qua cổng thật). */
export async function stockOfVariant(companyId: string, variantId: string) {
  return (await withCompany(companyId, () => stockOf([variantId]))).get(variantId)!;
}

export async function packageRow(packageId: string) {
  const { rows } = await testPool().query<{
    status: string;
    handover_source: string | null;
    handed_over_at: Date | null;
    handed_over_by: string | null;
    pickup_confirmed_at: Date | null;
    handover_reverted_by: string | null;
    needs_attention: boolean;
    flag_note: string | null;
    reserved_at: Date | null;
    version: number;
  }>('select * from "order".packages where id = $1', [packageId]);
  return rows[0]!;
}

export async function packageLineRows(packageId: string) {
  const { rows } = await testPool().query<{ id: string; unit_cost: string | null; stock_deducted: boolean; reserved_qty: number; quantity: number }>(
    'select id, unit_cost, stock_deducted, reserved_qty, quantity from "order".package_lines where package_id = $1 order by created_at, id',
    [packageId],
  );
  return rows;
}

/** Phiếu kho theo kiện, cũ trước. */
export async function packageDocuments(packageId: string) {
  const { rows } = await testPool().query<{ id: string; number: string; kind: string; note: string | null }>(
    `select id, number, kind, note from product.stock_documents where source_type = 'package' and source_id = $1
     order by created_at`,
    [packageId],
  );
  return rows;
}

export async function outboxOf(orderId: string, type: string) {
  const { rows } = await testPool().query<{ payload: Record<string, unknown> }>(
    'select payload from core.outbox_messages where key = $1 and type = $2 order by id',
    [orderId, type],
  );
  return rows.map((r) => r.payload);
}

export async function invariantBroken(companyId: string, variantId: string) {
  const { rows } = await testPool().query<{ invariant_broken: boolean }>(
    'select invariant_broken from product.stock_levels where company_id = $1 and variant_id = $2',
    [companyId, variantId],
  );
  return rows[0]!.invariant_broken;
}

/** Gian hàng của channel; `awaiting` thì đang chờ kiểm kê đầu kỳ (mỗi công ty tối đa một gian hàng như vậy). */
export async function channelShop(companyId: string, awaiting: boolean): Promise<string> {
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, opening_stocktake_id, opening_stocktake_number, order_cutoff_at)
     values ($1, 'lazada', $2, 'Shop Thử', $3, $4, $5) returning id`,
    [companyId, randomUUID(), awaiting ? randomUUID() : null, awaiting ? 'KK-000001' : null, awaiting ? new Date() : null],
  );
  return rows[0]!.id;
}

/**
 * Ship cấp đơn của một đơn (#260; spec 199c D10) để `reportDelivered` tính tiền. Chỉ ghi trường có khoá trong `s`
 * (giá trị `null` thì ghi null); trường bỏ trống giữ nguyên.
 */
export async function setOrderShipping(
  orderId: string,
  s: Partial<{ shippingFee: string; shippingFeeOriginal: string | null; shippingFeeDiscountPlatform: string | null }>,
) {
  const columns = {
    shippingFee: 'shipping_fee',
    shippingFeeOriginal: 'shipping_fee_original',
    shippingFeeDiscountPlatform: 'shipping_fee_discount_platform',
  } as const;
  const keys = (Object.keys(columns) as (keyof typeof columns)[]).filter((k) => k in s);
  if (!keys.length) return;
  const set = keys.map((k, i) => `${columns[k]} = $${i + 2}`).join(', ');
  await testPool().query(`update "order".orders set ${set} where id = $1`, [orderId, ...keys.map((k) => s[k] ?? null)]);
}

/** Sửa tiền của dòng đơn mà dòng kiện trỏ tới (spec 199c D10, Review Focus 4). */
export async function setOrderLineMoney(
  packageLineId: string,
  m: Partial<{ quantity: number; unitPrice: string; sellerDiscount: string; platformDiscount: string }>,
) {
  const { rows } = await testPool().query<{ order_line_id: string }>(
    'select order_line_id from "order".package_lines where id = $1',
    [packageLineId],
  );
  const orderLineId = rows[0]!.order_line_id;
  await testPool().query(
    `update "order".order_lines set quantity = coalesce($2, quantity), unit_price = coalesce($3, unit_price),
       seller_discount = coalesce($4, seller_discount), platform_discount = coalesce($5, platform_discount) where id = $1`,
    [orderLineId, m.quantity ?? null, m.unitPrice ?? null, m.sellerDiscount ?? null, m.platformDiscount ?? null],
  );
}

/** Các mũi tên đã ghi cho kiện, cũ trước. */
export async function transitionsOf(packageId: string) {
  const { rows } = await testPool().query<{ action: string; from_state: string | null; to_state: string; source: string }>(
    `select action, from_state, to_state, source from core.state_transitions where entity_type = 'packages' and entity_id = $1 order by id`,
    [packageId],
  );
  return rows;
}

/** Lý do của các mũi tên vào `to` của kiện, cũ trước (lịch sử giao thất bại có lý do, spec 199c §5.4). */
export async function transitionReasonsOf(packageId: string, to: string) {
  const { rows } = await testPool().query<{ reason: string | null }>(
    `select reason from core.state_transitions where entity_type = 'packages' and entity_id = $1 and to_state = $2 order by id`,
    [packageId, to],
  );
  return rows.map((r) => r.reason);
}
