// Cấp kế của attribute cascade (#400, Documents/21 §18.5): gọi sàn bằng token gian hàng Lazada, `cascadeId` từ `raw` attribute
// đã lưu, `path` chuyển nguyên; không có gian hàng 409, sàn không có cascade 422, quyền `listing.manage`.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CascadeLevelSchema } from '#src/modules/channel/channel/api/schemas.ts';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { replaceLeaf } from '#src/modules/channel/channel/repository/platform-categories.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const app = testApp();
const cascadeNext = vi.fn(async (_token: string, _cat: string, _cascadeId: string, path: string | null) => ({
  prop: path ? null : { id: '100006867', label: 'Tỉnh', required: true },
  items: [{ id: '160387', label: 'Hà Nội', leaf: Boolean(path) }],
}));
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    categoriesNeedToken: false,
    cascadeNext,
  }),
);
afterAll(() => resetAdapters());

const leaf = `CAS-${randomUUID().slice(0, 8)}`;
const attr = (code: string, input: PlatformAttribute['input'], raw: Record<string, unknown>): PlatformAttribute => ({
  code,
  label: code,
  kind: 'property',
  input,
  options: [],
  allowCustom: false,
  required: true,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw,
});

let ceo: { token: string; companyId: string };
const url = (q: string) => `/api/v1/channel/platforms/lazada/categories/${leaf}/cascade?${q}`;
const get = (q: string, token = ceo.token) => request(app).get(url(q)).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  await testPool().query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at)
     values ('lazada', $1, 'Thực phẩm', true, 'Thực phẩm', 'thuc pham', now())`,
    [leaf],
  );
  await replaceLeaf('lazada', leaf, {
    attributes: [attr('propCascade', 'cascade', { id: 35, name: 'propCascade' }), attr('material', 'text', { id: 1 })],
    sizeChartRule: null,
    fetchedAt: new Date(),
  });
  const c = await createCompany({ optionalModules: ['channel'] });
  ceo = { token: c.ceo.token, companyId: c.companyId };
});

describe('cascade', () => {
  it('chưa có gian hàng Lazada active: 409 shop_not_connected, không gọi sàn', async () => {
    const res = await get('code=propCascade');
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/shop_not_connected');
    expect(cascadeNext).not.toHaveBeenCalled();
  });

  it('có gian hàng: gọi sàn bằng token, cascadeId từ raw, path chuyển nguyên; đúng schema', async () => {
    const shop = await request(app)
      .post('/api/v1/channel/shops/lazada/token')
      .set('Authorization', `Bearer ${ceo.token}`)
      .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    await activateShop(shop.body.shop.id);
    const first = await get('code=propCascade');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    CascadeLevelSchema.parse(first.body);
    expect(first.body).toEqual({ prop: { id: '100006867', label: 'Tỉnh', required: true }, items: [{ id: '160387', label: 'Hà Nội', leaf: false }] });
    expect(cascadeNext).toHaveBeenLastCalledWith(expect.stringMatching(/^tok-/), leaf, '35', null);
    const path = '120013644:162,100006867:160387';
    const next = await get(`code=propCascade&path=${encodeURIComponent(path)}`);
    expect(next.body).toEqual({ prop: null, items: [{ id: '160387', label: 'Hà Nội', leaf: true }] });
    expect(cascadeNext).toHaveBeenLastCalledWith(expect.any(String), leaf, '35', path);
  });

  it('attribute không phải cascade hoặc không có: 422 errors.code; thiếu code: 422', async () => {
    for (const q of ['code=material', 'code=khong-co', '']) {
      const res = await get(q);
      expect(res.status).toBe(422);
      expect(res.body.errors.code).toBeDefined();
    }
  });

  it('sàn không có cascade: 422 marketplace_unsupported; Sale (không listing.manage): 403', async () => {
    const tiktok = await request(app)
      .get(`/api/v1/channel/platforms/tiktok/categories/${leaf}/cascade?code=propCascade`)
      .set('Authorization', `Bearer ${ceo.token}`);
    expect(tiktok.status).toBe(422);
    expect(tiktok.body.type).toBe('/problems/marketplace_unsupported');
    const sale = await addMember(ceo.companyId, 'sale');
    expect((await get('code=propCascade', sale.token)).status).toBe(403);
  });
});
