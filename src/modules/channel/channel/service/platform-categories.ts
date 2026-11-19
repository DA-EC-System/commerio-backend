// Cây category và attribute của leaf sàn cho trang đẩy và tab "Danh mục & thuộc tính" (#400, Documents/21 §18.5). Cây đọc
// từ DB, không gọi sàn; attribute của leaf dùng lại 7 ngày, quá hạn thì gọi sàn rồi ghi qua `replaceLeaf` (ngoài
// `withCompany`, A3). Lazada không cần token (G2.1, G2.2); TikTok gọi bằng token gian hàng (A4).
import { AppError } from '../../../../shared/errors/app-error.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { responsibleOrgOf } from '../../../core/index.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import type { AttributeInput, AttributeKind, AttributeOption, AttributeTier, RequiredWhen } from '../domain/product-spec.ts';
import {
  type CategoryRow,
  childrenOf,
  findCategory,
  leafAttributesOf,
  replaceLeaf,
  searchLeaves,
  specsOnCategory,
  treeSyncedAt,
} from '../repository/platform-categories.ts';
import { listShopRows } from '../repository/shops.ts';
import type { CategoryStatus, Marketplace, SizeChartRule, SpecSource } from '../repository/schema.ts';
import { forCompany, type MarketplaceAdapter, MarketplaceError, type PlatformAttribute } from './marketplaces/index.ts';
import { productPort } from './product-port.ts';
import { onMarketplace, platformOf, shopSession } from './shops.ts';

/** Attribute của leaf dùng lại 7 ngày (Documents/21 §18.5). */
export const ATTRIBUTES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PlatformCategory {
  externalId: string;
  parentExternalId: string | null;
  name: string;
  path: string;
  isLeaf: boolean;
  status: CategoryStatus;
}

export interface PlatformAttributeView {
  code: string;
  label: string;
  kind: AttributeKind;
  input: AttributeInput;
  options: AttributeOption[];
  allowCustom: boolean;
  required: boolean;
  requiredWhen: RequiredWhen[] | null;
  isKey: boolean;
  tier: AttributeTier;
  defaultValue: string | null;
}

export interface LeafDetail {
  category: PlatformCategory & { sizeChartRule: SizeChartRule | null };
  attributes: PlatformAttributeView[];
  fetchedAt: Date | null;
  stale: boolean;
  products: { productId: string; code: string; name: string; source: SpecSource }[];
}

const toCategory = (r: CategoryRow): PlatformCategory => ({
  externalId: r.externalId,
  parentExternalId: r.parentExternalId,
  name: r.name,
  path: r.path,
  isLeaf: r.isLeaf,
  status: r.status,
});

/**
 * `search` (≥ 2 ký tự, schema kiểm) thì leaf `active` gần nhất, tối đa 50; không thì con trực tiếp của `parentId` (không
 * gửi là cấp gốc). `syncedAt` là lần đồng bộ cây gần nhất, null khi sàn chưa có dòng nào.
 */
export async function listPlatformCategories(
  raw: string,
  query: { search?: string; parentId?: string },
): Promise<{ items: PlatformCategory[]; syncedAt: Date | null }> {
  const { platform } = platformOf(raw);
  const rows = query.search ? await searchLeaves(platform, query.search) : await childrenOf(platform, query.parentId ?? null);
  return { items: rows.map(toCategory), syncedAt: await treeSyncedAt(platform) };
}

const unsupported = () => new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ đọc category từ app');
const notLeaf = () => new AppError(422, 'category_not_leaf', 'Category này không phải category lá, chọn category cấp cuối');
const noShop = () => new AppError(409, 'shop_not_connected', 'Công ty chưa có gian hàng đang hoạt động trên sàn này để đọc category');

/**
 * Gọi sàn lấy attribute và luật bảng kích cỡ của một leaf. Sàn cần token: gian hàng `shopId` (phải của công ty, đúng sàn:
 * không thì 404), không gửi thì gian hàng `active` cũ nhất của công ty trên sàn; không có thì 409 `shop_not_connected`.
 * Sàn không cần token: gọi thẳng, tính vào hạn mức của công ty. Lỗi luật bảng kích cỡ không làm hỏng lời gọi (null).
 */
async function fetchLeaf(
  companyId: string,
  platform: Marketplace,
  adapter: MarketplaceAdapter,
  externalId: string,
  shopId: string | undefined,
): Promise<{ attributes: PlatformAttribute[]; sizeChartRule: SizeChartRule | null }> {
  const call = async (a: MarketplaceAdapter, token: string | null) => {
    const [attributes, rules] = await Promise.all([
      a.leafAttributes!(token, externalId),
      token && a.categoryRules ? a.categoryRules(token, externalId).catch(() => null) : Promise.resolve(null),
    ]);
    return { attributes, sizeChartRule: rules?.sizeChart ?? null };
  };
  if (adapter.categoriesNeedToken === false) return forCompany(companyId, () => call(adapter, null));
  return withCompany(companyId, async () => {
    let id = shopId;
    if (id === undefined) {
      const shop = (await listShopRows()).find((s) => s.platform === platform && s.status === 'active' && s.accessTokenEnc);
      if (!shop) throw noShop();
      id = shop.id;
    }
    const session = await shopSession(id);
    if (session.shop.platform !== platform) throw new AppError(404, 'not_found', 'Không tìm thấy gian hàng');
    return call(session.adapter, session.accessToken);
  });
}

/**
 * Chi tiết một leaf (AC-5, AC-S6): attribute từ bảng, chưa có hoặc quá 7 ngày thì gọi sàn rồi thay cả tập (A3). Gọi sàn
 * lỗi (sàn lỗi, không có gian hàng để gọi) mà bảng còn bản cũ thì trả bản cũ `stale: true`; chưa có bản nào thì lỗi
 * (sàn lỗi tạm 503). Category `removed` không gọi sàn. Node không phải lá: 422 `category_not_leaf`.
 */
export async function leafDetail(
  ctx: ModuleContext,
  companyId: string,
  raw: string,
  externalId: string,
  opts: { shopId?: string; now?: Date } = {},
): Promise<LeafDetail> {
  const { platform, adapter } = platformOf(raw);
  const now = opts.now ?? new Date();
  let category = await findCategory(platform, externalId);
  if (category && !category.isLeaf) throw notLeaf();
  const fetchedAt = category?.attributesFetchedAt ?? null;
  const fresh = fetchedAt !== null && now.getTime() - fetchedAt.getTime() < ATTRIBUTES_TTL_MS;
  let stale = false;
  if (!fresh && category?.status !== 'removed') {
    if (!adapter.leafAttributes) throw unsupported();
    try {
      const fetched = await fetchLeaf(companyId, platform, adapter, externalId, opts.shopId);
      await replaceLeaf(platform, externalId, { ...fetched, fetchedAt: now });
      category = await findCategory(platform, externalId);
    } catch (err) {
      const keepOld = fetchedAt !== null && (err instanceof MarketplaceError || (err instanceof AppError && err.code === 'shop_not_connected'));
      if (!keepOld) {
        if (err instanceof MarketplaceError) await onMarketplace(() => Promise.reject(err));
        throw err;
      }
      stale = true;
    }
  }
  if (!category) throw new AppError(404, 'not_found', 'Không tìm thấy category');
  const attributes = await leafAttributesOf(platform, externalId);
  const needOrg = attributes.some((a) => a.tier === 'company');
  const { products, org } = await withCompany(companyId, async () => ({
    products: await productsOn(ctx, platform, externalId),
    org: needOrg ? await responsibleOrgOf(companyId) : null,
  }));
  return {
    category: { ...toCategory(category), sizeChartRule: category.sizeChartRule },
    attributes: attributes.map(({ raw: _raw, ...a }) => {
      const field = a.tier === 'company' ? adapter.responsibleFields?.[a.code] : undefined;
      return { ...a, defaultValue: (field && org?.[field]) || null };
    }),
    fetchedAt: category.attributesFetchedAt,
    stale,
    products,
  };
}

/** Sản phẩm của công ty có spec trỏ tới leaf, mã và tên lấy qua `getVariants({ productIds })` (A13). */
async function productsOn(ctx: ModuleContext, platform: Marketplace, externalId: string): Promise<LeafDetail['products']> {
  const specs = await specsOnCategory(platform, externalId);
  if (!specs.length) return [];
  const variants = await productPort(ctx).variants(undefined, { productIds: specs.map((s) => s.productId) });
  const byProduct = new Map(variants.map((v) => [v.productId, v]));
  return specs.flatMap((s) => {
    const v = byProduct.get(s.productId);
    return v ? [{ productId: s.productId, code: v.productCode, name: v.productName, source: s.source }] : [];
  });
}
