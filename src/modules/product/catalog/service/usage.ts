// `ctx` của catalog và lý do chặn lưu trữ SKU (#204, Documents/21 §17.3, spec 204 mục 5.2). Tồn, chứng từ, đơn, listing
// nằm ở module khác: mỗi module tự trả câu lý do của phần mình, catalog chỉ gom lại.
// - inventory, purchasing (cùng module lớn, đã import catalog): `product/index.ts` nối bằng `withContext`;
// - order, channel (module lớn lớp trên): `src/wiring.ts` nối.
import type { ModuleContext } from '../../../../shared/module.ts';

/**
 * Câu lý do chặn lưu trữ theo SKU; SKU không vướng gì thì không có trong Map. Gọi trong `withCompany` của catalog.
 * `lock`: thao tác lưu trữ, nguồn khoá được phần của mình tới hết giao dịch (inventory khoá dòng tồn); xem chi tiết thì
 * không khoá.
 */
export type ArchiveBlockerSource = (variantIds: readonly string[], options?: { lock?: boolean }) => Promise<Map<string, string[]>>;

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
