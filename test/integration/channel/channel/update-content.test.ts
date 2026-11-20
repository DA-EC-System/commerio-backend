// Sửa nội dung listing đang bán (#293, Documents/21 §18.3, ca C2-24…C2-30): route `update-content` với adapter giả.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import {
  type ContentRevision,
  type ContentUpdate,
  MarketplaceError,
  type MarketplaceAdapter,
} from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter, seedSpecs } from './helpers.ts';

const variants: ListingVariant[] = [];
const variant = (): ListingVariant => {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Áo thun',
    sku: `CMR-${randomUUID().slice(0, 8)}`,
    attributesLabel: 'Đen / M',
    productCode: 'SP-TEST',
    attributes: [],
    archived: false,
    businessStatus: 'selling',
    description: 'Áo cotton bản mới',
    weightG: 250,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 15,
  };
  variants.push(v);
  return v;
};
setProductPort({
  variants: async (ids?: readonly string[]) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(150000)])),
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
});

let onContent: (productId: string, c: ContentUpdate) => Promise<{ underReview: boolean }>;
const updateContent = vi.fn((_t: string, productId: string, c: ContentUpdate) => onContent(productId, c));
/** Bản sửa trên sàn theo mã sản phẩm sàn; không có thì đang duyệt. Giá trị `Error` thì ném. */
const revisions = new Map<string, ContentRevision | Error>();
const contentRevision = vi.fn(async (_t: string, productId: string): Promise<ContentRevision> => {
  const r = revisions.get(productId) ?? { state: 'auditing' };
  if (r instanceof Error) throw r;
  return r;
});
const adapter: MarketplaceAdapter = fakeAdapter({
  async getSeller(accessToken) {
    return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
  },
  updateContent,
  contentRevision,
  getSkus: async () => [],
});
registerAdapter('lazada', adapter);
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;

/** Spec sàn của mọi sản phẩm giả (#400 lát 15, thay ghép danh mục cũ); sản phẩm đã có thì giữ. */
const seed = () => seedSpecs(company.companyId, 'lazada', '14275', variants, { brand: 'No Brand' });
const auth = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);
const edit = (listingId: string, version: number, token?: string) =>
  auth(app().post(`/api/v1/channel/shops/${shopId}/listings/${listingId}/update-content`), token).send({ version });

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
});

beforeEach(() => {
  updateContent.mockClear();
  onContent = async () => ({ underReview: false });
});

/** Listing `live` của biến thể mới (hoặc `cols` ghi đè, tên cột SQL). */
async function listing(cols: Record<string, unknown> = {}) {
  const v = variant();
  await seed();
  const all = {
    company_id: company.companyId,
    shop_id: shopId,
    variant_id: v.id,
    seller_sku: v.sku,
    status: 'live',
    // Listing do app tạo (cột mặc định `platform`, #399); ca sản phẩm người bán ghi đè.
    content_source: 'app',
    external_product_id: `P-${randomUUID().slice(0, 8)}`,
    external_sku_id: `S-${randomUUID().slice(0, 8)}`,
    ...cols,
  };
  const keys = Object.keys(all);
  const { rows } = await testPool().query<{ id: string; version: number }>(
    `insert into channel.listings (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id, version`,
    Object.values(all),
  );
  return { v, ...rows[0]! };
}

const row = async (id: string) =>
  (
    await testPool().query(
      'select status, version, revision_status, revision_reject_reason, revision_at from channel.listings where id = $1',
      [id],
    )
  ).rows[0];
const history = async (id: string) =>
  (
    await testPool().query<{ from: string; to: string; action: string; actor_id: string | null }>(
      `select from_state as "from", to_state as "to", action, actor_id from core.state_transitions
        where entity_type = 'listings' and entity_id = $1 order by id`,
      [id],
    )
  ).rows;

describe('POST /channel/shops/:id/listings/:listingId/update-content (#293)', () => {
  it('review R3: listing `content_source = platform` → 409 `invalid_transition` kèm `current`, không gọi sàn, không đổi listing', async () => {
    const { id, version } = await listing({ content_source: 'platform' });
    const res = await edit(id, version);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/invalid_transition$/);
    expect(res.body.detail ?? res.body.message).toContain('CEO dùng Ghi nội dung Commerio lên sàn');
    expect(res.body.current).toMatchObject({ id, status: 'live', contentSource: 'platform' });
    expect(updateContent).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: 'live', version, revision_status: null });
  });

  it('C2-24: sàn vẫn bán bản cũ → giữ live, bản sửa auditing; nội dung dựng từ catalog; lịch sử live → live', async () => {
    const { id, version, v } = await listing();
    const res = await edit(id, version);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'live', pendingRevision: { status: 'auditing', rejectReason: null } });
    expect(updateContent.mock.calls[0]![2]).toMatchObject({
      externalCategoryId: '14275',
      name: 'Áo thun - Đen / M',
      description: 'Áo cotton bản mới',
      attributes: { brand: 'No Brand' },
      responsible: { name: expect.any(String) },
    });
    const listed = await auth(app().get(`/api/v1/channel/shops/${shopId}/listings`));
    const mine = listed.body.items.find((i: { variantId: string }) => i.variantId === v.id);
    expect(mine.listing.pendingRevision).toMatchObject({ status: 'auditing', rejectReason: null, at: expect.any(String) });
    expect(await history(id)).toEqual([{ from: 'live', to: 'live', action: 'update_content', actor_id: expect.any(String) }]);
  });

  it('C2-25: sàn ngừng bán để duyệt → under_review qua request_review, không có bản sửa', async () => {
    onContent = async () => ({ underReview: true });
    const { id, version } = await listing();
    const res = await edit(id, version);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'under_review', pendingRevision: null });
    expect(await row(id)).toMatchObject({ status: 'under_review', revision_status: null });
    expect((await history(id)).map((h) => [h.from, h.to, h.action, h.actor_id === null])).toEqual([
      ['live', 'live', 'update_content', false],
      ['live', 'under_review', 'request_review', true],
    ]);
  });

  it('C2-28: bản sửa đã trượt, gọi lại → auditing, lý do xoá, at mới', async () => {
    const { id, version } = await listing({ revision_status: 'failed', revision_reject_reason: 'Ảnh mờ', revision_at: new Date('2026-01-01') });
    const res = await edit(id, version);
    expect(res.body.pendingRevision).toMatchObject({ status: 'auditing', rejectReason: null });
    expect((await row(id)).revision_at.getFullYear()).toBeGreaterThan(2026 - 1);
  });

  it('ghi sau khi sàn nhận không so version: đồng bộ tồn tăng version giữa chừng vẫn ghi bản sửa', async () => {
    const { id, version } = await listing();
    onContent = async () => {
      await testPool().query('update channel.listings set version = version + 1 where id = $1', [id]);
      return { underReview: false };
    };
    expect((await edit(id, version)).status).toBe(200);
    expect((await row(id)).revision_status).toBe('auditing');
  });

  it('C2-30: listing có bản sửa bị gỡ → ba cột bản sửa null', async () => {
    const { id, v } = await listing({ revision_status: 'auditing', revision_at: new Date() });
    const deactivate = vi.spyOn(adapter, 'deactivate').mockResolvedValue(undefined);
    const { version } = await row(id);
    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/${v.id}/delist`)).send({ version });
    deactivate.mockRestore();
    expect(res.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'delisted', revision_status: null, revision_reject_reason: null, revision_at: null });
  });

  it('C2-X07, C2-X08: under_review, hidden → 409 invalid_transition, không gọi sàn', async () => {
    for (const status of ['under_review', 'hidden']) {
      const { id, version } = await listing({ status });
      const res = await edit(id, version);
      expect(res.status).toBe(409);
      expect(res.body.type).toBe('/problems/invalid_transition');
    }
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('version cũ → 409 version_conflict kèm current; Sale → 403 (C2-24q); listing gian hàng khác → 404', async () => {
    const { id, version } = await listing();
    const stale = await edit(id, version + 5);
    expect(stale.status).toBe(409);
    expect(stale.body.type).toBe('/problems/version_conflict');
    expect(stale.body.current).toMatchObject({ id, status: 'live' });
    const sale = await addMember(company.companyId, 'sale');
    expect((await edit(id, version, sale.token)).status).toBe(403);
    const other = await createCompany({ optionalModules: ['channel'] });
    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/${id}/update-content`), other.ceo.token).send({ version });
    expect(res.status).toBe(404);
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('C2-24g: không quản tồn → 409 listing_unmanaged; sàn báo sản phẩm nhiều SKU → 409 shared_remote_product', async () => {
    const ceoId = (await testPool().query('select id from core.accounts where email = $1', [company.ceo.email])).rows[0].id;
    const unmanaged = await listing({ variant_id: null, mode: 'unmanaged', approved_by: ceoId });
    expect((await edit(unmanaged.id, unmanaged.version)).body.type).toBe('/problems/listing_unmanaged');
    onContent = async () => {
      throw new MarketplaceError('rejected', 'shared_remote_product', 'Sản phẩm trên sàn có nhiều SKU');
    };
    const b = await listing();
    const res = await edit(b.id, b.version);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/shared_remote_product');
    expect((await row(b.id)).revision_status).toBeNull();
  });

  it('sàn từ chối → 409 marketplace_rejected kèm câu sàn, listing không đổi; sàn chưa hỗ trợ → 422 marketplace_unsupported', async () => {
    onContent = async () => {
      throw new MarketplaceError('rejected', 'category_mismatch', 'Sản phẩm trên sàn ở danh mục khác');
    };
    const { id, version } = await listing();
    const res = await edit(id, version);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/marketplace_rejected');
    expect(await row(id)).toMatchObject({ status: 'live', version, revision_status: null });

    const saved = adapter.updateContent;
    delete adapter.updateContent;
    try {
      const unsupported = await edit(id, version);
      expect(unsupported.status).toBe(422);
      expect(unsupported.body.type).toBe('/problems/marketplace_unsupported');
    } finally {
      adapter.updateContent = saved;
    }
  });
});

describe('đồng bộ đọc bản sửa đang duyệt (#293)', () => {
  const productOf = async (id: string) =>
    (await testPool().query<{ external_product_id: string }>('select external_product_id from channel.listings where id = $1', [id])).rows[0]!
      .external_product_id;
  const auditing = (status = 'live') => listing({ status, revision_status: 'auditing', revision_at: new Date('2026-11-17T01:00:00Z') });

  it('C2-26, C2-27, C2-29: qua duyệt xoá; trượt ghi failed kèm lý do (không lý do thì câu mặc định); đang duyệt hay đang ẩn thì giữ', async () => {
    const approved = await auditing();
    const failed = await auditing();
    const silent = await auditing();
    const waiting = await auditing();
    const hidden = await auditing('hidden');
    revisions.set(await productOf(approved.id), { state: 'approved' });
    revisions.set(await productOf(failed.id), { state: 'failed', reason: 'Mô tả có từ cấm' });
    revisions.set(await productOf(silent.id), { state: 'failed', reason: null });
    await syncListings({ variants: async () => [], standardPrices: async () => new Map(), productImageUrls: async () => new Map(), availableOf: async () => new Map() }, company.companyId, shopId);
    expect(await row(approved.id)).toMatchObject({ status: 'live', revision_status: null, revision_at: null });
    expect(await row(failed.id)).toMatchObject({ revision_status: 'failed', revision_reject_reason: 'Mô tả có từ cấm' });
    expect((await row(silent.id)).revision_reject_reason).toBe('Sàn từ chối, không ghi lý do');
    expect(await row(waiting.id)).toMatchObject({ revision_status: 'auditing' });
    expect(await row(hidden.id)).toMatchObject({ status: 'hidden', revision_status: 'auditing' });
    expect(contentRevision.mock.calls.map((c) => c[1])).toContain(await productOf(hidden.id));
  });

  it('mất uỷ quyền khi đọc bản sửa → ném marketplace_unauthorized (việc nền giữ việc, báo kết nối lại)', async () => {
    const lost = await auditing();
    revisions.set(await productOf(lost.id), new MarketplaceError('unauthorized', '105002', 'token hết hạn'));
    await expect(
      syncListings({ variants: async () => [], standardPrices: async () => new Map(), productImageUrls: async () => new Map(), availableOf: async () => new Map() }, company.companyId, shopId),
    ).rejects.toMatchObject({ code: 'marketplace_unauthorized' });
    revisions.delete(await productOf(lost.id));
    await testPool().query('update channel.listings set revision_status = null, revision_at = null where id = $1', [lost.id]);
  });

  it('lỗi đọc bản sửa của một listing không làm hỏng lượt đồng bộ: listing khác vẫn cập nhật, listing lỗi giữ auditing', async () => {
    const broken = await auditing();
    const ok = await auditing();
    revisions.set(await productOf(broken.id), new MarketplaceError('unavailable', '500', 'Sàn lỗi'));
    revisions.set(await productOf(ok.id), { state: 'approved' });
    await expect(
      syncListings({ variants: async () => [], standardPrices: async () => new Map(), productImageUrls: async () => new Map(), availableOf: async () => new Map() }, company.companyId, shopId),
    ).resolves.toBeDefined();
    expect((await row(broken.id)).revision_status).toBe('auditing');
    expect((await row(ok.id)).revision_status).toBeNull();
  });
});

