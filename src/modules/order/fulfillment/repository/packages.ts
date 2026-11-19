import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { canReportLost, HANDED_OVER, isSealed, type PackageStatus } from '../domain/package.ts';
import type { HandoverSource, PlanLine } from '../domain/handover.ts';
import type { MappedSku } from '../domain/remap.ts';
import { type OpenPurpose, type PackageNotice, packageLines, packages } from './schema.ts';

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
  /** Kiện lần đầu thấy đã `lost` (sàn báo, spec #238 §5.4). */
  lostSource?: 'marketplace';
  /** Kiện tách từ kiện `reserved` mang lúc giữ của kiện cũ (spec 205 D4). */
  reservedAt?: Date | null;
  /** Kiện lập khi sàn chia lại kiện: kiện cũ nó thay (spec #238 §5.6), chỉ để truy vết. */
  replacesPackageId?: string;
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
  lines: readonly { orderLineId: string; variantId: string | null; quantity: number; reservedQty: number; stockUntracked?: boolean }[],
): Promise<string[]> {
  if (!lines.length) return [];
  const companyId = requireCompanyId('insertPackageLines');
  const rows = await getDb()
    .insert(packageLines)
    .values(lines.map((l) => ({ companyId, packageId, ...l })))
    .returning({ id: packageLines.id });
  return rows.map((r) => r.id);
}

type LostColumns = {
  lostReportedBy: string | null;
  lostReportedAt: Date | SQL | null;
  lostClaimCode: string | null;
  lostConfirmedBy: string | null;
  lostSelfApproved: boolean;
  lostSource: 'user' | 'marketplace' | null;
};

/**
 * Luật xoá cột thất lạc theo lần ghi (spec #238 §5.3, D14, D21), một chỗ cho mọi service:
 * - ghi `status` khác `lost` → xoá người xác nhận, nguồn, cờ tự duyệt (chỉ có nghĩa khi kiện đang `lost`);
 * - ghi `status` khác `lost` mà không còn báo mất được, hoặc kiện đang rời `lost` → xoá báo cáo treo (người báo, giờ,
 *   mã khiếu nại; hồ sơ đã nằm ở lịch sử trạng thái);
 * - gỡ `needs_open` mà không ghi `status` → xoá báo cáo treo (kiện đã đóng chỉ báo mất được khi đang chờ mở).
 * Bên gọi truyền cột `lost_*` tường minh thì giá trị đó thắng luật.
 */
function lostColumnRules(patch: { status?: PackageStatus; needsOpen?: boolean }): { [K in keyof LostColumns]?: LostColumns[K] | SQL } {
  const clearReport = { lostReportedBy: null, lostReportedAt: null, lostClaimCode: null };
  if (patch.status !== undefined && patch.status !== 'lost') {
    const report = canReportLost(patch.status)
      ? {
          // Trong `UPDATE … SET`, cột bên phải là giá trị cũ: kiện rời `lost` thì xoá, còn lại giữ.
          lostReportedBy: sql`case when ${packages.status} = 'lost' then null else ${packages.lostReportedBy} end`,
          lostReportedAt: sql`case when ${packages.status} = 'lost' then null else ${packages.lostReportedAt} end`,
          lostClaimCode: sql`case when ${packages.status} = 'lost' then null else ${packages.lostClaimCode} end`,
        }
      : clearReport;
    return { lostConfirmedBy: null, lostSource: null, lostSelfApproved: false, ...report };
  }
  if (patch.status === undefined && patch.needsOpen === false) return clearReport;
  return {};
}

/** Cần xử lý khi sàn báo kiện rời kho lúc còn chờ dỡ kiện về kệ (spec #238 D27). */
export const LEFT_WHILE_AWAITING_OPEN_NOTE = 'Sàn báo kiện rời kho khi còn chờ dỡ kiện về kệ';

/**
 * Cờ Cần mở chỉ có nghĩa khi kiện còn đóng trong kho (spec #238 §5.5, D27): kiện rời nhóm đã đóng (sau D28 chỉ còn đường
 * sàn báo rời kho) mà bên gọi không ghi cờ thì gỡ, để kiện không nằm mãi trong tab Cần mở. Mục đích `cancel`, `edit`,
 * `resplit` thì bật Cần xử lý (hộp đi theo sàn mà kho chưa dỡ); kiện đã có Cần xử lý thì giữ ghi chú cũ. `stocktake` gỡ
 * im. Trong `UPDATE … SET`, cột bên phải là giá trị cũ; bên gọi ghi `needsAttention`/`flagNote` tường minh thì thắng.
 */
function openFlagRules(patch: { status?: PackageStatus; needsOpen?: boolean; openPurpose?: unknown; needsAttention?: boolean; flagNote?: unknown }) {
  if (patch.status === undefined || isSealed(patch.status) || patch.needsOpen !== undefined || patch.openPurpose !== undefined) return {};
  const attention = sql`${packages.openPurpose} in ('cancel', 'edit', 'resplit')`;
  return {
    needsOpen: sql`false`,
    openPurpose: sql`null`,
    needsAttention: sql`case when ${attention} then true else ${packages.needsAttention} end`,
    flagNote: sql`case when ${attention} and not ${packages.needsAttention} then ${LEFT_WHILE_AWAITING_OPEN_NOTE}::text else ${packages.flagNote} end`,
  };
}

/**
 * Giữ vận đơn sau khi mở kiện `awaiting_pickup` (spec #238 D25) chỉ có nghĩa tới khi kiện báo sẵn sàng lại: kiện sang
 * trạng thái ngoài `backordered`, `reserved`, `packed` mà bên gọi không ghi cột này thì tắt (CHECK `packages_waybill_kept`
 * không đổi vì mã, vận đơn giữ nguyên).
 */
function waybillRules(patch: { status?: PackageStatus; waybillKept?: boolean }) {
  if (patch.status === undefined || patch.waybillKept !== undefined) return {};
  return patch.status === 'backordered' || patch.status === 'reserved' || patch.status === 'packed' ? {} : { waybillKept: false };
}

export async function updatePackage(
  id: string,
  patch: Partial<{
    status: PackageStatus;
    platformPackageCode: string | null;
    trackingCode: string | null;
    carrierCode: string | null;
    carrierName: string | null;
    labelError: boolean;
    packedBy: string | null;
    packedAt: Date | null;
    needsOpen: boolean;
    openPurpose: OpenPurpose | null;
    needsAttention: boolean;
    flagNote: string | null;
    notices: PackageNotice[];
    handedOverAt: Date | SQL | null;
    handedOverBy: string | null;
    handoverSource: HandoverSource | null;
    handoverRevertedBy: string;
    pickupConfirmedAt: Date | null;
    deliveredAt: Date;
    reservedAt: Date | SQL | null;
    deliveryPostedAt: Date | SQL | null;
    waybillKept: boolean;
  }> &
    Partial<PackageShipping> &
    Partial<LostColumns>,
): Promise<void> {
  await getDb()
    .update(packages)
    .set({
      ...lostColumnRules(patch),
      ...openFlagRules(patch),
      ...waybillRules(patch),
      ...patch,
      version: sql`${packages.version} + 1`,
      updatedAt: sql`now()`,
    })
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
  /** Mã vận đơn của sàn; quét nhận hoàn (spec 199c §5.5) so mã để khớp kiện, không thêm câu đọc. */
  trackingCode: string | null;
  needsAttention: boolean;
  needsOpen: boolean;
  selfDelivery: boolean;
  /** Báo cáo thất lạc đang treo (spec #238 §5.3): người báo và mã khiếu nại cùng có hoặc cùng không. */
  lostReportedBy: string | null;
  lostClaimCode: string | null;
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
  trackingCode: packages.trackingCode,
  needsAttention: packages.needsAttention,
  needsOpen: packages.needsOpen,
  selfDelivery: packages.selfDelivery,
  lostReportedBy: packages.lostReportedBy,
  lostClaimCode: packages.lostClaimCode,
};

/** Dòng kiện kèm dòng đơn và số chờ bỏ (spec 205 §5.10). */
export type PackageLineRow = PlanLine & { orderLineId: string; pendingDropQty: number };

/** Dòng của các kiện, theo thứ tự chèn ổn định (id dòng). */
export async function planLinesOf(packageIds: readonly string[]): Promise<Map<string, PackageLineRow[]>> {
  const byPackage = new Map<string, PackageLineRow[]>(packageIds.map((id) => [id, []]));
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
      stockUntracked: packageLines.stockUntracked,
      pendingDropQty: packageLines.pendingDropQty,
    })
    .from(packageLines)
    .where(inArray(packageLines.packageId, [...packageIds]))
    .orderBy(asc(packageLines.createdAt), asc(packageLines.id));
  for (const { packageId, ...l } of rows) byPackage.get(packageId)!.push(l);
  return byPackage;
}

/** Gian hàng của kiện, đọc không khoá (route kho quét khoá gian hàng trước khi khoá kiện, spec 199b §5.7). */
export async function packageShopOf(id: string): Promise<{ shopId: string | null } | undefined> {
  const [row] = await getDb().select({ shopId: packages.shopId }).from(packages).where(eq(packages.id, id));
  return row;
}

/** Một kiện kèm dòng, khoá dòng kiện tới hết giao dịch; không có (hoặc công ty khác, RLS) thì `undefined`. */
export async function lockPackage(id: string): Promise<(Omit<HandoverPackage, 'lines'> & { lines: PackageLineRow[] }) | undefined> {
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
  /** Mục đích mở kiện (`cancel`, `edit`, `resplit`, `stocktake`); null khi không chờ mở. */
  openPurpose: OpenPurpose | null;
  labelError: boolean;
  /** Kiện cũ mà kiện này thay khi sàn chia lại kiện (spec #238 §5.6). */
  replacesPackageId: string | null;
  /** Đã mở kiện `awaiting_pickup`, giữ vận đơn: đóng gói, báo sẵn sàng lại không gọi sàn (D25). */
  waybillKept: boolean;
  shipping: PackageShipping;
  lines: PackageLineRow[];
}

async function orderPackages(orderId: string, lock: boolean): Promise<PackageRow[]> {
  const db = getDb();
  const query = db
    .select({
      ...handoverColumns,
      platformPackageCode: packages.platformPackageCode,
      trackingCode: packages.trackingCode,
      openPurpose: packages.openPurpose,
      labelError: packages.labelError,
      replacesPackageId: packages.replacesPackageId,
      waybillKept: packages.waybillKept,
      shipping: {
        shipmentProvider: packages.shipmentProvider,
        shippingProviderType: packages.shippingProviderType,
        shippingType: packages.shippingType,
        promisedShippingAt: packages.promisedShippingAt,
      },
    })
    .from(packages)
    .where(eq(packages.orderId, orderId))
    .orderBy(asc(packages.code));
  const rows = lock ? await query.for('update') : await query;
  if (!rows.length) return [];
  const lines = await planLinesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lines: lines.get(r.id)! }));
}

/** Các kiện của đơn kèm dòng, khoá dòng kiện tới hết giao dịch. */
export function lockOrderPackages(orderId: string): Promise<PackageRow[]> {
  return orderPackages(orderId, true);
}

/**
 * Như `lockOrderPackages` nhưng không khoá: lượt kéo đơn xem trước kế hoạch chia lại kiện để biết có phải lấy khoá
 * advisory phân hàng trước khi khoá kiện không (spec #238 §5.6 "Khoá").
 */
export function readOrderPackages(orderId: string): Promise<PackageRow[]> {
  return orderPackages(orderId, false);
}

/**
 * Kiện có dòng trỏ tới các dòng đơn (mọi trạng thái) kèm dòng, khoá theo id tăng dần tới hết giao dịch (spec 237 §5.5,
 * thứ tự khoá §5.8: sau khoá advisory phân hàng).
 */
export async function lockPackagesOfOrderLines(orderLineIds: readonly string[]): Promise<(HandoverPackage & { lines: PackageLineRow[] })[]> {
  if (!orderLineIds.length) return [];
  const db = getDb();
  const rows = await db
    .select(handoverColumns)
    .from(packages)
    .where(
      inArray(
        packages.id,
        db.select({ id: packageLines.packageId }).from(packageLines).where(inArray(packageLines.orderLineId, [...orderLineIds])),
      ),
    )
    .orderBy(asc(packages.id))
    .for('update');
  const lines = await planLinesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lines: lines.get(r.id)! }));
}

/** Ghi ghép SKU lên dòng kiện (spec 237): biến thể hoặc "không quản tồn". Không đổi số giữ, số trừ. */
export async function setLineSku(lineIds: readonly string[], to: MappedSku): Promise<void> {
  if (!lineIds.length) return;
  await getDb()
    .update(packageLines)
    .set({
      variantId: to.kind === 'variant' ? to.variantId : null,
      stockUntracked: to.kind === 'untracked',
      version: sql`${packageLines.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(packageLines.id, [...lineIds]));
}

/** Dòng vừa giữ được hàng: `reserved_qty = quantity`. */
export async function markLinesReserved(lineIds: readonly string[]): Promise<void> {
  if (!lineIds.length) return;
  await getDb()
    .update(packageLines)
    .set({ reservedQty: sql`${packageLines.quantity}`, version: sql`${packageLines.version} + 1`, updatedAt: sql`now()` })
    .where(inArray(packageLines.id, [...lineIds]));
}

/**
 * Kiện thay được lấy trước khi kho dỡ kiện cũ (spec #238 §5.6): dòng đích nhận `reserved_qty` của dòng nguồn (dòng chờ
 * bỏ cùng dòng đơn ở kiện cũ), rồi xoá dòng nguồn. Không đổi tổng đang giữ theo SKU nên không gọi cổng tồn. Một câu
 * update, một câu delete; bên gọi đã khoá cả hai kiện.
 */
export async function moveReservations(pairs: readonly { fromLineId: string; toLineId: string }[]): Promise<void> {
  if (!pairs.length) return;
  const values = sql.join(
    pairs.map((p) => sql`(${p.fromLineId}::uuid, ${p.toLineId}::uuid)`),
    sql`, `,
  );
  await getDb().execute(sql`
    update ${packageLines} as t set reserved_qty = f.reserved_qty, version = t.version + 1, updated_at = now()
    from (values ${values}) as v(from_id, to_id) join ${packageLines} as f on f.id = v.from_id
    where t.id = v.to_id`);
  await getDb()
    .delete(packageLines)
    .where(
      inArray(
        packageLines.id,
        pairs.map((p) => p.fromLineId),
      ),
    );
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

/**
 * Đặt số đang giữ của mọi dòng kiện: 0 hoặc đủ (Documents/25 §7.4), và lúc giữ của kiện (`reserved_at`, spec 199b §5.1).
 * Không tăng `version` của kiện: bên gọi đổi trạng thái thì `updatePackage` tăng.
 */
export async function setReserved(packageId: string, reserved: boolean): Promise<void> {
  const db = getDb();
  await db
    .update(packageLines)
    .set({ reservedQty: reserved ? sql`${packageLines.quantity}` : 0, version: sql`${packageLines.version} + 1`, updatedAt: sql`now()` })
    .where(eq(packageLines.packageId, packageId));
  await db
    .update(packages)
    .set({ reservedAt: reserved ? sql`now()` : null, updatedAt: sql`now()` })
    .where(eq(packages.id, packageId));
}

export type PackageViewRow = typeof packages.$inferSelect & {
  lines: { id: string; variantId: string | null; stockUntracked: boolean; orderLineId: string; quantity: number; pendingDropQty: number }[];
  /** Kiện cũ mà kiện này thay khi sàn chia lại kiện (spec #238 §5.6); null khi không phải kiện thay. */
  replaces: { id: string; code: string; status: PackageStatus } | null;
};

/**
 * Gắn dòng cho các kiện đã đọc (một câu), giữ thứ tự kiện; kiện thay gắn thêm mã, trạng thái của kiện cũ (một câu, chỉ
 * khi có kiện thay). Mọi đường dựng `PackageViewRow` đi qua đây.
 */
export async function attachViewLines(rows: (typeof packages.$inferSelect)[]): Promise<PackageViewRow[]> {
  if (!rows.length) return [];
  const replacedIds = [...new Set(rows.flatMap((r) => (r.replacesPackageId ? [r.replacesPackageId] : [])))];
  const replaced = replacedIds.length
    ? await getDb().select({ id: packages.id, code: packages.code, status: packages.status }).from(packages).where(inArray(packages.id, replacedIds))
    : [];
  const replacedById = new Map(replaced.map((r) => [r.id, r]));
  const lines = await getDb()
    .select({
      packageId: packageLines.packageId,
      id: packageLines.id,
      variantId: packageLines.variantId,
      stockUntracked: packageLines.stockUntracked,
      orderLineId: packageLines.orderLineId,
      quantity: packageLines.quantity,
      pendingDropQty: packageLines.pendingDropQty,
    })
    .from(packageLines)
    .where(
      inArray(
        packageLines.packageId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(packageLines.createdAt), asc(packageLines.id));
  return rows.map((r) => ({
    ...r,
    lines: lines.filter((l) => l.packageId === r.id),
    replaces: (r.replacesPackageId && replacedById.get(r.replacesPackageId)) || null,
  }));
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
