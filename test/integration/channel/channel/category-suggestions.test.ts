// Gợi ý category của sàn theo sản phẩm (#400 lát 9, AC-1, AC-2, AC-3; Documents/21 §18.5): tên và ảnh đầu qua cổng
// product, gọi sàn bằng token gian hàng, Lazada thiếu ảnh 422 `images_missing`, TikTok tên dưới 25 ký tự 422
// `product_name_too_short` (cả hai không gọi sàn), gian hàng không `active` 409, sàn `unavailable` gọi lại một lần rồi 503,
// quyền TikTok ghi `shop_category_permissions`, đường dẫn lấy từ cây khi đã đồng bộ (A10).
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CategorySuggestionsView } from '#src/modules/channel/channel/api/schemas.ts';
import {
  type CategorySuggestion,
  MarketplaceError,
  registerAdapter,
  resetAdapters,
} from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const app = testApp();
const variants: ListingVariant[] = [];
const images = new Map<string, string[]>();
setProductPort({
  variants: async (_ids, opts) => variants.filter((v) => !opts?.productIds || opts.productIds.includes(v.productId)),
  standardPrices: async () => new Map(),
  availableOf: async () => new Map(),
  productImageUrls: async (ids) => new Map(ids.flatMap((id) => (images.has(id) ? [[id, images.get(id)!] as const] : []))),
});

const num = () => String(randomInt(800_000_000, 900_000_000));
const lzLeaf = num();
const lzOther = num();
const ttLeaf = num();
const lazadaSuggest = vi.fn(async (): Promise<CategorySuggestion[]> => [
  { externalId: lzLeaf, path: "Men's Clothing > Tops > T-Shirts", permissionStatuses: null },
  { externalId: lzOther, path: "Women's Clothing > Tops", permissionStatuses: null },
]);
const tiktokSuggest = vi.fn(async (): Promise<CategorySuggestion[]> => [
  { externalId: ttLeaf, path: 'Giày dép > Giày dép nam > Giày thể thao', permissionStatuses: ['INVITE_ONLY'] },
]);
const seller = async (accessToken: string) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' });
registerAdapter('lazada', fakeAdapter({ getSeller: seller, suggestionRules: { needsImage: true }, suggestCategories: lazadaSuggest }));
registerAdapter('tiktok', fakeAdapter({ getSeller: seller, suggestionRules: { minNameLength: 25 }, suggestCategories: tiktokSuggest }));
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

let ceo: { token: string; companyId: string };
let lazadaShop: string;
let tiktokShop: string;

function product(name: string, withImage: boolean): string {
  const productId = randomUUID();
  variants.push({
    id: randomUUID(),
    productId,
    productName: name,
    productCode: 'SP-TEST',
    sku: `SKU-${productId.slice(0, 8)}`,
    attributesLabel: '',
    attributes: [],
    archived: false,
    businessStatus: 'selling',
    description: null,
    weightG: null,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
  });
  if (withImage) images.set(productId, ['https://img.test/a.jpg']);
  return productId;
}

const connect = async (platform: 'lazada' | 'tiktok') => {
  const res = await request(app)
    .post(`/api/v1/channel/shops/${platform}/token`)
    .set('Authorization', `Bearer ${ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.shop.id as string;
};
const get = (shopId: string, productId: string, token = ceo.token) =>
  request(app).get(`/api/v1/channel/shops/${shopId}/category-suggestions?productId=${productId}`).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  await testPool().query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at)
     values ('lazada', $1, 'Áo thun', true, 'Thời trang nam > Áo > Áo thun', 'thoi trang nam > ao > ao thun', now())`,
    [lzLeaf],
  );
  const c = await createCompany({ optionalModules: [] });
  ceo = { token: c.ceo.token, companyId: c.companyId };
  lazadaShop = await connect('lazada');
  tiktokShop = await connect('tiktok');
});

beforeEach(() => {
  lazadaSuggest.mockClear();
  tiktokSuggest.mockClear();
});

describe('category-suggestions', () => {
  it('gian hàng chưa active: 409 shop_not_connected, không gọi sàn', async () => {
    const res = await get(lazadaShop, product('Áo thun nam cổ tròn', true));
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/shop_not_connected');
    expect(lazadaSuggest).not.toHaveBeenCalled();
  });

  it('AC-1 Lazada: đúng thứ tự sàn, gửi tên và ảnh đầu, permission null, đường dẫn từ cây khi đã đồng bộ', async () => {
    await activateShop(lazadaShop);
    await activateShop(tiktokShop);
    const pid = product('Áo thun nam cổ tròn', true);
    const res = await get(lazadaShop, pid);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    CategorySuggestionsView.parse(res.body);
    expect(res.body).toEqual({
      items: [
        { externalId: lzLeaf, path: 'Thời trang nam > Áo > Áo thun', permission: null },
        { externalId: lzOther, path: "Women's Clothing > Tops", permission: null },
      ],
      cached: false,
    });
    expect(lazadaSuggest).toHaveBeenCalledWith(expect.stringMatching(/^tok-/), { name: 'Áo thun nam cổ tròn', imageUrl: 'https://img.test/a.jpg' });
  });

  it('Lazada sản phẩm chưa có ảnh: 422 images_missing, không gọi sàn', async () => {
    const res = await get(lazadaShop, product('Áo thun nam cổ tròn', false));
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/images_missing');
    expect(lazadaSuggest).not.toHaveBeenCalled();
  });

  it('AC-2 TikTok: một leaf kèm quyền, ghi shop_category_permissions của gian hàng đó', async () => {
    const res = await get(tiktokShop, product('Giày sneaker nam vải canvas đế cao su', false));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toEqual([{ externalId: ttLeaf, path: 'Giày dép > Giày dép nam > Giày thể thao', permission: 'invite_only' }]);
    const { rows } = await testPool().query(
      'select status, company_id, checked_at from channel.shop_category_permissions where shop_id = $1 and external_category_id = $2',
      [tiktokShop, ttLeaf],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'invite_only', company_id: ceo.companyId });
    const first = rows[0].checked_at as Date;

    tiktokSuggest.mockResolvedValueOnce([{ externalId: ttLeaf, path: 'x', permissionStatuses: ['AVAILABLE'] }]);
    await get(tiktokShop, product('Giày sneaker nam vải canvas đế cao su', false));
    const again = await testPool().query(
      'select status, checked_at from channel.shop_category_permissions where shop_id = $1 and external_category_id = $2',
      [tiktokShop, ttLeaf],
    );
    expect(again.rows[0].status).toBe('available');
    expect((again.rows[0].checked_at as Date).getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  it('AC-3 TikTok tên dưới 25 ký tự: 422 product_name_too_short kèm min 25, không gọi sàn', async () => {
    const res = await get(tiktokShop, product('Áo thun Oversize', true));
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/product_name_too_short');
    expect(res.body.min).toBe(25);
    expect(tiktokSuggest).not.toHaveBeenCalled();
  });

  it('sàn unavailable: gọi lại một lần; lần hai được thì 200', async () => {
    tiktokSuggest.mockRejectedValueOnce(new MarketplaceError('unavailable', '36009003'));
    const res = await get(tiktokShop, product('Giày sneaker nam vải canvas đế cao su', false));
    expect(res.status).toBe(200);
    expect(tiktokSuggest).toHaveBeenCalledTimes(2);
  });

  it('sàn unavailable hai lần: 503 marketplace_unavailable, đúng hai lời gọi', async () => {
    tiktokSuggest.mockRejectedValueOnce(new MarketplaceError('unavailable')).mockRejectedValueOnce(new MarketplaceError('unavailable'));
    const res = await get(tiktokShop, product('Giày sneaker nam vải canvas đế cao su', false));
    expect(res.status).toBe(503);
    expect(res.body.type).toBe('/problems/marketplace_unavailable');
    expect(tiktokSuggest).toHaveBeenCalledTimes(2);
  });

  it('sàn từ chối: không gọi lại, 409 marketplace_rejected', async () => {
    tiktokSuggest.mockRejectedValueOnce(new MarketplaceError('rejected', '12052051'));
    const res = await get(tiktokShop, product('Giày sneaker nam vải canvas đế cao su', false));
    expect(res.status).toBe(409);
    expect(tiktokSuggest).toHaveBeenCalledTimes(1);
  });

  it('sản phẩm không có, gian hàng công ty khác hay id sai: 404; Sale: 403', async () => {
    expect((await get(lazadaShop, randomUUID())).status).toBe(404);
    expect((await get('khong-phai-uuid', randomUUID())).status).toBe(404);
    const other = await createCompany({ optionalModules: [] });
    expect((await get(lazadaShop, product('Áo thun nam cổ tròn', true), other.ceo.token)).status).toBe(404);
    const sale = await addMember(ceo.companyId, 'sale');
    expect((await get(lazadaShop, product('Áo thun nam cổ tròn', true), sale.token)).status).toBe(403);
    expect(lazadaSuggest).not.toHaveBeenCalled();
  });

  it('thiếu productId: 422', async () => {
    const res = await request(app).get(`/api/v1/channel/shops/${lazadaShop}/category-suggestions`).set('Authorization', `Bearer ${ceo.token}`);
    expect(res.status).toBe(422);
    expect(res.body.errors.productId).toBeDefined();
  });
});
