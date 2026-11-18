// Cờ "Tên trên sàn đã đổi" (#396; Documents/21 §18.3): mốc tên lúc ghép trên listing, so với bản sao SKU sàn ở mỗi lần ghi
// bản sao; app đẩy, sửa nội dung thì đặt lại mốc; CEO xác nhận bằng `acknowledge-title`. Sàn giả theo Lazada (`name`,
// `name_en`). Mỗi ca dùng SKU sàn và biến thể riêng.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { ChannelListing, ListingList, RemoteSkuList } from '#src/modules/channel/channel/api/schemas.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import type { ContentUpdate, CreatedProduct, NewProduct, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { inBackground, registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { runRemoteSkusRefresh, saveFullSnapshot } from '#src/modules/channel/channel/service/remote-skus.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const categoryId = randomUUID();
const variants: ListingVariant[] = [];
const newVariant = (): ListingVariant => {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Cốc sứ',
    sku: `CMR-${randomUUID().slice(0, 8)}`,
    categoryId,
    attributesLabel: 'Trắng',
    archived: false,
    businessStatus: 'selling',
    description: 'Cốc sứ trắng',
    weightG: 200,
    lengthMm: 100,
    widthMm: 100,
    heightMm: 100,
  };
  variants.push(v);
  return v;
};
const port = {
  variants: async (ids?: readonly string[]) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 5])),
};
setProductPort(port);

/** SKU trên sàn giả; sửa phần tử để giả người bán đổi tên trên sàn. */
const remote: RemoteSku[] = [];
const newRemote = (extra: Partial<RemoteSku> = {}) => {
  const id = randomUUID().slice(0, 8);
  const r: RemoteSku = {
    externalProductId: `item-${id}`,
    externalSkuId: `sku-${id}`,
    sellerSku: `LZ-${id}`,
    title: `Cốc ${id}`,
    titleEn: `Cup ${id}`,
    state: 'live',
    rejectReason: null,
    quantity: 3,
    ...extra,
  };
  remote.push(r);
  return r;
};
/** Sàn giả ghi tên app gửi lên SKU của sản phẩm (như Lazada `/product/update`: `name` đổi, `name_en` giữ). */
const writeName = (externalProductId: string, name: string) => {
  for (const r of remote) if (r.externalProductId === externalProductId) r.title = name;
};
let onCreate: (p: NewProduct) => Promise<CreatedProduct>;
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    categoryAttributes: async () => [],
    listSkus: async () => remote.map((r) => ({ ...r })),
    getSkus: async (_t, skus) => remote.filter((r) => skus.includes(r.sellerSku)),
    uploadImage: async (_t, url) => `https://slatic.test/${encodeURIComponent(url)}`,
    createProduct: async (_t, p) => onCreate(p),
    updateProduct: async (_t, productId, _sku, p) => {
      writeName(productId, p.name);
      return { live: true };
    },
    updateContent: async (_t, productId, c: ContentUpdate) => {
      writeName(productId, c.name);
      return { underReview: false };
    },
    updatePriceQuantity: async (_t, items) => items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true })),
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let other: Awaited<ReturnType<typeof createCompany>>;
let sale: Awaited<ReturnType<typeof addMember>>;
let warehouse: Awaited<ReturnType<typeof addMember>>;
let shopId: string;
const as = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);

/** Đọc trọn bản sao như nút Tải lại (bỏ khoảng chờ 60 giây), chạy việc nền ngay. */
const reload = async () => {
  await testPool().query('update channel.shops set remote_skus_synced_at = null where id = $1', [shopId]);
  expect((await as(app().post(`/api/v1/channel/shops/${shopId}/remote-skus/refresh`))).status).toBe(202);
  await inBackground(() => runRemoteSkusRefresh({ companyId: company.companyId, shopId }, { attempt: 2, lastAttempt: true }));
};
const match = (externalSkuId: string, variantId: string | null) =>
  as(app().post(`/api/v1/channel/shops/${shopId}/listings/match`)).send({ externalSkuId, variantId });
const acknowledge = (listingId: string, version: unknown, token = company.ceo.token, shop = shopId) =>
  as(app().post(`/api/v1/channel/shops/${shop}/listings/${listingId}/acknowledge-title`), token).send({ version });
const rowOf = async (id: string) =>
  (
    await testPool().query(
      `select status, version, remote_title_at_match, remote_title_en_at_match, remote_title_matched_at, remote_title_changed_at
         from channel.listings where id = $1`,
      [id],
    )
  ).rows[0];
/** Cờ trên `GET /listings` (dòng của biến thể) và `GET remote-skus` (phần tử của SKU sàn); hai chỗ phải giống nhau. */
const flagOf = async (variantId: string, externalSkuId: string) => {
  const listings = ListingList.parse((await as(app().get(`/api/v1/channel/shops/${shopId}/listings`))).body);
  const skus = RemoteSkuList.parse((await as(app().get(`/api/v1/channel/shops/${shopId}/remote-skus`))).body);
  const onListing = listings.items.find((i) => i.variantId === variantId)!.remoteTitleChanged;
  expect(skus.items.find((i) => i.externalSkuId === externalSkuId)!.remoteTitleChanged).toEqual(onListing);
  return onListing;
};
/** SKU sàn đã ghép (CEO, áp ngay) với biến thể mới. */
async function mapped(extra: Partial<RemoteSku> = {}) {
  const r = newRemote(extra);
  const v = newVariant();
  await reload();
  const res = await match(r.externalSkuId, v.id);
  expect(res.status).toBe(200);
  return { r, v, listing: ChannelListing.parse(res.body) };
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  other = await createCompany({ optionalModules: ['channel'] });
  sale = await addMember(company.companyId, 'sale');
  warehouse = await addMember(company.companyId, 'warehouse');
  const res = await as(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  const map = await as(app().put(`/api/v1/channel/shops/${shopId}/category-maps/${categoryId}`)).send({
    externalCategoryId: '14275',
    attributes: { brand: 'No Brand' },
    version: null,
  });
  expect(map.status).toBe(200);
});

describe('bản sao lưu tên tiếng Anh', () => {
  it('AC-1: `remote-skus` trả `title` = `name`, `titleEn` = `name_en`; sàn không có tên tiếng Anh thì null', async () => {
    const r = newRemote();
    const bare = newRemote({ titleEn: null });
    await reload();
    const items = RemoteSkuList.parse((await as(app().get(`/api/v1/channel/shops/${shopId}/remote-skus`))).body).items;
    expect(items.find((i) => i.externalSkuId === r.externalSkuId)).toMatchObject({ title: r.title, titleEn: r.titleEn });
    expect(items.find((i) => i.externalSkuId === bare.externalSkuId)).toMatchObject({ titleEn: null, remoteTitleChanged: null });
  });
});

describe('cờ "Tên trên sàn đã đổi"', () => {
  it('AC-2: đổi tên trên sàn → lượt đọc kế tiếp bật cờ (from, to), tăng version; đổi lại như cũ thì mất cờ', async () => {
    const { r, v, listing } = await mapped();
    const from = r.title;
    expect(await rowOf(listing.id)).toMatchObject({ remote_title_at_match: from, remote_title_changed_at: null });
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
    const before = (await rowOf(listing.id)).version;

    r.title = 'Cốc người bán đổi tên';
    await reload();
    const flag = await flagOf(v.id, r.externalSkuId);
    expect(flag).toMatchObject({ from, to: 'Cốc người bán đổi tên', fromEn: r.titleEn, toEn: r.titleEn });
    expect(flag!.detectedAt).toEqual(expect.any(String));
    const flagged = await rowOf(listing.id);
    expect(flagged.version).toBe(before + 1);

    // Lượt đọc sau vẫn khác: giữ lúc phát hiện đầu tiên, không tăng version.
    await reload();
    expect((await flagOf(v.id, r.externalSkuId))!.detectedAt).toBe(flag!.detectedAt);
    expect((await rowOf(listing.id)).version).toBe(flagged.version);

    r.title = from;
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
    expect((await rowOf(listing.id)).version).toBe(flagged.version + 1);
  });

  it('AC-2: đổi riêng tên tiếng Anh cũng bật cờ (fromEn, toEn)', async () => {
    const { r, v } = await mapped();
    await reload();
    const fromEn = r.titleEn;
    r.titleEn = 'Mug renamed';
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toMatchObject({ from: r.title, to: r.title, fromEn, toEn: 'Mug renamed' });
  });

  it('A1: mốc chưa có tên tiếng Anh (sau migration) thì lượt đọc kế tiếp lấy `title_en` làm mốc, không bật cờ', async () => {
    const { r, v, listing } = await mapped();
    await testPool().query(
      'update channel.listings set remote_title_en_at_match = null, remote_title_matched_at = null, remote_title_changed_at = null where id = $1',
      [listing.id],
    );
    await testPool().query('update channel.remote_skus set title_en = null where shop_id = $1 and external_sku_id = $2', [shopId, r.externalSkuId]);
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
    expect(await rowOf(listing.id)).toMatchObject({ remote_title_en_at_match: r.titleEn, remote_title_matched_at: expect.any(Date) });
  });

  it('AC-4: SKU thiếu nhãn biến thể (`labelMissing`, TikTok) giữ tiêu đề đã lưu, không bật cờ', async () => {
    const { r, v } = await mapped({ title: 'Áo - Đen', titleEn: null });
    await reload();
    Object.assign(r, { title: `Áo - ${r.sellerSku}`, labelMissing: true });
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
  });

  it('A2: listing đang đẩy không bị đánh giá (không tăng version giữa lúc việc đẩy chạy)', async () => {
    const { r, listing } = await mapped();
    await reload();
    await testPool().query("update channel.listings set status = 'pushing', push_started_at = now() where id = $1", [listing.id]);
    const before = (await rowOf(listing.id)).version;
    r.title = 'Tên khác khi đang đẩy';
    await reload();
    expect(await rowOf(listing.id)).toMatchObject({ version: before, remote_title_changed_at: null });
  });

  it('AC-S2: CSDL chặn cờ khi chưa có mốc', async () => {
    const { listing } = await mapped();
    await expect(
      testPool().query('update channel.listings set remote_title_changed_at = now(), remote_title_matched_at = null where id = $1', [listing.id]),
    ).rejects.toMatchObject({ constraint: 'listings_remote_title' });
    await expect(
      testPool().query('update channel.listings set remote_title_at_match = null, remote_title_en_at_match = $2 where id = $1', [listing.id, 'x']),
    ).rejects.toMatchObject({ constraint: 'listings_remote_title' });
  });
});

/** Listing đã ghép có cờ bật. */
async function flagged() {
  const m = await mapped();
  await reload();
  m.r.title = `Tên mới ${randomUUID().slice(0, 4)}`;
  await reload();
  return { ...m, version: (await rowOf(m.listing.id)).version as number };
}

describe('acknowledge-title, đổi ghép', () => {
  it('AC-3: Sale, Kho 403 trước khi kiểm body', async () => {
    const { listing } = await flagged();
    for (const token of [sale.token, warehouse.token]) {
      const res = await acknowledge(listing.id, 'x', token);
      expect(res.status).toBe(403);
    }
  });

  it('AC-3: version cũ 409 `version_conflict` kèm `current`; body sai 422', async () => {
    const { listing, version } = await flagged();
    const res = await acknowledge(listing.id, version - 1);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/version_conflict$/);
    expect(res.body.current).toMatchObject({ id: listing.id, version });
    expect((await acknowledge(listing.id, 'x')).status).toBe(422);
  });

  it('review diff: listing đang đẩy → 409 `invalid_transition`, không tăng version (việc đẩy không bỏ kết quả)', async () => {
    const { listing, version } = await flagged();
    await testPool().query("update channel.listings set status = 'pushing', push_started_at = now() where id = $1", [listing.id]);
    const res = await acknowledge(listing.id, version);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/invalid_transition$/);
    expect(res.body.current).toMatchObject({ id: listing.id, status: 'pushing' });
    expect((await rowOf(listing.id)).version).toBe(version);
  });

  it('AC-3: listing công ty khác, gian hàng công ty khác 404', async () => {
    const { listing, version } = await flagged();
    expect((await acknowledge(listing.id, version, other.ceo.token)).status).toBe(404);
    expect((await acknowledge(randomUUID(), version)).status).toBe(404);
  });

  it('AC-3: CEO xác nhận → 200, mốc = tên hiện tại, xoá cờ, tăng version, ghi nhật ký; xác nhận lại 409 `invalid_transition`', async () => {
    const { r, v, listing, version } = await flagged();
    const res = await acknowledge(listing.id, version);
    expect(res.status).toBe(200);
    expect(ChannelListing.parse(res.body).version).toBe(version + 1);
    expect(await rowOf(listing.id)).toMatchObject({ remote_title_at_match: r.title, remote_title_changed_at: null, version: version + 1 });
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
    const audit = await testPool().query(
      "select action, before, after from core.audit_logs where entity_type = 'channel.listings' and entity_id = $1 order by id desc limit 1",
      [listing.id],
    );
    expect(audit.rows[0]).toMatchObject({ action: 'update', after: { remoteTitleAtMatch: r.title } });
    // Lượt đọc sau thấy cùng tên: không bật lại.
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
    const again = await acknowledge(listing.id, version + 1);
    expect(again.status).toBe(409);
    expect(again.body.type).toMatch(/invalid_transition$/);
  });

  it('AC-3: đổi ghép sang biến thể khác xoá cờ, mốc = tên hiện tại', async () => {
    const { r, listing } = await flagged();
    const v2 = newVariant();
    const res = await match(r.externalSkuId, v2.id);
    expect(res.status).toBe(200);
    expect(await rowOf(listing.id)).toMatchObject({ remote_title_at_match: r.title, remote_title_changed_at: null });
    expect(await flagOf(v2.id, r.externalSkuId)).toBeNull();
  });
});

describe('app đẩy, sửa nội dung thì không bật cờ (AC-5)', () => {
  /** Listing `pushing` của biến thể mới; `cols` ghi đè cột (tên cột SQL). */
  async function pushing(cols: Record<string, unknown> = {}) {
    const v = newVariant();
    const all = { company_id: company.companyId, shop_id: shopId, variant_id: v.id, seller_sku: v.sku, status: 'pushing', push_started_at: new Date(), ...cols };
    const keys = Object.keys(all);
    const { rows } = await testPool().query<{ id: string }>(
      `insert into channel.listings (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(all),
    );
    return { v, id: rows[0]!.id };
  }
  const push = (listingId: string) =>
    runListingPush(port, { companyId: company.companyId, shopId, listingId, imageUrls: ['https://img.test/a.png'] });
  const sentName = (v: ListingVariant) => `${v.productName} - ${v.attributesLabel}`;

  it('tạo mới: mốc = tên app gửi, đọc bản sao kế tiếp không bật cờ', async () => {
    const created: RemoteSku[] = [];
    onCreate = async (p) => {
      created.push(newRemote({ sellerSku: p.sellerSku, title: p.name, titleEn: null }));
      return { externalProductId: created[0]!.externalProductId, externalSkuId: created[0]!.externalSkuId, live: true };
    };
    const { v, id } = await pushing();
    await push(id);
    expect(await rowOf(id)).toMatchObject({ status: 'live', remote_title_at_match: sentName(v), remote_title_en_at_match: null });
    await reload();
    expect(await flagOf(v.id, created[0]!.externalSkuId)).toBeNull();
  });

  it('đẩy lại sản phẩm đã ghép (tên sàn cũ khác tên app): không bật cờ, `name_en` của sàn giữ làm mốc', async () => {
    const r = newRemote({ title: 'Tên gốc của shop', titleEn: 'Original name' });
    await reload();
    // Listing do app đẩy (#399): đẩy lại ghi nội dung của app lên sàn.
    const { v, id } = await pushing({
      content_source: 'app',
      external_product_id: r.externalProductId,
      external_sku_id: r.externalSkuId,
      seller_sku: r.sellerSku,
      external_image_urls: ['https://slatic.test/a.png'],
      remote_title_at_match: r.title,
      remote_title_en_at_match: r.titleEn,
      remote_title_matched_at: new Date(Date.now() - 60_000),
    });
    const stale = new Date();
    await push(id);
    expect(await rowOf(id)).toMatchObject({ remote_title_at_match: sentName(v), remote_title_en_at_match: 'Original name' });
    // Lượt đọc bắt đầu trước khi đẩy xong còn tên cũ: không so (A1).
    await withCompany(company.companyId, () => saveFullSnapshot(shopId, [{ ...r, title: 'Tên gốc của shop' }], new Date(stale.getTime() - 1000)));
    expect((await rowOf(id)).remote_title_changed_at).toBeNull();
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
  });

  it('đẩy lại listing nội dung của người bán (#399): chỉ bật lại SKU, giữ mốc tên lúc ghép', async () => {
    const r = newRemote({ title: 'Tên gốc của shop', titleEn: 'Original name' });
    await reload();
    const { v, id } = await pushing({
      content_source: 'platform',
      external_product_id: r.externalProductId,
      external_sku_id: r.externalSkuId,
      seller_sku: r.sellerSku,
      external_image_urls: ['https://slatic.test/a.png'],
      remote_title_at_match: r.title,
      remote_title_en_at_match: r.titleEn,
      remote_title_matched_at: new Date(Date.now() - 60_000),
    });
    await push(id);
    expect(await rowOf(id)).toMatchObject({ remote_title_at_match: 'Tên gốc của shop', remote_title_en_at_match: 'Original name' });
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
  });

  it('nhánh `existing` (#346): sàn đã có SellerSku, app ghi đè tên → không bật cờ', async () => {
    const r = newRemote({ title: 'Tên SKU có sẵn', titleEn: null });
    await reload();
    // Sản phẩm của app sinh ra ở lần gọi tạo trước (#399 Ca 2): giờ tạo khớp lần gọi đó thì mới ghi đè.
    const previousCall = new Date(Date.now() - 60_000);
    onCreate = async () => ({ externalProductId: r.externalProductId, externalSkuId: r.externalSkuId, live: true, existing: true, createdAt: previousCall });
    const { v, id } = await pushing({ seller_sku: r.sellerSku, create_attempted_at: previousCall });
    await push(id);
    expect(await rowOf(id)).toMatchObject({ remote_title_at_match: sentName(v) });
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
  });

  it('sửa nội dung (#293): mốc = tên app gửi, không bật cờ; cờ đang bật cũng được xoá', async () => {
    const { r, v, listing } = await flagged();
    // Sửa nội dung chỉ cho listing nội dung của app (#399).
    await testPool().query(`update channel.listings set content_source = 'app' where id = $1`, [listing.id]);
    const res = await as(app().post(`/api/v1/channel/shops/${shopId}/listings/${listing.id}/update-content`)).send({
      version: (await rowOf(listing.id)).version,
    });
    expect(res.status).toBe(200);
    expect(await rowOf(listing.id)).toMatchObject({ remote_title_at_match: sentName(v), remote_title_changed_at: null });
    await reload();
    expect(await flagOf(v.id, r.externalSkuId)).toBeNull();
  });
});
