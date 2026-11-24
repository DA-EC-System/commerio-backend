// Ghi nội dung Commerio lên sản phẩm người bán đã ghép (#399): route `take-over-content` với adapter giả, rồi chạy việc
// `channel.listing_push` mà route xếp.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { ChannelListing } from '#src/modules/channel/channel/api/schemas.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import { MarketplaceError, type NewProduct } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import type { ListingPushJob } from '#src/modules/channel/channel/service/shop-jobs.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter, seedSpecs } from './helpers.ts';

const variants: ListingVariant[] = [];
const variant = (): ListingVariant => {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Áo thun basic',
    sku: `CMR-${randomUUID().slice(0, 8)}`,
    attributesLabel: 'Đen / M',
    productCode: 'SP-TEST',
    groupId: 'GROUP-TEST',
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
const port = {
  variants: async (ids?: readonly string[]) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(150000)])),
  productImageUrls: async (productIds: readonly string[]) => new Map(productIds.map((id) => [id, [`https://img.test/${id}.png`]])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
};
setProductPort(port);

let onUpdate: () => Promise<{ live: boolean }>;
const updateProduct = vi.fn((_t: string, _p: string, _s: string, _product: NewProduct) => onUpdate());
const uploadImage = vi.fn(async (_t: string, url: string) => `https://slatic.test/${encodeURIComponent(url)}`);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    updateProduct,
    uploadImage,
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

/** Spec sàn của mọi sản phẩm giả (#400 lát 15, thay ghép danh mục cũ); sản phẩm đã có thì giữ. */
const seed = () => seedSpecs(company.companyId, 'lazada', '14275', variants, { brand: 'No Brand' });
let ceoId: string;
const auth = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);
const takeOver = (listingId: string, version: number, token?: string, shop = shopId) =>
  auth(app().post(`/api/v1/channel/shops/${shop}/listings/${listingId}/take-over-content`), token).send({ version });

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  ceoId = (await testPool().query<{ id: string }>('select id from core.accounts where email = $1', [company.ceo.email])).rows[0]!.id;
});

beforeEach(() => {
  updateProduct.mockClear();
  uploadImage.mockClear();
  onUpdate = async () => ({ live: true });
});

/** Listing ghép (`platform`) `live` của biến thể mới; `cols` ghi đè (tên cột SQL). */
async function matched(cols: Record<string, unknown> = {}) {
  const v = variant();
  await seed();
  const tag = randomUUID().slice(0, 8);
  const all = {
    company_id: company.companyId,
    shop_id: shopId,
    variant_id: v.id,
    seller_sku: `NB-${tag}`,
    status: 'live',
    external_product_id: `P-${tag}`,
    external_sku_id: `S-${tag}`,
    content_source: 'platform',
    ...cols,
  };
  const keys = Object.keys(all);
  const { rows } = await testPool().query<{ id: string; version: number; external_product_id: string }>(
    `insert into channel.listings (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id, version, external_product_id`,
    Object.values(all),
  );
  return { v, ...rows[0]! };
}

const row = async (id: string) =>
  (await testPool().query('select status, content_source, push_error, hidden_by, version from channel.listings where id = $1', [id])).rows[0];
const jobOf = async (listingId: string) =>
  (
    await testPool().query<{ data: ListingPushJob }>(
      "select data from pgboss.job where name = 'channel.listing_push' and data->>'listingId' = $1",
      [listingId],
    )
  ).rows.map((r) => r.data);

describe('take-over-content (#399)', () => {
  it('AC-4: CEO → 202, listing `pushing` xếp việc ghi nội dung; việc chạy xong gọi updateProduct, listing thành `app`', async () => {
    const l = await matched();
    const res = await takeOver(l.id, l.version);
    expect(res.status).toBe(202);
    expect(ChannelListing.parse(res.body)).toMatchObject({ id: l.id, status: 'pushing', contentSource: 'platform' });
    const [job] = await jobOf(l.id);
    expect(job).toMatchObject({ shopId, listingId: l.id, takeOver: true, imageUrls: [expect.stringContaining('https://img.test/')] });
    const history = await testPool().query(
      "select from_state, to_state, action, actor_id from core.state_transitions where entity_type = 'listings' and entity_id = $1",
      [l.id],
    );
    expect(history.rows).toEqual([{ from_state: 'live', to_state: 'pushing', action: 'take_over_content', actor_id: ceoId }]);
    const audit = await testPool().query(
      "select action, actor_id, after from core.audit_logs where entity_type = 'channel.listings' and entity_id = $1",
      [l.id],
    );
    expect(audit.rows).toEqual([{ action: 'update', actor_id: ceoId, after: expect.objectContaining({ action: 'take_over_content', contentSource: 'app' }) }]);

    await runListingPush(port, job!);
    expect(updateProduct).toHaveBeenCalledTimes(1);
    expect(updateProduct.mock.calls[0]!.slice(1, 3)).toEqual([l.external_product_id, l.external_product_id.replace('P-', 'S-')]);
    expect(updateProduct.mock.calls[0]![3]).toMatchObject({ name: 'Áo thun basic - Đen / M' });
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(await row(l.id)).toMatchObject({ status: 'live', content_source: 'app', push_error: null });
  });

  it('listing `hidden` → 409 `invalid_transition` (updateProduct bật SKU trên sàn): hiện lại listing trước', async () => {
    const l = await matched({ status: 'hidden', hidden_by: 'platform' });
    const res = await takeOver(l.id, l.version);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/invalid_transition$/);
    expect(res.body.detail ?? res.body.message).toContain('Hiện lại listing trước khi ghi nội dung Commerio lên sàn');
    expect(await jobOf(l.id)).toEqual([]);
    expect(await row(l.id)).toMatchObject({ status: 'hidden', hidden_by: 'platform' });
  });

  it('AC-4: sàn từ chối khi ghi, listing xuất phát từ `push_failed` → `push_failed` kèm `pushError`, giữ `platform`', async () => {
    const l = await matched({ status: 'push_failed' });
    expect((await takeOver(l.id, l.version)).status).toBe(202);
    onUpdate = async () => {
      throw new MarketplaceError('rejected', '4155', 'Sản phẩm đang bị khoá sửa');
    };
    await runListingPush(port, (await jobOf(l.id))[0]!);
    expect(await row(l.id)).toMatchObject({
      status: 'push_failed',
      content_source: 'platform',
      push_error: { code: 'marketplace_rejected', platformMessage: 'Sản phẩm đang bị khoá sửa' },
    });
  });

  it('review R2: sàn từ chối khi ghi, listing xuất phát từ `live` → về `live`, giữ `pushError`, `platform`, tồn, giá `pending`', async () => {
    const l = await matched({ stock_sync: 'synced', price_sync: 'synced' });
    expect((await takeOver(l.id, l.version)).status).toBe(202);
    onUpdate = async () => {
      throw new MarketplaceError('rejected', '4155', 'Sản phẩm đang bị khoá sửa');
    };
    await runListingPush(port, (await jobOf(l.id))[0]!);
    const after = await testPool().query('select status, content_source, push_error, stock_sync, price_sync from channel.listings where id = $1', [l.id]);
    expect(after.rows[0]).toMatchObject({
      status: 'live',
      content_source: 'platform',
      push_error: { code: 'marketplace_rejected', platformMessage: 'Sản phẩm đang bị khoá sửa' },
      stock_sync: 'pending',
      price_sync: 'pending',
    });
    const history = await testPool().query(
      "select from_state, to_state, action, actor_id from core.state_transitions where entity_type = 'listings' and entity_id = $1 order by id",
      [l.id],
    );
    expect(history.rows.map((r) => r.action)).toEqual(['take_over_content', 'take_over_failed']);
    expect(history.rows[1]).toMatchObject({ from_state: 'pushing', to_state: 'live', actor_id: null });
  });

  it('review R2: quá 30 phút chưa có kết quả, listing xuất phát từ `live` → về `live` kèm `pushError`', async () => {
    const l = await matched();
    expect((await takeOver(l.id, l.version)).status).toBe(202);
    await testPool().query("update channel.listings set push_started_at = now() - interval '31 minutes' where id = $1", [l.id]);
    await runListingPush(port, (await jobOf(l.id))[0]!);
    expect(updateProduct).not.toHaveBeenCalled();
    expect(await row(l.id)).toMatchObject({ status: 'live', content_source: 'platform', push_error: { code: 'marketplace_unavailable' } });
  });

  it('AC-4: Admin, Sale 403 (chỉ CEO); Kho 403 (thiếu quyền), không xếp việc', async () => {
    const l = await matched();
    for (const role of ['admin', 'sale', 'warehouse'] as const) {
      const member = await addMember(company.companyId, role);
      const res = await takeOver(l.id, l.version, member.token);
      expect(res.status).toBe(403);
    }
    expect(await jobOf(l.id)).toEqual([]);
    expect(await row(l.id)).toMatchObject({ status: 'live', content_source: 'platform' });
  });

  it('AC-4: `version` cũ → 409 `version_conflict` kèm `current`', async () => {
    const l = await matched();
    const res = await takeOver(l.id, l.version + 5);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/version_conflict$/);
    expect(res.body.current).toMatchObject({ id: l.id, contentSource: 'platform' });
  });

  it('AC-4: listing `app`, listing đang đẩy, chưa có mã sàn → 409 `invalid_transition` kèm `current`', async () => {
    for (const cols of [{ content_source: 'app' }, { status: 'pushing', push_started_at: new Date() }, { status: 'push_failed', external_product_id: null, external_sku_id: null }]) {
      const l = await matched(cols);
      const res = await takeOver(l.id, l.version);
      expect(res.status).toBe(409);
      expect(res.body.type).toMatch(/invalid_transition$/);
      expect(res.body.current).toMatchObject({ id: l.id });
    }
  });

  it('listing chờ CEO quyết thay đổi ngoài app → 409 `invalid_transition`; chờ duyệt ghép → 409 `mapping_pending`', async () => {
    const outside = await matched({ status: 'hidden', hidden_by: 'platform', outside_change_kind: 'disabled', outside_change_at: new Date() });
    const a = await takeOver(outside.id, outside.version);
    expect(a.status).toBe(409);
    expect(a.body.type).toMatch(/invalid_transition$/);
    const pending = await matched({ pending_mode: 'unmanaged', pending_requested_by: ceoId, pending_requested_at: new Date() });
    const b = await takeOver(pending.id, pending.version);
    expect(b.status).toBe(409);
    expect(b.body.type).toMatch(/mapping_pending$/);
  });

  it('AC-4: sản phẩm trên sàn nhiều SKU (bản sao SKU sàn) → 409 `shared_remote_product` (như update-content), không xếp việc', async () => {
    const l = await matched();
    for (const sku of ['S-A', 'S-B']) {
      await testPool().query(
        `insert into channel.remote_skus (company_id, shop_id, external_product_id, external_sku_id, seller_sku, title, state, quantity)
         values ($1, $2, $3, $4, $4, 'Áo', 'live', 1)`,
        [company.companyId, shopId, l.external_product_id, `${sku}-${randomUUID().slice(0, 6)}`],
      );
    }
    const res = await takeOver(l.id, l.version);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/shared_remote_product$/);
    expect(await jobOf(l.id)).toEqual([]);
  });

  describe('kiểm gian hàng như `push` (review R4)', () => {
    const setShop = (set: string) => testPool().query(`update channel.shops set ${set} where id = $1`, [shopId]);
    const untouched = async (l: { id: string; version: number }) => {
      expect(await jobOf(l.id)).toEqual([]);
      expect(await row(l.id)).toMatchObject({ status: 'live', content_source: 'platform', version: l.version });
    };

    it('gian hàng `needs_reauth` → 409 `shop_not_active` kèm `current`, listing không đổi', async () => {
      const l = await matched();
      await setShop("status = 'needs_reauth'");
      try {
        const res = await takeOver(l.id, l.version);
        expect(res.status).toBe(409);
        expect(res.body.type).toMatch(/shop_not_active$/);
        expect(res.body.current).toBe('needs_reauth');
      } finally {
        await setShop("status = 'active'");
      }
      await untouched(l);
    });

    it('gian hàng `active` mà hết token → 409 `shop_not_connected`, listing không đổi', async () => {
      const l = await matched();
      const saved = (await testPool().query('select access_token_enc from channel.shops where id = $1', [shopId])).rows[0].access_token_enc;
      await setShop('access_token_enc = null');
      try {
        const res = await takeOver(l.id, l.version);
        expect(res.status).toBe(409);
        expect(res.body.type).toMatch(/shop_not_connected$/);
      } finally {
        await testPool().query('update channel.shops set access_token_enc = $2 where id = $1', [shopId, saved]);
      }
      await untouched(l);
    });

    it('gian hàng chờ phiếu kiểm kê đầu kỳ → 409 `shop_awaiting_stocktake`, listing không đổi', async () => {
      const l = await matched();
      await setShop("opening_stocktake_id = gen_random_uuid(), opening_stocktake_number = 'KK-0001'");
      try {
        const res = await takeOver(l.id, l.version);
        expect(res.status).toBe(409);
        expect(res.body.type).toMatch(/shop_awaiting_stocktake$/);
      } finally {
        await setShop('opening_stocktake_id = null, opening_stocktake_number = null');
      }
      await untouched(l);
    });
  });

  it('404: listing của công ty khác, mã sai dạng', async () => {
    const l = await matched();
    const other = await createCompany({ optionalModules: [] });
    const res = await takeOver(l.id, l.version, other.ceo.token);
    expect(res.status).toBe(404);
    expect((await takeOver('khong-phai-uuid', 1)).status).toBe(404);
  });

  it('422 khi thiếu `version`', async () => {
    const l = await matched();
    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/${l.id}/take-over-content`)).send({});
    expect(res.status).toBe(422);
  });
});
