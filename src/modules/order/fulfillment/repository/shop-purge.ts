// Xoá kiện, kiện trả lạc của gian hàng bị xoá (#398). Chạy trong giao dịch, `withCompany` của bên gọi (channel).
import { asc, inArray } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { packageLines, packages, unmatchedReturnParcelLines, unmatchedReturnParcels } from './schema.ts';

/** Dòng kiện còn giữ hàng (`reserved_qty > 0`, đã ghép SKU) của một kiện. */
export interface HeldLine {
  variantId: string;
  quantity: number;
}

/**
 * Khoá các kiện của đơn (`FOR UPDATE`, id tăng dần như `lockPackagesOfOrderLines`) và đọc phần đang giữ của từng kiện.
 * Trả mọi kiện đã khoá, kể cả kiện không giữ gì (`held` rỗng).
 */
export async function lockPackagesOfOrders(orderIds: readonly string[]): Promise<{ id: string; held: HeldLine[] }[]> {
  if (!orderIds.length) return [];
  const db = getDb();
  const rows = await db
    .select({ id: packages.id })
    .from(packages)
    .where(inArray(packages.orderId, [...orderIds]))
    .orderBy(asc(packages.id))
    .for('update');
  if (!rows.length) return [];
  const lines = await db
    .select({ packageId: packageLines.packageId, variantId: packageLines.variantId, reservedQty: packageLines.reservedQty })
    .from(packageLines)
    .where(inArray(packageLines.packageId, rows.map((r) => r.id)));
  const held = new Map<string, HeldLine[]>(rows.map((r) => [r.id, []]));
  for (const l of lines) {
    if (l.variantId !== null && l.reservedQty > 0) held.get(l.packageId)!.push({ variantId: l.variantId, quantity: l.reservedQty });
  }
  return rows.map((r) => ({ id: r.id, held: held.get(r.id)! }));
}

/**
 * Xoá dòng kiện rồi kiện, mỗi bảng một câu: kiện thay (`replaces_package_id`) cùng đơn nên nằm trong cùng tập. Trigger
 * `package_lines_line_total` hoãn tới commit và chỉ bỏ qua khi dòng đơn đã mất: bên gọi xoá dòng đơn trong cùng giao dịch.
 */
export async function deletePackages(ids: readonly string[]): Promise<{ packages: number; packageLines: number }> {
  if (!ids.length) return { packages: 0, packageLines: 0 };
  const db = getDb();
  const lines = await db.delete(packageLines).where(inArray(packageLines.packageId, [...ids])).returning({ id: packageLines.id });
  const rows = await db.delete(packages).where(inArray(packages.id, [...ids])).returning({ id: packages.id });
  return { packages: rows.length, packageLines: lines.length };
}

/** Xoá kiện trả lạc (và dòng của nó) đã gắn vào các yêu cầu trả; trả id kiện đã xoá. */
export async function deleteParcelsOfReturns(returnRequestIds: readonly string[]): Promise<string[]> {
  if (!returnRequestIds.length) return [];
  const db = getDb();
  const parcels = await db
    .select({ id: unmatchedReturnParcels.id })
    .from(unmatchedReturnParcels)
    .where(inArray(unmatchedReturnParcels.returnRequestId, [...returnRequestIds]))
    .orderBy(asc(unmatchedReturnParcels.id))
    .for('update');
  if (!parcels.length) return [];
  const ids = parcels.map((p) => p.id);
  await db.delete(unmatchedReturnParcelLines).where(inArray(unmatchedReturnParcelLines.parcelId, ids));
  await db.delete(unmatchedReturnParcels).where(inArray(unmatchedReturnParcels.id, ids));
  return ids;
}
