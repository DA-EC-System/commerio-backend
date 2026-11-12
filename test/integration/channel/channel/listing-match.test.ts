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
import { withCompany } from '#src/shared/db/client.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
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
/** Đọc trọn lại bản sao SKU sàn của gian hàng (bỏ khoảng chờ giữa hai lần Tải lại). */
const reload = async (id = shopId) => {
  await testPool().query('update channel.shops set remote_skus_synced_at = null where id = $1', [id]);
  const res = await as(app().post(`/api/v1/channel/shops/${id}/remote-skus/refresh`), company.ceo.token);
  expect(res.status).toBe(200);
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
      `select 1 from core.audit_logs where entity_id = $1 and after @> '{"selfApproved": true}'::jsonb`,
      [listing.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('DoD: Sale ghép SKU sàn chưa ghép sang "không quản tồn" → 202; SKU vẫn tính là chưa ghép tới khi CEO duyệt', async () => {
    const r = newRemote();
    const res = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: null });
    expect(res.status).toBe(202);
    expect(res.body.pendingMapping).toMatchObject({ variantId: null, requestedBy: { id: sale.accountId } });
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
  it('Listing đổi giữa lúc ghép đọc và lúc ghi → 409 `version_conflict` có `current` là listing mới nhất', async () => {
    const { r, listing } = await mapped();
    const res = await raceBehindLock(
      async (holder) => {
        await holder.query('select id from channel.shops where id = $1 for share', [shopId]);
        await holder.query('update channel.listings set version = version + 1 where id = $1', [listing.id]);
      },
      1,
      () => match(admin.token, { externalSkuId: r.externalSkuId, variantId: newVariant().id }).then((x) => x),
    );
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/version_conflict$/);
    expect(ChannelListing.parse(res.body.current)).toMatchObject({ id: listing.id, version: listing.version + 1 });
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

  it('Lần mở đầu gọi sàn một lần rồi lưu; lần sau đọc bản sao, không gọi sàn; trả `syncedAt`', async () => {
    const id = await freshShop();
    const before = listSkusCalls;
    const first = await remoteSkusOf(id);
    expect(first.status).toBe(200);
    expect(listSkusCalls).toBe(before + 1);
    const second = await remoteSkusOf(id);
    expect(listSkusCalls).toBe(before + 1);
    const body = RemoteSkuList.parse(second.body);
    expect(body.syncedAt).toEqual(first.body.syncedAt);
    expect(body.syncedAt).not.toBeNull();
    expect(body.items.length).toBe(first.body.items.length);
  });

  it('Tải lại: đọc trọn, SKU đã mất trên sàn bị bỏ khỏi bản sao; bấm lại trong 60 giây thì không gọi sàn', async () => {
    const id = await freshShop();
    const r = newRemote();
    dirty = false;
    await remoteSkusOf(id);
    r.state = 'deleted';
    await testPool().query("update channel.shops set remote_skus_synced_at = now() - interval '2 minutes' where id = $1", [id]);
    const before = listSkusCalls;
    const res = await as(app().post(`/api/v1/channel/shops/${id}/remote-skus/refresh`), sale.token);
    expect(res.status).toBe(200);
    expect(listSkusCalls).toBe(before + 1);
    expect(RemoteSkuList.parse(res.body).items.some((i) => i.externalSkuId === r.externalSkuId)).toBe(false);
    await as(app().post(`/api/v1/channel/shops/${id}/remote-skus/refresh`), sale.token);
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
    await remoteSkusOf(id);
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
    await remoteSkusOf(id);
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
    await remoteSkusOf(id);
    await testPool().query("update channel.shops set remote_skus_changed_since = now() - interval '30 minutes' where id = $1", [id]);
    const before = listSkusCalls;
    changedSince.length = 0;
    await runListingSync(port, { companyId: company.companyId, shopId: id });
    expect(changedSince).toEqual([]);
    expect(listSkusCalls).toBe(before);
  });

  it('Review vòng 2 N1: lần đọc trọn ra rỗng trong khi lần trước có SKU thì không xoá bản sao; rỗng lần thứ hai liền mới xoá', async () => {
    const id = await freshShop();
    await remoteSkusOf(id);
    const count = async () => Number((await testPool().query('select count(*) from channel.remote_skus where shop_id = $1', [id])).rows[0].count);
    const had = await count();
    expect(had).toBeGreaterThan(0);
    const refresh = async () => {
      // Lùi cả đồng hồ của bản sao 2 phút, như thể lần đọc trước đã qua khoảng chờ 60 giây.
      await testPool().query("update channel.shops set remote_skus_synced_at = remote_skus_synced_at - interval '2 minutes' where id = $1", [id]);
      await testPool().query("update channel.remote_skus set seen_at = seen_at - interval '2 minutes' where shop_id = $1", [id]);
      return as(app().post(`/api/v1/channel/shops/${id}/remote-skus/refresh`), sale.token);
    };
    listSkusEmpty = true;
    try {
      expect((await refresh()).status).toBe(200);
      expect(await count()).toBe(had);
      expect((await refresh()).status).toBe(200);
      expect(await count()).toBe(0);
    } finally {
      listSkusEmpty = false;
    }
  });

  it('Review vòng 2 N3: SKU về thiếu nhãn biến thể thì giữ tiêu đề cũ trong bản sao, vẫn cập nhật tồn, trạng thái', async () => {
    const id = await freshShop();
    const r = newRemote({ title: 'Áo - Trắng, M' });
    dirty = false;
    await remoteSkusOf(id);
    await testPool().query("update channel.shops set remote_skus_changed_since = now() - interval '70 minutes' where id = $1", [id]);
    changedResult = [{ ...r, title: `Áo - ${r.sellerSku}`, labelMissing: true, quantity: 9, state: 'inactive' }];
    await runListingSync(port, { companyId: company.companyId, shopId: id });
    const { rows } = await testPool().query('select title, quantity, state from channel.remote_skus where shop_id = $1 and external_sku_id = $2', [id, r.externalSkuId]);
    expect(rows[0]).toEqual({ title: 'Áo - Trắng, M', quantity: 9, state: 'inactive' });
  });

  it('Lần đọc trọn đã quá 24 giờ thì lượt định kỳ đọc trọn thay vì đọc theo giờ sửa', async () => {
    const id = await freshShop();
    await remoteSkusOf(id);
    await testPool().query("update channel.shops set remote_skus_synced_at = now() - interval '25 hours' where id = $1", [id]);
    const before = listSkusCalls;
    changedSince.length = 0;
    await runListingSync(port, { companyId: company.companyId, shopId: id });
    expect(listSkusCalls).toBe(before + 1);
    expect(changedSince).toEqual([]);
  });
});
