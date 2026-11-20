// Cây category và attribute của leaf sàn cho trang đẩy và tab "Danh mục & thuộc tính" (#400, Documents/21 §18.5). Cây đọc
// từ DB, không gọi sàn; attribute của leaf dùng lại 7 ngày, quá hạn thì gọi sàn rồi ghi qua `replaceLeaf` (ngoài
// `withCompany`, A3). Lazada không cần token (G2.1, G2.2); TikTok gọi bằng token gian hàng (A4).
import { AppError } from '../../../../shared/errors/app-error.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { responsibleOrgOf } from '../../../core/index.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import type { AttributeInput, AttributeKind, AttributeOption, AttributeTier, CategoryPermission, RequiredWhen } from '../domain/product-spec.ts';
import { permissionsOf } from '../repository/product-specs.ts';
import {
  type CategoryRow,
  childrenOf,
  findCategory,
  leafAttributesOf,
  pathIdsOf,
  replaceLeaf,
  searchLeaves,
  specsOnCategory,
  treeSyncedAt,
} from '../repository/platform-categories.ts';
import { listShopRows } from '../repository/shops.ts';
import type { CategoryStatus, Marketplace, SizeChartRule, SpecSource } from '../repository/schema.ts';
import { type CascadeLevel, forCompany, type MarketplaceAdapter, MarketplaceError, type PlatformAttribute } from './marketplaces/index.ts';
import { productPort } from './product-port.ts';
import { onMarketplace, ownShop, platformOf, shopSession } from './shops.ts';

/** Attribute của leaf dùng lại 7 ngày (Documents/21 §18.5). */
export const ATTRIBUTES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PlatformCategory {
  externalId: string;
  parentExternalId: string | null;
  name: string;
  path: string;
  isLeaf: boolean;
  status: CategoryStatus;
  /** `externalId` từ gốc tới chính category, cùng thứ tự với `path` (#467); cha chưa có trong bảng thì thiếu phần gốc. */
  pathIds: string[];
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

const toCategory = (r: CategoryRow, pathIds: ReadonlyMap<string, string[]>): PlatformCategory => ({
  externalId: r.externalId,
  parentExternalId: r.parentExternalId,
  name: r.name,
  path: r.path,
  isLeaf: r.isLeaf,
  status: r.status,
  pathIds: pathIds.get(r.externalId) ?? [r.externalId],
});

/**
 * `search` (≥ 2 ký tự, schema kiểm) thì leaf `active` gần nhất, tối đa 50; không thì con trực tiếp của `parentId` (không
 * gửi là cấp gốc). `syncedAt` là lần đồng bộ cây gần nhất, null khi sàn chưa có dòng nào.
 */
export async function listPlatformCategories(
  raw: string,
  query: { search?: string; parentId?: string; shopId?: string },
  /** Công ty của người gọi; cần khi có `query.shopId`. */
  companyId?: string,
): Promise<{ items: (PlatformCategory & { permission?: CategoryPermission | null })[]; syncedAt: Date | null }> {
  const { platform } = platformOf(raw);
  // `shopId` (#448, Documents/21 §18.5): gian hàng phải của công ty, đúng sàn (404); leaf kèm quyền của gian hàng đó.
  if (query.shopId !== undefined) await assertShopOn(companyId!, platform, query.shopId);
  const rows = query.search ? await searchLeaves(platform, query.search) : await childrenOf(platform, query.parentId ?? null);
  const pathIds = await pathIdsOf(platform, rows.map((r) => r.externalId));
  const items = rows.map((r) => toCategory(r, pathIds));
  if (query.shopId === undefined) return { items, syncedAt: await treeSyncedAt(platform) };
  const shopId = query.shopId;
  const leafIds = rows.filter((r) => r.isLeaf).map((r) => r.externalId);
  const permissions = await withCompany(companyId!, () => permissionsOf(shopId, leafIds));
  return {
    items: items.map((c) => ({ ...c, permission: c.isLeaf ? (permissions.get(c.externalId)?.status ?? null) : null })),
    syncedAt: await treeSyncedAt(platform),
  };
}

const unsupported = () => new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ đọc category từ app');
const notLeaf = () => new AppError(422, 'category_not_leaf', 'Category này không phải category lá, chọn category cấp cuối');
const noShop = () => new AppError(409, 'shop_not_connected', 'Công ty chưa có gian hàng đang hoạt động trên sàn này để đọc category');

const shopNotFound = () => new AppError(404, 'not_found', 'Không tìm thấy gian hàng');

/** `shopId` gửi kèm phải là gian hàng của công ty, đúng sàn; không thì 404 (cả khi bảng còn hạn, review BE1 P2-7). */
export async function assertShopOn(companyId: string, platform: Marketplace, shopId: string): Promise<void> {
  const shop = await withCompany(companyId, () => ownShop(shopId));
  if (shop.platform !== platform) throw shopNotFound();
}

/**
 * Gọi sàn lấy attribute và luật bảng kích cỡ của một leaf, **ngoài** giao dịch (`channel/CLAUDE.md`: gọi sàn trước, ghi
 * sau; review BE1 P1-2). Sàn cần token: chỉ mở `withCompany` để chọn gian hàng `shopId` (đã kiểm ở `leafDetail`), không
 * gửi thì gian hàng `active` cũ nhất của công ty trên sàn (không có: 409 `shop_not_connected`), rồi lấy phiên; lớp bọc token
 * tự `forCompany` nên hạn mức tính đúng công ty. Sàn không cần token: gọi thẳng trong `forCompany`.
 * `sizeChartRule` `undefined` là không hỏi được (sàn không có luật, hay hỏi lỗi): `replaceLeaf` giữ giá trị đang có (P2-2).
 */
async function fetchLeaf(
  companyId: string,
  platform: Marketplace,
  adapter: MarketplaceAdapter,
  externalId: string,
  shopId: string | undefined,
): Promise<{ attributes: PlatformAttribute[]; sizeChartRule: SizeChartRule | null | undefined }> {
  const call = async (a: MarketplaceAdapter, token: string | null) => {
    const [attributes, rules] = await Promise.all([
      a.leafAttributes!(token, externalId),
      token && a.categoryRules ? a.categoryRules(token, externalId).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    return { attributes, sizeChartRule: rules === undefined ? undefined : (rules.sizeChart ?? null) };
  };
  if (adapter.categoriesNeedToken === false) return forCompany(companyId, () => call(adapter, null));
  const session = await withCompany(companyId, async () => {
    let id = shopId;
    if (id === undefined) {
      const shop = (await listShopRows()).find((s) => s.platform === platform && s.status === 'active' && s.accessTokenEnc);
      if (!shop) throw noShop();
      id = shop.id;
    }
    return shopSession(id);
  });
  return call(session.adapter, session.accessToken);
}

/**
 * Chi tiết một leaf (AC-5, AC-S6): attribute từ bảng, chưa có hoặc quá 7 ngày thì gọi sàn rồi thay cả tập (A3). Gọi sàn
 * lỗi (sàn lỗi, không có gian hàng để gọi) mà bảng còn bản cũ thì trả bản cũ `stale: true`; chưa có bản nào thì lỗi
 * (sàn lỗi tạm 503). Category `removed` không gọi sàn. Node không phải lá: 422 `category_not_leaf`. `shopId` khác công ty
 * hay khác sàn: 404 trước mọi bước khác.
 */
export async function leafDetail(
  ctx: ModuleContext,
  companyId: string,
  raw: string,
  externalId: string,
  opts: { shopId?: string; now?: Date } = {},
): Promise<LeafDetail> {
  const { platform, adapter } = platformOf(raw);
  const { category: found, stale } = await ensureLeaf(companyId, platform, adapter, externalId, opts);
  const category = found;
  if (!category) throw new AppError(404, 'not_found', 'Không tìm thấy category');
  const attributes = await leafAttributesOf(platform, externalId);
  const needOrg = attributes.some((a) => a.tier === 'company');
  const { products, org } = await withCompany(companyId, async () => ({
    products: await productsOn(ctx, platform, externalId),
    org: needOrg ? await responsibleOrgOf(companyId) : null,
  }));
  return {
    category: { ...toCategory(category, await pathIdsOf(platform, [externalId])), sizeChartRule: category.sizeChartRule },
    attributes: attributes.map(({ raw: _raw, ...a }) => {
      const field = a.tier === 'company' ? adapter.responsibleFields?.[a.code] : undefined;
      return { ...a, defaultValue: (field && org?.[field]) || null };
    }),
    fetchedAt: category.attributesFetchedAt,
    stale,
    products,
  };
}

/**
 * Attribute của leaf còn dùng được (A3, A16): chưa có hoặc quá 7 ngày thì gọi sàn rồi thay cả tập. Gọi sàn lỗi mà bảng còn
 * bản cũ: `stale`; chưa có bản nào thì ném (sàn lỗi tạm 503). Category `removed` không gọi sàn. Không phải lá: 422. Gọi ngoài
 * `withCompany` (ghi bảng tham chiếu).
 */
export async function ensureLeaf(
  companyId: string,
  platform: Marketplace,
  adapter: MarketplaceAdapter,
  externalId: string,
  opts: { shopId?: string; now?: Date } = {},
): Promise<{ category: CategoryRow | undefined; stale: boolean }> {
  const now = opts.now ?? new Date();
  if (opts.shopId !== undefined) await assertShopOn(companyId, platform, opts.shopId);
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
  return { category, stale };
}

/** Sản phẩm của công ty có spec trỏ tới leaf (tối đa 200, `specsOnCategory`), mã và tên qua `getVariants({ productIds })` (A13). */
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

/**
 * Giá trị cấp kế của attribute `input = 'cascade'` (#400, Documents/21 §18.5, Lazada GetNextCascadeProp): gọi sàn, không lưu.
 * API cần token gian hàng (khác cây, attribute): `shopId` hoặc gian hàng `active` đầu tiên của công ty trên sàn đó, không có
 * thì 409 `shop_not_connected`. Sàn không có cascade: 422 `marketplace_unsupported`. `cascadeId` lấy ở `raw.id` của attribute
 * đã lưu; attribute chưa có hoặc không phải cascade: 422 `errors.code`.
 */
export async function cascadeLevel(
  companyId: string,
  raw: string,
  externalId: string,
  query: { code: string; path?: string; shopId?: string },
): Promise<CascadeLevel> {
  const { platform, adapter } = platformOf(raw);
  if (!adapter.cascadeNext) throw unsupported();
  const attr = (await leafAttributesOf(platform, externalId)).find((a) => a.code === query.code);
  const cascadeId = attr?.input === 'cascade' && attr.raw['id'] != null ? String(attr.raw['id']) : null;
  if (!cascadeId) {
    throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors: { code: 'Không phải attribute cascade của category này' } });
  }
  const session = await withCompany(companyId, async () => {
    let id = query.shopId;
    if (id === undefined) {
      const shop = (await listShopRows()).find((s) => s.platform === platform && s.status === 'active' && s.accessTokenEnc);
      if (!shop) throw noShop();
      id = shop.id;
    }
    const s = await shopSession(id);
    if (s.shop.platform !== platform) throw new AppError(404, 'not_found', 'Không tìm thấy gian hàng');
    return s;
  });
  return onMarketplace(() => session.adapter.cascadeNext!(session.accessToken, externalId, cascadeId, query.path?.trim() || null));
}
