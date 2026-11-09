// Đọc dữ kiện để dựng `fulfillment.package_delivered` (spec 199c §5.3). Chạy trong giao dịch của bên gọi, kiện đã
// khoá `FOR UPDATE`; fulfillment không import sales nên dòng đơn, ship đơn đọc bằng SQL thô (cùng cách
// `repository/package-list.ts`).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { type DeliveredLine, type OrderShipping } from '../domain/delivery.ts';
import type { PackageStatus } from '../domain/package.ts';
import { packageLines, packages } from './schema.ts';

export interface DeliveryState {
  orderId: string;
  shopId: string | null;
  deliveredAt: Date | null;
  deliveryPostedAt: Date | null;
  /** Kiện còn dòng đã ghép SKU, chưa trừ tồn, không phải `before_cutoff`: hoãn phát tới khi hàm bù chốt giá vốn. */
  deferred: boolean;
}

/** Trạng thái cần thiết của kiện để `reportDelivered` quyết phát hay hoãn (một câu theo khoá chính). */
export async function deliveryStateOf(packageId: string): Promise<DeliveryState | undefined> {
  const [row] = await getDb()
    .select({
      orderId: packages.orderId,
      shopId: packages.shopId,
      deliveredAt: packages.deliveredAt,
      deliveryPostedAt: packages.deliveryPostedAt,
      deferred: sql<boolean>`exists (
        select 1 from ${packageLines} where ${packageLines.packageId} = ${packageId}
          and ${packageLines.variantId} is not null and not ${packageLines.stockDeducted}
      ) and not exists (
        select 1 from ${packages} where id = ${packageId} and ${packages.handoverSource} = 'before_cutoff'
      )`,
    })
    .from(packages)
    .where(eq(packages.id, packageId));
  if (!row) return undefined;
  return row;
}

/**
 * Dòng kiện kèm tiền của dòng đơn để tính `deliveredAmounts` (spec 199c §5.2, §5.3): một câu join `"order".order_lines`
 * theo `order_line_id`, giữ `id` dòng kiện để đối chiếu. Dòng kiện trỏ tới dòng đơn không có là lỗi dữ liệu (ném, đơn
 * rollback; không thay bằng `0`).
 */
export async function deliveryLinesOf(packageId: string): Promise<DeliveredLine[]> {
  const { rows } = await getDb().execute<{ id: string; variant_id: string | null; quantity: string; unit_cost: string | null; ol_id: string | null; ol_quantity: string; ol_unit_price: string; ol_seller_discount: string; ol_platform_discount: string }>(sql`
    select l.id, l.variant_id, l.quantity, l.unit_cost, o.id as ol_id, o.quantity as ol_quantity, o.unit_price as ol_unit_price,
           o.seller_discount as ol_seller_discount, o.platform_discount as ol_platform_discount
    from ${packageLines} l
    left join "order".order_lines o on o.id = l.order_line_id
    where l.package_id = ${packageId}
    order by l.created_at, l.id`);
  for (const r of rows) {
    if (r.ol_id === null) throw new Error(`Dòng kiện ${r.id} trỏ tới dòng đơn không có`);
  }
  return rows.map((r) => ({
    variantId: r.variant_id,
    quantity: Number(r.quantity),
    unitCost: r.unit_cost,
    order: {
      quantity: Number(r.ol_quantity),
      unitPrice: r.ol_unit_price,
      sellerDiscount: r.ol_seller_discount,
      platformDiscount: r.ol_platform_discount,
    },
  }));
}

/** Ship cấp đơn (#260, null được cho đơn trước #260; spec 199c D10). */
export async function orderShippingOf(orderId: string): Promise<OrderShipping> {
  const { rows } = await getDb().execute<{ shipping_fee: string; shipping_fee_original: string | null; shipping_fee_discount_platform: string | null }>(sql`
    select shipping_fee, shipping_fee_original, shipping_fee_discount_platform from "order".orders where id = ${orderId}`);
  const row = rows[0];
  if (!row) throw new Error(`Đơn ${orderId} không có khi tính tiền kiện giao`);
  return {
    shippingFee: row.shipping_fee,
    shippingFeeOriginal: row.shipping_fee_original,
    shippingFeeDiscountPlatform: row.shipping_fee_discount_platform,
  };
}

/** Kiện khác của đơn đã báo giao (`delivery_posted_at` khác null): kiện đó không mang ship cấp đơn (D4). */
export async function anotherDeliveryPosted(orderId: string, packageId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ found: sql<boolean>`true` })
    .from(packages)
    .where(sql`${packages.orderId} = ${orderId} and ${packages.id} <> ${packageId} and ${packages.deliveryPostedAt} is not null`);
  return row !== undefined;
}

/**
 * Trạng thái kiện theo lô cho finance (spec 199c §5.6): một câu theo khoá chính, lọc thêm `company_id` (ngoài RLS).
 * Bên gọi chặn mảng rỗng (Drizzle `inArray` với mảng rỗng).
 */
export async function packageStatuses(
  companyId: string,
  ids: readonly string[],
): Promise<{ id: string; orderId: string; status: PackageStatus; deliveredAt: Date | null }[]> {
  return getDb()
    .select({ id: packages.id, orderId: packages.orderId, status: packages.status, deliveredAt: packages.deliveredAt })
    .from(packages)
    .where(and(eq(packages.companyId, companyId), inArray(packages.id, [...ids])));
}
