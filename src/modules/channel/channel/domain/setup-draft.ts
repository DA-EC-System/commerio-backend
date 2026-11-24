// Bản nháp thiết lập gian hàng (#569, Documents/21 mục 18.7.5): dữ liệu người dùng nhập ở các bước Liên kết SKU sàn,
// Danh mục sản phẩm, Đồng bộ tồn của wizard, lưu ở `channel.shops.setup_draft`. Luật ghi và xác nhận làm ở PR sau
// (`PUT /setup/draft`, `POST sku-links` cho gian hàng `connecting`); file này giữ hình dạng và cách đọc an toàn.

/** Ba bước có mốc xác nhận, theo thứ tự làm. */
export const DRAFT_STEPS = ['link_skus', 'assign_groups', 'stock_sync'] as const;
export type DraftStep = (typeof DRAFT_STEPS)[number];
export type DraftConfirmed = Record<DraftStep, string | null>;

export interface SetupDecision {
  externalSkuId: string;
  action: 'link' | 'create' | 'skip' | 'unmanaged';
  variantId: string | null;
}

export interface SetupDraft {
  decisions: SetupDecision[];
  createGroups: { externalProductId: string; groupId: string }[];
  openingStock: 'push' | 'stocktake' | null;
  returnWindowDays: number | null;
  /** Tập `externalSkuId` của bản sao SKU sàn lúc xác nhận `link_skus`; xoá cùng mốc */
  baseline: string[] | null;
  confirmed: DraftConfirmed;
}

export const NO_CONFIRMATION: DraftConfirmed = { link_skus: null, assign_groups: null, stock_sync: null };

/** Mốc xác nhận của nháp đã lưu; nháp chưa có hoặc hỏng hình thì coi như chưa xác nhận bước nào. */
export function draftConfirmedOf(raw: unknown): DraftConfirmed {
  const confirmed = (raw as { confirmed?: unknown } | null)?.confirmed;
  if (!confirmed || typeof confirmed !== 'object') return { ...NO_CONFIRMATION };
  const at = (v: unknown) => (typeof v === 'string' ? v : null);
  const c = confirmed as Record<string, unknown>;
  return { link_skus: at(c.link_skus), assign_groups: at(c.assign_groups), stock_sync: at(c.stock_sync) };
}
