// Ghép SKU tay, CEO duyệt khi ghép sang "không quản tồn" hoặc đổi ghép đã có đơn (#220; Documents/21 §18.3, §18.6.5;
// 27 US-GH-04; 25 §11). Mỗi ca dùng SKU sàn và biến thể riêng, không phụ thuộc thứ tự.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelListing, RemoteSkuList } from '#src/modules/channel/channel/api/schemas.ts';
import { MarketplaceError, type RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { unmatchedRemoteCounts } from '#src/modules/channel/channel/repository/remote-skus.ts';
import { runListingSync } from '#src/modules/channel/channel/service/background.ts';
import { runRemoteSkusRefresh } from '#src/modules/channel/channel/service/remote-skus.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { inBackground, registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { type ListingVariant, type ProductPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const variants: ListingVariant[] = [];
const newVariant = (extra: Partial<ListingVariant> = {}) => {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Cốc sứ',
    sku: `CMR-${randomUUID().slice(0, 8)}`,
    categoryId: randomUUID(),
    attributesLabel: 'Trắng',
    archived: false,
    businessStatus: 'selling',
    description: null,
    weightG: 200,
    lengthMm: 100,
    widthMm: 100,
    heightMm: 100,
    ...extra,
  };
  variants.push(v);
  return v;
};
const port: ProductPort = {
  variants: async (ids) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 5])),
};
setProductPort(port);

const remote: RemoteSku[] = [];
let listSkusCalls = 0;
const changedSince: Date[] = [];
let changedResult: RemoteSku[] = [];
let changedFails = false;
/** Sàn trả danh sách rỗng ở lần đọc trọn (review vòng 2 N1). */
let listSkusEmpty = false;
/** Lần đọc trọn lỗi (sàn trả thiếu; review vòng 3 R1). */
let listSkusFails = false;
/** SKU mới trên sàn chưa vào bản sao: `match` tải lại bản sao trước (bản sao chỉ làm mới khi đồng bộ, Tải lại). */
let dirty = false;
/** SKU mới trên sàn, SKU người bán khác SKU Commerio (lý do phải ghép tay). */
const newRemote = (extra: Partial<RemoteSku> = {}) => {
  const id = randomUUID().slice(0, 8);
  const r: RemoteSku = {
    externalProductId: `item-${id}`,
    externalSkuId: `sku-${id}`,
    sellerSku: `LZ-${id}`,
    title: `Cốc ${id}`,
    state: 'live',
    rejectReason: null,
    quantity: 3,
    ...extra,
  };
  remote.push(r);
  dirty = true;
  return r;
};
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    listSkus: async () => {
      listSkusCalls++;
      if (listSkusFails) throw new MarketplaceError('rejected', 'incomplete_list', 'Sàn trả thiếu');
      return listSkusEmpty ? [] : remote;
    },
    getSkus: async (_t, skus) => remote.filter((r) => skus.includes(r.sellerSku)),
    listSkusChanged: async (_t, since) => {
      if (changedFails) throw new MarketplaceError('unavailable', 'daily_call_limit', 'Hết hạn mức');
      changedSince.push(since);
      return changedResult;
    },
    deactivate: async () => {},
    updatePriceQuantity: async (_t, items) => items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true })),
  }),
);
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let admin: Awaited<ReturnType<typeof addMember>>;
let sale: Awaited<ReturnType<typeof addMember>>;
let shopId: string;
const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
/** Chạy lượt Tải lại đang chờ như worker (#361), lần thử cuối. */
const runJob = (id = shopId) => inBackground(() => runRemoteSkusRefresh({ companyId: company.companyId, shopId: id }, { attempt: 2, lastAttempt: true }));
/** Đọc trọn lại bản sao SKU sàn của gian hàng (bỏ khoảng chờ giữa hai lần Tải lại): Tải lại xếp việc (202), chạy việc. */
const reload = async (id = shopId) => {
  await testPool().query('update channel.shops set remote_skus_synced_at = null where id = $1', [id]);
  const res = await as(app().post(`/api/v1/channel/shops/${id}/remote-skus/refresh`), company.ceo.token);
  expect(res.status).toBe(202);
  await runJob(id);
  return res;
};
const match = async (token: string, body: { externalSkuId: string; variantId: string | null }) => {
  if (dirty) {
    dirty = false;
    await reload();
  }
  return as(app().post(`/api/v1/channel/shops/${shopId}/listings/match`), token).send(body);
};
const decide = (token: string, listingId: string, action: string, body: object) =>
  as(app().post(`/api/v1/channel/shops/${shopId}/listings/${listingId}/mapping/${action}`), token).send(body);

const rowOf = async (externalSkuId: string) =>
  (
    await testPool().query(
      `select id, mode, variant_id, seller_sku, status, approved_by, mapping_self_approved, pending_variant_id, pending_mode,
              pending_requested_by, version
         from channel.listings where shop_id = $1 and external_sku_id = $2 and status <> 'delisted'`,
      [shopId, externalSkuId],
    )
  ).rows[0];
const transitionsOf = async (listingId: string) =>
  (
    await testPool().query(
      'select action, actor_id, self_approved, reason from core.state_transitions where entity_id = $1 order by at, id',
      [listingId],
    )
  ).rows;
/** Đơn sàn đã nhận có món mang SKU người bán này: ghép của SKU đó "đã có đơn dùng". */
const orderWith = async (sellerSku: string) =>
  testPool().query(
    `insert into channel.raw_orders (company_id, shop_id, external_order_id, payload) values ($1, $2, $3, $4)`,
    [company.companyId, shopId, randomUUID(), JSON.stringify({ lines: [{ externalLineId: '1', sellerSku }] })],
  );
/** SKU sàn đã ghép với một biến thể bằng Sale (200), trả listing. */
async function mapped() {
  const r = newRemote();
  const v = newVariant();
  const res = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: v.id });
  expect(res.status).toBe(200);
  return { r, v, listing: ChannelListing.parse(res.body) };
}
const accountIdOf = async (email: string) =>
  (await testPool().query<{ id: string }>('select id from core.accounts where email = $1', [email])).rows[0]!.id;

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  admin = await addMember(company.companyId, 'admin');
  sale = await addMember(company.companyId, 'sale');
  const res = await as(app().post('/api/v1/channel/shops/lazada/token'), company.ceo.token).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
});

describe('remote-skus', () => {
  it('Sale đọc được SKU trên sàn kèm ghép; `unmatched` bỏ SKU đã ghép, bỏ SKU đã xoá', async () => {
    const { r } = await mapped();
    const free = newRemote();
    const gone = newRemote({ state: 'deleted' });
    await reload();
    dirty = false;
    const all = await as(app().get(`/api/v1/channel/shops/${shopId}/remote-skus`), sale.token);
    expect(all.status).toBe(200);
    const items = RemoteSkuList.parse(all.body).items;
    expect(items.find((i) => i.externalSkuId === r.externalSkuId)).toMatchObject({ mode: 'mapped', sellerSku: r.sellerSku });
    expect(items.find((i) => i.externalSkuId === free.externalSkuId)).toMatchObject({ mode: null, matchedVariantId: null });
    expect(items.some((i) => i.externalSkuId === gone.externalSkuId)).toBe(false);
    const open = await as(app().get(`/api/v1/channel/shops/${shopId}/remote-skus?unmatched=true`), sale.token);
    const ids = RemoteSkuList.parse(open.body).items.map((i) => i.externalSkuId);
    expect(ids).toContain(free.externalSkuId);
    expect(ids).not.toContain(r.externalSkuId);
  });

  it('Review #309 B1: Sale xin "không quản tồn" cho SKU chưa ghép → CEO thấy yêu cầu qua `remote-skus` và duyệt được', async () => {
    const r = newRemote();
    expect((await match(sale.token, { externalSkuId: r.externalSkuId, variantId: null })).status).toBe(202);
    const res = await as(app().get(`/api/v1/channel/shops/${shopId}/remote-skus?unmatched=true`), company.ceo.token);
    const item = RemoteSkuList.parse(res.body).items.find((i) => i.externalSkuId === r.externalSkuId)!;
    expect(item).toMatchObject({ mode: null, pendingMapping: { variantId: null, requestedBy: { id: sale.accountId } } });
    expect(item.listingId).not.toBeNull();
    const ok = await decide(company.ceo.token, item.listingId!, 'approve', { version: item.listingVersion });
    expect(ok.status).toBe(200);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ mode: 'unmanaged', pending_mode: null });
    const after = await as(app().get(`/api/v1/channel/shops/${shopId}/remote-skus`), company.ceo.token);
    expect(RemoteSkuList.parse(after.body).items.find((i) => i.externalSkuId === r.externalSkuId)).toMatchObject({ mode: 'unmanaged', pendingMapping: null });
  });
});

describe('listings/match', () => {
  it('US-GH-04 AC1: Sale ghép SKU sàn chưa ghép → 200, listing `live` mang SKU người bán trên sàn, không xếp việc đẩy', async () => {
    const { r, v, listing } = await mapped();
    expect(listing).toMatchObject({ status: 'live', sellerSku: r.sellerSku, externalSkuId: r.externalSkuId, pendingMapping: null });
    // #399: SKU người bán có sẵn trên sàn, nội dung là của người bán.
    expect(listing.contentSource).toBe('platform');
    expect(await rowOf(r.externalSkuId)).toMatchObject({ mode: 'mapped', variant_id: v.id, approved_by: null, mapping_self_approved: false });
    const jobs = await testPool().query("select 1 from pgboss.job where name = 'channel.listing_push' and data->>'listingId' = $1", [listing.id]);
    expect(jobs.rowCount).toBe(0);
  });

  it('Admin đổi ghép chưa có đơn → 200, áp luôn, tồn và giá chờ đẩy lại theo biến thể mới', async () => {
    const { r } = await mapped();
    const v2 = newVariant();
    const res = await match(admin.token, { externalSkuId: r.externalSkuId, variantId: v2.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stockSync: 'pending', priceSync: 'pending', pendingMapping: null });
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: v2.id, pending_requested_by: null });
  });

  it('US-GH-04 AC2, DoD: Admin đổi ghép đã có đơn → 202, lưu `pendingMapping`, ghép cũ giữ nguyên', async () => {
    const { r, v } = await mapped();
    await orderWith(r.sellerSku);
    const v2 = newVariant();
    const res = await match(admin.token, { externalSkuId: r.externalSkuId, variantId: v2.id });
    expect(res.status).toBe(202);
    const listing = ChannelListing.parse(res.body);
    expect(listing.pendingMapping).toMatchObject({ variantId: v2.id, requestedBy: { id: admin.accountId, name: 'Nhân Viên Thử' } });
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: v.id, pending_variant_id: v2.id, pending_mode: 'mapped' });
    // DoD: ghép lại listing đang chờ duyệt → 409 `mapping_pending`.
    const again = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: newVariant().id });
    expect(again.status).toBe(409);
    expect(again.body.type).toMatch(/mapping_pending$/);
  });

  it('DoD: CEO đổi ghép đã có đơn → 200 áp luôn, lịch sử và nhật ký ghi tự duyệt', async () => {
    const { r, listing } = await mapped();
    await orderWith(r.sellerSku);
    const v2 = newVariant();
    const res = await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: v2.id });
    expect(res.status).toBe(200);
    const ceoId = await accountIdOf(company.ceo.email);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: v2.id, approved_by: ceoId, mapping_self_approved: true });
    expect((await transitionsOf(listing.id)).at(-1)).toMatchObject({ action: 'match', actor_id: ceoId, self_approved: true });
    const audit = await testPool().query(
      `select operation, after from core.audit_logs where entity_id = $1 and after @> '{"selfApproved": true}'::jsonb`,
      [listing.id],
    );
    expect(audit.rowCount).toBe(1);
    // #352: SKU không phải số chứng từ: nhãn ở cột riêng, `after` không có `code`.
    expect(audit.rows[0].operation).toBe('match');
    expect(audit.rows[0].after).not.toHaveProperty('code');
  });

  it('DoD: Sale ghép SKU sàn chưa ghép sang "không quản tồn" → 202; SKU vẫn tính là chưa ghép tới khi CEO duyệt', async () => {
    const r = newRemote();
    const res = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: null });
    expect(res.status).toBe(202);
    expect(res.body.pendingMapping).toMatchObject({ variantId: null, requestedBy: { id: sale.accountId } });
    expect(res.body.contentSource).toBe('platform');
    expect(await rowOf(r.externalSkuId)).toMatchObject({ mode: 'unmanaged', variant_id: null, approved_by: null, pending_mode: 'unmanaged' });
    const open = await as(app().get(`/api/v1/channel/shops/${shopId}/remote-skus?unmatched=true`), sale.token);
    expect(RemoteSkuList.parse(open.body).items.map((i) => i.externalSkuId)).toContain(r.externalSkuId);
  });

  it('CEO ghép sang "không quản tồn" → 200, CEO là người duyệt, tự duyệt', async () => {
    const r = newRemote();
    const res = await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: null });
    expect(res.status).toBe(200);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ mode: 'unmanaged', approved_by: await accountIdOf(company.ceo.email), mapping_self_approved: true });
  });

  it('422: biến thể đã ghép SKU sàn khác của gian hàng, biến thể không thuộc công ty; SKU sàn không còn, chưa có SKU người bán', async () => {
    const { v } = await mapped();
    const taken = await match(sale.token, { externalSkuId: newRemote().externalSkuId, variantId: v.id });
    expect(taken.status).toBe(422);
    expect(taken.body.errors).toHaveProperty('variantId');
    const foreign = await match(sale.token, { externalSkuId: newRemote().externalSkuId, variantId: randomUUID() });
    expect(foreign.body.errors).toHaveProperty('variantId');
    const missing = await match(sale.token, { externalSkuId: 'sku-khong-co', variantId: newVariant().id });
    expect(missing.status).toBe(422);
    expect(missing.body.errors).toHaveProperty('externalSkuId');
    const noSeller = await match(sale.token, { externalSkuId: newRemote({ sellerSku: '' }).externalSkuId, variantId: newVariant().id });
    expect(noSeller.body.errors).toHaveProperty('externalSkuId');
  });

  it('DoD: Sale gọi `push`, `delist` vẫn 403; Kho gọi `match` 403', async () => {
    const { v, listing } = await mapped();
    const push = await as(app().post(`/api/v1/channel/shops/${shopId}/listings/push`), sale.token).send({ variantIds: [v.id] });
    expect(push.status).toBe(403);
    const delist = await as(app().post(`/api/v1/channel/shops/${shopId}/listings/${v.id}/delist`), sale.token).send({ version: listing.version });
    expect(delist.status).toBe(403);
    const kho = await addMember(company.companyId, 'warehouse');
    const res = await match(kho.token, { externalSkuId: newRemote().externalSkuId, variantId: newVariant().id });
    expect(res.status).toBe(403);
  });
});

describe('mapping/:action', () => {
  async function pendingRemap() {
    const { r, v } = await mapped();
    await orderWith(r.sellerSku);
    const v2 = newVariant();
    const res = await match(admin.token, { externalSkuId: r.externalSkuId, variantId: v2.id });
    expect(res.status).toBe(202);
    return { r, v, v2, listing: ChannelListing.parse(res.body) };
  }

  it('DoD: Admin, Sale gọi duyệt → 403; `version` lệch → 409 `version_conflict`; từ chối thiếu lý do → 422 `errors.reason`', async () => {
    const { listing } = await pendingRemap();
    expect((await decide(admin.token, listing.id, 'approve', { version: listing.version })).status).toBe(403);
    expect((await decide(sale.token, listing.id, 'approve', { version: listing.version })).status).toBe(403);
    const stale = await decide(company.ceo.token, listing.id, 'approve', { version: listing.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toMatch(/version_conflict$/);
    const noReason = await decide(company.ceo.token, listing.id, 'reject', { version: listing.version });
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors).toHaveProperty('reason');
  });

  it('CEO duyệt → 200 áp ghép mới, bỏ `pendingMapping`; duyệt lại → 409 `invalid_transition`', async () => {
    const { r, v2, listing } = await pendingRemap();
    const res = await decide(company.ceo.token, listing.id, 'approve', { version: listing.version });
    expect(res.status).toBe(200);
    expect(ChannelListing.parse(res.body).pendingMapping).toBeNull();
    const ceoId = await accountIdOf(company.ceo.email);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: v2.id, approved_by: ceoId, mapping_self_approved: false, pending_mode: null });
    expect((await transitionsOf(listing.id)).map((t) => t.action)).toEqual(['match', 'request_mapping', 'approve_mapping']);
    const again = await decide(company.ceo.token, listing.id, 'approve', { version: res.body.version });
    expect(again.status).toBe(409);
    expect(again.body.type).toMatch(/invalid_transition$/);
  });

  it('CEO từ chối đổi ghép → giữ ghép cũ, lịch sử ghi lý do', async () => {
    const { r, v, listing } = await pendingRemap();
    const res = await decide(company.ceo.token, listing.id, 'reject', { version: listing.version, reason: 'Ghép nhầm màu' });
    expect(res.status).toBe(200);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: v.id, pending_requested_by: null });
    expect((await transitionsOf(listing.id)).at(-1)).toMatchObject({ action: 'reject_mapping', reason: 'Ghép nhầm màu' });
  });

  it('CEO từ chối "không quản tồn" của SKU chưa ghép → dòng chờ bị xoá, SKU ghép lại được', async () => {
    const r = newRemote();
    const asked = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: null });
    const res = await decide(company.ceo.token, asked.body.id, 'reject', { version: asked.body.version, reason: 'Không phải quà tặng' });
    expect(res.status).toBe(200);
    expect(res.body.pendingMapping).toBeNull();
    expect(await rowOf(r.externalSkuId)).toBeUndefined();
    expect((await match(sale.token, { externalSkuId: r.externalSkuId, variantId: newVariant().id })).status).toBe(200);
  });

  it('CEO duyệt "không quản tồn" → mode `unmanaged` có người duyệt', async () => {
    const r = newRemote();
    const asked = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: null });
    const res = await decide(company.ceo.token, asked.body.id, 'approve', { version: asked.body.version });
    expect(res.status).toBe(200);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ mode: 'unmanaged', approved_by: await accountIdOf(company.ceo.email), pending_mode: null });
  });

  it('Duyệt listing đang đẩy lên sàn → 409 `invalid_transition`, ghép chờ giữ nguyên', async () => {
    const { r, v, listing } = await pendingRemap();
    await testPool().query(`update channel.listings set status = 'pushing' where id = $1`, [listing.id]);
    const res = await decide(company.ceo.token, listing.id, 'approve', { version: listing.version });
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/invalid_transition$/);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: v.id, pending_mode: 'mapped' });
  });

  it('Hai ghép chờ cùng một biến thể, CEO duyệt cùng lúc → một lần 200, lần kia 422 `errors.variantId` (không 500)', async () => {
    const a = await mapped();
    const b = await mapped();
    await orderWith(a.r.sellerSku);
    await orderWith(b.r.sellerSku);
    const v2 = newVariant();
    const pa = await match(admin.token, { externalSkuId: a.r.externalSkuId, variantId: v2.id });
    const pb = await match(admin.token, { externalSkuId: b.r.externalSkuId, variantId: v2.id });
    expect([pa.status, pb.status]).toEqual([202, 202]);
    const results = await Promise.all([
      decide(company.ceo.token, pa.body.id, 'approve', { version: pa.body.version }),
      decide(company.ceo.token, pb.body.id, 'approve', { version: pb.body.version }),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 422]);
    expect(results.find((x) => x.status === 422)!.body.errors).toHaveProperty('variantId');
  });

  it('Review #309 B3: người xin tự duyệt chỉ khi được tự duyệt (CEO) → ghi `mapping_self_approved`; CSDL chặn người duyệt trùng người xin', async () => {
    const { r, listing } = await pendingRemap();
    const ceoId = await accountIdOf(company.ceo.email);
    // Người xin về sau được nâng lên CEO: dựng bằng cách đổi người xin của yêu cầu chờ.
    await testPool().query('update channel.listings set pending_requested_by = $2 where id = $1', [listing.id, ceoId]);
    const res = await decide(company.ceo.token, listing.id, 'approve', { version: listing.version });
    expect(res.status).toBe(200);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ approved_by: ceoId, mapping_self_approved: true });
    expect((await transitionsOf(listing.id)).at(-1)).toMatchObject({ action: 'approve_mapping', self_approved: true });
    await expect(
      testPool().query('update channel.listings set mapping_self_approved = false where id = $1', [listing.id]),
    ).rejects.toMatchObject({ constraint: 'listings_mapping_second_person' });
  });

  it('Duyệt bình thường giữ người xin ở `mapping_requested_by`, khác người duyệt', async () => {
    const { listing } = await pendingRemap();
    expect((await decide(company.ceo.token, listing.id, 'approve', { version: listing.version })).status).toBe(200);
    const row = (await testPool().query('select mapping_requested_by, approved_by from channel.listings where id = $1', [listing.id])).rows[0];
    expect(row).toEqual({ mapping_requested_by: admin.accountId, approved_by: await accountIdOf(company.ceo.email) });
  });

  it('404 khi listing không có hoặc mã sai định dạng', async () => {
    expect((await decide(company.ceo.token, randomUUID(), 'approve', { version: 1 })).status).toBe(404);
    expect((await decide(company.ceo.token, 'abc', 'approve', { version: 1 })).status).toBe(404);
  });
});

describe('đợt 2: gỡ listing thì bỏ ghép chờ duyệt (review #309 N2)', () => {
  async function pendingRemap() {
    const { r, v } = await mapped();
    await orderWith(r.sellerSku);
    const res = await match(admin.token, { externalSkuId: r.externalSkuId, variantId: newVariant().id });
    expect(res.status).toBe(202);
    return { r, v, listing: ChannelListing.parse(res.body) };
  }
  const pendingOf = async (id: string) =>
    (await testPool().query('select status, pending_requested_by, pending_mode from channel.listings where id = $1', [id])).rows[0];

  it('Gỡ tay listing đang chờ duyệt đổi ghép → ghép chờ bị bỏ, lịch sử ghi `reject_mapping`', async () => {
    const { v, listing } = await pendingRemap();
    const res = await as(app().post(`/api/v1/channel/shops/${shopId}/listings/${v.id}/delist`), admin.token).send({ version: listing.version });
    expect(res.status).toBe(200);
    expect(res.body.pendingMapping).toBeNull();
    expect(await pendingOf(listing.id)).toEqual({ status: 'delisted', pending_requested_by: null, pending_mode: null });
    expect((await transitionsOf(listing.id)).map((t) => t.action).slice(-2)).toEqual(['delist', 'reject_mapping']);
  });

  it('Sàn xoá sản phẩm của listing đang chờ duyệt → lượt đồng bộ gỡ và bỏ ghép chờ; dòng chỉ chờ "không quản tồn" bị xoá', async () => {
    const { r, listing } = await pendingRemap();
    const only = newRemote();
    const asked = await match(sale.token, { externalSkuId: only.externalSkuId, variantId: null });
    expect(asked.status).toBe(202);
    r.state = 'deleted';
    only.state = 'deleted';
    await syncListings(port, company.companyId, shopId);
    expect(await pendingOf(listing.id)).toEqual({ status: 'delisted', pending_requested_by: null, pending_mode: null });
    const last = (await transitionsOf(listing.id)).at(-1);
    expect(last).toMatchObject({ action: 'reject_mapping', actor_id: null });
    expect(await pendingOf(asked.body.id)).toBeUndefined();
    expect((await transitionsOf(asked.body.id)).at(-1)).toMatchObject({ action: 'reject_mapping', actor_id: null });
  });

  it('Ngắt gian hàng có listing chờ duyệt → listing gỡ do ngắt không còn ghép chờ; dòng chỉ chờ "không quản tồn" bị xoá', async () => {
    const res = await as(app().post('/api/v1/channel/shops/lazada/token'), company.ceo.token).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    const other = res.body.shop.id as string;
    await activateShop(other);
    const on = (path: string, token: string) => as(app().post(`/api/v1/channel/shops/${other}${path}`), token);
    const a = newRemote();
    const b = newRemote();
    await reload(other);
    expect((await on('/listings/match', sale.token).send({ externalSkuId: a.externalSkuId, variantId: newVariant().id })).status).toBe(200);
    await testPool().query(
      `insert into channel.raw_orders (company_id, shop_id, external_order_id, payload) values ($1, $2, $3, $4)`,
      [company.companyId, other, randomUUID(), JSON.stringify({ lines: [{ externalLineId: '1', sellerSku: a.sellerSku }] })],
    );
    const remap = await on('/listings/match', admin.token).send({ externalSkuId: a.externalSkuId, variantId: newVariant().id });
    expect(remap.status).toBe(202);
    const onlyPending = await on('/listings/match', sale.token).send({ externalSkuId: b.externalSkuId, variantId: null });
    expect(onlyPending.status).toBe(202);
    const shop = await as(app().get(`/api/v1/channel/shops/${other}`), company.ceo.token);
    const off = await on('/disconnect', company.ceo.token).send({ version: shop.body.version });
    expect(off.status).toBe(200);
    expect(await pendingOf(remap.body.id)).toEqual({ status: 'delisted', pending_requested_by: null, pending_mode: null });
    expect((await transitionsOf(remap.body.id)).at(-1)).toMatchObject({ action: 'reject_mapping' });
    expect(await pendingOf(onlyPending.body.id)).toBeUndefined();
  });
});

describe('đợt 2: đơn về giữa lúc đổi ghép (review #309 N1)', () => {
  it('Lượt nhận đơn đang giữ khoá gian hàng và chèn đơn mang SKU đó → lượt đổi ghép chờ, rồi thấy đơn và đòi CEO (202)', async () => {
    const { r } = await mapped();
    const v2 = newVariant();
    const res = await raceBehindLock(
      async (holder) => {
        await holder.query('select id from channel.shops where id = $1 for share', [shopId]);
        await holder.query(
          'insert into channel.raw_orders (company_id, shop_id, external_order_id, payload) values ($1, $2, $3, $4)',
          [company.companyId, shopId, randomUUID(), JSON.stringify({ lines: [{ externalLineId: '1', sellerSku: r.sellerSku }] })],
        );
      },
      1,
      () => match(admin.token, { externalSkuId: r.externalSkuId, variantId: v2.id }).then((x) => x),
    );
    expect(res.status).toBe(202);
  });
});

describe('đợt 2: 409 `version_conflict` kèm `current`', () => {
  /** Chạy `match` sau giao dịch giữ khoá gian hàng và đổi listing bằng `change` (chưa commit tới khi `match` chờ khoá). */
  const matchBehind = (externalSkuId: string, change: string, params: unknown[]) =>
    raceBehindLock(
      async (holder) => {
        await holder.query('select id from channel.shops where id = $1 for share', [shopId]);
        await holder.query(change, params);
      },
      1,
      () => match(admin.token, { externalSkuId, variantId: newVariant().id }).then((x) => x),
    );

  it('Request khác đổi ghép giữa lúc ghép đọc và lúc ghi → 409 `version_conflict` có `current` là listing mới nhất', async () => {
    const { r, listing } = await mapped();
    const other = newVariant();
    const res = await matchBehind(r.externalSkuId, 'update channel.listings set variant_id = $2, version = version + 1 where id = $1', [listing.id, other.id]);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/version_conflict$/);
    expect(ChannelListing.parse(res.body.current)).toMatchObject({ id: listing.id, version: listing.version + 1 });
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: other.id });
  });

  it('#411: việc đẩy tồn, giá chỉ tăng `version` giữa hai lần đọc → ghép vẫn 200, ghi theo `version` mới', async () => {
    const { r, listing } = await mapped();
    const v2 = newVariant();
    const res = await raceBehindLock(
      async (holder) => {
        await holder.query('select id from channel.shops where id = $1 for share', [shopId]);
        await holder.query("update channel.listings set stock_sync = 'synced', version = version + 3 where id = $1", [listing.id]);
      },
      1,
      () => match(admin.token, { externalSkuId: r.externalSkuId, variantId: v2.id }).then((x) => x),
    );
    expect(res.status).toBe(200);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: v2.id, version: listing.version + 4 });
  });

  it('#411: request khác ghi ghép chờ CEO duyệt giữa hai lần đọc → 409 `version_conflict`, ghép chờ giữ nguyên', async () => {
    const { r, listing } = await mapped();
    const other = newVariant();
    const res = await matchBehind(
      r.externalSkuId,
      `update channel.listings set pending_variant_id = $2, pending_mode = 'mapped', pending_requested_by = $3, pending_requested_at = now(),
              version = version + 1 where id = $1`,
      [listing.id, other.id, sale.accountId],
    );
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/version_conflict$/);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ pending_variant_id: other.id, pending_requested_by: sale.accountId });
  });

  it('#411: listing sang `pushing` giữa hai lần đọc → 409, không ghép listing đang đẩy', async () => {
    const { r, v, listing } = await mapped();
    const res = await matchBehind(r.externalSkuId, "update channel.listings set status = 'pushing', version = version + 1 where id = $1", [listing.id]);
    expect(res.status).toBe(409);
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: v.id, status: 'pushing' });
  });
});

describe('đợt 2: bản sao SKU sàn (Documents/21 §18.3 "đọc từ lần đồng bộ gần nhất")', () => {
  /** Gian hàng mới của công ty, chưa có bản sao. */
  async function freshShop() {
    const res = await as(app().post('/api/v1/channel/shops/lazada/token'), company.ceo.token).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    const id = res.body.shop.id as string;
    await activateShop(id);
    return id;
  }
  const remoteSkusOf = (id: string, q = '') => as(app().get(`/api/v1/channel/shops/${id}/remote-skus${q}`), sale.token);
  /** Lần mở trang đầu: `GET` xếp lượt tải nền (#361), chạy việc đó. */
  const openFirst = async (id: string) => {
    expect((await remoteSkusOf(id)).status).toBe(200);
    await runJob(id);
  };
  const refreshOf = (id: string) => as(app().post(`/api/v1/channel/shops/${id}/remote-skus/refresh`), sale.token);

  it('Lần mở đầu xếp lượt tải nền (không gọi sàn trong request), lượt đó gọi sàn một lần rồi lưu; lần sau đọc bản sao; trả `syncedAt`', async () => {
    const id = await freshShop();
    const before = listSkusCalls;
    const first = await remoteSkusOf(id);
    expect(first.status).toBe(200);
    expect(RemoteSkuList.parse(first.body)).toMatchObject({ items: [], syncedAt: null, refresh: { status: 'running' } });
    expect(listSkusCalls).toBe(before);
    await runJob(id);
    expect(listSkusCalls).toBe(before + 1);
    const second = RemoteSkuList.parse((await remoteSkusOf(id)).body);
    const third = RemoteSkuList.parse((await remoteSkusOf(id)).body);
    expect(listSkusCalls).toBe(before + 1);
    expect(second.syncedAt).not.toBeNull();
    expect(third.syncedAt).toEqual(second.syncedAt);
    expect(third.items.length).toBe(second.items.length);
    expect(second.refresh.status).toBe('idle');
  });

  it('Tải lại: đọc trọn, SKU đã mất trên sàn bị bỏ khỏi bản sao; bấm lại trong 60 giây thì không gọi sàn', async () => {
    const id = await freshShop();
    const r = newRemote();
    dirty = false;
    await openFirst(id);
    r.state = 'deleted';
    await testPool().query("update channel.shops set remote_skus_synced_at = now() - interval '2 minutes' where id = $1", [id]);
    const before = listSkusCalls;
    expect((await refreshOf(id)).status).toBe(202);
    await runJob(id);
    expect(listSkusCalls).toBe(before + 1);
    expect(RemoteSkuList.parse((await remoteSkusOf(id)).body).items.some((i) => i.externalSkuId === r.externalSkuId)).toBe(false);
    expect((await refreshOf(id)).status).toBe(200);
    expect(listSkusCalls).toBe(before + 1);
  });

  it('Ghép SKU chưa có listing tra bản sao, không gọi sàn; SKU chưa có trong bản sao → 422 `errors.externalSkuId`', async () => {
    const r = newRemote();
    await reload();
    dirty = false;
    const before = listSkusCalls;
    expect((await match(sale.token, { externalSkuId: r.externalSkuId, variantId: newVariant().id })).status).toBe(200);
    const late = newRemote();
    dirty = false;
    const res = await match(sale.token, { externalSkuId: late.externalSkuId, variantId: newVariant().id });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('externalSkuId');
    expect(listSkusCalls).toBe(before);
  });

  it('Số SKU chưa ghép đếm từ bản sao: giảm ngay khi ghép; chờ duyệt "không quản tồn" vẫn tính là chưa ghép', async () => {
    const id = await freshShop();
    const count = async () => (await withCompany(company.companyId, () => unmatchedRemoteCounts([id]))).get(id) ?? 0;
    await openFirst(id);
    const start = await count();
    expect(start).toBe(remote.filter((r) => r.state !== 'deleted').length);
    const r = remote.find((x) => x.state !== 'deleted' && x.sellerSku)!;
    const ok = await as(app().post(`/api/v1/channel/shops/${id}/listings/match`), sale.token).send({ externalSkuId: r.externalSkuId, variantId: newVariant().id });
    expect(ok.status).toBe(200);
    expect(await count()).toBe(start - 1);
    const other = remote.find((x) => x.state !== 'deleted' && x.sellerSku && x !== r)!;
    const asked = await as(app().post(`/api/v1/channel/shops/${id}/listings/match`), sale.token).send({ externalSkuId: other.externalSkuId, variantId: null });
    expect(asked.status).toBe(202);
    expect(await count()).toBe(start - 1);
  });

  it('Lượt đồng bộ listing định kỳ đọc sản phẩm sửa từ mốc trừ 2 phút: SKU mới vào, SKU đã xoá ra; sàn lỗi thì lượt đồng bộ vẫn xong', async () => {
    const id = await freshShop();
    await openFirst(id);
    // Đọc theo giờ sửa mỗi giờ một lần (review vòng 2 N2): mốc phải cũ hơn 1 giờ.
    const mark = new Date(Date.now() - 70 * 60_000);
    await testPool().query('update channel.shops set remote_skus_changed_since = $2 where id = $1', [id, mark]);
    const added = newRemote();
    dirty = false;
    const gone = remote.find((x) => x.state !== 'deleted' && x !== added)!;
    changedSince.length = 0;
    changedResult = [added, { ...gone, state: 'deleted' }];
    await runListingSync(port, { companyId: company.companyId, shopId: id });
    expect(changedSince).toEqual([new Date(mark.getTime() - 2 * 60_000)]);
    const ids = RemoteSkuList.parse((await remoteSkusOf(id)).body).items.map((i) => i.externalSkuId);
    expect(ids).toContain(added.externalSkuId);
    expect(ids).not.toContain(gone.externalSkuId);
    const { rows } = await testPool().query('select remote_skus_changed_since from channel.shops where id = $1', [id]);
    expect(rows[0].remote_skus_changed_since.getTime()).toBeGreaterThan(mark.getTime());

    await testPool().query('update channel.shops set remote_skus_changed_since = $2 where id = $1', [id, mark]);
    changedFails = true;
    try {
      await expect(runListingSync(port, { companyId: company.companyId, shopId: id })).resolves.toBeUndefined();
    } finally {
      changedFails = false;
    }
  });

  it('Review vòng 2 N2: lần đọc trước chưa quá 1 giờ thì lượt đồng bộ listing không gọi sàn để làm mới bản sao', async () => {
    const id = await freshShop();
    await openFirst(id);
    await testPool().query("update channel.shops set remote_skus_changed_since = now() - interval '30 minutes' where id = $1", [id]);
    const before = listSkusCalls;
    changedSince.length = 0;
    await runListingSync(port, { companyId: company.companyId, shopId: id });
    expect(changedSince).toEqual([]);
    expect(listSkusCalls).toBe(before);
  });

  it('Review vòng 2 N1: lần đọc trọn ra rỗng trong khi lần trước có SKU thì không xoá bản sao; rỗng lần thứ hai liền mới xoá', async () => {
    const id = await freshShop();
    await openFirst(id);
    const count = async () => Number((await testPool().query('select count(*) from channel.remote_skus where shop_id = $1', [id])).rows[0].count);
    const had = await count();
    expect(had).toBeGreaterThan(0);
    const refresh = async () => {
      // Lùi cả đồng hồ của bản sao 2 phút, như thể lần đọc trước đã qua khoảng chờ 60 giây.
      await testPool().query("update channel.shops set remote_skus_synced_at = remote_skus_synced_at - interval '2 minutes' where id = $1", [id]);
      await testPool().query("update channel.remote_skus set seen_at = seen_at - interval '2 minutes' where shop_id = $1", [id]);
      const res = await refreshOf(id);
      await runJob(id);
      return res;
    };
    // Lượt Tải lại đọc theo giờ sửa trước (#361): sàn không báo sửa gì, để chỉ còn ảnh hưởng của lần đọc trọn rỗng.
    changedResult = [];
    listSkusEmpty = true;
    try {
      expect((await refresh()).status).toBe(202);
      expect(await count()).toBe(had);
      expect((await refresh()).status).toBe(202);
      expect(await count()).toBe(0);
    } finally {
      listSkusEmpty = false;
    }
  });

  it('Review vòng 2 N3: SKU về thiếu nhãn biến thể thì giữ tiêu đề cũ trong bản sao, vẫn cập nhật tồn, trạng thái', async () => {
    const id = await freshShop();
    const r = newRemote({ title: 'Áo - Trắng, M' });
    dirty = false;
    await openFirst(id);
    await testPool().query("update channel.shops set remote_skus_changed_since = now() - interval '70 minutes' where id = $1", [id]);
    changedResult = [{ ...r, title: `Áo - ${r.sellerSku}`, labelMissing: true, quantity: 9, state: 'inactive' }];
    await runListingSync(port, { companyId: company.companyId, shopId: id });
    const { rows } = await testPool().query('select title, quantity, state from channel.remote_skus where shop_id = $1 and external_sku_id = $2', [id, r.externalSkuId]);
    expect(rows[0]).toEqual({ title: 'Áo - Trắng, M', quantity: 9, state: 'inactive' });
  });

  it('Review vòng 3 R1: đọc trọn định kỳ lỗi thì giãn lần thử (1 giờ, 2 giờ, …), mốc ở CSDL; Tải lại vẫn đọc ngay, đọc được thì xoá mốc', async () => {
    const id = await freshShop();
    await openFirst(id);
    const state = async () =>
      (
        await testPool().query<{ failures: number; retry: Date | null }>(
          'select remote_skus_full_failures as failures, remote_skus_full_retry_at as retry from channel.shops where id = $1',
          [id],
        )
      ).rows[0]!;
    const minutesAhead = (d: Date | null) => (d ? Math.round((d.getTime() - Date.now()) / 60_000) : null);
    await testPool().query("update channel.shops set remote_skus_synced_at = now() - interval '25 hours' where id = $1", [id]);
    listSkusFails = true;
    try {
      let before = listSkusCalls;
      await runListingSync(port, { companyId: company.companyId, shopId: id });
      expect(listSkusCalls).toBe(before + 1);
      let s1 = await state();
      expect(s1.failures).toBe(1);
      expect(minutesAhead(s1.retry)).toBeGreaterThanOrEqual(59);
      expect(minutesAhead(s1.retry)).toBeLessThanOrEqual(60);

      // Chưa tới mốc: lượt sau không đọc trọn.
      before = listSkusCalls;
      await runListingSync(port, { companyId: company.companyId, shopId: id });
      expect(listSkusCalls).toBe(before);

      // Tới mốc mà vẫn lỗi: lần sau cách 2 giờ.
      await testPool().query("update channel.shops set remote_skus_full_retry_at = now() - interval '1 minute' where id = $1", [id]);
      await runListingSync(port, { companyId: company.companyId, shopId: id });
      expect(listSkusCalls).toBe(before + 1);
      s1 = await state();
      expect(s1.failures).toBe(2);
      expect(minutesAhead(s1.retry)).toBeGreaterThanOrEqual(119);
      expect(minutesAhead(s1.retry)).toBeLessThanOrEqual(120);

      // Tải lại không chờ mốc giãn của lượt định kỳ, chỉ chờ 10 phút sau lần lỗi gần nhất (vòng 4 B2).
      await testPool().query("update channel.shops set remote_skus_full_failed_at = now() - interval '11 minutes' where id = $1", [id]);
      before = listSkusCalls;
      expect((await refreshOf(id)).status).toBe(202);
      await runJob(id);
      expect(listSkusCalls).toBe(before + 1);
    } finally {
      listSkusFails = false;
    }
    await testPool().query("update channel.shops set remote_skus_full_failed_at = now() - interval '11 minutes' where id = $1", [id]);
    expect((await refreshOf(id)).status).toBe(202);
    await runJob(id);
    expect(await state()).toEqual({ failures: 0, retry: null });
  });

  it('Review vòng 4 B2: Tải lại trong 10 phút sau lần đọc trọn lỗi → 429 `remote_skus_retry_later` kèm `Retry-After`, không gọi sàn', async () => {
    const id = await freshShop();
    await openFirst(id);
    await testPool().query("update channel.shops set remote_skus_synced_at = now() - interval '2 minutes' where id = $1", [id]);
    const refresh = () => refreshOf(id);
    listSkusFails = true;
    try {
      let before = listSkusCalls;
      expect((await refresh()).status).toBe(202);
      await runJob(id);
      expect(listSkusCalls).toBe(before + 1);
      before = listSkusCalls;
      const res = await refresh();
      expect(res.status).toBe(429);
      expect(res.body.type).toMatch(/remote_skus_retry_later$/);
      const wait = Number(res.headers['retry-after']);
      expect(wait).toBeGreaterThan(540);
      expect(wait).toBeLessThanOrEqual(600);
      expect(listSkusCalls).toBe(before);
      await testPool().query("update channel.shops set remote_skus_full_failed_at = now() - interval '11 minutes' where id = $1", [id]);
      expect((await refresh()).status).toBe(202);
      await runJob(id);
      expect(listSkusCalls).toBe(before + 1);
    } finally {
      listSkusFails = false;
    }
    await testPool().query("update channel.shops set remote_skus_full_failed_at = now() - interval '11 minutes' where id = $1", [id]);
    expect((await refresh()).status).toBe(202);
    await runJob(id);
    const { rows } = await testPool().query('select remote_skus_full_failed_at as f from channel.shops where id = $1', [id]);
    expect(rows[0].f).toBeNull();
  });

  it('Review vòng 5 C2 (#361): lần mở trang đầu lỗi thì `GET remote-skus` lần sau trong 10 phút → 200 kèm `refresh.failed`, số giây chờ, không gọi sàn lại', async () => {
    const id = await freshShop();
    listSkusFails = true;
    try {
      const before = listSkusCalls;
      await openFirst(id);
      const res = await remoteSkusOf(id);
      expect(res.status).toBe(200);
      const body = RemoteSkuList.parse(res.body);
      expect(body.refresh).toMatchObject({ status: 'failed', error: { code: 'marketplace_rejected', platformCode: 'incomplete_list' } });
      expect(body.refresh.retryAfterSeconds).toBeGreaterThan(0);
      await runJob(id);
      expect(listSkusCalls).toBe(before + 1);
    } finally {
      listSkusFails = false;
    }
  });

  it('Review vòng 3 R1: giãn lần thử tối đa 24 giờ', async () => {
    const id = await freshShop();
    await openFirst(id);
    await testPool().query(
      "update channel.shops set remote_skus_synced_at = now() - interval '25 hours', remote_skus_full_failures = 9, remote_skus_full_retry_at = now() - interval '1 minute', remote_skus_full_failed_at = now() - interval '1 hour' where id = $1",
      [id],
    );
    listSkusFails = true;
    try {
      await runListingSync(port, { companyId: company.companyId, shopId: id });
    } finally {
      listSkusFails = false;
    }
    const { rows } = await testPool().query('select remote_skus_full_failures as f, remote_skus_full_retry_at as r from channel.shops where id = $1', [id]);
    expect(rows[0].f).toBe(10);
    expect(Math.round((rows[0].r.getTime() - Date.now()) / 3600_000)).toBe(24);
  });

  it('Lần đọc trọn đã quá 24 giờ thì lượt định kỳ đọc trọn thay vì đọc theo giờ sửa', async () => {
    const id = await freshShop();
    await openFirst(id);
    await testPool().query("update channel.shops set remote_skus_synced_at = now() - interval '25 hours' where id = $1", [id]);
    const before = listSkusCalls;
    changedSince.length = 0;
    await runListingSync(port, { companyId: company.companyId, shopId: id });
    expect(listSkusCalls).toBe(before + 1);
    expect(changedSince).toEqual([]);
  });
});

// #346: lần đẩy hỏng mà sàn vẫn tạo sản phẩm (Lazada E500) không còn khoá biến thể (Documents/21 §18.3 `match`, §18.6.5).
describe('#346: ghép vào biến thể có listing lỗi đẩy', () => {
  /** Listing lỗi đẩy chưa có mã sàn của biến thể (như sau E500), trả id. */
  const failedRow = async (variantId: string, sellerSku: string, status = 'push_failed') =>
    (
      await testPool().query<{ id: string }>(
        `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, push_error, push_attempts, listed_price, external_image_urls, content_source)
         values ($1, $2, $3, $4, $5, $6, 1, 50000, '{https://img/a.jpg}', 'app') returning id`,
        [
          company.companyId,
          shopId,
          variantId,
          sellerSku,
          status,
          status === 'push_failed' ? JSON.stringify({ code: 'marketplace_rejected', message: 'E500: Create product failed', at: new Date().toISOString() }) : null,
        ],
      )
    ).rows[0]!.id;
  const byId = async (id: string) => (await testPool().query('select * from channel.listings where id = $1', [id])).rows[0];
  const openRowsOf = async (variantId: string) =>
    (await testPool().query("select id from channel.listings where shop_id = $1 and variant_id = $2 and status <> 'delisted'", [shopId, variantId])).rows;

  it('AC-1: cùng SKU người bán → 200, dùng lại listing lỗi: `live`, mã sàn, tồn sàn, xoá lỗi, chờ đẩy tồn và giá', async () => {
    const r = newRemote();
    const v = newVariant();
    const id = await failedRow(v.id, r.sellerSku);
    const res = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: v.id });
    expect(res.status).toBe(200);
    expect(ChannelListing.parse(res.body)).toMatchObject({ id, status: 'live', externalSkuId: r.externalSkuId, pendingMapping: null });
    expect(await byId(id)).toMatchObject({
      external_product_id: r.externalProductId,
      platform_stock: 3,
      push_error: null,
      stock_sync: 'pending',
      price_sync: 'pending',
      external_image_urls: ['https://img/a.jpg'],
      listed_price: '50000.00',
      // #399: gắn SKU sàn có sẵn thì nội dung trên sàn coi là của người bán.
      content_source: 'platform',
    });
    expect(await openRowsOf(v.id)).toHaveLength(1);
    expect((await transitionsOf(id)).at(-1)).toMatchObject({ action: 'match' });
  });

  it('Khác SKU người bán, chưa có đơn mang SKU người bán cũ → 200 dùng lại, SKU người bán theo SKU sàn', async () => {
    const r = newRemote();
    const v = newVariant();
    const id = await failedRow(v.id, `CU-${randomUUID().slice(0, 6)}`);
    const res = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: v.id });
    expect(res.status).toBe(200);
    expect(await byId(id)).toMatchObject({ status: 'live', seller_sku: r.sellerSku, external_sku_id: r.externalSkuId });
  });

  async function pendingOnFailed() {
    const r = newRemote();
    const v = newVariant();
    const old = `CU-${randomUUID().slice(0, 6)}`;
    const id = await failedRow(v.id, old);
    await orderWith(old);
    const res = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: v.id });
    return { r, v, id, old, res };
  }

  it('Khác SKU người bán, đã có đơn mang SKU người bán cũ, Sale → 202, yêu cầu chờ ghi lên listing lỗi; SKU sàn hiện chờ duyệt', async () => {
    const { r, v, id, old, res } = await pendingOnFailed();
    expect(res.status).toBe(202);
    expect(ChannelListing.parse(res.body)).toMatchObject({ id, status: 'push_failed', pendingMapping: { variantId: v.id, externalSkuId: r.externalSkuId } });
    expect(await byId(id)).toMatchObject({ external_sku_id: null, seller_sku: old, pending_external_sku_id: r.externalSkuId, pending_seller_sku: r.sellerSku });
    const list = await as(app().get(`/api/v1/channel/shops/${shopId}/remote-skus?unmatched=true`), company.ceo.token);
    const item = RemoteSkuList.parse(list.body).items.find((i) => i.externalSkuId === r.externalSkuId)!;
    expect(item).toMatchObject({ mode: null, listingId: id, pendingMapping: { externalSkuId: r.externalSkuId } });
    // Ghép SKU sàn đang chờ lần nữa → 409 `mapping_pending`.
    const again = await match(admin.token, { externalSkuId: r.externalSkuId, variantId: newVariant().id });
    expect(again.status).toBe(409);
    expect(again.body.type).toMatch(/mapping_pending$/);
    // Đẩy lại listing đang chờ duyệt bị chặn theo dòng.
    const push = await as(app().post(`/api/v1/channel/shops/${shopId}/listings/push`), company.ceo.token).send({ variantIds: [v.id] });
    expect(push.body.results[0]).toMatchObject({ code: 'mapping_pending' });
  });

  it('CEO duyệt → listing lỗi thành `live` với mã sàn chờ; từ chối → giữ `push_failed`, bỏ yêu cầu', async () => {
    const a = await pendingOnFailed();
    const ok = await decide(company.ceo.token, a.id, 'approve', { version: a.res.body.version });
    expect(ok.status).toBe(200);
    expect(await byId(a.id)).toMatchObject({
      status: 'live',
      external_sku_id: a.r.externalSkuId,
      external_product_id: a.r.externalProductId,
      seller_sku: a.r.sellerSku,
      platform_stock: 3,
      push_error: null,
      pending_external_sku_id: null,
      pending_requested_by: null,
      content_source: 'platform',
    });
    const b = await pendingOnFailed();
    const no = await decide(company.ceo.token, b.id, 'reject', { version: b.res.body.version, reason: 'Sai SKU' });
    expect(no.status).toBe(200);
    expect(await byId(b.id)).toMatchObject({ status: 'push_failed', external_sku_id: null, pending_external_sku_id: null, pending_requested_by: null });
  });

  it('CEO ghép khác SKU người bán đã có đơn → 200 áp luôn, tự duyệt', async () => {
    const r = newRemote();
    const v = newVariant();
    const old = `CU-${randomUUID().slice(0, 6)}`;
    const id = await failedRow(v.id, old);
    await orderWith(old);
    const res = await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: v.id });
    expect(res.status).toBe(200);
    expect(await byId(id)).toMatchObject({ status: 'live', external_sku_id: r.externalSkuId, mapping_self_approved: true });
  });

  it('AC-2: listing kia đã có mã sàn → 422 câu cũ; AC-3: listing đang đẩy → 409 `invalid_transition`', async () => {
    const { v } = await mapped();
    const taken = await match(sale.token, { externalSkuId: newRemote().externalSkuId, variantId: v.id });
    expect(taken.status).toBe(422);
    expect(taken.body.errors.variantId).toBe('Biến thể đã ghép SKU sàn khác của gian hàng này');
    const v2 = newVariant();
    await failedRow(v2.id, `PU-${randomUUID().slice(0, 6)}`, 'pushing');
    const busy = await match(sale.token, { externalSkuId: newRemote().externalSkuId, variantId: v2.id });
    expect(busy.status).toBe(409);
    expect(busy.body.type).toMatch(/invalid_transition$/);
  });

  it('Đổi ghép SKU sàn đã có listing sang biến thể có listing lỗi → listing lỗi tự gỡ, ghép áp luôn', async () => {
    const { r } = await mapped();
    const x = newVariant();
    const id = await failedRow(x.id, x.sku);
    const res = await match(admin.token, { externalSkuId: r.externalSkuId, variantId: x.id });
    expect(res.status).toBe(200);
    expect(await byId(id)).toMatchObject({ status: 'delisted' });
    expect((await transitionsOf(id)).at(-1)).toMatchObject({ action: 'delist', reason: 'Thay bằng ghép SKU sàn có sẵn' });
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: x.id });
  });

  it('Đổi ghép đó cần CEO: Sale → 202, listing lỗi giữ tới lúc CEO duyệt rồi mới tự gỡ', async () => {
    const { r } = await mapped();
    await orderWith(r.sellerSku);
    const x = newVariant();
    const id = await failedRow(x.id, x.sku);
    const res = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: x.id });
    expect(res.status).toBe(202);
    expect(await byId(id)).toMatchObject({ status: 'push_failed' });
    const ok = await decide(company.ceo.token, res.body.id, 'approve', { version: res.body.version });
    expect(ok.status).toBe(200);
    expect(await byId(id)).toMatchObject({ status: 'delisted' });
    expect(await rowOf(r.externalSkuId)).toMatchObject({ variant_id: x.id });
  });

  it('Listing lỗi đang chờ duyệt SKU sàn khác: ghép SKU sàn khác vào biến thể đó → 409 `mapping_pending`', async () => {
    const { v } = await pendingOnFailed();
    const res = await match(admin.token, { externalSkuId: newRemote().externalSkuId, variantId: v.id });
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/mapping_pending$/);
  });

  it('AC-6: listing lỗi chuyển sang đang đẩy giữa lúc đọc và lúc ghi → 409 `invalid_transition`, không ghi', async () => {
    const r = newRemote();
    const v = newVariant();
    const id = await failedRow(v.id, r.sellerSku);
    await reload();
    dirty = false;
    const res = await raceBehindLock(
      async (holder) => {
        await holder.query('select id from channel.shops where id = $1 for share', [shopId]);
        await holder.query("update channel.listings set status = 'pushing', push_error = null, version = version + 1 where id = $1", [id]);
      },
      1,
      () => match(sale.token, { externalSkuId: r.externalSkuId, variantId: v.id }).then((x) => x),
    );
    expect(res.status).toBe(409);
    expect(await byId(id)).toMatchObject({ status: 'pushing', external_sku_id: null });
  });
});
