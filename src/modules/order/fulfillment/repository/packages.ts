import { asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import type { PackageStatus } from '../domain/package.ts';
import { packageLines, packages } from './schema.ts';

export interface PackageRow {
  id: string;
  status: PackageStatus;
  platformPackageCode: string | null;
  trackingCode: string | null;
  needsOpen: boolean;
  needsAttention: boolean;
  lines: { orderLineId: string; variantId: string | null; quantity: number; reservedQty: number }[];
}

/** Các kiện của đơn kèm dòng, khoá dòng kiện tới hết giao dịch. */
export async function lockOrderPackages(orderId: string): Promise<PackageRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: packages.id,
      status: packages.status,
      platformPackageCode: packages.platformPackageCode,
      trackingCode: packages.trackingCode,
      needsOpen: packages.needsOpen,
      needsAttention: packages.needsAttention,
    })
    .from(packages)
    .where(eq(packages.orderId, orderId))
    .orderBy(asc(packages.code))
    .for('update');
  if (!rows.length) return [];
  const lines = await db
    .select({
      packageId: packageLines.packageId,
      orderLineId: packageLines.orderLineId,
      variantId: packageLines.variantId,
      quantity: packageLines.quantity,
      reservedQty: packageLines.reservedQty,
    })
    .from(packageLines)
    .where(
      inArray(
        packageLines.packageId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.packageId === r.id).map(({ packageId: _, ...l }) => l) }));
}

export async function insertPackage(input: {
  code: string;
  orderId: string;
  shopId: string | null;
  platformPackageCode: string | null;
  trackingCode: string | null;
  status: PackageStatus;
  shipBy: Date | null;
  handedOverAt?: Date;
  deliveredAt?: Date;
}): Promise<string> {
  const [row] = await getDb()
    .insert(packages)
    .values({ companyId: requireCompanyId('insertPackage'), ...input })
    .returning({ id: packages.id });
  return row!.id;
}

export async function insertPackageLines(
  packageId: string,
  lines: readonly { orderLineId: string; variantId: string | null; quantity: number; reservedQty: number }[],
): Promise<void> {
  if (!lines.length) return;
  const companyId = requireCompanyId('insertPackageLines');
  await getDb()
    .insert(packageLines)
    .values(lines.map((l) => ({ companyId, packageId, ...l })));
}

export async function updatePackage(
  id: string,
  patch: Partial<{
    status: PackageStatus;
    platformPackageCode: string;
    trackingCode: string | null;
    needsOpen: boolean;
    openPurpose: 'cancel' | 'edit' | 'resplit' | null;
    needsAttention: boolean;
    flagNote: string | null;
    handedOverAt: Date;
    deliveredAt: Date;
  }>,
): Promise<void> {
  await getDb()
    .update(packages)
    .set({ ...patch, version: sql`${packages.version} + 1`, updatedAt: sql`now()` })
    .where(eq(packages.id, id));
}

/** Đặt số đang giữ của mọi dòng kiện: 0 hoặc đủ (Documents/25 §7.4). */
export async function setReserved(packageId: string, reserved: boolean): Promise<void> {
  await getDb()
    .update(packageLines)
    .set({ reservedQty: reserved ? sql`${packageLines.quantity}` : 0, version: sql`${packageLines.version} + 1`, updatedAt: sql`now()` })
    .where(eq(packageLines.packageId, packageId));
}

export type PackageViewRow = typeof packages.$inferSelect & {
  lines: { variantId: string | null; orderLineId: string; quantity: number }[];
};

/** Kiện của các đơn kèm dòng, cũ trước; để đọc, không khoá. */
export async function findPackagesOfOrders(orderIds: readonly string[]): Promise<PackageViewRow[]> {
  if (!orderIds.length) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(packages)
    .where(inArray(packages.orderId, [...orderIds]))
    .orderBy(asc(packages.code));
  if (!rows.length) return [];
  const lines = await db
    .select({ packageId: packageLines.packageId, variantId: packageLines.variantId, orderLineId: packageLines.orderLineId, quantity: packageLines.quantity })
    .from(packageLines)
    .where(
      inArray(
        packageLines.packageId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.packageId === r.id) }));
}
