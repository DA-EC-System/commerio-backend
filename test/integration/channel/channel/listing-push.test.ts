// Việc nền đẩy listing `channel.listing_push` (#219, Documents/21 §18.3, §18.6.4): gọi thẳng handler với adapter giả.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldJob } from '#src/modules/core/index.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { PUSH_ATTEMPTS, runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import { type CreatedProduct, MarketplaceError, type NewProduct } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
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
  businessStatus: 'selling',
  description: 'Áo cotton',
  weightG: 250,
  lengthMm: 300,
  widthMm: 200,
  heightMm: 15,
  ...extra,
});
const variants: ListingVariant[] = [];
const noPrice = new Set<string>();
const port = {
  variants: async (ids?: readonly string[]) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, noPrice.has(id) ? null : new Decimal(150000)])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
};
setProductPort(port);

/** Sàn giả: mỗi ca đặt `onCreate`, `onUpdate`; ghi lại dữ liệu đã gửi. */
let onCreate: (p: NewProduct) => Promise<CreatedProduct>;
let onUpdate: (productId: string, skuId: string, p: NewProduct) => Promise<{ live: boolean }>;
const createProduct = vi.fn((_t: string, p: NewProduct) => onCreate(p));
const updateProduct = vi.fn((_t: string, productId: string, skuId: string, p: NewProduct) => onUpdate(productId, skuId, p));
const uploadImage = vi.fn(async (_t: string, url: string) => `https://slatic.test/${encodeURIComponent(url)}`);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    categoryAttributes: async () => [],
    uploadImage,
    createProduct,
    updateProduct,
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
const job = (listingId: string, imageUrls = ['https://img.test/a.png']) => ({ companyId: company.companyId, shopId, listingId, imageUrls });

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  const map = await auth(app().put(`/api/v1/channel/shops/${shopId}/category-maps/${categoryId}`)).send({
    externalCategoryId: '14275',
    attributes: { brand: 'No Brand' },
    version: null,
  });
  expect(map.status).toBe(200);
});

beforeEach(() => {
  createProduct.mockClear();
  updateProduct.mockClear();
  uploadImage.mockClear();
  onCreate = async (p) => ({ externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}`, live: false });
  onUpdate = async () => ({ live: true });
});

/** Một listing `pushing` của biến thể mới; `cols` ghi đè cột (tên cột SQL). */
async function pushing(cols: Record<string, unknown> = {}, extra: Partial<ListingVariant> = {}) {
  const v = variant(`CMR-${randomUUID().slice(0, 8)}`, extra);
  variants.push(v);
  const all = { company_id: company.companyId, shop_id: shopId, variant_id: v.id, seller_sku: v.sku, status: 'pushing', push_started_at: new Date(), ...cols };
  const keys = Object.keys(all);
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.listings (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(all),
  );
  return { v, id: rows[0]!.id };
}

async function listing(id: string) {
  const { rows } = await testPool().query(
    `select status, external_product_id, external_sku_id, external_image_urls, push_error, push_attempts, stock_sync, price_sync,
            listed_price, platform_stock, reject_reason from channel.listings where id = $1`,
    [id],
  );
  return rows[0];
}

async function history(id: string) {
  const { rows } = await testPool().query<{ from: string; to: string; action: string; actor_id: string | null }>(
    `select from_state as "from", to_state as "to", action, actor_id from core.state_transitions
      where entity_type = 'listings' and entity_id = $1 order by id`,
    [id],
  );
  return rows;
}

describe('việc nền channel.listing_push', () => {
  it('AC-10, AC-21, C2-05/06: tạo mới trên sàn, ghi mã sàn, ảnh, giá, tồn; lịch sử pushing → under_review do hệ thống', async () => {
    const { id, v } = await pushing({ seller_sku: 'SKU-TREN-SAN' });
    await runListingPush(port, job(id));
    expect(createProduct).toHaveBeenCalledTimes(1);
    const sent = createProduct.mock.calls[0]![1];
    const startedAt = (await testPool().query('select push_started_at from channel.listings where id = $1', [id])).rows[0].push_started_at as Date;
    expect(sent).toMatchObject({
      sellerSku: 'SKU-TREN-SAN',
      name: 'Áo thun - Đen / M',
      price: '150000',
      quantity: 7,
      imageUrls: ['https://slatic.test/https%3A%2F%2Fimg.test%2Fa.png'],
      idempotencyKey: `cm-${id}-${startedAt.getTime()}`,
    });
    expect(await listing(id)).toMatchObject({
      status: 'under_review',
      external_product_id: 'item-SKU-TREN-SAN',
      external_sku_id: 'sku-SKU-TREN-SAN',
      external_image_urls: ['https://slatic.test/https%3A%2F%2Fimg.test%2Fa.png'],
      push_error: null,
      listed_price: '150000.00',
      platform_stock: 7,
      stock_sync: 'synced',
    });
    expect(await history(id)).toEqual([{ from: 'pushing', to: 'under_review', action: 'send_review', actor_id: null }]);
    expect(v.sku).not.toBe('SKU-TREN-SAN');
  });

  it('AC-17, AC-20, C2-02…04: listing đã có mã sàn (đẩy lại) gọi updateProduct, không tạo; dùng ảnh đã có, tồn để đồng bộ đẩy', async () => {
    const { id } = await pushing({ external_product_id: 'P1', external_sku_id: 'S1', external_image_urls: ['https://slatic.test/cu.png'] });
    await runListingPush(port, job(id, []));
    expect(createProduct).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
    expect(updateProduct.mock.calls[0]!.slice(1, 3)).toEqual(['P1', 'S1']);
    expect(updateProduct.mock.calls[0]![3].imageUrls).toEqual(['https://slatic.test/cu.png']);
    expect(await listing(id)).toMatchObject({ status: 'live', external_product_id: 'P1', stock_sync: 'pending', price_sync: 'synced' });
  });

  it('AC-7: lỗi tạm thì ghi pushError, tăng pushAttempts, giữ pushing và ném để thử lại; lần thứ 5 thì push_failed, không ném', async () => {
    onCreate = async () => {
      throw new MarketplaceError('unavailable', '901', 'Hệ thống bận');
    };
    const { id } = await pushing();
    await expect(runListingPush(port, job(id))).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await listing(id)).toMatchObject({
      status: 'pushing',
      push_attempts: 1,
      push_error: { code: 'marketplace_unavailable', message: 'Hệ thống bận', at: expect.any(String) },
    });
    await testPool().query('update channel.listings set push_attempts = $2 where id = $1', [id, PUSH_ATTEMPTS - 1]);
    await expect(runListingPush(port, job(id))).resolves.toBeUndefined();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', push_attempts: PUSH_ATTEMPTS });
  });

  it('AC-8, C2-07: sàn từ chối thì push_failed ngay kèm câu của sàn, không ném', async () => {
    onCreate = async () => {
      throw new MarketplaceError('rejected', '4110', 'Category attribute is mandatory');
    };
    const { id } = await pushing();
    await expect(runListingPush(port, job(id))).resolves.toBeUndefined();
    expect(await listing(id)).toMatchObject({
      status: 'push_failed',
      push_attempts: 1,
      push_error: { code: 'marketplace_rejected', message: 'Category attribute is mandatory' },
    });
    expect((await history(id)).at(-1)).toMatchObject({ to: 'push_failed', action: 'fail', actor_id: null });
  });

  it('việc chạy lại khi listing không còn pushing thì bỏ, không gọi sàn', async () => {
    const { id } = await pushing({ status: 'under_review', external_product_id: 'P', external_sku_id: `S-${randomUUID()}` });
    await runListingPush(port, job(id));
    expect(createProduct).not.toHaveBeenCalled();
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it('AC-9: quá 30 phút vẫn pushing thì push_failed, không gọi sàn', async () => {
    const { id } = await pushing({ push_started_at: new Date(Date.now() - 31 * 60_000) });
    await runListingPush(port, job(id));
    expect(createProduct).not.toHaveBeenCalled();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', push_error: { code: 'marketplace_unavailable' } });
  });

  it('dữ liệu đổi giữa lúc xếp việc và lúc chạy (mất giá) thì push_failed với mã của dòng', async () => {
    const { id, v } = await pushing();
    noPrice.add(v.id);
    await runListingPush(port, job(id));
    expect(await listing(id)).toMatchObject({ status: 'push_failed', push_error: { code: 'price_missing' } });
  });

  it('AC-22: listing đổi trong lúc gọi sàn (đồng bộ vừa fail) thì không ném, chỉ ghi mã sàn vừa tạo', async () => {
    const { id } = await pushing();
    onCreate = async (p) => {
      await testPool().query("update channel.listings set status = 'push_failed', version = version + 1 where id = $1", [id]);
      return { externalProductId: 'P-MUON', externalSkuId: `S-${p.sellerSku}`, live: true };
    };
    await expect(runListingPush(port, job(id))).resolves.toBeUndefined();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', external_product_id: 'P-MUON' });
  });

  describe('gian hàng', () => {
    const setShop = (status: string, extra = '') => testPool().query(`update channel.shops set status = $2 ${extra} where id = $1`, [shopId, status]);
    afterAll(() => setShop('connecting'));

    it('AC-S3: gian hàng mất uỷ quyền thì giữ việc (HoldJob), listing vẫn pushing', async () => {
      const { id } = await pushing();
      await setShop('needs_reauth');
      await expect(runListingPush(port, job(id))).rejects.toBeInstanceOf(HoldJob);
      expect((await listing(id)).status).toBe('pushing');
      await setShop('connecting');
    });

    it('sàn từ chối token giữa lúc đẩy thì gian hàng needs_reauth và giữ việc', async () => {
      onCreate = async () => {
        throw new MarketplaceError('unauthorized', 'IllegalAccessToken');
      };
      const { id } = await pushing();
      await expect(runListingPush(port, job(id))).rejects.toBeInstanceOf(HoldJob);
      const { rows } = await testPool().query('select status from channel.shops where id = $1', [shopId]);
      expect(rows[0].status).toBe('needs_reauth');
      expect((await listing(id)).status).toBe('pushing');
      await setShop('connecting');
    });

    it('gian hàng đã ngắt thì push_failed "Gian hàng đã ngắt"', async () => {
      const { id } = await pushing();
      await setShop('disconnected', ', disconnected_at = now()');
      await runListingPush(port, job(id));
      expect(await listing(id)).toMatchObject({ status: 'push_failed', push_error: { message: 'Gian hàng đã ngắt' } });
      await setShop('connecting', ', disconnected_at = null');
    });
  });
});
