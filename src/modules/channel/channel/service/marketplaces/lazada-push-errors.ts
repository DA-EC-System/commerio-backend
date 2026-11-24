// Bảng dịch lỗi đẩy của Lazada (#567, Documents/21 §18.6.4). Mã chi tiết nằm ở `detail[].code` hoặc đầu `detail[].message`
// (`lazadaError` tách). Nguồn câu thật: issue #567 (MEASURE_PROP), ca đêm 18/11/2026 (PACKAGE_WEIGHT), gọi thật 17/11/2026
// (CAT_PROP_MANDATORY kèm `brandProp`), ghi chú #104, thong-so-san-pham (4134, 4138, 4139, SALEPROP, PROP_REQUIRED).
import {
  attributeInText,
  attributeOfField,
  attributeTarget,
  kgText,
  type PlatformErrorRule,
  promotionLockedRule,
  type RuleMatch,
} from '../../domain/platform-error.ts';

/** Mã attribute của lỗi: `detail.field` (`brandProp`) khi leaf có, rồi mã nêu trong câu, rồi chữ sau "đo lường"/"measure". */
function attributeCodeOf(m: RuleMatch): string | null {
  const field = attributeOfField(m.detail?.field ?? null);
  if (field && m.ctx.attributeLabel(field) !== null) return field;
  return (
    attributeInText(m.platformMessage, m.ctx) ??
    m.platformMessage?.match(/(?:đo lường|measure(?:ment)?(?: attribute| property)?)\s+([A-Za-z0-9_]+)/i)?.[1] ??
    (field && field !== 'Product' ? field : null)
  );
}

const labelOf = (m: RuleMatch, code: string | null): string | null => (code ? (m.ctx.attributeLabel(code) ?? code) : null);

const attributeRuleTarget = (m: RuleMatch) => {
  const code = attributeCodeOf(m);
  return code ? attributeTarget(code, m.ctx) : null;
};

export const LAZADA_PUSH_ERRORS: readonly PlatformErrorRule[] = [
  {
    platformCode: 'BIZ_CHECK_MEASURE_PROP_TEXT_INVALID',
    code: 'attribute_value_invalid',
    kind: 'data',
    message: (m) => `Giá trị của thuộc tính ${labelOf(m, attributeCodeOf(m)) ?? 'đo lường'} phải là số kèm đơn vị, vd 500 g`,
    target: attributeRuleTarget,
  },
  {
    platformCode: 'BIZ_CHECK_PACKAGE_WEIGHT_BY_KG_INVALID',
    code: 'weight_out_of_range',
    kind: 'data',
    message: (m) => {
      const range = m.platformMessage?.match(/(\d+(?:\.\d+)?)\s*(?:và|and|đến|to|-|~)\s*(\d+(?:\.\d+)?)/);
      return range
        ? `Cân nặng kiện hàng phải từ ${kgText(range[1]!)} đến ${kgText(range[2]!)} kg theo sàn`
        : 'Cân nặng kiện hàng nằm ngoài khoảng sàn cho phép';
    },
    target: { kind: 'variant_field', field: 'weight' },
  },
  {
    platformCode: /^BIZ_CHECK_(CAT_PROP_MANDATORY|PROP_REQUIRED)$/,
    code: 'attribute_required',
    kind: 'data',
    message: (m) => `Thiếu ${labelOf(m, attributeCodeOf(m)) ?? 'một attribute'} bắt buộc của category`,
    target: attributeRuleTarget,
  },
  {
    platformCode: 'BIZ_CHECK_SALEPROP_ATTRIBUTE_INVALID',
    code: 'axis_unmapped',
    kind: 'data',
    message: (m) => {
      const code = attributeCodeOf(m);
      return `Thuộc tính biến thể ${code ? `${labelOf(m, code)} ` : ''}không có trong category này`;
    },
    target: (m) => {
      const code = attributeCodeOf(m);
      const attributeId = code ? m.ctx.axisAttributeId(code) : null;
      return attributeId ? { kind: 'axis', attributeId } : { kind: 'axis' };
    },
  },
  {
    platformCode: /^(BIZ_CHECK_MAIN_IMAGE_REQUIRE|4139)$/,
    code: 'images_missing',
    kind: 'data',
    message: 'Sàn bắt buộc ảnh chính của sản phẩm',
    target: { kind: 'product_field', field: 'images' },
  },
  {
    platformCode: /^(BIZ_CHECK_EXIST_OUTER_IMAGE|4138)$/,
    code: 'image_rejected',
    kind: 'platform',
    message: (m) => `${m.ctx.platformName} không tải được ảnh sản phẩm; thay ảnh khác`,
    target: { kind: 'product_field', field: 'images' },
  },
  {
    platformCode: '4134',
    code: 'category_not_leaf',
    kind: 'data',
    message: 'Category đã chọn không phải category cuối của sàn; chọn lại category',
    target: { kind: 'category' },
  },
  // Đẩy tồn, giá theo SKU (#571). Nguồn: bảng mã lỗi của UpdatePriceQuantity, UpdateSellableQuantity trên open.lazada.com
  // (đọc 24/11/2026). 501 "Update product failed" chỉ là mã tổng, lý do thật ở `detail[]` theo SKU nên luật khớp mã trong đó.
  promotionLockedRule('4170', 'stock'),
  {
    platformCode: '4225',
    ops: ['stock', 'price'],
    code: 'semi_hosted_product',
    kind: 'platform',
    target: null,
    message: 'Sản phẩm thuộc chương trình bán hộ (GSP) của Lazada: sửa giá, tồn của sản phẩm này trên GSP',
  },
  {
    platformCode: /^(4104|4118|BIZ_CHECK_PRICE_PRECISION_INVALID|BIZ_CHECK_PRICE_IS_ZERO)$/,
    ops: ['price'],
    code: 'price_invalid',
    kind: 'data',
    target: { kind: 'variant_field', field: 'price' },
    message: (m) => `Lazada không nhận giá này${m.platformMessage ? `: ${m.platformMessage}` : ''}. Sửa giá muốn thực nhận hoặc giá ghi đè rồi đồng bộ lại`,
  },
];
