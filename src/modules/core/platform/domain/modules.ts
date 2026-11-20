/** Mười một phân hệ luôn bật (giai-phap.tex, bảng phân hệ); Kênh bán thành lõi từ #459. */
export const CORE_MODULES = [
  'platform',
  'identity',
  'catalog',
  'pricing',
  'inventory',
  'sales',
  'fulfillment',
  'finance',
  'payment',
  'notification',
  'channel',
] as const;

/** Bốn phân hệ CEO bật, tắt ở `/admin/modules` (UC-PI-02); đăng ký bật sẵn `DEFAULT_OPTIONAL_MODULES` (#459). */
export const OPTIONAL_MODULES = ['purchasing', 'inbox', 'assistant', 'report'] as const;

export type OptionalModule = (typeof OPTIONAL_MODULES)[number];

/** Phân hệ tuỳ chọn bật sẵn khi đăng ký công ty (Documents/21 mục 2.1). */
export const DEFAULT_OPTIONAL_MODULES: readonly OptionalModule[] = ['purchasing'];

/** Tên phân hệ người dùng thấy, cho nhãn nhật ký (#352; chữ chép `MODULE_LABELS` của FE `src/utils/modules.ts`). */
export const MODULE_NAMES: Record<OptionalModule, string> = {
  purchasing: 'Nhập hàng',
  inbox: 'Hộp thư chung',
  assistant: 'Trợ lý AI',
  report: 'Báo cáo',
};
export type ModuleCode = (typeof CORE_MODULES)[number] | OptionalModule;
