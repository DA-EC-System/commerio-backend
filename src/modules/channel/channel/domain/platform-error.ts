// Dịch lỗi đẩy của sàn thành mã, câu tiếng Việt và chỗ sửa (#567, Documents/21 §18.6.4 "Dịch lỗi đẩy của sàn"). Hàm thuần:
// bảng luật do adapter khai (`errorMap`), service truyền lỗi có cấu trúc và ngữ cảnh spec, không rẽ nhánh theo sàn.
import type { BlockerTarget } from './blocker.ts';

/** `data`: người bán sửa được trong app; `platform`: sàn từ chối vì lý do ngoài dữ liệu; `connection`: lỗi tạm, mất kết nối. */
export type PushErrorKind = 'data' | 'platform' | 'connection';

/** Một lý do có cấu trúc của sàn (Lazada `detail[]`; TikTok `fail_reasons` của Check Product Listing). */
export interface PlatformErrorDetail {
  field: string | null;
  code: string | null;
  message: string | null;
}

/** Lỗi sàn đã tách khỏi `MarketplaceError`: mã, câu ngoài cùng và các lý do chi tiết. */
export interface PlatformFailure {
  platformCode: string | null;
  platformMessage: string | null;
  details: readonly PlatformErrorDetail[];
}

/** Ngữ cảnh của sản phẩm đang đẩy, để điền nhãn và suy chỗ sửa. */
export interface PushErrorContext {
  /** Tên sàn hiển thị (`MarketplaceAdapter.name`). */
  platformName: string;
  /** Nhãn của attribute có trong leaf đang dùng; null khi leaf không có mã đó. */
  attributeLabel(code: string): string | null;
  /** Id thuộc tính biến thể của sản phẩm đang ánh xạ tới mã này (`axisMap`); null khi không phải trục. */
  axisAttributeId(code: string): string | null;
}

/** Dữ liệu một luật nhận khi dựng câu, chỗ sửa. */
export interface RuleMatch {
  detail: PlatformErrorDetail | null;
  platformCode: string;
  platformMessage: string | null;
  ctx: PushErrorContext;
}

/** Một dòng bảng dịch của adapter (21 §18.6.4 `PlatformErrorRule`). `message`, `target` được là hàm khi cần đọc câu sàn. */
export interface PlatformErrorRule {
  platformCode: string | RegExp;
  /** Chỉ khớp khi `detail.field` bằng giá trị này. */
  field?: string;
  code: string;
  kind: PushErrorKind;
  message: string | ((m: RuleMatch) => string);
  target?: BlockerTarget | null | ((m: RuleMatch) => BlockerTarget | null);
}

export interface TranslatedPushError {
  code: string;
  kind: PushErrorKind;
  message: string;
  target: BlockerTarget | null;
  platformCode: string | null;
  platformMessage: string | null;
  /** false khi không luật nào khớp: service ghi log `push_error_unmapped` và đếm metric. */
  mapped: boolean;
}

/**
 * Mã kiểm trước khi tạo sản phẩm (#305, `PRECHECK_CODES`): adapter ném bằng mã của app nên dùng chung mọi sàn, xét sau bảng
 * của adapter (chi tiết khớp bảng adapter thì thắng, vd TikTok 12052051 trong Check Product Listing).
 */
const PRECHECK_RULES: PlatformErrorRule[] = [
  {
    platformCode: 'shop_not_eligible',
    code: 'shop_not_eligible',
    kind: 'platform',
    message: (m) => `Gian hàng ${m.ctx.platformName} chưa đủ điều kiện đăng bán: ${m.platformMessage ?? 'sàn không nêu lý do'}. Hoàn tất trên Seller Center rồi đăng lại`,
  },
  {
    platformCode: 'listing_check_failed',
    code: 'listing_check_failed',
    kind: 'data',
    message: (m) =>
      `${m.ctx.platformName} từ chối sản phẩm: ${m.platformMessage ?? 'sàn không nêu lý do'}. Sửa sản phẩm hoặc thông tin ${m.ctx.platformName} của sản phẩm (category, attribute) rồi đăng lại`,
  },
];

const matches = (rule: PlatformErrorRule, code: string, field: string | null): boolean =>
  (typeof rule.platformCode === 'string' ? rule.platformCode === code : rule.platformCode.test(code)) &&
  (rule.field === undefined || rule.field === field);

/** Mã attribute Lazada đặt ở `detail.field` (`brandProp` → `brand`). */
export const attributeOfField = (field: string | null): string | null => (field ? field.replace(/Prop$/, '') || null : null);

/** Mã attribute nêu trong câu sàn mà leaf có (`… đo lường weight …`, `attribute 100149 …`). */
export function attributeInText(text: string | null, ctx: PushErrorContext): string | null {
  for (const token of text?.match(/[A-Za-z0-9_]+/g) ?? []) if (ctx.attributeLabel(token) !== null) return token;
  return null;
}

/** Chỗ sửa của một attribute: thuộc tính biến thể của sản phẩm thì phần ánh xạ, không thì ô attribute. */
export function attributeTarget(code: string, ctx: PushErrorContext): BlockerTarget {
  const attributeId = ctx.axisAttributeId(code);
  return attributeId ? { kind: 'axis', attributeId } : { kind: 'spec_attribute', attributeCode: code };
}

function apply(rule: PlatformErrorRule, m: RuleMatch): TranslatedPushError {
  const target = typeof rule.target === 'function' ? rule.target(m) : (rule.target ?? null);
  return {
    code: rule.code,
    kind: rule.kind,
    message: typeof rule.message === 'function' ? rule.message(m) : rule.message,
    target,
    platformCode: m.platformCode,
    platformMessage: m.platformMessage,
    mapped: true,
  };
}

/**
 * Khớp theo mã chi tiết trước (từng `detail` theo thứ tự, luật đầu tiên khớp), rồi mã ngoài cùng; không khớp thì
 * `marketplace_rejected` với câu chung "{sàn} không nhận sản phẩm: {câu sàn}", chỗ sửa suy từ `detail.field` khi trùng
 * attribute của leaf. `platformCode`, `platformMessage` lấy của detail khi có (Lazada: không lấy 4110/"E500").
 */
export function translatePlatformError(rules: readonly PlatformErrorRule[], failure: PlatformFailure, ctx: PushErrorContext): TranslatedPushError {
  const all = [...rules, ...PRECHECK_RULES];
  const details = failure.details.filter((d) => d.code || d.message);
  for (const detail of details) {
    if (!detail.code) continue;
    const rule = all.find((r) => matches(r, detail.code!, detail.field));
    if (rule) return apply(rule, { detail, platformCode: detail.code, platformMessage: detail.message, ctx });
  }
  if (failure.platformCode) {
    const rule = all.find((r) => r.field === undefined && matches(r, failure.platformCode!, null));
    if (rule) return apply(rule, { detail: null, platformCode: failure.platformCode, platformMessage: failure.platformMessage, ctx });
  }
  const first = details[0];
  const platformCode = first?.code ?? failure.platformCode;
  const platformMessage = first?.message ?? failure.platformMessage;
  const field = attributeOfField(first?.field ?? null);
  const target = field && ctx.attributeLabel(field) !== null ? attributeTarget(field, ctx) : null;
  return {
    code: 'marketplace_rejected',
    kind: target ? 'data' : 'platform',
    message: platformMessage
      ? `${ctx.platformName} không nhận sản phẩm: ${platformMessage}`
      : `${ctx.platformName} không nhận sản phẩm${platformCode ? ` (mã ${platformCode})` : ''}`,
    target,
    platformCode,
    platformMessage,
    mapped: false,
  };
}

/**
 * Loại và chỗ sửa của mã lỗi do app đặt lúc đẩy (mã chặn 18.5 kiểm lại ở việc nền, lỗi kết nối, #399). Mã không có ở đây
 * là `data`, không chỗ sửa.
 */
const APP_ERRORS: Record<string, { kind: PushErrorKind; target: BlockerTarget | null }> = {
  price_missing: { kind: 'data', target: { kind: 'variant_field', field: 'price' } },
  below_floor: { kind: 'data', target: { kind: 'variant_field', field: 'price' } },
  dimensions_missing: { kind: 'data', target: { kind: 'variant_field', field: 'dimensions' } },
  images_missing: { kind: 'data', target: { kind: 'product_field', field: 'images' } },
  variant_images_missing: { kind: 'data', target: { kind: 'product_field', field: 'variantImages' } },
  size_chart_missing: { kind: 'data', target: { kind: 'product_field', field: 'sizeChart' } },
  category_unmapped: { kind: 'data', target: { kind: 'category' } },
  spec_incomplete: { kind: 'data', target: { kind: 'category' } },
  category_not_permitted: { kind: 'platform', target: { kind: 'shop', field: 'category_permission' } },
  axis_unmapped: { kind: 'data', target: { kind: 'axis' } },
  axis_shape: { kind: 'data', target: { kind: 'category' } },
  platform_product_ambiguous: { kind: 'data', target: null },
  marketplace_unavailable: { kind: 'connection', target: null },
  shop_not_connected: { kind: 'connection', target: null },
  sku_exists_on_platform: { kind: 'platform', target: null },
  marketplace_rejected: { kind: 'platform', target: null },
};

export const appPushError = (code: string): { kind: PushErrorKind; target: BlockerTarget | null } =>
  APP_ERRORS[code] ?? { kind: 'data', target: null };

/** Số kg của sàn ("300.0", "0.001") viết kiểu Việt Nam ("300", "0,001"). */
export const kgText = (raw: string): string => String(Number(raw)).replace('.', ',');
