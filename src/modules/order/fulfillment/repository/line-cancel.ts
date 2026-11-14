// Dòng kiện của món sàn huỷ (spec 205 §5.10): xoá dòng, đánh dấu chờ bỏ, đọc dòng chờ bỏ khi mở kiện. Bên gọi đã khoá
// kiện (`lockOrderPackages`, `lockPackingPackage`): trigger `package_lines_line_total` không tự xếp hàng (D11).
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { packageLines } from './schema.ts';

export async function deleteLines(lineIds: readonly string[]): Promise<void> {
  if (!lineIds.length) return;
  await getDb().delete(packageLines).where(inArray(packageLines.id, [...lineIds]));
}

const pendingAll = { pendingDropQty: sql`${packageLines.quantity}`, version: sql`${packageLines.version} + 1`, updatedAt: sql`now()` };

/** Các dòng chờ bỏ cả số lượng (`pending_drop_qty = quantity`). */
export async function setPendingDrop(lineIds: readonly string[]): Promise<void> {
  if (!lineIds.length) return;
  await getDb().update(packageLines).set(pendingAll).where(inArray(packageLines.id, [...lineIds]));
}

/** Mọi dòng của kiện chờ bỏ (sàn huỷ cả kiện đã đóng gói); dòng đã chờ bỏ đủ thì không ghi lại. */
export async function setPendingDropAll(packageId: string): Promise<void> {
  await getDb()
    .update(packageLines)
    .set(pendingAll)
    .where(and(eq(packageLines.packageId, packageId), sql`${packageLines.pendingDropQty} <> ${packageLines.quantity}`));
}

/** Bỏ đánh dấu chờ bỏ của mọi dòng (kiện huỷ khi mở, `open_cancel`). */
export async function clearPendingDrop(packageId: string): Promise<void> {
  await getDb()
    .update(packageLines)
    .set({ pendingDropQty: 0, version: sql`${packageLines.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(packageLines.packageId, packageId), gt(packageLines.pendingDropQty, 0)));
}

/** Dòng chờ bỏ của kiện, theo thứ tự chèn. */
export async function pendingDropLinesOf(packageId: string): Promise<{ id: string; variantId: string | null; quantity: number; reservedQty: number }[]> {
  return getDb()
    .select({ id: packageLines.id, variantId: packageLines.variantId, quantity: packageLines.quantity, reservedQty: packageLines.reservedQty })
    .from(packageLines)
    .where(and(eq(packageLines.packageId, packageId), gt(packageLines.pendingDropQty, 0)))
    .orderBy(asc(packageLines.createdAt), asc(packageLines.id));
}
