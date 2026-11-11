// Phần của fulfillment trong luồng hàng trả (#202, Documents/21 §20, 25 §9): kiện của dòng trả, kiện trả không khớp.
// Chạy trong giao dịch, `withCompany` của bên gọi.
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import type { PackageStatus } from '../domain/package.ts';
import { packageLines, packages, unmatchedReturnParcelLines, unmatchedReturnParcels } from './schema.ts';

export type UnmatchedParcelRow = typeof unmatchedReturnParcels.$inferSelect;
export type UnmatchedParcelStatus = UnmatchedParcelRow['status'];

/** Dòng kiện của các dòng đơn, kèm trạng thái kiện (giá vốn bình quân của hàng trả, gắn kiện cho dòng trả). */
export async function packageLinesOfOrderLines(orderLineIds: readonly string[]) {
  if (!orderLineIds.length) return [];
  return getDb()
    .select({
      orderLineId: packageLines.orderLineId,
      packageId: packageLines.packageId,
      quantity: packageLines.quantity,
      unitCost: packageLines.unitCost,
      status: packages.status,
    })
    .from(packageLines)
    .innerJoin(packages, eq(packages.id, packageLines.packageId))
    .where(inArray(packageLines.orderLineId, [...orderLineIds]))
    .orderBy(packages.code);
}

export async function lockPackageStatus(id: string): Promise<{ id: string; orderId: string; status: PackageStatus; needsAttention: boolean } | undefined> {
  const [row] = await getDb()
    .select({ id: packages.id, orderId: packages.orderId, status: packages.status, needsAttention: packages.needsAttention })
    .from(packages)
    .where(eq(packages.id, id))
    .for('update');
  return row;
}

export async function insertUnmatchedParcel(input: {
  code: string;
  scannedCode: string;
  note: string | null;
  receivedBy: string;
  lines: readonly { variantId: string; quantity: number }[];
}): Promise<UnmatchedParcelRow> {
  const companyId = requireCompanyId('insertUnmatchedParcel');
  const db = getDb();
  const [row] = await db
    .insert(unmatchedReturnParcels)
    .values({ companyId, code: input.code, scannedCode: input.scannedCode, note: input.note, receivedBy: input.receivedBy })
    .returning();
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (lines.length) await db.insert(unmatchedReturnParcelLines).values(lines.map((l) => ({ companyId, parcelId: row!.id, ...l })));
  return row!;
}

export async function setParcelInspection(id: string, inspection: { documentId: string; number: string }): Promise<void> {
  await getDb()
    .update(unmatchedReturnParcels)
    .set({ inspectionId: inspection.documentId, inspectionNumber: inspection.number })
    .where(eq(unmatchedReturnParcels.id, id));
}

export async function findUnmatchedParcels(status?: UnmatchedParcelStatus): Promise<UnmatchedParcelRow[]> {
  return getDb()
    .select()
    .from(unmatchedReturnParcels)
    .where(status ? eq(unmatchedReturnParcels.status, status) : undefined)
    .orderBy(desc(unmatchedReturnParcels.createdAt))
    .limit(500);
}

export async function findUnmatchedParcel(id: string, opts: { lock?: boolean } = {}): Promise<UnmatchedParcelRow | undefined> {
  const q = getDb().select().from(unmatchedReturnParcels).where(eq(unmatchedReturnParcels.id, id));
  const [row] = await (opts.lock ? q.for('update') : q);
  return row;
}

export async function unmatchedParcelLines(parcelIds: readonly string[]) {
  if (!parcelIds.length) return [];
  return getDb()
    .select({ parcelId: unmatchedReturnParcelLines.parcelId, variantId: unmatchedReturnParcelLines.variantId, quantity: unmatchedReturnParcelLines.quantity })
    .from(unmatchedReturnParcelLines)
    .where(inArray(unmatchedReturnParcelLines.parcelId, [...parcelIds]))
    .orderBy(unmatchedReturnParcelLines.createdAt, unmatchedReturnParcelLines.id);
}

/** Đóng kiện (`attached`/`dismissed`) theo `version`, chỉ khi còn `open`; false khi đã đổi. */
export async function resolveUnmatchedParcel(
  id: string,
  version: number,
  patch: { status: 'attached'; returnRequestId: string; resolvedBy: string } | { status: 'dismissed'; statusReason: string; resolvedBy: string },
): Promise<boolean> {
  const rows = await getDb()
    .update(unmatchedReturnParcels)
    .set({ ...patch, resolvedAt: sql`now()`, version: sql`${unmatchedReturnParcels.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(unmatchedReturnParcels.id, id), eq(unmatchedReturnParcels.version, version), eq(unmatchedReturnParcels.status, 'open')))
    .returning({ id: unmatchedReturnParcels.id });
  return rows.length > 0;
}

export async function countOpenUnmatchedParcels(): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(unmatchedReturnParcels).where(eq(unmatchedReturnParcels.status, 'open'));
  return Number(row!.n);
}
