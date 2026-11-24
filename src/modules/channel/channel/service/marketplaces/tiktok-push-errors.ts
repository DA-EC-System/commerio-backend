// Bảng dịch lỗi đẩy của TikTok Shop (#567, Documents/21 §18.6.4). Mã đến từ Create Product hoặc từng `fail_reasons` của
// Check Product Listing (`listing_check_failed`, mỗi lý do một `details`). Nguồn: gọi thật 17/11/2026 (12052051, 12052104),
// tich-hop-san/tiktok.md (12052522).
import { attributeInText, attributeTarget, type PlatformErrorRule, promotionLockedRule } from '../../domain/platform-error.ts';

export const TIKTOK_PUSH_ERRORS: readonly PlatformErrorRule[] = [
  {
    platformCode: '12052051',
    code: 'name_length',
    kind: 'data',
    message: 'Sàn yêu cầu tên sản phẩm dài 25–255 ký tự',
    target: { kind: 'product_field', field: 'name' },
  },
  {
    platformCode: '12052104',
    code: 'attribute_required',
    kind: 'data',
    message: (m) => {
      const code = attributeInText(m.platformMessage, m.ctx);
      return `Thiếu ${code ? m.ctx.attributeLabel(code) : 'một attribute'} bắt buộc của category`;
    },
    target: (m) => {
      const code = attributeInText(m.platformMessage, m.ctx);
      return code ? attributeTarget(code, m.ctx) : null;
    },
  },
  {
    platformCode: '12052522',
    code: 'variant_images_missing',
    kind: 'data',
    message: 'Sàn bắt buộc ảnh cho mọi giá trị của thuộc tính biến thể gắn ảnh',
    target: { kind: 'product_field', field: 'variantImages' },
  },
  // Đẩy tồn, giá theo SKU (#571): khoá do khuyến mãi (docv2 update-price-202309, update-inventory-202309, tra 12/11/2026).
  promotionLockedRule('12052393', 'stock'),
  promotionLockedRule('12052165', 'stock'),
  promotionLockedRule('12052038', 'price'),
  promotionLockedRule('12019045', 'price'),
];
