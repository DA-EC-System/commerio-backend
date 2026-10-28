import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChannelListing, ListingList, PushResults } from '#src/modules/channel/channel/api/schemas.ts';
import { MarketplaceError, type NewProduct } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const categoryId = randomUUID();
const productId = randomUUID();
const variant = (sku: string, extra: Partial<ListingVariant> = {}): ListingVariant => ({
  id: randomUUID(),
  productId,
  productName: 'Áo thun',
  sku,
  categoryId,
  attributesLabel: 'Đen / M',
  archived: false,
  description: 'Áo cotton',
  weightG: 250,
  lengthMm: 300,
  widthMm: 200,
  heightMm: 15,
  ...extra,
});
const ok = variant('CMR-OK');
const noPrice = variant('CMR-NOPRICE');
const noDims = variant('CMR-NODIMS', { weightG: null });
const unmapped = variant('CMR-UNMAPPED', { categoryId: randomUUID() });
const rejected = variant('CMR-REJECT');
const down = variant('CMR-DOWN');
const archived = variant('CMR-ARCHIVED', { archived: true });
const all = [ok, noPrice, noDims, unmapped, rejected, down, archived];

setProductPort({
  variants: async (ids) => all.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, id === noPrice.id ? null : new Decimal(150000)])),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 7])),
});

const created: NewProduct[] = [];
const uploadImage = vi.fn(async (_t: string, url: string) => `https://slatic.test/${encodeURIComponent(url)}`);
const deactivate = vi.fn(async () => {});
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    categoryAttributes: async () => [],
    uploadImage,
    async createProduct(_t, p) {
      if (p.sellerSku === 'CMR-REJECT') throw new MarketplaceError('rejected', '4110', 'Category attribute is mandatory');
      if (p.sellerSku === 'CMR-DOWN') throw new MarketplaceError('unavailable', '901');
      created.push(p);
      return { externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}` };
    },
    deactivate,
  }),
);
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const auth = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);
const push = (variantIds: string[], imageUrls: Record<string, string[]> = { [productId]: ['https://img.test/a.png'] }) =>
  auth(app().post(`/api/v1/channel/shops/${shopId}/listings/push`)).send({ variantIds, imageUrls });

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({
    accessToken: `tok-${randomUUID().slice(0, 12)}`,
  });
  shopId = res.body.shop.id;
  const map = await auth(app().put(`/api/v1/channel/shops/${shopId}/category-maps/${categoryId}`)).send({
    externalCategoryId: '14275',
    attributes: { brand: 'No Brand' },
    version: null,
  });
  expect(map.status).toBe(200);
});

describe('đẩy listing', () => {
  it('kết quả theo từng biến thể, dòng lỗi không làm hỏng dòng khác', async () => {
    const res = await push(all.map((v) => v.id));
    expect(res.status).toBe(200);
    const byS = new Map(PushResults.parse(res.body).results.map((r) => [r.sku, r]));
    expect(byS.get('CMR-OK')).toMatchObject({ outcome: 'created', status: 'under_review', externalSkuId: 'sku-CMR-OK' });
    expect(byS.get('CMR-NOPRICE')).toMatchObject({ outcome: 'failed', code: 'price_missing' });
    expect(byS.get('CMR-NODIMS')).toMatchObject({ outcome: 'failed', code: 'dimensions_missing' });
    expect(byS.get('CMR-UNMAPPED')).toMatchObject({ outcome: 'failed', code: 'category_unmapped' });
    expect(byS.get('CMR-REJECT')).toMatchObject({
      outcome: 'failed',
      code: 'marketplace_rejected',
      status: 'push_failed',
      message: 'Category attribute is mandatory',
    });
    expect(byS.get('CMR-DOWN')).toMatchObject({ outcome: 'failed', code: 'marketplace_unavailable', status: 'push_failed' });
    expect(byS.get('CMR-ARCHIVED')).toMatchObject({ outcome: 'failed', code: 'not_found' });
  });

  it('gửi sàn đúng dữ liệu: ảnh đã đưa lên sàn, giá chuẩn, khả dụng, thuộc tính của danh mục', () => {
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      externalCategoryId: '14275',
      attributes: { brand: 'No Brand' },
      name: 'Áo thun - Đen / M',
      imageUrls: ['https://slatic.test/https%3A%2F%2Fimg.test%2Fa.png'],
      sellerSku: 'CMR-OK',
      price: '150000',
      quantity: 7,
    });
  });

  it('đọc lại: listing under_review có mã sàn, lịch sử pushing → under_review; lỗi sàn ghi pushError', async () => {
    const { rows } = await testPool().query(
      'select variant_id, status, external_sku_id, push_error, push_attempts, platform_stock from channel.listings where shop_id = $1',
      [shopId],
    );
    const byVariant = new Map(rows.map((r) => [r.variant_id, r]));
    expect(byVariant.get(ok.id)).toMatchObject({ status: 'under_review', external_sku_id: 'sku-CMR-OK', platform_stock: 7 });
    expect(byVariant.get(rejected.id)).toMatchObject({ status: 'push_failed', push_attempts: 1 });
    expect(byVariant.get(down.id)).toMatchObject({ push_error: 'Sàn lỗi tạm, đẩy lại sau' });
    expect(byVariant.has(noPrice.id)).toBe(false);

    const okRow = rows.find((r) => r.variant_id === ok.id);
    const history = await testPool().query(
      `select from_state, to_state, action, actor_id is null as by_system from core.state_transitions
       where entity_type = 'listings' and entity_id = (select id from channel.listings where shop_id = $1 and variant_id = $2)
       order by id`,
      [shopId, ok.id],
    );
    expect(okRow).toBeDefined();
    expect(history.rows).toEqual([
      { from_state: null, to_state: 'pushing', action: 'push', by_system: false },
      { from_state: 'pushing', to_state: 'under_review', action: 'send_review', by_system: true },
    ]);
  });

  it('đẩy lại: đã có trên sàn thì already_listed; lỗi đẩy thì tạo lại được, ảnh không gửi lại cũng được khi đã có', async () => {
    const res = await push([ok.id]);
    expect(res.body.results[0]).toMatchObject({ outcome: 'failed', code: 'already_listed' });
    const again = await push([noPrice.id, rejected.id], {});
    const [first, second] = again.body.results;
    expect(first).toMatchObject({ code: 'price_missing' });
    expect(second).toMatchObject({ code: 'images_missing' });
  });

  it('GET listings: mọi biến thể đang bán kèm listing, đúng schema', async () => {
    const res = await auth(app().get(`/api/v1/channel/shops/${shopId}/listings`));
    expect(res.status).toBe(200);
    const items = ListingList.parse(res.body).items;
    expect(items.map((i) => i.sku)).not.toContain('CMR-ARCHIVED');
    expect(items.find((i) => i.sku === 'CMR-OK')).toMatchObject({ price: 150000, listing: { status: 'under_review' } });
    expect(items.find((i) => i.sku === 'CMR-NOPRICE')).toMatchObject({ price: null, listing: null });
  });

  it('kiểm đầu vào và quyền', async () => {
    expect((await push([])).status).toBe(422);
    expect((await push(Array.from({ length: 21 }, () => randomUUID()))).status).toBe(422);
    expect((await push([ok.id], { [productId]: ['ftp://x/a.png'] })).status).toBe(422);
    const sale = await addMember(company.companyId, 'sale');
    expect((await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/push`), sale.token).send({ variantIds: [ok.id] })).status).toBe(403);
    const other = await createCompany({ optionalModules: ['channel'] });
    expect((await auth(app().get(`/api/v1/channel/shops/${shopId}/listings`), other.ceo.token)).status).toBe(404);
  });
});

describe('gỡ listing', () => {
  it('tắt sản phẩm trên sàn rồi chuyển delisted; version cũ 409; chưa có listing 404', async () => {
    const { rows } = await testPool().query('select version from channel.listings where shop_id = $1 and variant_id = $2', [shopId, ok.id]);
    const version = rows[0].version as number;
    const url = `/api/v1/channel/shops/${shopId}/listings/${ok.id}/delist`;
    expect((await auth(app().post(url)).send({ version: version + 5 })).status).toBe(409);
    const res = await auth(app().post(url)).send({ version });
    expect(res.status).toBe(200);
    expect(ChannelListing.parse(res.body)).toMatchObject({ status: 'delisted', platformStock: 0 });
    expect(deactivate).toHaveBeenCalledWith(expect.any(String), 'item-CMR-OK', 'sku-CMR-OK');
    const again = await auth(app().post(url)).send({ version: res.body.version });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');
    expect((await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/${noPrice.id}/delist`)).send({ version: 1 })).status).toBe(404);
  });

  it('gian hàng đã ngắt: 409 shop_not_connected', async () => {
    const shop = await auth(app().get(`/api/v1/channel/shops/${shopId}`));
    await auth(app().post(`/api/v1/channel/shops/${shopId}/disconnect`)).send({ version: shop.body.version });
    const res = await push([down.id]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('shop_not_connected');
  });
});
