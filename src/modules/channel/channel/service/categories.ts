// Danh mục sàn và ghép danh mục Commerio → danh mục lá của sàn (#104 A2). Gọi trong `withCompany`.
import { AppError } from '../../../../shared/errors/app-error.ts';
import {
  type CategoryMapRow,
  insertCategoryMap,
  listCategoryMaps,
  updateCategoryMap,
} from '../repository/category-maps.ts';
import type { CategoryAttribute, PlatformCategory } from './marketplaces/index.ts';
import { onMarketplace, shopSession } from './shops.ts';

const SEARCH_LIMIT = 50;

export interface CategoryMap {
  categoryId: string;
  platform: CategoryMapRow['platform'];
  externalCategoryId: string;
  attributes: Record<string, string>;
  version: number;
  updatedAt: Date;
}

const toMap = (r: CategoryMapRow): CategoryMap => ({
  categoryId: r.categoryId,
  platform: r.platform,
  externalCategoryId: r.externalCategoryId,
  attributes: r.attributes,
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

export async function categoryAttributes(shopId: string, externalCategoryId: string): Promise<{ items: CategoryAttribute[] }> {
  const { adapter, accessToken } = await shopSession(shopId);
  return { items: await onMarketplace(() => adapter.categoryAttributes(accessToken, externalCategoryId)) };
}

export async function getCategoryMaps(shopId: string): Promise<{ items: CategoryMap[] }> {
  const { shop } = await shopSession(shopId);
  return { items: (await listCategoryMaps(shop.platform)).map(toMap) };
}

/**
 * Ghép một danh mục Commerio. Thuộc tính bắt buộc của danh mục sàn phải đủ và đúng lựa chọn (422 theo từng thuộc
 * tính); `version: null` là ghép mới. Không kiểm `categoryId` có trong catalog: catalog chưa có cổng đọc danh mục,
 * mã lạ không khớp sản phẩm nào nên vô hại.
 */
export async function putCategoryMap(
  shopId: string,
  categoryId: string,
  input: { externalCategoryId: string; attributes: Record<string, string>; version: number | null },
): Promise<CategoryMap> {
  const { shop, adapter, accessToken } = await shopSession(shopId);
  const required = await onMarketplace(() => adapter.categoryAttributes(accessToken, input.externalCategoryId));
  const errors: Record<string, string> = {};
  for (const a of required) {
    const value = input.attributes[a.name]?.trim();
    if (!value) errors[`attributes.${a.name}`] = `Nhập ${a.label}`;
    else if (a.options.length && !a.options.includes(value)) errors[`attributes.${a.name}`] = `${a.label} không có trong lựa chọn của sàn`;
  }
  if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });

  const values = { externalCategoryId: input.externalCategoryId, attributes: input.attributes };
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
