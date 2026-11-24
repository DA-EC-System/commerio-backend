// `ctx` của catalog và lý do chặn lưu trữ SKU (#204, Documents/21 §17.1, §17.3, spec 204 mục 5.2, 5.3). Tồn, chứng từ,
// đơn, listing nằm ở module khác: mỗi module tự trả phần của mình (câu lý do, ngưỡng tồn, hiện diện), catalog chỉ gom lại.
// - inventory, purchasing (cùng module lớn, đã import catalog): `product/index.ts` nối bằng `withContext`;
// - order, channel (module lớn lớp trên): `src/wiring.ts` nối.
import type { ModuleContext } from '../../../../shared/module.ts';
import type { Presence } from '../domain/labels.ts';

/**
 * Câu lý do chặn lưu trữ theo SKU; SKU không vướng gì thì không có trong Map. Gọi trong `withCompany` của catalog.
 * `lock`: thao tác lưu trữ, nguồn khoá được phần của mình tới hết giao dịch (inventory khoá dòng tồn); xem chi tiết thì
 * không khoá.
 */
export type ArchiveBlockerSource = (variantIds: readonly string[], options?: { lock?: boolean }) => Promise<Map<string, string[]>>;

/** Hiện diện trên sàn của một SKU (D8). */
export interface ListingPresence {
  presence: Presence;
  /** Có listing lỗi, kể cả khi đã `live` (nhãn phụ "Có lỗi"). */
  hasListingError: boolean;
  /** Số listing chưa gỡ, mọi gian hàng. */
  listingCount: number;
}

/** `ctx` mà router của catalog nhận. */
export interface CatalogContext extends ModuleContext {
  /** Tồn thực, đang giữ, chờ xử lý, phiếu kho mở; khoá dòng tồn tới hết giao dịch (spec 204 D10). */
  readonly stockArchiveBlockers?: ArchiveBlockerSource;
  /** Đang về, đề nghị nhập, phiếu nhận, phiếu trả NCC chưa xong. */
  readonly purchaseArchiveBlockers?: ArchiveBlockerSource;
  /** Đơn `unpaid`, `processing`; yêu cầu trả đang mở. */
  readonly orderArchiveBlockers?: ArchiveBlockerSource;
  /** Listing đang đẩy lên sàn. */
  readonly listingArchiveBlockers?: ArchiveBlockerSource;
  /** Ngưỡng tồn theo SKU (inventory); Map đủ mọi id, chưa đặt là null. Không khoá. */
  readonly minQtyOf?: (variantIds: readonly string[]) => Promise<Map<string, number | null>>;
  /** Hiện diện trên sàn theo SKU (channel, D8); Map đủ mọi id. */
  readonly listingPresenceOf?: (variantIds: readonly string[]) => Promise<Map<string, ListingPresence>>;
  /**
   * Độ phủ sàn (channel, FE#464): gian hàng chưa ngắt và gian hàng mà từng SKU đã lên sàn hoặc đang đẩy. Chỉ gọi khi người
   * xem có `channel.shop.view`.
   */
  readonly channelCoverageOf?: (
    variantIds: readonly string[],
  ) => Promise<{ shops: { shopId: string; shopName: string; platform: string }[]; listedShops: Map<string, Set<string>> }>;
  /** SKU đã dùng ở từng module (mọi trạng thái chứng từ): có thì không xoá hẳn sản phẩm (spec 204 mục 6). */
  readonly stockInUse?: InUseSource;
  readonly purchaseInUse?: InUseSource;
  readonly orderInUse?: InUseSource;
  readonly listingInUse?: InUseSource;
  /** Xoá dòng tồn của SKU khi xoá hẳn sản phẩm (inventory; dòng chỉ còn ngưỡng tồn). */
  readonly deleteStockLevels?: (variantIds: readonly string[]) => Promise<void>;
}

/** SKU đã dùng trong `variantIds`; SKU chưa dùng thì không có trong Set. Gọi trong `withCompany` của catalog. */
export type InUseSource = (variantIds: readonly string[]) => Promise<Set<string>>;

const IN_USE_SOURCES = ['stockInUse', 'purchaseInUse', 'orderInUse', 'listingInUse'] as const;

/** Gộp SKU đã dùng của bốn module. Thiếu nguồn là lỗi lập trình. `variantIds` rỗng thì không gọi nguồn nào. */
export async function inUseOf(ctx: CatalogContext, variantIds: readonly string[]): Promise<Set<string>> {
  const result = new Set<string>();
  if (!variantIds.length) return result;
  for (const name of IN_USE_SOURCES) {
    const source = ctx[name];
    if (!source) throw new Error(`Chưa nối nguồn SKU đã dùng: ${name}`);
    // Tuần tự: các nguồn dùng chung một client của giao dịch.
    for (const id of await source(variantIds)) result.add(id);
  }
  return result;
}

/** Thứ tự nguồn quyết thứ tự câu lý do. */
const SOURCES = ['stockArchiveBlockers', 'purchaseArchiveBlockers', 'orderArchiveBlockers', 'listingArchiveBlockers'] as const;

/**
 * Gom câu lý do của bốn nguồn theo thứ tự kho, mua hàng, đơn, sàn. Thiếu nguồn là lỗi lập trình (không coi là "không
 * chặn"). `variantIds` rỗng thì không gọi nguồn nào.
 */
export async function archiveBlockersOf(
  ctx: CatalogContext,
  variantIds: readonly string[],
  options: { lock?: boolean } = {},
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!variantIds.length) return result;
  for (const name of SOURCES) {
    const source = ctx[name];
    if (!source) throw new Error(`Chưa nối nguồn lý do chặn lưu trữ: ${name}`);
    // Tuần tự: các nguồn dùng chung một client của giao dịch.
    for (const [id, reasons] of await source(variantIds, options)) result.set(id, [...(result.get(id) ?? []), ...reasons]);
  }
  return result;
}

/** Cổng một nguồn của `ctx` (ngưỡng tồn, hiện diện, xoá dòng tồn); thiếu là lỗi lập trình, không coi là "chưa có số". */
export function requirePort<K extends 'minQtyOf' | 'listingPresenceOf' | 'channelCoverageOf' | 'deleteStockLevels'>(
  ctx: CatalogContext,
  name: K,
): NonNullable<CatalogContext[K]> {
  const port = ctx[name];
  if (!port) throw new Error(`Chưa nối cổng của catalog: ${name}`);
  return port as NonNullable<CatalogContext[K]>;
}
