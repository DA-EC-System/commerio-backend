// Xem kiện cho kho (Documents/21 §19.2, spec 199a §5.5): danh sách theo tab có `counts`, chi tiết kèm lịch sử.
// Dựng trang theo lô: dòng kiện một câu, đơn một lần qua `ctx.orderRefsOf`, gian hàng một lần qua `ctx.shopsOf`.
import { getStatusHistory } from '../../../core/index.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import type { PackageTab } from '../domain/package.ts';
import type { SplitLevel } from '../domain/split.ts';
import { countPackageTabs, findPackagePage, findPackagesByIds, type PackageFilter } from '../repository/package-list.ts';
import type { PackageViewRow } from '../repository/packages.ts';
import { type PackageOrderRef, toPackageSummary } from './views.ts';

/**
 * Hàm module khác tiêm vào: tên gian hàng của channel (`src/wiring.ts`), thông tin đơn của sales (`order/index.ts`
 * bằng `withContext`, vì sales đã import fulfillment).
 */
export interface FulfillmentContext extends ModuleContext {
  readonly shopsOf?: (ids: readonly string[]) => Promise<Map<string, { shopName: string; platform: string }>>;
  readonly orderRefsOf?: (orderIds: readonly string[]) => Promise<Map<string, PackageOrderRef>>;
  /** Gian hàng đang chờ kiểm kê đầu kỳ (channel); `lock` khoá dòng gian hàng `FOR SHARE` (spec 199b §5.6). */
  readonly stockHoldOf?: (shopIds: readonly string[], opts?: { lock?: boolean }) => Promise<Set<string>>;
  /** Thao tác kiện trên sàn (channel), tiêm qua src/wiring.ts. */
  readonly marketplacePackages?: MarketplacePackages;
  /** `Order` đầy đủ của sales (spec 205 D9), chạy trong `withCompany` của bên gọi; route tách kiện trả bản này. */
  readonly orderViewOf?: (orderId: string) => Promise<object>;
  /** Mã kiện app kế tiếp (`KH-000001`) từ bộ đếm của sales, trong giao dịch của bên gọi (spec 205 D15). */
  readonly nextPackageCode?: () => Promise<string>;
}

export interface PlatformPackageItems {
  externalOrderId: string;
  externalLineIds: readonly string[];
}

/**
 * Thao tác kiện trên sàn của channel; gọi ngoài giao dịch, lỗi sàn đã là `AppError`. Sàn từ chối tách, hoặc nhóm vượt
 * giới hạn sàn bắt tách (`mustSplitReasons`), thì 422 `split_not_supported` kèm câu của sàn.
 */
export interface MarketplacePackages {
  /** Mức tách kiện của gian hàng theo sàn (spec 205 D6); gian hàng không có thì `none`. */
  splitLevel(companyId: string, shopId: string): Promise<SplitLevel>;
  splitAttributes(
    companyId: string,
    shopId: string,
    externalOrderId: string,
  ): Promise<{
    canSplit: boolean;
    mustSplit: boolean;
    reason: string | null;
    mustSplitReasons: { type: string; externalCategoryId: string | null; maxCount: number | null }[];
  }>;
  /** Mỗi nhóm là mã món sàn của một kiện mới; trả mã kiện sàn theo thứ tự nhóm. */
  split(companyId: string, shopId: string, externalOrderId: string, groups: readonly (readonly string[])[]): Promise<string[]>;
  ship(companyId: string, shopId: string, packageCode: string, opts?: { handover?: 'pickup' | 'drop_off' }): Promise<void>;
  carriers(companyId: string, shopId: string, ref: PlatformPackageItems): Promise<{ code: string; name: string; isDefault: boolean }[]>;
  pack(companyId: string, shopId: string, ref: PlatformPackageItems & { carrierCode?: string }): Promise<{
    packageCode: string;
    trackingCode: string | null;
    carrier: { code: string; name: string } | null;
  } | null>;
  readyToShip(companyId: string, shopId: string, packageCode: string): Promise<void>;
  repack(companyId: string, shopId: string, packageCode: string): Promise<'repacked' | 'not_supported'>;
  shippingDocuments(companyId: string, shopId: string, packageCodes: readonly string[]): Promise<Uint8Array[]>;
}

export function stockHoldLookupOf(ctx: Pick<FulfillmentContext, 'stockHoldOf'>) {
  if (!ctx.stockHoldOf) throw new AppError(500, 'internal_error', 'Chưa nối trạng thái gian hàng của channel (src/wiring.ts)');
  return ctx.stockHoldOf;
}

export function orderRefsLookupOf(ctx: FulfillmentContext) {
  if (!ctx.orderRefsOf) throw new AppError(500, 'internal_error', 'Chưa nối dữ liệu đơn của sales (src/modules/order/index.ts)');
  return ctx.orderRefsOf;
}

export function orderViewLookupOf(ctx: FulfillmentContext) {
  if (!ctx.orderViewOf) throw new AppError(500, 'internal_error', 'Chưa nối chi tiết đơn của sales (src/modules/order/index.ts)');
  return ctx.orderViewOf;
}

export function packageCodeLookupOf(ctx: FulfillmentContext) {
  if (!ctx.nextPackageCode) throw new AppError(500, 'internal_error', 'Chưa nối bộ đếm mã kiện của sales (src/modules/order/index.ts)');
  return ctx.nextPackageCode;
}

export function marketplacePackagesOf(ctx: FulfillmentContext): MarketplacePackages {
  if (!ctx.marketplacePackages) throw new AppError(500, 'internal_error', 'Chưa nối cổng thao tác kiện của channel (src/wiring.ts)');
  return ctx.marketplacePackages;
}

const unique = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => id !== null))];

async function summaries(ctx: FulfillmentContext, rows: readonly PackageViewRow[], now: number) {
  const shopIds = unique(rows.map((r) => r.shopId));
  const [orders, shops] = await Promise.all([
    orderRefsLookupOf(ctx)(unique(rows.map((r) => r.orderId))),
    ctx.shopsOf && shopIds.length ? ctx.shopsOf(shopIds) : Promise.resolve(new Map<string, { shopName: string; platform: string }>()),
  ]);
  return rows.map((p) => {
    const order = orders.get(p.orderId);
    // Kiện luôn có đơn cùng công ty; thiếu là dữ liệu hỏng.
    if (!order) throw new Error(`Kiện ${p.id} không có đơn ${p.orderId}`);
    const shop = p.shopId ? shops.get(p.shopId) : undefined;
    return toPackageSummary(p, order, shop && p.shopId ? { id: p.shopId, shopName: shop.shopName, platform: shop.platform } : null, now);
  });
}

export async function listPackages(ctx: FulfillmentContext, q: PackageFilter & { tab: PackageTab; page: number; pageSize: number }) {
  const filter: PackageFilter = { search: q.search, source: q.source, shopId: q.shopId };
  const [{ rows, total }, counts] = await Promise.all([
    findPackagePage({ ...filter, tab: q.tab, limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
    countPackageTabs(filter),
  ]);
  return { items: await summaries(ctx, rows, Date.now()), total, page: q.page, pageSize: q.pageSize, counts };
}

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy kiện');

export async function getPackage(ctx: FulfillmentContext, id: string) {
  if (!isUuid(id)) throw notFound();
  const [row] = await findPackagesByIds([id]);
  if (!row) throw notFound();
  const [[summary], history] = await Promise.all([summaries(ctx, [row], Date.now()), getStatusHistory('packages', id)]);
  return { ...summary!, statusHistory: history.map((h) => ({ ...h, at: h.at.toISOString() })) };
}
