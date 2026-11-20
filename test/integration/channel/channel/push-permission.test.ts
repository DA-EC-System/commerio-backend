// Việc nền đẩy dùng spec (#400 lát 11): quyền category theo gian hàng (A17, Documents/21 §18.5 "ghi từ gợi ý và từ lần kiểm
// trước khi đẩy"): sàn có quyền theo gian hàng (TikTok) mà chưa có dòng quyền cho leaf của spec, hoặc dòng quá 7 ngày, thì đọc
// cây bằng token gian hàng (ngoài giao dịch), ghi quyền mọi leaf, rồi mới kiểm; sàn lỗi thì bỏ qua, để sàn quyết. Đẩy xong ghi
// `listings.external_category_id` (không tăng `version`, L029); thương hiệu catalog chuyển vào `NewProduct.brand`.
import { randomInt, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { replaceLeaf } from '#src/modules/channel/channel/repository/platform-categories.ts';
import { upsertPermissions } from '#src/modules/channel/channel/repository/product-specs.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import { MarketplaceError, type NewProduct, type PlatformCategoryNode } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const IMAGES = ['https://files.commerio.test/a.jpg'];
const variants: ListingVariant[] = [];
const port = {
  variants: async (ids?: readonly string[], opts?: { productIds?: readonly string[] }) =>
    variants.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(150000)])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
  productImageUrls: async () => new Map<string, string[]>(),
};
setProductPort(port);

const num = () => String(randomInt(800_000_000, 900_000_000));
/** Quyền leaf theo cây của gian hàng; đổi trong từng ca. */
const tree = new Map<string, string[]>();
const categoryTree = vi.fn(async (): Promise<PlatformCategoryNode[]> => [
  { externalId: 'ROOT', parentExternalId: null, name: 'Gốc', isLeaf: false, path: 'Gốc', permissionStatuses: ['AVAILABLE'] },
  ...[...tree].map(([id, statuses]) => ({ externalId: id, parentExternalId: 'ROOT', name: id, isLeaf: true, path: `Gốc > ${id}`, permissionStatuses: statuses })),
]);
/** Attribute leaf sàn trả khi việc đẩy lấy lại (A16); mặc định không có attribute. */
let leafAttrs: PlatformAttribute[] = [];
const leafAttributes = vi.fn(async () => leafAttrs);
const createProduct = vi.fn(async (_t: string, p: NewProduct) => ({ externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}`, live: true }));
registerAdapter(
  'tiktok',
  fakeAdapter({
    getSeller: async (accessToken) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop TikTok', region: 'VN' }),
    categoriesNeedToken: true,
    categoryPermissionsPerShop: true,
    categoryTree,
    leafAttributes,
    uploadImage: async (_t, url) => url,
    createProduct,
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;

/** Biến thể của một sản phẩm mới có spec TikTok ở `leaf`; trả biến thể. */
async function productWithSpec(leaf: string, brand: string | null = null) {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Giày sneaker nam vải canvas đế cao su',
    sku: `PP-${randomUUID().slice(0, 8)}`,
    categoryId: randomUUID(),
    attributesLabel: '',
    productCode: 'SP-TEST',
    attributes: [],
    archived: false,
    businessStatus: 'selling',
    description: 'Giày',
    weightG: 250,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 15,
    brand,
  };
  variants.push(v);
  await testPool().query(
    `insert into channel.product_specs (company_id, product_id, platform, external_category_id, source, version)
     values ($1, $2, 'tiktok', $3, 'push', 1)`,
    [company.companyId, v.productId, leaf],
  );
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, push_started_at)
     values ($1, $2, $3, $4, 'pushing', now()) returning id`,
    [company.companyId, shopId, v.id, v.sku],
  );
  return { v, listingId: rows[0]!.id };
}
const run = (listingId: string) => runListingPush(port, { companyId: company.companyId, shopId, listingId, imageUrls: IMAGES });
async function listingOf(id: string) {
  const { rows } = await testPool().query('select status, push_error, external_category_id, version from channel.listings where id = $1', [id]);
  return rows[0] as { status: string; push_error: { code: string } | null; external_category_id: string | null; version: number };
}
async function permissionOf(leaf: string) {
  const { rows } = await testPool().query('select status, checked_at from channel.shop_category_permissions where shop_id = $1 and external_category_id = $2', [
    shopId,
    leaf,
  ]);
  return rows[0] as { status: string; checked_at: Date } | undefined;
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  const res = await request(testApp())
    .post('/api/v1/channel/shops/tiktok/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  shopId = res.body.shop.id;
  await activateShop(shopId);
});

beforeEach(() => {
  tree.clear();
  categoryTree.mockClear();
  createProduct.mockClear();
  leafAttributes.mockClear();
  leafAttrs = [];
});

describe('quyền category trước khi đẩy (A17)', () => {
  it('chưa có dòng quyền: đọc cây một lần, ghi mọi leaf; leaf không available → push_failed category_not_permitted, không tạo', async () => {
    const leaf = num();
    const other = num();
    tree.set(leaf, ['INVITE_ONLY']).set(other, ['AVAILABLE']);
    const { listingId } = await productWithSpec(leaf);
    await run(listingId);
    expect(categoryTree).toHaveBeenCalledTimes(1);
    expect((await listingOf(listingId)).push_error?.code).toBe('category_not_permitted');
    expect((await listingOf(listingId)).status).toBe('push_failed');
    expect(createProduct).not.toHaveBeenCalled();
    expect((await permissionOf(leaf))?.status).toBe('invite_only');
    expect((await permissionOf(other))?.status).toBe('available');
    expect(await permissionOf('ROOT')).toBeUndefined();
  });

  it('dòng quyền còn mới (dưới 7 ngày) available: không đọc cây, tạo; ghi external_category_id, version không bị nhảy thêm vì cột này', async () => {
    const leaf = num();
    await testPool().query(
      `insert into channel.shop_category_permissions (company_id, shop_id, external_category_id, status, checked_at) values ($1, $2, $3, 'available', now() - interval '6 days')`,
      [company.companyId, shopId, leaf],
    );
    const { listingId } = await productWithSpec(leaf);
    await run(listingId);
    expect(categoryTree).not.toHaveBeenCalled();
    expect(createProduct).toHaveBeenCalledTimes(1);
    const row = await listingOf(listingId);
    expect(row).toMatchObject({ status: 'live', external_category_id: leaf });
  });

  it('dòng quá 7 ngày: đọc lại cây, cập nhật checked_at và trạng thái mới', async () => {
    const leaf = num();
    await testPool().query(
      `insert into channel.shop_category_permissions (company_id, shop_id, external_category_id, status, checked_at) values ($1, $2, $3, 'available', now() - interval '8 days')`,
      [company.companyId, shopId, leaf],
    );
    // Lần đọc cây gần nhất của gian hàng cũng quá 7 ngày (dòng của ca khác cùng gian hàng).
    await testPool().query("update channel.shop_category_permissions set checked_at = now() - interval '8 days' where shop_id = $1", [shopId]);
    tree.set(leaf, ['PROHIBITED']);
    const { listingId } = await productWithSpec(leaf);
    await run(listingId);
    expect(categoryTree).toHaveBeenCalledTimes(1);
    const p = await permissionOf(leaf);
    expect(p?.status).toBe('prohibited');
    expect(Date.now() - p!.checked_at.getTime()).toBeLessThan(60_000);
    expect((await listingOf(listingId)).push_error?.code).toBe('category_not_permitted');
  });

  it('đọc cây lỗi: bỏ qua, vẫn đẩy (sàn quyết)', async () => {
    await testPool().query("update channel.shop_category_permissions set checked_at = now() - interval '8 days' where shop_id = $1", [shopId]);
    categoryTree.mockRejectedValueOnce(new MarketplaceError('unavailable'));
    const { listingId } = await productWithSpec(num());
    await run(listingId);
    expect(categoryTree).toHaveBeenCalledTimes(1);
    expect(createProduct).toHaveBeenCalledTimes(1);
    expect((await listingOf(listingId)).status).toBe('live');
  });

  it('review BE2 P2-4: leaf không có trong cây (không có dòng quyền) mà gian hàng vừa đọc cây: không đọc lại mỗi lần đẩy', async () => {
    await testPool().query("update channel.shop_category_permissions set checked_at = now() - interval '8 days' where shop_id = $1", [shopId]);
    tree.set(num(), ['AVAILABLE']);
    const missing = num();
    const first = await productWithSpec(missing);
    await run(first.listingId);
    expect(categoryTree).toHaveBeenCalledTimes(1);
    expect(await permissionOf(missing)).toBeUndefined();
    const second = await productWithSpec(missing);
    await run(second.listingId);
    expect(categoryTree).toHaveBeenCalledTimes(1);
    expect((await listingOf(second.listingId)).status).toBe('live');
  });
});

// Review BE2 P2-3 (A16, AC-13): việc đẩy lấy lại attribute leaf cả khi bản trong bảng **quá 7 ngày**, không chỉ khi chưa có:
// attribute bắt buộc sàn mới thêm phải vào `missing` (`spec_incomplete`) thay vì để sàn từ chối với câu khó hiểu.
describe('attribute leaf cũ trước khi đẩy (A16)', () => {
  const required: PlatformAttribute = {
    code: '100999',
    label: 'Thuộc tính mới',
    kind: 'property',
    input: 'text',
    options: [],
    allowCustom: true,
    required: true,
    requiredWhen: null,
    isKey: false,
    tier: 'category',
    raw: {},
  };
  const days = (n: number) => new Date(Date.now() - n * 24 * 3600_000);

  it('attribute quá 7 ngày: lấy lại; sàn vừa thêm attribute bắt buộc → push_failed spec_incomplete, không tạo', async () => {
    const leaf = num();
    tree.set(leaf, ['AVAILABLE']);
    await replaceLeaf('tiktok', leaf, { attributes: [], sizeChartRule: null, fetchedAt: days(8) });
    leafAttrs = [required];
    const { listingId } = await productWithSpec(leaf);
    await run(listingId);
    expect(leafAttributes).toHaveBeenCalledTimes(1);
    expect(createProduct).not.toHaveBeenCalled();
    expect(await listingOf(listingId)).toMatchObject({ status: 'push_failed', push_error: { code: 'spec_incomplete' } });
  });

  it('attribute còn mới (dưới 7 ngày): không gọi sàn', async () => {
    const leaf = num();
    tree.set(leaf, ['AVAILABLE']);
    await replaceLeaf('tiktok', leaf, { attributes: [], sizeChartRule: null, fetchedAt: days(1) });
    leafAttrs = [required];
    const { listingId } = await productWithSpec(leaf);
    await run(listingId);
    expect(leafAttributes).not.toHaveBeenCalled();
    expect(createProduct).toHaveBeenCalledTimes(1);
  });
});

describe('dữ liệu đẩy', () => {
  it('thương hiệu catalog vào NewProduct.brand', async () => {
    const leaf = num();
    tree.set(leaf, ['AVAILABLE']);
    const { listingId } = await productWithSpec(leaf, 'Teas');
    await run(listingId);
    expect(createProduct.mock.calls[0]![1]).toMatchObject({ externalCategoryId: leaf, brand: 'Teas' });
  });
});

// Review BE2 P2-9: `upsertPermissions` truyền mã leaf bằng tham số, không tự dựng literal mảng (trước chỉ bỏ `"`, không thoát `\`).
describe('upsertPermissions', () => {
  it('mã có dấu ngoặc kép, gạch chéo ngược, dấu phẩy, ngoặc nhọn ghi đúng nguyên văn', async () => {
    const odd = [`${num()}"a`, `${num()}\b`, `${num()},c`, `${num()}{d}`];
    await withCompany(company.companyId, () =>
      upsertPermissions(company.companyId, shopId, odd.map((externalCategoryId) => ({ externalCategoryId, status: 'available' as const })), new Date()),
    );
    for (const id of odd) expect((await permissionOf(id))?.status).toBe('available');
  });
});
