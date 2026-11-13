import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { packageTabCondition } from './package-list.ts';
import { planLinesOf } from './packages.ts';
import { packageLines, packages } from './schema.ts';

const packingColumns = {
  id: packages.id, code: packages.code, orderId: packages.orderId, shopId: packages.shopId,
  status: packages.status, version: packages.version, selfDelivery: packages.selfDelivery,
  platformPackageCode: packages.platformPackageCode, trackingCode: packages.trackingCode, labelError: packages.labelError,
};

async function packingPackage(id: string, lock: boolean) {
  const query = getDb().select(packingColumns).from(packages).where(eq(packages.id, id));
  const [row] = await (lock ? query.for('update') : query);
  return row && { ...row, lines: (await planLinesOf([row.id])).get(row.id)! };
}

export type PackingPackage = NonNullable<Awaited<ReturnType<typeof packingPackage>>>;
export const readPackingPackage = (id: string) => packingPackage(id, false);
export const lockPackingPackage = (id: string) => packingPackage(id, true);

export async function packageGroupOf(shopId: string, platformPackageCode: string) {
  return getDb().select({ id: packages.id, code: packages.code, orderId: packages.orderId, status: packages.status, version: packages.version })
    .from(packages)
    .where(and(eq(packages.shopId, shopId), eq(packages.platformPackageCode, platformPackageCode), ne(packages.status, 'cancelled')))
    .orderBy(asc(packages.id));
}

export async function lockReadyPackages(ids: readonly string[]) {
  return getDb().select(packingColumns).from(packages).where(inArray(packages.id, [...ids])).orderBy(asc(packages.id)).for('update');
}

export async function platformItemsOf(packageId: string) {
  const { rows } = await getDb().execute<{ externalOrderId: string | null; externalLineId: string | null }>(sql`
    select o.external_order_id as "externalOrderId", l.external_line_id as "externalLineId"
    from ${packages}
    join "order".orders o on o.id = ${packages.orderId}
    join ${packageLines} on ${packageLines.packageId} = ${packages.id}
    join "order".order_lines l on l.id = ${packageLines.orderLineId} and l.order_id = o.id
    where ${packages.id} = ${packageId}
    order by l.external_line_id
  `);
  const externalOrderId = rows[0]?.externalOrderId;
  if (!externalOrderId || rows.some((line) => !line.externalLineId)) {
    throw new AppError(409, 'item_not_packable', 'Kiện thiếu mã đơn hoặc mã món trên sàn');
  }
  return { externalOrderId, externalLineIds: rows.map((row) => row.externalLineId!) };
}

export async function setLinesPacked(packageId: string, packed: boolean): Promise<void> {
  await getDb().update(packageLines)
    .set({ packedQty: packed ? sql`${packageLines.quantity}` : 0, updatedAt: sql`now()`, version: sql`${packageLines.version} + 1` })
    .where(eq(packageLines.packageId, packageId));
}

export async function pickListBase(filter: { ids: readonly string[] } | { limit: number }) {
  const db = getDb();
  const order = [sql`${packages.shipBy} asc nulls last`, asc(packages.code)] as const;
  const selected = 'ids' in filter
    ? db.select({ packageId: packages.id, orderId: packages.orderId }).from(packages).where(inArray(packages.id, [...filter.ids])).orderBy(...order)
    : db.select({ packageId: packages.id, orderId: packages.orderId }).from(packages).where(packageTabCondition('reserved')).orderBy(...order).limit(filter.limit + 1);
  const page = db.$with('pick_page').as(selected);
  const rows = await db.with(page).select({
    packageId: page.packageId, orderId: page.orderId, orderLineId: packageLines.orderLineId,
    variantId: packageLines.variantId, quantity: packageLines.quantity,
  }).from(page)
    .innerJoin(packages, eq(packages.id, page.packageId))
    .leftJoin(packageLines, eq(packageLines.packageId, page.packageId))
    .orderBy(...order, asc(packageLines.id));
  const ids = [...new Set(rows.map((row) => row.packageId))];
  const truncated = 'limit' in filter && ids.length > filter.limit;
  const excluded = truncated ? ids.pop() : undefined;
  return {
    rows: rows.flatMap(({ packageId, orderId, orderLineId, variantId, quantity }) =>
      packageId !== excluded && orderLineId && quantity !== null ? [{ packageId, orderId, orderLineId, variantId, quantity }] : [],
    ),
    packageIds: ids,
    truncated,
  };
}
