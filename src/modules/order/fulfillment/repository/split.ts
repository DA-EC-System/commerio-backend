// Truy vấn của tách kiện (spec 205 §5.4). Mọi hàm chạy trong `withCompany` của bên gọi. Mã đơn, mã món sàn đọc bằng SQL
// thô `"order".orders`, `"order".order_lines` (cùng schema `order`, fulfillment không import sales) như `platformItemsOf`.
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { PackageStatus } from '../domain/package.ts';
import type { SplitLine } from '../domain/split.ts';
import type { PackageShipping } from './packages.ts';
import { packageLines, packages } from './schema.ts';

export interface SplitSource {
  id: string;
  code: string;
  orderId: string;
  shopId: string | null;
  status: PackageStatus;
  version: number;
  shipBy: Date | null;
  reservedAt: Date | null;
  platformPackageCode: string | null;
  shipping: PackageShipping;
  /** Theo `created_at, id` như `planLinesOf`: thứ tự chọn dòng của `planSplit`. */
  lines: SplitLine[];
}

/** Kiện nguồn kèm dòng, đọc không khoá (bên gọi khoá bằng `lockOrderPackages` trước khi đọc lại ở bước ghi). */
export async function readSplitSource(id: string): Promise<SplitSource | undefined> {
  const db = getDb();
  const [row] = await db
    .select({
      id: packages.id,
      code: packages.code,
      orderId: packages.orderId,
      shopId: packages.shopId,
      status: packages.status,
      version: packages.version,
      shipBy: packages.shipBy,
      reservedAt: packages.reservedAt,
      platformPackageCode: packages.platformPackageCode,
      shipping: {
        shipmentProvider: packages.shipmentProvider,
        shippingProviderType: packages.shippingProviderType,
        shippingType: packages.shippingType,
        promisedShippingAt: packages.promisedShippingAt,
      },
    })
    .from(packages)
    .where(eq(packages.id, id));
  if (!row) return undefined;
  const lines = await db
    .select({
      id: packageLines.id,
      orderLineId: packageLines.orderLineId,
      variantId: packageLines.variantId,
      quantity: packageLines.quantity,
      reservedQty: packageLines.reservedQty,
    })
    .from(packageLines)
    .where(eq(packageLines.packageId, id))
    .orderBy(asc(packageLines.createdAt), asc(packageLines.id));
  return { ...row, lines };
}

/** Số kiện chưa huỷ khác của đơn (nhánh `sku`, D13). */
export async function liveSiblingCount(orderId: string, packageId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(packages)
    .where(and(eq(packages.orderId, orderId), ne(packages.id, packageId), ne(packages.status, 'cancelled')));
  return row!.n;
}

/** Mã đơn sàn và mã món sàn theo dòng đơn của kiện; thiếu thì null, bên gọi quyết (khác `platformItemsOf`: không ném). */
export async function platformLineIds(packageId: string): Promise<{ externalOrderId: string | null; byOrderLine: Map<string, string | null> }> {
  const { rows } = await getDb().execute<{ externalOrderId: string | null; orderLineId: string | null; externalLineId: string | null }>(sql`
    select o.external_order_id as "externalOrderId", ${packageLines.orderLineId} as "orderLineId", l.external_line_id as "externalLineId"
    from ${packages}
    join "order".orders o on o.id = ${packages.orderId}
    left join ${packageLines} on ${packageLines.packageId} = ${packages.id}
    left join "order".order_lines l on l.id = ${packageLines.orderLineId} and l.order_id = o.id
    where ${packages.id} = ${packageId}
  `);
  return {
    externalOrderId: rows[0]?.externalOrderId ?? null,
    byOrderLine: new Map(rows.flatMap((r) => (r.orderLineId ? [[r.orderLineId, r.externalLineId] as const] : []))),
  };
}

/** Chuyển nguyên dòng sang kiện khác; `reserved_qty`, `variant_id`, `order_line_id` giữ nguyên. */
export async function moveLines(toPackageId: string, lineIds: readonly string[]): Promise<void> {
  if (!lineIds.length) return;
  await getDb()
    .update(packageLines)
    .set({ packageId: toPackageId, version: sql`${packageLines.version} + 1`, updatedAt: sql`now()` })
    .where(inArray(packageLines.id, [...lineIds]));
}

/**
 * Chuyển một phần dòng (D12): dòng cũ còn `keep`, dòng mới ở kiện `toPackageId` mang `moved`, chép dòng đơn và biến thể.
 * Một câu sửa cả `quantity` và `reserved_qty` để CHECK `package_lines_reserved_whole` đúng ở mọi bước.
 */
export async function carveLineInto(
  lineId: string,
  keep: { quantity: number; reservedQty: number },
  moved: { quantity: number; reservedQty: number },
  toPackageId: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(packageLines)
    .set({ quantity: keep.quantity, reservedQty: keep.reservedQty, version: sql`${packageLines.version} + 1`, updatedAt: sql`now()` })
    .where(eq(packageLines.id, lineId));
  await db.execute(sql`
    insert into ${packageLines} (company_id, package_id, order_line_id, variant_id, quantity, reserved_qty)
    select company_id, ${toPackageId}, order_line_id, variant_id, ${moved.quantity}, ${moved.reservedQty}
    from ${packageLines} where id = ${lineId}
  `);
}
