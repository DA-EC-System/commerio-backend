// Việc nền đẩy listing `channel.listing_push` (#219, Documents/21 §18.3, §18.6.4): gọi thẳng handler với adapter giả.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldJob } from '#src/modules/core/index.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { PUSH_ATTEMPTS, runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import { type CreatedProduct, MarketplaceError, type NewProduct, type RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter, seedSpecs } from './helpers.ts';

const categoryId = randomUUID();
const productId = randomUUID();
const variant = (sku: string, extra: Partial<ListingVariant> = {}): ListingVariant => ({
  id: randomUUID(),
  productId,
  productName: 'Áo thun',
  sku,
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
  ...extra,
});
const variants: ListingVariant[] = [];
const noPrice = new Set<string>();
const port = {
  variants: async (ids?: readonly string[]) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, noPrice.has(id) ? null : new Decimal(150000)])),
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
};
setProductPort(port);

/** Sàn giả: mỗi ca đặt `onCreate`, `onUpdate`; ghi lại dữ liệu đã gửi. */
let onCreate: (p: NewProduct) => Promise<CreatedProduct>;
let onUpdate: (productId: string, skuId: string, p: NewProduct) => Promise<{ live: boolean }>;
const createProduct = vi.fn((_t: string, p: NewProduct) => onCreate(p));
const updateProduct = vi.fn((_t: string, productId: string, skuId: string, p: NewProduct) => onUpdate(productId, skuId, p));
const uploadImage = vi.fn(async (_t: string, url: string) => `https://slatic.test/${encodeURIComponent(url)}`);
/** Trạng thái SKU trên sàn giả theo SellerSku (#399): `getSkus` đọc, `activate` bật lên `afterActivate`. */
const remote = new Map<string, { productId: string; skuId: string; state: RemoteSku['state'] }>();
let afterActivate: RemoteSku['state'] = 'live';
const getSkus = vi.fn(async (_t: string, sellerSkus: readonly string[]): Promise<RemoteSku[]> =>
  sellerSkus.flatMap((sellerSku) => {
    const r = remote.get(sellerSku);
    return r ? [{ externalProductId: r.productId, externalSkuId: r.skuId, sellerSku, title: 'Áo của người bán', state: r.state, rejectReason: null, quantity: 3 }] : [];
  }),
);
const activate = vi.fn(async (_t: string, productId: string) => {
  for (const r of remote.values()) if (r.productId === productId) r.state = afterActivate;
});
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
    getSkus,
    activate,
  }),
);
// Gian hàng TikTok kéo đơn được: mất uỷ quyền thì SKU bán trên đó chưa tin được (#223).
registerAdapter(
  'tiktok',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop TikTok', region: 'VN' };
    },
    listOrders: async () => ({ orders: [], nextCursor: null, safeUntil: null }),
    // #399: như TikTok, bật theo cả sản phẩm, `updateProduct` thay nội dung cả sản phẩm.
    togglesByProduct: true,
    categoryAttributes: async () => [],
    uploadImage,
    createProduct,
    updateProduct,
    getSkus,
    activate,
    getOrder: async () => {
      throw new Error('không có đơn');
    },
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
});

beforeEach(() => {
  createProduct.mockClear();
  updateProduct.mockClear();
  uploadImage.mockClear();
  getSkus.mockClear();
  activate.mockClear();
  afterActivate = 'live';
  onCreate = async (p) => ({ externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}`, live: false });
  onUpdate = async () => ({ live: true });
});

/** Một listing `pushing` của biến thể mới; `cols` ghi đè cột (tên cột SQL). */
async function pushing(cols: Record<string, unknown> = {}, extra: Partial<ListingVariant> = {}) {
  const v = variant(`CMR-${randomUUID().slice(0, 8)}`, extra);
  variants.push(v);
  await seedSpecs(company.companyId, 'lazada', '14275', [v], { brand: 'No Brand' });
  // Listing do app tạo (#399: cột mặc định `platform`); ca cần sản phẩm người bán thì ghi đè.
  const all = { company_id: company.companyId, shop_id: shopId, variant_id: v.id, seller_sku: v.sku, status: 'pushing', push_started_at: new Date(), content_source: 'app', ...cols };
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
            listed_price, platform_stock, reject_reason, content_source from channel.listings where id = $1`,
    [id],
  );
  return rows[0];
}

async function attemptedAt(id: string) {
  const { rows } = await testPool().query('select create_attempted_at from channel.listings where id = $1', [id]);
  return rows[0].create_attempted_at as Date | null;
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

  it('#292 AC-8: gửi tổ chức chịu trách nhiệm hiệu lực của hồ sơ công ty lúc đẩy (adapter điền khi map để trống)', async () => {
    const profile = (await auth(app().get('/api/v1/platform/company'))).body;
    const set = await auth(app().put('/api/v1/platform/company')).send({ responsibleName: 'Cty Nhập A', address: '1 Lê Lợi', version: profile.version });
    expect(set.status).toBe(200);
    const { id } = await pushing();
    await runListingPush(port, job(id));
    expect(createProduct.mock.calls[0]![1]).toMatchObject({ attributes: { brand: 'No Brand' }, responsible: { name: 'Cty Nhập A', address: '1 Lê Lợi' } });
  });

  it('#346 AC-7: sàn đã có sẵn SKU cùng SellerSku (lần trước tạo dù báo lỗi) → ghi nội dung, giá của app lên SKU đó, tồn để đồng bộ đẩy', async () => {
    // #399: lần gọi tạo trước báo lỗi mà sàn vẫn tạo sản phẩm (giờ tạo sát mốc lần gọi đó) → của app, ghi như cũ.
    const { id } = await pushing({ create_attempted_at: new Date(Date.now() - 60_000) });
    onCreate = async (p) => ({ externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}`, live: false, existing: true, createdAt: new Date() });
    await runListingPush(port, job(id));
    expect(updateProduct).toHaveBeenCalledTimes(1);
    const [, productId, skuId, sent] = updateProduct.mock.calls[0]!;
    expect(productId).toMatch(/^item-/);
    expect(skuId).toMatch(/^sku-/);
    expect(sent).toMatchObject({ price: '150000' });
    expect(await listing(id)).toMatchObject({ status: 'live', external_sku_id: skuId, stock_sync: 'pending', price_sync: 'synced', listed_price: '150000.00', content_source: 'app' });
  });

  it('#399 AC-3: SKU có sẵn do người bán tạo trước lượt đẩy → `push_failed` `sku_exists_on_platform`, không ghi gì lên sàn', async () => {
    const { id, v } = await pushing();
    const startedAt = (await testPool().query('select push_started_at from channel.listings where id = $1', [id])).rows[0].push_started_at as Date;
    onCreate = async () => ({
      externalProductId: 'P-NB',
      externalSkuId: `S-NB-${v.sku}`,
      live: true,
      existing: true,
      createdAt: new Date(startedAt.getTime() - 5 * 60_000 - 1000),
      title: 'Áo thun cotton form rộng',
    });
    await runListingPush(port, job(id));
    expect(updateProduct).not.toHaveBeenCalled();
    const row = await listing(id);
    expect(row).toMatchObject({ status: 'push_failed', external_sku_id: null, push_error: { code: 'sku_exists_on_platform' } });
    expect(row.push_error.message).toBe(`SKU ${v.sku} đã có trên Sàn giả (Áo thun cotton form rộng). Dùng Ghép SKU thay vì đẩy.`);
  });

  it('#346 (sửa sau review): đẩy lại listing `push_failed` sau hơn 5 phút, sản phẩm sàn tạo sát lần gọi tạo trước (lần trước E500 mà vẫn tạo) → nhận lại, `content_source = app`', async () => {
    // Lần gọi tạo trước cách đây 10 phút; sàn tạo sản phẩm lúc đó (lệch 1 phút).
    const { id } = await pushing({ created_at: new Date(Date.now() - 20 * 60_000), create_attempted_at: new Date(Date.now() - 10 * 60_000) });
    onCreate = async (p) => ({
      externalProductId: `item-${p.sellerSku}`,
      externalSkuId: `sku-${p.sellerSku}`,
      live: false,
      existing: true,
      createdAt: new Date(Date.now() - 10 * 60_000),
    });
    await runListingPush(port, job(id));
    expect(updateProduct).toHaveBeenCalledTimes(1);
    expect(await listing(id)).toMatchObject({ status: 'live', content_source: 'app', push_error: null });
  });

  it('#346 (sửa sau review): sản phẩm sàn tạo lệch hơn 5 phút so với lần gọi tạo trước vẫn là của người bán → `sku_exists_on_platform`', async () => {
    const { id } = await pushing({ created_at: new Date(Date.now() - 20 * 60_000), create_attempted_at: new Date(Date.now() - 10 * 60_000) });
    onCreate = async () => ({
      externalProductId: 'P-NB3',
      externalSkuId: `S-NB3-${randomUUID()}`,
      live: true,
      existing: true,
      createdAt: new Date(Date.now() - 30 * 60_000),
    });
    await runListingPush(port, job(id));
    expect(updateProduct).not.toHaveBeenCalled();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', push_error: { code: 'sku_exists_on_platform' } });
  });

  it('#399 sau rà bảo mật: listing tạo 3 ngày trước, chưa từng gọi tạo; người bán tự tạo sản phẩm cùng SellerSku 1 ngày trước → `sku_exists_on_platform`, không ghi gì lên sàn', async () => {
    const { id } = await pushing({ created_at: new Date(Date.now() - 3 * 24 * 3600_000) });
    onCreate = async () => ({
      externalProductId: 'P-NB4',
      externalSkuId: `S-NB4-${randomUUID()}`,
      live: true,
      existing: true,
      createdAt: new Date(Date.now() - 24 * 3600_000),
    });
    await runListingPush(port, job(id));
    expect(updateProduct).not.toHaveBeenCalled();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', external_sku_id: null, push_error: { code: 'sku_exists_on_platform' } });
  });

  it('#399 sau rà bảo mật (vòng 2): lần gọi tạo trước bị sàn từ chối 9 ngày trước, người bán tự tạo sản phẩm 5 ngày trước → `sku_exists_on_platform`, không ghi lên sàn', async () => {
    const { id } = await pushing({ create_attempted_at: new Date(Date.now() - 9 * 24 * 3600_000) });
    onCreate = async () => ({
      externalProductId: 'P-NB5',
      externalSkuId: `S-NB5-${randomUUID()}`,
      live: true,
      existing: true,
      createdAt: new Date(Date.now() - 5 * 24 * 3600_000),
    });
    await runListingPush(port, job(id));
    expect(updateProduct).not.toHaveBeenCalled();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', push_error: { code: 'sku_exists_on_platform' } });
  });

  it('#399 sau rà bảo mật, ca E500 #346: lần 1 gọi tạo, sàn tạo mà báo lỗi; lần 2 (sau hơn 5 phút) thấy existing sát lần gọi trước → nhận lại, content_source = app', async () => {
    const { id } = await pushing({ created_at: new Date(Date.now() - 3 * 24 * 3600_000) });
    let created: CreatedProduct | undefined;
    onCreate = async (p) => {
      if (created) return { ...created, existing: true };
      created = { externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}`, live: false, createdAt: new Date() };
      throw new MarketplaceError('unavailable', 'E500', 'Create product failed');
    };
    await expect(runListingPush(port, job(id))).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await attemptedAt(id)).not.toBeNull();
    // Hơn 5 phút sau: lùi cả mốc lần gọi lẫn giờ tạo trên sàn.
    await testPool().query("update channel.listings set create_attempted_at = create_attempted_at - interval '10 minutes' where id = $1", [id]);
    created = { ...created!, createdAt: new Date(created!.createdAt!.getTime() - 10 * 60_000) };
    await runListingPush(port, job(id));
    expect(updateProduct).toHaveBeenCalledTimes(1);
    expect(await listing(id)).toMatchObject({ status: 'live', content_source: 'app', push_error: null });
  });

  it('#399 sau rà bảo mật: mỗi lần gọi tạo đều cập nhật create_attempted_at', async () => {
    const { id } = await pushing();
    onCreate = async () => {
      throw new MarketplaceError('unavailable', '901', 'Hệ thống bận');
    };
    await expect(runListingPush(port, job(id))).rejects.toMatchObject({ kind: 'unavailable' });
    const first = await attemptedAt(id);
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    await expect(runListingPush(port, job(id))).rejects.toMatchObject({ kind: 'unavailable' });
    expect(createProduct).toHaveBeenCalledTimes(2);
    expect((await attemptedAt(id))!.getTime()).toBeGreaterThan(first!.getTime());
  });

  it('#399 (review #407): người bán tạo sản phẩm 2 phút trước lần đẩy, bị báo `sku_exists_on_platform`; bấm đẩy lại vẫn không ghi đè', async () => {
    const { id } = await pushing();
    const sellerCreatedAt = new Date(Date.now() - 2 * 60_000);
    onCreate = async () => ({ externalProductId: 'P-NB6', externalSkuId: `S-NB6-${randomUUID()}`, live: true, existing: true, createdAt: sellerCreatedAt });
    await runListingPush(port, job(id));
    expect(await listing(id)).toMatchObject({ status: 'push_failed', push_error: { code: 'sku_exists_on_platform' } });
    // Lần gọi không tạo gì trên sàn: mốc trả về như trước lần gọi (chưa từng gọi tạo).
    expect(await attemptedAt(id)).toBeNull();
    // Người dùng bấm đẩy lại.
    await testPool().query("update channel.listings set status = 'pushing', push_started_at = now(), push_error = null where id = $1", [id]);
    await runListingPush(port, job(id));
    expect(updateProduct).not.toHaveBeenCalled();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', push_error: { code: 'sku_exists_on_platform' } });
  });

  it('#399 AC-3: sàn không trả giờ tạo của SKU có sẵn → coi là của người bán, `sku_exists_on_platform`', async () => {
    const { id } = await pushing();
    onCreate = async () => ({ externalProductId: 'P-NB2', externalSkuId: `S-NB2-${randomUUID()}`, live: true, existing: true, title: 'SP' });
    await runListingPush(port, job(id));
    expect(updateProduct).not.toHaveBeenCalled();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', push_error: { code: 'sku_exists_on_platform' } });
  });

  it('#346 AC-8: SKU có sẵn đang thuộc listing chưa gỡ khác → `push_failed` `marketplace_rejected`, không ghi đè', async () => {
    const other = await pushing({ status: 'live', external_product_id: 'P-CHU', external_sku_id: 'S-CHU' });
    const { id } = await pushing();
    onCreate = async () => ({ externalProductId: 'P-CHU', externalSkuId: 'S-CHU', live: true, existing: true });
    await runListingPush(port, job(id));
    expect(updateProduct).not.toHaveBeenCalled();
    const row = await listing(id);
    expect(row).toMatchObject({ status: 'push_failed', external_sku_id: null });
    expect(row.push_error).toMatchObject({ code: 'marketplace_rejected' });
    expect(row.push_error.message).toMatch(/đang ghép với biến thể khác/);
    expect(await listing(other.id)).toMatchObject({ status: 'live', external_sku_id: 'S-CHU' });
  });

  it('#346: SKU có sẵn đang chờ CEO duyệt ghép vào listing lỗi khác → `push_failed`, không ghi đè', async () => {
    const ceo = (await testPool().query<{ id: string }>('select id from core.accounts where email = $1', [company.ceo.email])).rows[0]!.id;
    const waiting = await pushing({ status: 'push_failed' });
    await testPool().query(
      `update channel.listings set pending_variant_id = variant_id, pending_mode = 'mapped', pending_requested_by = $2, pending_requested_at = now(),
              pending_external_sku_id = 'S-CHO', pending_external_product_id = 'P-CHO', pending_seller_sku = 'SS-CHO' where id = $1`,
      [waiting.id, ceo],
    );
    const { id } = await pushing();
    onCreate = async () => ({ externalProductId: 'P-CHO', externalSkuId: 'S-CHO', live: true, existing: true });
    await runListingPush(port, job(id));
    expect(updateProduct).not.toHaveBeenCalled();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', external_sku_id: null });
  });

  it('AC-17, AC-20, C2-02…04: listing đã có mã sàn (đẩy lại) gọi updateProduct, không tạo; dùng ảnh đã có, tồn để đồng bộ đẩy', async () => {
    const { id } = await pushing({ external_product_id: 'P1', external_sku_id: 'S1', external_image_urls: ['https://slatic.test/cu.png'] });
    await runListingPush(port, job(id, []));
    expect(createProduct).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
    expect(updateProduct.mock.calls[0]!.slice(1, 3)).toEqual(['P1', 'S1']);
    expect(updateProduct.mock.calls[0]![3].imageUrls).toEqual(['https://slatic.test/cu.png']);
    // #399 AC-2: listing app tạo vẫn ghi nội dung như trước.
    expect(await listing(id)).toMatchObject({ status: 'live', external_product_id: 'P1', stock_sync: 'pending', price_sync: 'synced', content_source: 'app' });
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

  it('#305 AC-6: bước kiểm trước khi tạo chặn thì push_failed giữ mã kiểm (shop_not_eligible, listing_check_failed), câu của sàn', async () => {
    for (const code of ['shop_not_eligible', 'listing_check_failed']) {
      onCreate = async () => {
        throw new MarketplaceError('rejected', code, '12052051: The product name must be between 25 and 255 characters, inclusive.');
      };
      const { id } = await pushing();
      await expect(runListingPush(port, job(id))).resolves.toBeUndefined();
      expect(await listing(id)).toMatchObject({
        status: 'push_failed',
        push_attempts: 1,
        push_error: { code, message: '12052051: The product name must be between 25 and 255 characters, inclusive.' },
      });
    }
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

  describe('SKU chưa tin được (#223, Documents/21 §18.6.6)', () => {
    /** Biến thể `v` có listing ở một gian hàng TikTok đang mất uỷ quyền (đơn chưa cập nhật). */
    async function staleElsewhere(v: ListingVariant) {
      const res = await auth(app().post('/api/v1/channel/shops/tiktok/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
      const other = res.body.shop.id as string;
      await testPool().query(
        "update channel.shops set status = 'needs_reauth', order_cutoff_at = now() - interval '1 day', open_orders_pulled_at = now() where id = $1",
        [other],
      );
      await testPool().query(
        `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status)
         values ($1, $2, $3, 'tt-p', $4, $5, 'live')`,
        [company.companyId, other, v.id, `tt-${v.sku}`, v.sku],
      );
    }

    it('tạo mới trên sàn gửi tồn 0, listing chờ đẩy tồn', async () => {
      const { id, v } = await pushing();
      await staleElsewhere(v);
      await runListingPush(port, job(id));
      expect(createProduct.mock.calls[0]![1].quantity).toBe(0);
      expect(await listing(id)).toMatchObject({ platform_stock: 0, stock_sync: 'pending' });
    });

    it('đẩy lại sản phẩm đã có trên sàn cũng gửi tồn 0', async () => {
      const { id, v } = await pushing({ external_product_id: 'P9', external_sku_id: 'S9', external_image_urls: ['https://slatic.test/cu.png'] });
      await staleElsewhere(v);
      await runListingPush(port, job(id, []));
      expect(updateProduct.mock.calls[0]![3].quantity).toBe(0);
      expect(await listing(id)).toMatchObject({ stock_sync: 'pending' });
    });
  });

  describe('#399 Ca 1: đẩy lại listing nội dung của người bán (ghép → gỡ → đẩy lại)', () => {
    /** Listing `pushing` chép mã sàn từ bản gỡ của listing ghép; `state` là trạng thái SKU trên sàn giả, null là sàn không còn. */
    async function reshelved(state: RemoteSku['state'] | null) {
      const tag = randomUUID().slice(0, 8);
      const sellerSku = `NB-${tag}`;
      if (state) remote.set(sellerSku, { productId: `P-${tag}`, skuId: `S-${tag}`, state });
      return pushing({ content_source: 'platform', seller_sku: sellerSku, external_product_id: `P-${tag}`, external_sku_id: `S-${tag}` });
    }
    const stockPushJobs = async (shop: string) =>
      Number((await testPool().query("select count(*) from pgboss.job where name = 'channel.stock_push' and data->>'shopId' = $1", [shop])).rows[0].count);

    it('AC-1 Lazada: sàn đang tắt → chỉ bật lại SKU; không updateProduct, không đưa ảnh; giá, tồn chờ đồng bộ đẩy', async () => {
      const { id } = await reshelved('inactive');
      await runListingPush(port, job(id));
      expect(activate).toHaveBeenCalledTimes(1);
      expect(updateProduct).not.toHaveBeenCalled();
      expect(createProduct).not.toHaveBeenCalled();
      expect(uploadImage).not.toHaveBeenCalled();
      expect(await listing(id)).toMatchObject({
        status: 'live',
        content_source: 'platform',
        stock_sync: 'pending',
        price_sync: 'pending',
        listed_price: null,
        external_image_urls: null,
        push_error: null,
      });
      expect((await history(id)).at(-1)).toMatchObject({ action: 'go_live', actor_id: null });
      expect(await stockPushJobs(shopId)).toBeGreaterThan(0);
    });

    it('sàn vẫn đang bán thì không gọi bật; sàn đưa vào duyệt sau khi bật thì `under_review`', async () => {
      const live = await reshelved('live');
      await runListingPush(port, job(live.id));
      expect(activate).not.toHaveBeenCalled();
      expect(await listing(live.id)).toMatchObject({ status: 'live' });
      afterActivate = 'review';
      const review = await reshelved('inactive');
      await runListingPush(port, job(review.id));
      expect(activate).toHaveBeenCalledTimes(1);
      expect(await listing(review.id)).toMatchObject({ status: 'under_review', content_source: 'platform' });
    });

    it('sàn không còn SKU → `push_failed` như đẩy lại (sku_not_found), không gọi ghi', async () => {
      const { id } = await reshelved(null);
      await runListingPush(port, job(id));
      expect(activate).not.toHaveBeenCalled();
      expect(updateProduct).not.toHaveBeenCalled();
      const row = await listing(id);
      expect(row).toMatchObject({ status: 'push_failed', push_error: { code: 'marketplace_rejected' } });
      expect(row.push_error.message).toMatch(/không còn SKU/);
    });

    it('bật xong mà sàn vẫn tắt → `push_failed` kèm câu', async () => {
      afterActivate = 'inactive';
      const { id } = await reshelved('inactive');
      await runListingPush(port, job(id));
      const row = await listing(id);
      expect(row).toMatchObject({ status: 'push_failed', push_error: { code: 'marketplace_rejected' } });
      expect(row.push_error.message).toMatch(/chưa bật lại/);
    });

    it('AC-1 sàn bật theo cả sản phẩm (kiểu TikTok): chỉ `activate` theo sản phẩm, không updateProduct', async () => {
      const res = await auth(app().post('/api/v1/channel/shops/tiktok/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
      const tiktokShop = res.body.shop.id as string;
      const tag = randomUUID().slice(0, 8);
      remote.set(`NB-${tag}`, { productId: `TP-${tag}`, skuId: `TS-${tag}`, state: 'inactive' });
      const { id, v } = await pushing({ shop_id: tiktokShop, content_source: 'platform', seller_sku: `NB-${tag}`, external_product_id: `TP-${tag}`, external_sku_id: `TS-${tag}` });
      await seedSpecs(company.companyId, 'tiktok', '600042', [v]);
      await runListingPush(port, { companyId: company.companyId, shopId: tiktokShop, listingId: id, imageUrls: ['https://img.test/a.png'] });
      expect(activate.mock.calls[0]![1]).toBe(`TP-${tag}`);
      expect(updateProduct).not.toHaveBeenCalled();
      expect(uploadImage).not.toHaveBeenCalled();
      expect(await listing(id)).toMatchObject({ status: 'live', content_source: 'platform', stock_sync: 'pending', price_sync: 'pending' });
    });
  });
});
