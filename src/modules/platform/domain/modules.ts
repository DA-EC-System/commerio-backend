/** Mười phân hệ luôn bật (giai-phap.tex, bảng phân hệ). */
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
] as const;

/** Năm phân hệ CEO chọn khi đăng ký và bật thêm sau (UC-PI-01, UC-PI-02). */
export const OPTIONAL_MODULES = ['purchasing', 'channel', 'inbox', 'assistant', 'report'] as const;

export type OptionalModule = (typeof OPTIONAL_MODULES)[number];
export type ModuleCode = (typeof CORE_MODULES)[number] | OptionalModule;
