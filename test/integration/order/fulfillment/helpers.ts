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
       pickup_confirmed_at, ship_by, tracking_code, needs_open, open_purpose, reserved_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [
      companyId,
      packageCode,
      order.orderId,
      shop.rows[0]!.shop_id,
      p.status,
      p.handedOverAt !== undefined ? p.handedOverAt : out ? new Date() : null,
      p.handoverSource !== undefined ? p.handoverSource : out ? 'scan' : null,
      p.pickupConfirmedAt ?? null,
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
      `insert into "order".package_lines (company_id, package_id, order_line_id, variant_id, quantity, reserved_qty)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [companyId, packageId, orderLines[i]!.id, l.variantId, l.quantity, l.reserved ? l.quantity : 0],
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

/** Các mũi tên đã ghi cho kiện, cũ trước. */
export async function transitionsOf(packageId: string) {
  const { rows } = await testPool().query<{ action: string; from_state: string | null; to_state: string; source: string }>(
    `select action, from_state, to_state, source from core.state_transitions where entity_type = 'packages' and entity_id = $1 order by id`,
    [packageId],
  );
  return rows;
}
