// Cây category và attribute của leaf Lazada đổi sang kiểu chung (#400 lát 3, A15). Hàm thuần trên phản hồi
// `/category/tree/get` và `/category/attributes/get` (gọi thật 18/11/2026, không cần access_token: G2.1, G2.2).
import type { AttributeInput, PlatformAttribute } from '../../domain/product-spec.ts';
import { MarketplaceError, type PlatformCategoryNode } from './common.ts';

type TreeNode = { category_id?: unknown; name?: unknown; leaf?: unknown; children?: TreeNode[] };

/** Mọi node của cây (cả không phải lá), đường dẫn từ gốc nối " > ". */
export function lazadaCategoryNodes(data: unknown): PlatformCategoryNode[] {
  const out: PlatformCategoryNode[] = [];
  const walk = (n: TreeNode, parent: PlatformCategoryNode | null) => {
    const name = String(n.name ?? '');
    const node: PlatformCategoryNode = {
      externalId: String(n.category_id),
      parentExternalId: parent?.externalId ?? null,
      name,
      isLeaf: n.leaf === true,
      path: parent ? `${parent.path} > ${name}` : name,
    };
    out.push(node);
    for (const c of n.children ?? []) walk(c, node);
  };
  for (const n of Array.isArray(data) ? (data as TreeNode[]) : []) walk(n, null);
  return out;
}

type RawAttr = {
  name?: unknown;
  label?: unknown;
  input_type?: unknown;
  attribute_type?: unknown;
  is_mandatory?: unknown;
  is_sale_prop?: unknown;
  advanced?: { is_key_prop?: unknown };
  options?: { id?: unknown; name?: unknown }[];
};

/** Kiểu nhập của Lazada cho tự nhập giá trị (không bắt chọn trong `options`). */
const FREE_INPUT = new Set(['text', 'richText', 'numeric', 'date', 'enumInput', 'multiEnumInput']);
const INPUT: Record<string, AttributeInput> = {
  singleSelect: 'select',
  enumInput: 'select',
  multiSelect: 'multiselect',
  multiEnumInput: 'multiselect',
  numeric: 'number',
  img: 'image',
  date: 'date',
  text: 'text',
  richText: 'text',
};
/**
 * Attribute `normal` app tự gửi từ catalog: tên, mô tả (`createProduct`, `updateProduct`). Giữ trong bảng thì form cho sửa và
 * spec đè lên nội dung sản phẩm.
 */
const APP_CONTENT = new Set(['name', 'name_en', 'description', 'description_en']);
/** Lazada `brand` (bắt buộc, danh sách thương hiệu ở API khác) và xuất xứ là cột của catalog (#340, A1). */
const PRODUCT_TIER = new Set(['brand', 'country_origin_hb']);

const flag = (v: unknown) => String(v) === '1';

/**
 * Attribute của một leaf (A15). Bỏ attribute `sku` không phải sales (giá, SellerSku, kích thước gói, tồn, giá KM: catalog
 * cung cấp) và trường nội dung app tự gửi. `is_sale_prop = 1` → `sales`. `allowCustom` khi kiểu nhập tự do hoặc không kèm
 * lựa chọn (vd `brand`). `propCascade` không có `input_type`, `label` → `cascade`, nhãn là mã. Mã là `name` (khớp khoá
 * attribute của spec chép từ ghép danh mục cũ). `data` không phải mảng (Lazada trả `code: "0"` mà thiếu `data`) là `unexpected_response`: coi là
 * rỗng thì `replaceLeaf` xoá hết attribute của leaf cho mọi công ty (review BE1 P2-1).
 */
export function lazadaLeafAttributes(data: unknown): PlatformAttribute[] {
  if (!Array.isArray(data)) throw new MarketplaceError('rejected', 'unexpected_response', 'Sàn trả attribute của category không phải danh sách');
  const out: PlatformAttribute[] = [];
  for (const a of data as RawAttr[]) {
    if (typeof a.name !== 'string' || a.name === '') continue;
    const sales = flag(a.is_sale_prop);
    if (a.attribute_type === 'sku' && !sales) continue;
    if (APP_CONTENT.has(a.name)) continue;
    const type = typeof a.input_type === 'string' ? a.input_type : null;
    const options = (a.options ?? [])
      .filter((o) => o.id != null && o.name != null)
      .map((o) => ({ id: String(o.id), label: String(o.name) }));
    const input: AttributeInput = type === null ? (a.name === 'propCascade' ? 'cascade' : 'text') : (INPUT[type] ?? 'text');
    out.push({
      code: a.name,
      label: typeof a.label === 'string' && a.label !== '' ? a.label : a.name,
      kind: sales ? 'sales' : 'property',
      input,
      options,
      allowCustom: (type !== null && FREE_INPUT.has(type)) || options.length === 0,
      required: flag(a.is_mandatory),
      requiredWhen: null,
      isKey: flag(a.advanced?.is_key_prop),
      tier: PRODUCT_TIER.has(a.name) ? 'product' : 'category',
      raw: a as Record<string, unknown>,
    });
  }
  return out;
}
