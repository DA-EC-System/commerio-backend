// Bản nháp thiết lập (#569 PR C; Documents/21 §18.7.5, §18.12): PUT /setup/draft, sku-links của gian hàng `connecting`,
// GET /setup (draft, draftVersion), POST /setup { draftVersion }, vòng đời nháp. Mỗi ca một công ty riêng.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import type { RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const variant = (sku: string, name: string, archived = false): ListingVariant => ({
  id: randomUUID(),
  productId: randomUUID(),
  productName: name,
  sku,
  attributesLabel: '',
  productCode: 'SP-TEST',
  groupId: 'GROUP-TEST',
  attributes: [],
  archived,
  businessStatus: 'selling',
  description: null,
  weightG: 200,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 10,
});
const v1 = variant('DR-1', 'Áo thun');
const v2 = variant('DR-2', 'Quần jean');
const vArchived = variant('DR-OLD', 'Mũ cũ', true);
const BAD_GROUP = '00000000-0000-4000-8000-00000000dead';
const GOOD_GROUP = '00000000-0000-4000-8000-00000000beef';

setProductPort({
  variants: async (ids) => [v1, v2, vArchived].filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 9])),
  // Chỉ để kiểm danh mục sản phẩm hợp lệ (danh sách sản phẩm rỗng): nhóm `BAD_GROUP` bị từ chối.
  createFromPlatform: (async (_ctx: unknown, groupId: string) =>
    groupId === BAD_GROUP
      ? { ok: false, groupError: 'Danh mục sản phẩm không hợp lệ', errors: new Map(), variantIds: new Map() }
      : { ok: true, groupError: null, errors: new Map(), variantIds: new Map() }) as never,
});

const sku = (externalSkuId: string, externalProductId: string, sellerSku: string, title: string): RemoteSku => ({
  externalProductId,
  externalSkuId,
  sellerSku,
  title,
  state: 'live',
  rejectReason: null,
  quantity: 4,
});
let remote: RemoteSku[] = [];
const resetRemote = () => {
  remote = [
    sku('sku-1', 'item-A', 'DR-1', 'Áo thun trắng'),
    sku('sku-2', 'item-A', 'DR-2', 'Quần jean xanh'),
    sku('sku-3', 'item-B', 'LZ-3', 'Mũ lưỡi trai'),
    sku('sku-4', 'item-C', 'LZ-4', 'Bình giữ nhiệt'),
  ];
};
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    getSkus: async (_t, sellerSkus) => remote.filter((r) => sellerSkus.includes(r.sellerSku)),
    listSkus: async () => remote,
    updatePriceQuantity: async (_t, items) => items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true as const })),
  }),
);
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

/** Gian hàng `connecting` của công ty đã có gian hàng xong thiết lập; `GET /setup` đã đọc sàn nên bản sao SKU có đủ. */
async function connectingShop() {
  resetRemote();
  const c = await createCompany({ optionalModules: [] });
  await testPool().query(
    "insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at) values ($1, 'lazada', $2, 'Cũ', 'active', now())",
    [c.companyId, randomUUID()],
  );
  const auth = (r: request.Test, token = c.ceo.token) => r.set('Authorization', `Bearer ${token}`);
  const res = await auth(request(testApp()).post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  const shopId = res.body.shop.id as string;
  const base = `/api/v1/channel/shops/${shopId}`;
  const api = {
    c,
    shopId,
    preview: () => auth(request(testApp()).get(`${base}/setup`)),
    put: (body: object, token?: string) => auth(request(testApp()).put(`${base}/setup/draft`), token).send(body),
    links: (body: object, token?: string) => auth(request(testApp()).post(`${base}/sku-links`), token).send(body),
    finish: (body: object) => auth(request(testApp()).post(`${base}/setup`)).send(body),
  };
  await api.preview();
  return api;
}

const decideAll = (v: number) => ({
  draftVersion: v,
  items: [
    { externalSkuId: 'sku-1', action: 'link', variantId: v1.id },
    { externalSkuId: 'sku-2', action: 'unmanaged' },
    { externalSkuId: 'sku-3', action: 'create' },
    { externalSkuId: 'sku-4', action: 'skip' },
  ],
});
const draftRow = async (shopId: string) =>
  (await testPool().query('select setup_draft, setup_draft_version from channel.shops where id = $1', [shopId])).rows[0] as {
    setup_draft: { confirmed: Record<string, string | null>; decisions: unknown[]; createGroups: unknown[] } | null;
    setup_draft_version: number;
  };

describe('GET /setup: draft và draftVersion', () => {
  it('chưa có nháp thì draft null, draftVersion 0; có rồi thì trả nháp và số phiên bản', async () => {
    const s = await connectingShop();
    const first = await s.preview();
    expect(first.status).toBe(200);
    expect(first.body.draft).toBeNull();
    expect(first.body.draftVersion).toBe(0);
    const put = await s.put({ openingStock: 'push', returnWindowDays: 7, draftVersion: 0 });
    expect(put.status).toBe(200);
    expect(put.body.draftVersion).toBe(1);
    expect(put.body.draft).toMatchObject({ openingStock: 'push', returnWindowDays: 7, decisions: [], baseline: null });
    const again = await s.preview();
    expect(again.body.draftVersion).toBe(1);
    expect(again.body.draft).toMatchObject({ openingStock: 'push', returnWindowDays: 7, changed: null });
  });
});

describe('PUT /setup/draft: phiên bản và quyền', () => {
  it('sai draftVersion: 409 version_conflict kèm current { draft, draftVersion }; ghi lại đúng giá trị thì không tăng phiên bản', async () => {
    const s = await connectingShop();
    await s.put({ openingStock: 'push', draftVersion: 0 });
    const stale = await s.put({ openingStock: 'stocktake', draftVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(stale.body.current.draftVersion).toBe(1);
    expect(stale.body.current.draft.openingStock).toBe('push');
    const same = await s.put({ openingStock: 'push', draftVersion: 1 });
    expect(same.status).toBe(200);
    expect(same.body.draftVersion).toBe(1);
  });

  it('thiếu quyền thiết lập gian hàng: 403; thiếu draftVersion: 422', async () => {
    const s = await connectingShop();
    const warehouse = await addMember(s.c.companyId, 'warehouse');
    expect((await s.put({ openingStock: 'push', draftVersion: 0 }, warehouse.token)).status).toBe(403);
    expect((await s.links({ items: [], draftVersion: 0 }, warehouse.token)).status).toBe(403);
    const noVersion = await s.put({ openingStock: 'push' });
    expect(noVersion.status).toBe(422);
  });

  it('confirm sai thì 422 và không ghi gì (kể cả dữ liệu đi kèm)', async () => {
    const s = await connectingShop();
    const res = await s.put({ openingStock: 'push', confirm: 'link_skus', draftVersion: 0 });
    expect(res.status).toBe(422);
    expect(res.body.errors.decisions).toBeDefined();
    expect(res.body.externalSkuIds).toHaveLength(4);
    expect((await draftRow(s.shopId)).setup_draft_version).toBe(0);
  });
});

describe('POST sku-links của gian hàng connecting: ghi nháp', () => {
  it('thiếu draftVersion: 422; có thì ghi, dòng lỗi không ghi, dòng khác vẫn ghi', async () => {
    const s = await connectingShop();
    const missing = await s.links({ items: [{ externalSkuId: 'sku-1', action: 'skip' }] });
    expect(missing.status).toBe(422);
    expect(missing.body.errors.draftVersion).toBeDefined();
    const res = await s.links({
      draftVersion: 0,
      items: [
        { externalSkuId: 'sku-1', action: 'link', variantId: v1.id },
        { externalSkuId: 'sku-2', action: 'link', variantId: vArchived.id },
        { externalSkuId: 'sku-9', action: 'skip' },
        { externalSkuId: 'sku-4', action: 'skip' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.draftVersion).toBe(1);
    expect(res.body.results.map((r: { externalSkuId: string; result: string; code: string | null }) => [r.externalSkuId, r.result, r.code])).toEqual([
      ['sku-1', 'saved', null],
      ['sku-2', 'error', 'variant_archived'],
      ['sku-9', 'error', 'remote_sku_not_found'],
      ['sku-4', 'saved', null],
    ]);
    expect(res.body.draft.decisions).toEqual([
      { externalSkuId: 'sku-1', action: 'link', variantId: v1.id },
      { externalSkuId: 'sku-4', action: 'skip', variantId: null },
    ]);
  });

  it('hai SKU sàn chọn cùng một biến thể: dòng sau lỗi variant_taken; nhóm sai: 422 và không ghi gì', async () => {
    const s = await connectingShop();
    const res = await s.links({
      draftVersion: 0,
      items: [
        { externalSkuId: 'sku-1', action: 'link', variantId: v1.id },
        { externalSkuId: 'sku-2', action: 'link', variantId: v1.id },
      ],
    });
    expect(res.body.results[1]).toMatchObject({ result: 'error', code: 'variant_taken' });
    const bad = await s.links({
      draftVersion: 1,
      items: [{ externalSkuId: 'sku-3', action: 'create' }],
      groups: [{ externalProductId: 'item-B', groupId: BAD_GROUP }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors['groups.0.groupId']).toBeDefined();
    expect((await draftRow(s.shopId)).setup_draft_version).toBe(1);
  });

  it('gian hàng needs_reauth chưa thiết lập xong: 409 invalid_transition kèm current (cả PUT lẫn sku-links)', async () => {
    const s = await connectingShop();
    await testPool().query("update channel.shops set status = 'needs_reauth' where id = $1", [s.shopId]);
    const put = await s.put({ openingStock: 'push', draftVersion: 0 });
    expect(put.status).toBe(409);
    expect(put.body.code).toBe('invalid_transition');
    expect(put.body.current).toBe('needs_reauth');
    const links = await s.links({ draftVersion: 0, items: [{ externalSkuId: 'sku-1', action: 'skip' }] });
    expect(links.status).toBe(409);
    expect(links.body.code).toBe('invalid_transition');
    expect(links.body.current).toBe('needs_reauth');
  });

  it('gian hàng needs_reauth đã hoạt động rồi: vẫn 409 shop_not_connected', async () => {
    const s = await connectingShop();
    await testPool().query("update channel.shops set status = 'needs_reauth', order_cutoff_at = now() where id = $1", [s.shopId]);
    const links = await s.links({ items: [{ externalSkuId: 'sku-1', action: 'skip' }] });
    expect(links.status).toBe(409);
    expect(links.body.code).toBe('shop_not_connected');
  });
});

describe('xoá mốc xác nhận và dọn createGroups', () => {
  /** Ba bước đã xác nhận: bốn SKU có quyết định (một `create`), danh mục cho sản phẩm item-B, tồn `push`. */
  async function confirmedShop() {
    const s = await connectingShop();
    const decided = await s.links({ ...decideAll(0), groups: [{ externalProductId: 'item-B', groupId: GOOD_GROUP }] });
    expect(decided.status).toBe(200);
    const one = await s.put({ confirm: 'link_skus', draftVersion: decided.body.draftVersion });
    expect(one.status).toBe(200);
    const two = await s.put({ confirm: 'assign_groups', draftVersion: one.body.draftVersion });
    expect(two.status).toBe(200);
    const three = await s.put({ openingStock: 'push', returnWindowDays: 7, confirm: 'stock_sync', draftVersion: two.body.draftVersion });
    expect(three.status).toBe(200);
    expect(three.body.draft.confirmed).toEqual({ link_skus: expect.any(String), assign_groups: expect.any(String), stock_sync: expect.any(String) });
    expect(three.body.draft.baseline).toEqual(['sku-1', 'sku-2', 'sku-3', 'sku-4']);
    return { s, version: three.body.draftVersion as number };
  }

  it('đổi một dòng ở bước 3 thì cả ba mốc và baseline về null', async () => {
    const { s, version } = await confirmedShop();
    const res = await s.links({ draftVersion: version, items: [{ externalSkuId: 'sku-4', action: 'unmanaged' }] });
    expect(res.status).toBe(200);
    expect(res.body.draft.confirmed).toEqual({ link_skus: null, assign_groups: null, stock_sync: null });
    expect(res.body.draft.baseline).toBeNull();
  });

  it('chỉ đổi danh mục ở bước 4: link_skus giữ, assign_groups và stock_sync về null', async () => {
    const { s, version } = await confirmedShop();
    const res = await s.links({ draftVersion: version, groups: [{ externalProductId: 'item-B', groupId: randomUUID() }] });
    // Danh mục lạ hợp lệ với catalog giả; dữ liệu đổi nên mốc từ bước 4 về null.
    expect(res.status).toBe(200);
    expect(res.body.draft.confirmed.link_skus).toEqual(expect.any(String));
    expect(res.body.draft.confirmed.assign_groups).toBeNull();
    expect(res.body.draft.confirmed.stock_sync).toBeNull();
  });

  it('đổi dòng create cuối của sản phẩm sang skip thì nhóm của sản phẩm đó bị bỏ trong cùng lần ghi', async () => {
    const { s, version } = await confirmedShop();
    const res = await s.links({ draftVersion: version, items: [{ externalSkuId: 'sku-3', action: 'skip' }] });
    expect(res.body.draft.createGroups).toEqual([]);
  });

  it('xác nhận link_skus khi không có dòng create thì đặt luôn mốc assign_groups', async () => {
    const s = await connectingShop();
    const decided = await s.links({
      draftVersion: 0,
      items: ['sku-1', 'sku-2', 'sku-3', 'sku-4'].map((externalSkuId) => ({ externalSkuId, action: 'skip' })),
    });
    const res = await s.put({ confirm: 'link_skus', draftVersion: decided.body.draftVersion });
    expect(res.status).toBe(200);
    expect(res.body.draft.confirmed.link_skus).toEqual(expect.any(String));
    expect(res.body.draft.confirmed.assign_groups).toEqual(res.body.draft.confirmed.link_skus);
  });

  it('xác nhận assign_groups khi sản phẩm có dòng create chưa có danh mục: 422 kèm externalProductIds', async () => {
    const s = await connectingShop();
    const decided = await s.links({ draftVersion: 0, items: [{ externalSkuId: 'sku-3', action: 'create' }] });
    const res = await s.put({ confirm: 'assign_groups', draftVersion: decided.body.draftVersion });
    expect(res.status).toBe(422);
    expect(res.body.errors.createGroups).toBeDefined();
    expect(res.body.externalProductIds).toEqual(['item-B']);
  });
});

describe('SKU sàn đổi so với nháp (GET /setup đọc sàn)', () => {
  it('bỏ quyết định của SKU đã xoá khỏi sàn; baseline khác thì xoá mốc từ link_skus và draft.changed báo removed, added', async () => {
    const { s, version } = await (async () => {
      const shop = await connectingShop();
      const decided = await shop.links({
        draftVersion: 0,
        items: ['sku-1', 'sku-2', 'sku-3', 'sku-4'].map((externalSkuId) => ({ externalSkuId, action: 'skip' })),
      });
      const confirmed = await shop.put({ confirm: 'link_skus', draftVersion: decided.body.draftVersion });
      return { s: shop, version: confirmed.body.draftVersion as number };
    })();
    remote = [...remote.filter((r) => r.externalSkuId !== 'sku-4'), sku('sku-9', 'item-D', 'LZ-9', 'Ví da')];
    const res = await s.preview();
    expect(res.status).toBe(200);
    expect(res.body.draft.decisions.map((d: { externalSkuId: string }) => d.externalSkuId)).toEqual(['sku-1', 'sku-2', 'sku-3']);
    expect(res.body.draft.confirmed).toEqual({ link_skus: null, assign_groups: null, stock_sync: null });
    expect(res.body.draft.changed).toEqual({ removed: ['sku-4'], added: ['sku-9'] });
    expect(res.body.draftVersion).toBeGreaterThan(version);
  });

  it('chưa xác nhận link_skus (không có baseline): SKU đã xoá bị bỏ quyết định nhưng không xoá mốc nào', async () => {
    const s = await connectingShop();
    const put = await s.put({ openingStock: 'push', returnWindowDays: 7, draftVersion: 0 });
    const decided = await s.links({ draftVersion: put.body.draftVersion, items: [{ externalSkuId: 'sku-4', action: 'skip' }] });
    expect(decided.status).toBe(200);
    remote = remote.filter((r) => r.externalSkuId !== 'sku-4');
    const res = await s.preview();
    expect(res.body.draft.decisions).toEqual([]);
    expect(res.body.draft.openingStock).toBe('push');
    expect(res.body.draft.changed).toBeNull();
  });
});

describe('POST /setup { draftVersion }: hoàn tất từ nháp', () => {
  it('thiếu mốc: 409 setup_draft_incomplete kèm missing; không có nháp cũng vậy', async () => {
    const s = await connectingShop();
    const none = await s.finish({ draftVersion: 0 });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('setup_draft_incomplete');
    expect(none.body.missing).toEqual(['link_skus', 'assign_groups', 'stock_sync']);
    const decided = await s.links({
      draftVersion: 0,
      items: ['sku-1', 'sku-2', 'sku-3', 'sku-4'].map((externalSkuId) => ({ externalSkuId, action: 'skip' })),
    });
    const one = await s.put({ confirm: 'link_skus', draftVersion: decided.body.draftVersion });
    const part = await s.finish({ draftVersion: one.body.draftVersion });
    expect(part.status).toBe(409);
    expect(part.body.missing).toEqual(['stock_sync']);
  });

  it('sai draftVersion: 409 version_conflict kèm current', async () => {
    const s = await connectingShop();
    const decided = await s.links({
      draftVersion: 0,
      items: ['sku-1', 'sku-2', 'sku-3', 'sku-4'].map((externalSkuId) => ({ externalSkuId, action: 'skip' })),
    });
    const one = await s.put({ confirm: 'link_skus', draftVersion: decided.body.draftVersion });
    const three = await s.put({ openingStock: 'push', returnWindowDays: 7, confirm: 'stock_sync', draftVersion: one.body.draftVersion });
    const res = await s.finish({ draftVersion: three.body.draftVersion - 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('version_conflict');
    expect(res.body.current.draftVersion).toBe(three.body.draftVersion);
  });

  it('đủ ba mốc: tạo listing theo nháp (liên kết, không quản tồn), gian hàng active, nháp bị xoá', async () => {
    const s = await connectingShop();
    const decided = await s.links({
      draftVersion: 0,
      items: [
        { externalSkuId: 'sku-1', action: 'link', variantId: v1.id },
        { externalSkuId: 'sku-2', action: 'unmanaged' },
        { externalSkuId: 'sku-3', action: 'skip' },
        { externalSkuId: 'sku-4', action: 'skip' },
      ],
    });
    const one = await s.put({ confirm: 'link_skus', draftVersion: decided.body.draftVersion });
    const three = await s.put({ openingStock: 'push', returnWindowDays: 7, confirm: 'stock_sync', draftVersion: one.body.draftVersion });
    expect(three.status).toBe(200);
    const res = await s.finish({ draftVersion: three.body.draftVersion });
    expect(res.status).toBe(200);
    expect(res.body.shop.status).toBe('active');
    expect(res.body.matched).toBe(1);
    const listings = (
      await testPool().query(
        'select external_sku_id, variant_id, mode, status from channel.listings where shop_id = $1 order by external_sku_id',
        [s.shopId],
      )
    ).rows;
    expect(listings).toEqual([
      { external_sku_id: 'sku-1', variant_id: v1.id, mode: 'mapped', status: 'live' },
      { external_sku_id: 'sku-2', variant_id: null, mode: 'unmanaged', status: 'live' },
    ]);
    expect(await draftRow(s.shopId)).toEqual({ setup_draft: null, setup_draft_version: 0 });
  });
});

describe('vòng đời nháp', () => {
  it('ngắt gian hàng thì xoá nháp', async () => {
    const s = await connectingShop();
    const put = await s.put({ openingStock: 'push', draftVersion: 0 });
    expect(put.status).toBe(200);
    const shop = await request(testApp()).get(`/api/v1/channel/shops/${s.shopId}`).set('Authorization', `Bearer ${s.c.ceo.token}`);
    const out = await request(testApp())
      .post(`/api/v1/channel/shops/${s.shopId}/disconnect`)
      .set('Authorization', `Bearer ${s.c.ceo.token}`)
      .send({ version: shop.body.version });
    expect(out.status).toBe(200);
    expect(await draftRow(s.shopId)).toEqual({ setup_draft: null, setup_draft_version: 0 });
  });

  it('mất uỷ quyền rồi thiết lập tiếp (resume_setup) giữ nguyên nháp', async () => {
    const s = await connectingShop();
    const put = await s.put({ openingStock: 'push', returnWindowDays: 7, draftVersion: 0 });
    await testPool().query("update channel.shops set status = 'needs_reauth' where id = $1", [s.shopId]);
    expect((await draftRow(s.shopId)).setup_draft_version).toBe(put.body.draftVersion);
    await testPool().query("update channel.shops set status = 'connecting' where id = $1", [s.shopId]);
    const again = await s.put({ returnWindowDays: 14, draftVersion: put.body.draftVersion });
    expect(again.status).toBe(200);
    expect(again.body.draft.openingStock).toBe('push');
  });
});
