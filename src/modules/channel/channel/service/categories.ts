// Danh mục sàn và ghép danh mục Commerio → danh mục lá của sàn (#104 A2). Gọi trong `withCompany`.
import { AppError } from '../../../../shared/errors/app-error.ts';
import { responsibleOrgOf } from '../../../core/index.ts';
import {
  type CategoryMapRow,
  insertCategoryMap,
  listCategoryMaps,
  updateCategoryMap,
} from '../repository/category-maps.ts';
import type { CategoryAttribute, PlatformCategory, SizeChartRule } from './marketplaces/index.ts';
import { onMarketplace, shopSession } from './shops.ts';

const SEARCH_LIMIT = 50;

export interface CategoryMap {
  categoryId: string;
  platform: CategoryMapRow['platform'];
  externalCategoryId: string;
  attributes: Record<string, string>;
  /** Quy tắc bảng kích cỡ của danh mục sàn (#347); null là chưa biết (ghép trước #347 hoặc sàn không có quy tắc này). */
  sizeChartRule: SizeChartRule | null;
  version: number;
  updatedAt: Date;
}

const toMap = (r: CategoryMapRow): CategoryMap => ({
  categoryId: r.categoryId,
  platform: r.platform,
  externalCategoryId: r.externalCategoryId,
  attributes: r.attributes,
  sizeChartRule: r.sizeChartRule,
  version: r.version,
  updatedAt: r.updatedAt,
});

/** Danh mục lá có tên (cả đường dẫn) chứa `search`, không phân biệt hoa thường; tối đa 50. */
export async function searchCategories(shopId: string, search: string): Promise<{ items: PlatformCategory[] }> {
  const { adapter, accessToken } = await shopSession(shopId);
  const all = await onMarketplace(() => adapter.listCategories(accessToken));
  const q = search.trim().toLocaleLowerCase('vi');
  return { items: all.filter((c) => c.name.toLocaleLowerCase('vi').includes(q)).slice(0, SEARCH_LIMIT) };
}

export interface CategoryAttributeView {
  name: string;
  label: string;
  options: string[];
  /** Giá trị điền từ hồ sơ công ty khi để trống (#292); null là phải nhập. */
  defaultValue: string | null;
}

/** Thuộc tính sàn kèm giá trị mặc định từ hồ sơ công ty; chỉ đọc hồ sơ khi sàn có thuộc tính `prefill`. */
async function withDefaults(companyId: string, attrs: CategoryAttribute[]): Promise<CategoryAttributeView[]> {
  const org = attrs.some((a) => a.prefill) ? await responsibleOrgOf(companyId) : null;
  return attrs.map((a) => ({
    name: a.name,
    label: a.label,
    options: a.options,
    defaultValue: (a.prefill && org?.[a.prefill]) || null,
  }));
}

export async function categoryAttributes(shopId: string, externalCategoryId: string): Promise<{ items: CategoryAttributeView[] }> {
  const { shop, adapter, accessToken } = await shopSession(shopId);
  const attrs = await onMarketplace(() => adapter.categoryAttributes(accessToken, externalCategoryId));
  return { items: await withDefaults(shop.companyId, attrs) };
}

export async function getCategoryMaps(shopId: string): Promise<{ items: CategoryMap[] }> {
  const { shop } = await shopSession(shopId);
  return { items: (await listCategoryMaps(shop.platform)).map(toMap) };
}

/**
 * Ghép một danh mục Commerio. Thuộc tính bắt buộc của danh mục sàn phải đủ và đúng lựa chọn (422 theo từng thuộc
 * tính), trừ thuộc tính có `defaultValue` từ hồ sơ công ty; `version: null` là ghép mới. Không kiểm `categoryId` có
 * trong catalog: catalog chưa có cổng đọc danh mục, mã lạ không khớp sản phẩm nào nên vô hại.
 */
export async function putCategoryMap(
  shopId: string,
  categoryId: string,
  input: { externalCategoryId: string; attributes: Record<string, string>; version: number | null },
): Promise<CategoryMap> {
  const { shop, adapter, accessToken } = await shopSession(shopId);
  const required = await withDefaults(
    shop.companyId,
    await onMarketplace(() => adapter.categoryAttributes(accessToken, input.externalCategoryId)),
  );
  const attributes = { ...input.attributes };
  const errors: Record<string, string> = {};
  for (const a of required) {
    const value = attributes[a.name]?.trim();
    // Ô có giá trị từ hồ sơ để trống hoặc trùng thì không lưu: lúc đẩy lấy hồ sơ hiện tại (#292).
    if (a.defaultValue !== null && (!value || value === a.defaultValue)) delete attributes[a.name];
    else if (!value) errors[`attributes.${a.name}`] = `Nhập ${a.label}`;
    else if (a.options.length && !a.options.includes(value)) errors[`attributes.${a.name}`] = `${a.label} không có trong lựa chọn của sàn`;
  }
  if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });

  // Quy tắc bảng kích cỡ lưu cùng ghép để request đẩy chặn được mà không gọi sàn (#347).
  const rules = adapter.categoryRules ? await onMarketplace(() => adapter.categoryRules!(accessToken, input.externalCategoryId)) : null;
  const values = { externalCategoryId: input.externalCategoryId, attributes, sizeChartRule: rules?.sizeChart ?? null };
  const row =
    input.version === null
      ? await insertCategoryMap({ companyId: shop.companyId, platform: shop.platform, categoryId, ...values })
      : await updateCategoryMap(shop.platform, categoryId, input.version, values);
  if (!row) {
    const [current] = await listCategoryMaps(shop.platform, [categoryId]);
    throw new AppError(409, 'version_conflict', 'Ghép danh mục vừa được người khác sửa', {
      current: current ? toMap(current) : null,
    });
  }
  return toMap(row);
}
