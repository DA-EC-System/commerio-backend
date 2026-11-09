import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { HANDED_OVER, type PackageStatus } from '../domain/package.ts';
import type { HandoverSource, PlanLine } from '../domain/handover.ts';
import { type PackageNotice, packageLines, packages } from './schema.ts';

/** Vận chuyển sàn trả cho kiện (#260); null khi sàn chưa trả. */
export interface PackageShipping {
  shipmentProvider: string | null;
  shippingProviderType: string | null;
  shippingType: string | null;
  promisedShippingAt: Date | null;
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
  handoverSource?: HandoverSource;
  pickupConfirmedAt?: Date;
  deliveredAt?: Date;
} & Partial<PackageShipping>): Promise<string> {
  const [row] = await getDb()
    .insert(packages)
    .values({ companyId: requireCompanyId('insertPackage'), ...input })
    .returning({ id: packages.id });
  return row!.id;
}

/** Chèn dòng kiện, trả id theo đúng thứ tự `lines`. */
export async function insertPackageLines(
  packageId: string,
  lines: readonly { orderLineId: string; variantId: string | null; quantity: number; reservedQty: number }[],
): Promise<string[]> {
  if (!lines.length) return [];
  const companyId = requireCompanyId('insertPackageLines');
  const rows = await getDb()
    .insert(packageLines)
    .values(lines.map((l) => ({ companyId, packageId, ...l })))
    .returning({ id: packageLines.id });
  return rows.map((r) => r.id);
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
    notices: PackageNotice[];
    handedOverAt: Date | null;
    handedOverBy: string | null;
    handoverSource: HandoverSource | null;
    handoverRevertedBy: string;
    pickupConfirmedAt: Date | null;
    deliveredAt: Date;
  }> &
    Partial<PackageShipping>,
): Promise<void> {
  await getDb()
    .update(packages)
    .set({ ...patch, version: sql`${packages.version} + 1`, updatedAt: sql`now()` })
    .where(eq(packages.id, id));
}

/** Kiện kèm dòng cho lõi bàn giao trừ tồn (`service/handover-stock.ts`). */
export interface HandoverPackage {
  id: string;
  code: string;
  orderId: string;
  shopId: string | null;
  status: PackageStatus;
  version: number;
  handoverSource: HandoverSource | null;
  pickupConfirmedAt: Date | null;
  handedOverAt: Date | null;
  needsAttention: boolean;
  lines: PlanLine[];
}

const handoverColumns = {
  id: packages.id,
  code: packages.code,
  orderId: packages.orderId,
  shopId: packages.shopId,
  status: packages.status,
  version: packages.version,
  handoverSource: packages.handoverSource,
  pickupConfirmedAt: packages.pickupConfirmedAt,
  handedOverAt: packages.handedOverAt,
  needsAttention: packages.needsAttention,
};

/** Dòng của các kiện, theo thứ tự chèn ổn định (id dòng). */
async function planLinesOf(packageIds: readonly string[]): Promise<Map<string, (PlanLine & { orderLineId: string })[]>> {
  const byPackage = new Map<string, (PlanLine & { orderLineId: string })[]>(packageIds.map((id) => [id, []]));
  if (!packageIds.length) return byPackage;
  const rows = await getDb()
    .select({
      packageId: packageLines.packageId,
      id: packageLines.id,
      orderLineId: packageLines.orderLineId,
      variantId: packageLines.variantId,
      quantity: packageLines.quantity,
      reservedQty: packageLines.reservedQty,
      stockDeducted: packageLines.stockDeducted,
    })
    .from(packageLines)
    .where(inArray(packageLines.packageId, [...packageIds]))
    .orderBy(asc(packageLines.createdAt), asc(packageLines.id));
  for (const { packageId, ...l } of rows) byPackage.get(packageId)!.push(l);
  return byPackage;
}

/** Một kiện kèm dòng, khoá dòng kiện tới hết giao dịch; không có (hoặc công ty khác, RLS) thì `undefined`. */
export async function lockPackage(id: string): Promise<HandoverPackage | undefined> {
  const [row] = await getDb().select(handoverColumns).from(packages).where(eq(packages.id, id)).for('update');
  if (!row) return undefined;
  return { ...row, lines: (await planLinesOf([row.id])).get(row.id)! };
}

/**
 * Kiện của gian hàng đã rời kho mà còn dòng đã ghép SKU chưa trừ, trừ kiện `before_cutoff` (hàm bù cho #198). Khoá
 * theo mã kiện tăng dần.
 */
export async function lockDeferredPackages(shopId: string): Promise<HandoverPackage[]> {
  const rows = await getDb()
    .select(handoverColumns)
    .from(packages)
    .where(
      and(
        eq(packages.shopId, shopId),
        inArray(packages.status, [...HANDED_OVER]),
        sql`${packages.handoverSource} is distinct from 'before_cutoff'`,
        sql`exists (select 1 from ${packageLines} where ${packageLines.packageId} = ${packages.id}
                    and ${packageLines.variantId} is not null and not ${packageLines.stockDeducted})`,
      ),
    )
    .orderBy(asc(packages.code))
    .for('update');
  const lines = await planLinesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lines: lines.get(r.id)! }));
}

/** Kiện của đơn sàn kèm dòng, đủ trường cho lõi bàn giao (`HandoverPackage`). */
export interface PackageRow extends HandoverPackage {
  platformPackageCode: string | null;
  trackingCode: string | null;
  needsOpen: boolean;
  shipping: PackageShipping;
  lines: (PlanLine & { orderLineId: string })[];
}

/** Các kiện của đơn kèm dòng, khoá dòng kiện tới hết giao dịch. */
export async function lockOrderPackages(orderId: string): Promise<PackageRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      ...handoverColumns,
      platformPackageCode: packages.platformPackageCode,
      trackingCode: packages.trackingCode,
      needsOpen: packages.needsOpen,
      shipping: {
        shipmentProvider: packages.shipmentProvider,
        shippingProviderType: packages.shippingProviderType,
        shippingType: packages.shippingType,
        promisedShippingAt: packages.promisedShippingAt,
      },
    })
    .from(packages)
    .where(eq(packages.orderId, orderId))
    .orderBy(asc(packages.code))
    .for('update');
  if (!rows.length) return [];
  const lines = await planLinesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lines: lines.get(r.id)! }));
}

/** Dòng vừa giữ được hàng: `reserved_qty = quantity`. */
export async function markLinesReserved(lineIds: readonly string[]): Promise<void> {
  if (!lineIds.length) return;
  await getDb()
    .update(packageLines)
    .set({ reservedQty: sql`${packageLines.quantity}`, version: sql`${packageLines.version} + 1`, updatedAt: sql`now()` })
    .where(inArray(packageLines.id, [...lineIds]));
}

/** Dòng vừa trừ tồn: chốt giá vốn, `stock_deducted`, hết giữ. Một câu cho mọi dòng. */
export async function markLinesShipped(rows: readonly { id: string; unitCost: string }[]): Promise<void> {
  if (!rows.length) return;
  const values = sql.join(
    rows.map((r) => sql`(${r.id}::uuid, ${r.unitCost}::numeric)`),
    sql`, `,
  );
  await getDb().execute(sql`
    update ${packageLines} set unit_cost = v.cost, stock_deducted = true, reserved_qty = 0,
      version = ${packageLines.version} + 1, updated_at = now()
    from (values ${values}) as v(id, cost)
    where ${packageLines.id} = v.id`);
}

/** Dòng vừa đảo bàn giao: giữ hàng lại (inventory đã cộng lại đang giữ), bỏ cờ đã trừ, bỏ giá vốn. */
export async function markLinesReverted(lineIds: readonly string[]): Promise<void> {
  if (!lineIds.length) return;
  await getDb()
    .update(packageLines)
    .set({
      reservedQty: sql`${packageLines.quantity}`,
      stockDeducted: false,
      unitCost: null,
      version: sql`${packageLines.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(packageLines.id, [...lineIds]));
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

/** Gắn dòng cho các kiện đã đọc (một câu), giữ thứ tự kiện. */
export async function attachViewLines(rows: (typeof packages.$inferSelect)[]): Promise<PackageViewRow[]> {
  if (!rows.length) return [];
  const lines = await getDb()
    .select({ packageId: packageLines.packageId, variantId: packageLines.variantId, orderLineId: packageLines.orderLineId, quantity: packageLines.quantity })
    .from(packageLines)
    .where(
      inArray(
        packageLines.packageId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(packageLines.createdAt), asc(packageLines.id));
  return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.packageId === r.id) }));
}

/** Kiện của các đơn kèm dòng, cũ trước; để đọc, không khoá. */
export async function findPackagesOfOrders(orderIds: readonly string[]): Promise<PackageViewRow[]> {
  if (!orderIds.length) return [];
  return attachViewLines(
    await getDb()
      .select()
      .from(packages)
      .where(inArray(packages.orderId, [...orderIds]))
      .orderBy(asc(packages.code)),
  );
}
