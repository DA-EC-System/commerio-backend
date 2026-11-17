// Dòng kiện của món sàn huỷ (spec 205 §5.10): xoá dòng, đánh dấu và bỏ đánh dấu chờ bỏ (số chờ bỏ đọc kèm dòng ở
// `planLinesOf`). Bên gọi đã khoá kiện (`lockOrderPackages`, `lockPackingPackage`): trigger `package_lines_line_total`
// không tự xếp hàng (D11).
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
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
