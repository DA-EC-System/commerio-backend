// Cây category và attribute của leaf TikTok đổi sang kiểu chung (#400 lát 3, A15). Hàm thuần trên phản hồi Get Categories,
// Get Category Attributes 202309 (`category_version=v2`; OAS cục bộ của skill tts-openapi-guide, tra 19/11/2026; gọi thật
// 18/11/2026 trên shop thử VN).
import type { PlatformAttribute, RequiredWhen } from '../../domain/product-spec.ts';
import type { PlatformCategoryNode, Responsible } from './common.ts';

type Row = Record<string, unknown>;

/** Mã thuộc tính tổ chức chịu trách nhiệm hàng hoá, giống nhau ở 19 danh mục lá VN đã đo (#292, 17/11/2026). */
export const RESPONSIBLE_ATTRS: Readonly<Record<string, keyof Responsible>> = { '101489': 'name', '101490': 'address' };
/** Attribute điền từ hồ sơ công ty: `tier = 'company'`. */
const COMPANY_TIER = new Set(Object.keys(RESPONSIBLE_ATTRS));
/** Quốc gia xuất xứ: cột `origin_country` của catalog (#340, A1). */
const PRODUCT_TIER = new Set(['100149']);

/**
 * Mọi node của cây (cả không phải lá, cả không `AVAILABLE`), đường dẫn từ gốc theo `local_name`, kèm `permission_statuses`
 * của gian hàng mang token. Node có `parent_id` không có trong cây (hoặc "0") là gốc.
 */
export function tiktokCategoryNodes(categories: readonly Row[]): PlatformCategoryNode[] {
  const byId = new Map(categories.map((c) => [String(c.id), c]));
  const paths = new Map<string, string>();
  const pathOf = (c: Row, seen = new Set<string>()): string => {
    const id = String(c.id);
    const hit = paths.get(id);
    if (hit !== undefined) return hit;
    const name = String(c.local_name ?? '');
    const parent = byId.get(String(c.parent_id));
    const p = parent && !seen.has(id) ? `${pathOf(parent, seen.add(id))} > ${name}` : name;
    paths.set(id, p);
    return p;
  };
  return categories.map((c) => {
    const parentId = String(c.parent_id ?? '0');
    return {
      externalId: String(c.id),
      parentExternalId: byId.has(parentId) ? parentId : null,
      name: String(c.local_name ?? ''),
      isLeaf: c.is_leaf === true,
      path: pathOf(c),
      ...(Array.isArray(c.permission_statuses) && { permissionStatuses: c.permission_statuses.map(String) }),
    };
  });
}

/** `requirement_conditions` loại `VALUE_ID_MATCH` gom theo attribute điều kiện; loại khác chưa có trong OAS nên bỏ. */
function requiredWhenOf(conditions: unknown): RequiredWhen[] | null {
  if (!Array.isArray(conditions)) return null;
  const by = new Map<string, string[]>();
  for (const c of conditions as Row[]) {
    if (c.condition_type !== 'VALUE_ID_MATCH' || c.attribute_id == null || c.attribute_value_id == null) continue;
    const code = String(c.attribute_id);
    by.set(code, [...(by.get(code) ?? []), String(c.attribute_value_id)]);
  }
  return by.size ? [...by].map(([code, optionIds]) => ({ code, optionIds })) : null;
}

/**
 * Attribute của một leaf (A15): cả `PRODUCT_PROPERTY` lẫn `SALES_PROPERTY` (→ `sales`). Mã là id. `allowCustom =
 * is_customizable`; `is_multiple_selection` → `multiselect`, có `values` → `select`, còn lại `text`. `is_requried` (sàn viết
 * sai chính tả) → `required`.
 */
export function tiktokLeafAttributes(attributes: readonly Row[]): PlatformAttribute[] {
  return attributes
    .filter((a) => a.id != null)
    .map((a) => {
      const code = String(a.id);
      const options = ((a.values ?? []) as Row[]).filter((v) => v.id != null).map((v) => ({ id: String(v.id), label: String(v.name ?? v.id) }));
      return {
        code,
        label: String(a.name ?? code),
        kind: a.type === 'SALES_PROPERTY' ? 'sales' : 'property',
        input: a.is_multiple_selection === true ? 'multiselect' : options.length ? 'select' : 'text',
        options,
        allowCustom: a.is_customizable === true,
        required: a.is_requried === true,
        requiredWhen: requiredWhenOf(a.requirement_conditions),
        isKey: false,
        tier: COMPANY_TIER.has(code) ? 'company' : PRODUCT_TIER.has(code) ? 'product' : 'category',
        raw: a,
      } satisfies PlatformAttribute;
    });
}
