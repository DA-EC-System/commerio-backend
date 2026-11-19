// Ảnh bảng kích cỡ khi đẩy lên TikTok (#347, Documents/21 §18.5): quy tắc của category sàn (`platform_categories`, #400; lấy cùng
// attribute của leaf, test ở `platform-categories.test.ts`), request chặn trước khi xếp việc, việc nền tải ảnh lên sàn rồi gửi `size_chart`. Sàn và cổng sản phẩm đều giả.
import { randomInt, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushResults } from '#src/modules/channel/channel/api/schemas.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import { type CategoryRules, MarketplaceError, type NewProduct, type SizeChartRule } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter, seedSpecs } from './helpers.ts';

const IMAGES = ['https://files.commerio.test/a.jpg'];
const CHART_URL = 'https://files.commerio.test/size-chart.png';

const variants: ListingVariant[] = [];
const sizeCharts = new Map<string, string>();
const newVariant = (categoryId: string) => {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Áo thun',
    sku: `SC-${randomUUID().slice(0, 8)}`,
    categoryId,
    attributesLabel: 'Đen / M',
    productCode: 'SP-TEST',
    attributes: [],
    archived: false,
    businessStatus: 'selling',
    description: 'Áo cotton',
    weightG: 250,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 15,
  };
  variants.push(v);
  return v;
};
setProductPort({
  variants: async (ids) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(150000)])),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 7])),
  productImageUrls: async (ids) => new Map(variants.filter((v) => ids.includes(v.productId)).map((v) => [v.productId, IMAGES])),
  productSizeChartUrls: async (ids) => new Map(ids.flatMap((id) => (sizeCharts.has(id) ? [[id, sizeCharts.get(id)!] as const] : []))),
});

/** Quy tắc sàn theo mã category sàn: `REQ` bắt buộc, `OPT` tuỳ chọn, `NONE` không hỗ trợ, mã thêm theo ca; còn lại lỗi tạm. */
const rules = new Map<string, CategoryRules['sizeChart']>([
  ['REQ', 'required'],
  ['OPT', 'optional'],
  ['NONE', 'unsupported'],
]);
const categoryRules = vi.fn(async (_t: string, externalId: string): Promise<CategoryRules> => {
  const rule = rules.get(externalId);
  if (!rule) throw new MarketplaceError('unavailable');
  return { sizeChart: rule };
});
const uploadImage = vi.fn(async (_t: string, url: string, purpose?: string) => `tos/${purpose ?? 'main'}/${encodeURIComponent(url)}`);
const createProduct = vi.fn(async (_t: string, p: NewProduct) => ({ externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}`, live: false }));
registerAdapter(
  'tiktok',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop TikTok', region: 'VN' };
    },
    listOrders: async () => ({ orders: [], nextCursor: null, safeUntil: null }),
    getOrder: async () => {
      throw new Error('không có đơn');
    },
    categoryRules,
    uploadImage,
    createProduct,
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);

/**
 * Spec TikTok của sản phẩm mới (#400 lát 15, thay ghép danh mục cũ) ở một category lá riêng; quy tắc bảng kích cỡ lưu ở
 * `platform_categories.size_chart_rule` (`rule` null: chưa có quy tắc, như dữ liệu trước #347); `remote` là quy tắc sàn trả khi hỏi
 * (undefined: sàn lỗi tạm). Trả biến thể.
 */
async function specVariant(rule: SizeChartRule | null, remote: SizeChartRule | undefined = rule ?? undefined) {
  const leaf = String(randomInt(800_000_000, 900_000_000));
  if (remote) rules.set(leaf, remote);
  await testPool().query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at, size_chart_rule)
     values ('tiktok', $1, 'Áo', true, 'Thời trang > Áo', 'thoi trang > ao', now(), $2)`,
    [leaf, rule],
  );
  const v = newVariant(randomUUID());
  await seedSpecs(company.companyId, 'tiktok', leaf, [v]);
  return v;
}

const push = async (variantIds: string[]) => {
  const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/push`)).send({ variantIds });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return PushResults.parse(res.body).results;
};

async function jobsOf(listingId: string) {
  const { rows } = await testPool().query<{ data: Record<string, unknown> }>(
    "select data from pgboss.job where name = 'channel.listing_push' and data->>'listingId' = $1",
    [listingId],
  );
  return rows.map((r) => r.data);
}

/** Một listing `pushing` của biến thể, để chạy việc nền như worker. */
async function pushing(v: ListingVariant) {
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, push_started_at)
     values ($1, $2, $3, $4, 'pushing', now()) returning id`,
    [company.companyId, shopId, v.id, v.sku],
  );
  return rows[0]!.id;
}
const run = (listingId: string, sizeChartUrl: string | null = null) =>
  runListingPush(
    {
      variants: async (ids) => variants.filter((v) => !ids || ids.includes(v.id)),
      standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(150000)])),
      availableOf: async (ids) => new Map(ids.map((id) => [id, 7])),
      productImageUrls: async () => new Map(),
    },
    { companyId: company.companyId, shopId, listingId, imageUrls: IMAGES, ...(sizeChartUrl && { sizeChartUrl }) },
  );
async function listingOf(id: string) {
  const { rows } = await testPool().query('select status, push_error from channel.listings where id = $1', [id]);
  return rows[0] as { status: string; push_error: { code: string; message: string } | null };
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/tiktok/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  shopId = res.body.shop.id;
  await activateShop(shopId);
});

beforeEach(() => {
  sizeCharts.clear();
  categoryRules.mockClear();
  uploadImage.mockClear();
  createProduct.mockClear();
});

describe('request đẩy: chặn size_chart_missing trước khi xếp việc', () => {
  it('danh mục bắt buộc mà sản phẩm chưa có ảnh bảng kích cỡ: size_chart_missing, không có bản ghi, không có việc', async () => {
    const v = await specVariant('required');
    const [result] = await push([v.id]);
    expect(result).toMatchObject({ listingId: null, status: null, code: 'size_chart_missing' });
    expect(result!.message).toContain('bảng kích cỡ');
    const { rows } = await testPool().query('select id from channel.listings where variant_id = $1', [v.id]);
    expect(rows).toEqual([]);
  });

  it('có ảnh bảng kích cỡ thì xếp việc kèm sizeChartUrl; danh mục tuỳ chọn hay không hỗ trợ không bị chặn', async () => {
    const required = await specVariant('required');
    sizeCharts.set(required.productId, CHART_URL);
    const optional = await specVariant('optional');
    const none = await specVariant('unsupported');
    const results = await push([required.id, optional.id, none.id]);
    expect(results.map((r) => [r.status, r.code])).toEqual([
      ['pushing', null],
      ['pushing', null],
      ['pushing', null],
    ]);
    expect(await jobsOf(results[0]!.listingId!)).toEqual([
      { companyId: company.companyId, shopId, listingId: results[0]!.listingId, imageUrls: IMAGES, sizeChartUrl: CHART_URL },
    ]);
    // Không có ảnh bảng kích cỡ thì việc không mang `sizeChartUrl` (dạng cũ).
    expect(await jobsOf(results[1]!.listingId!)).toEqual([{ companyId: company.companyId, shopId, listingId: results[1]!.listingId, imageUrls: IMAGES }]);
  });
});

describe('việc nền đẩy lên sàn', () => {
  it('có ảnh bảng kích cỡ: tải lên với mục đích size_chart rồi gửi sizeChartUri trong sản phẩm', async () => {
    const v = await specVariant('required');
    const id = await pushing(v);
    await run(id, CHART_URL);
    expect(uploadImage).toHaveBeenCalledWith(expect.any(String), CHART_URL, 'size_chart');
    expect(createProduct.mock.calls[0]![1]).toMatchObject({ sizeChartUri: `tos/size_chart/${encodeURIComponent(CHART_URL)}` });
    expect((await listingOf(id)).status).toBe('under_review');
  });

  it('danh mục không hỗ trợ bảng kích cỡ: không tải, không gửi dù sản phẩm có ảnh', async () => {
    const v = await specVariant('unsupported');
    await run(await pushing(v), CHART_URL);
    expect(uploadImage).not.toHaveBeenCalledWith(expect.anything(), CHART_URL, 'size_chart');
    expect(createProduct.mock.calls[0]![1]).not.toHaveProperty('sizeChartUri');
  });

  it('danh mục bắt buộc mà việc không có ảnh (ảnh bị gỡ giữa lúc bấm và lúc chạy): fail size_chart_missing, không gọi sàn tạo sản phẩm', async () => {
    const v = await specVariant('required');
    const id = await pushing(v);
    await run(id);
    expect(createProduct).not.toHaveBeenCalled();
    expect(await listingOf(id)).toMatchObject({ status: 'push_failed', push_error: { code: 'size_chart_missing' } });
  });

  it('ghép trước #347 chưa có quy tắc: hỏi sàn một lần, bắt buộc thì cũng chặn', async () => {
    const v = await specVariant(null, 'required');
    const id = await pushing(v);
    await run(id);
    expect(categoryRules).toHaveBeenCalledTimes(1);
    expect(createProduct).not.toHaveBeenCalled();
    expect((await listingOf(id)).push_error?.code).toBe('size_chart_missing');
  });

  it('chưa có quy tắc và sàn lỗi tạm khi hỏi: coi như chưa biết, vẫn đẩy để sàn quyết', async () => {
    const v = await specVariant(null, undefined);
    await run(await pushing(v));
    expect(createProduct).toHaveBeenCalledTimes(1);
  });
});
