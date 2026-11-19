// Route cây category và chi tiết leaf (#400 lát 6, Documents/21 §18.5): quyền (AC-S1), tìm không gọi sàn (AC-4), leaf
// TikTok bằng token gian hàng kèm luật bảng kích cỡ và `defaultValue` từ hồ sơ công ty (AC-5), gian hàng sai (AC-S2).
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PlatformCategoryPage, PlatformLeafDetail } from '#src/modules/channel/channel/api/schemas.ts';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const app = testApp();
/** Mã category của sàn là số (review BE1 P2-5); ngẫu nhiên để không trùng file khác. */
const catId = () => String(randomInt(1e9, 2 ** 47));
const get = (path: string, token?: string) => {
  const r = request(app).get(`/api/v1/channel${path}`);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
afterAll(() => resetAdapters());

const attr = (code: string, extra: Partial<PlatformAttribute> = {}): PlatformAttribute => ({
  code,
  label: code,
  kind: 'property',
  input: 'text',
  options: [],
  allowCustom: true,
  required: false,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw: {},
  ...extra,
});

const calls = { tree: 0, lazadaAttrs: 0, tiktokAttrs: [] as (string | null)[], rules: [] as string[] };
registerAdapter(
  'lazada',
  fakeAdapter({
    categoriesNeedToken: false,
    categoryTree: async () => {
      calls.tree++;
      return [];
    },
    leafAttributes: async () => {
      calls.lazadaAttrs++;
      return [attr('brand', { tier: 'product', required: true })];
    },
  }),
);
registerAdapter(
  'tiktok',
  fakeAdapter({
    categoriesNeedToken: true,
    responsibleFields: { '101489': 'name', '101490': 'address' },
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop TikTok thử', region: 'VN' };
    },
    leafAttributes: async (token) => {
      calls.tiktokAttrs.push(token);
      return [attr('101489', { tier: 'company', required: true }), attr('101490', { tier: 'company' }), attr('100000', { kind: 'sales', requiredWhen: [{ code: '101490', optionIds: ['7', '8'] }] })];
    },
    categoryRules: async (token) => {
      calls.rules.push(token);
      return { sizeChart: 'required' };
    },
  }),
);

async function tiktokShop(token: string) {
  const access = `tok-${randomUUID().slice(0, 12)}`;
  const res = await request(app).post('/api/v1/channel/shops/tiktok/token').set('Authorization', `Bearer ${token}`).send({ accessToken: access });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const shopId = res.body.shops[0].shop.id as string;
  await activateShop(shopId);
  return { shopId, access };
}

describe('quyền (AC-S1)', () => {
  it('401 không token; 403 chưa chọn công ty; Kho 403; phân hệ channel tắt 403; sàn không có adapter 422', async () => {
    const company = await createCompany({ optionalModules: ['channel'] });
    expect((await get('/platforms/lazada/categories')).status).toBe(401);

    const { token: bare } = await login(company.ceo.email);
    const noCompany = await get('/platforms/lazada/categories', bare);
    expect(noCompany.status).toBe(403);
    expect(noCompany.body.type).toBe('/problems/company_not_selected');

    const kho = await addMember(company.companyId, 'warehouse');
    for (const path of ['/platforms/lazada/categories', '/platforms/lazada/categories/123']) {
      const res = await get(path, kho.token);
      expect(res.status).toBe(403);
      expect(res.body.type).toBe('/problems/forbidden');
    }

    const off = await createCompany();
    const disabled = await get('/platforms/lazada/categories', off.ceo.token);
    expect(disabled.status).toBe(403);
    expect(disabled.body.type).toBe('/problems/module_disabled');

    for (const path of ['/platforms/mock/categories', '/platforms/khong-co/categories', '/platforms/mock/categories/1']) {
      const res = await get(path, company.ceo.token);
      expect(res.status, path).toBe(422);
      expect(res.body.type).toBe('/problems/marketplace_unsupported');
    }

    const sale = await addMember(company.companyId, 'sale');
    expect((await get('/platforms/lazada/categories', sale.token)).status).toBe(200);
  });
});

describe('cây (AC-4)', () => {
  it('tìm và theo cấp đọc DB, không gọi sàn; search 1 ký tự 422', async () => {
    const { ceo } = await createCompany({ optionalModules: ['channel'] });
    const before = { ...calls };
    const res = await get(`/platforms/lazada/categories?search=${encodeURIComponent('áo thun')}`, ceo.token);
    expect(res.status).toBe(200);
    expect(() => PlatformCategoryPage.parse(res.body)).not.toThrow();
    expect(res.body.items.length).toBeLessThanOrEqual(50);
    const roots = await get('/platforms/lazada/categories', ceo.token);
    expect(roots.status).toBe(200);
    expect(calls.tree).toBe(before.tree);
    expect(calls.lazadaAttrs).toBe(before.lazadaAttrs);

    const short = await get('/platforms/lazada/categories?search=a', ceo.token);
    expect(short.status).toBe(422);
    expect(short.body.errors).toHaveProperty('search');
  });
});

describe('chi tiết leaf (AC-5, AC-S2, AC-S6)', () => {
  it('TikTok: token gian hàng shopId, luật bảng kích cỡ lưu bảng, defaultValue từ hồ sơ công ty; lần hai không gọi sàn', async () => {
    const { companyId, ceo } = await createCompany({ optionalModules: ['channel'] });
    const { shopId } = await tiktokShop(ceo.token);
    const leaf = catId();
    const n = calls.tiktokAttrs.length;

    const res = await get(`/platforms/tiktok/categories/${leaf}?shopId=${shopId}`, ceo.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(() => PlatformLeafDetail.parse(res.body)).not.toThrow();
    expect(calls.tiktokAttrs).toHaveLength(n + 1);
    expect(calls.tiktokAttrs.at(-1)).toMatch(/^tok-/);
    expect(calls.rules.at(-1)).toBe(calls.tiktokAttrs.at(-1));

    const { rows } = await testPool().query<{ name: string; address: string | null; responsible_name: string | null }>(
      'select name, address, responsible_name from core.companies where id = $1',
      [companyId],
    );
    const org = rows[0]!;
    expect(res.body.category).toMatchObject({ externalId: leaf, isLeaf: true, sizeChartRule: 'required' });
    expect(res.body).toMatchObject({ stale: false, products: [] });
    expect(res.body.attributes.map((a: { code: string; tier: string; defaultValue: string | null }) => [a.code, a.tier, a.defaultValue])).toEqual([
      ['101489', 'company', org.responsible_name ?? org.name],
      ['101490', 'company', org.address],
      ['100000', 'category', null],
    ]);
    // Đúng Documents/21 §18.5: `requiredWhen[].optionIds` (review BE1 P1-1).
    expect(res.body.attributes[2].requiredWhen).toEqual([{ code: '101490', optionIds: ['7', '8'] }]);
    const saved = await testPool().query('select size_chart_rule from channel.platform_categories where platform = $1 and external_id = $2', [
      'tiktok',
      leaf,
    ]);
    expect(saved.rows).toEqual([{ size_chart_rule: 'required' }]);

    // Không gửi shopId: gian hàng active đầu tiên; bản còn hạn nên không gọi sàn.
    expect((await get(`/platforms/tiktok/categories/${leaf}`, ceo.token)).status).toBe(200);
    expect(calls.tiktokAttrs).toHaveLength(n + 1);
  });

  it('Lazada không cần gian hàng; TikTok không gian hàng active 409; shopId công ty khác 404, sai dạng 422', async () => {
    const { ceo } = await createCompany({ optionalModules: ['channel'] });
    const lz = await get(`/platforms/lazada/categories/${catId()}`, ceo.token);
    expect(lz.status, JSON.stringify(lz.body)).toBe(200);
    expect(lz.body.attributes).toEqual([expect.objectContaining({ code: 'brand', tier: 'product', defaultValue: null })]);

    const none = await get(`/platforms/tiktok/categories/${catId()}`, ceo.token);
    expect(none.status).toBe(409);
    expect(none.body.type).toBe('/problems/shop_not_connected');

    const other = await createCompany({ optionalModules: ['channel'] });
    const { shopId: theirs } = await tiktokShop(other.ceo.token);
    const foreign = await get(`/platforms/tiktok/categories/${catId()}?shopId=${theirs}`, ceo.token);
    expect(foreign.status).toBe(404);
    const bad = await get(`/platforms/tiktok/categories/1?shopId=abc`, ceo.token);
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('shopId');

    // Mã category không phải số: 422, không gọi sàn, không ghi dòng vào bảng chung (review BE1 P2-5).
    const before = calls.lazadaAttrs;
    for (const path of ['/platforms/lazada/categories/abc', '/platforms/lazada/categories/12a', '/platforms/lazada/categories?parentId=x1']) {
      const res = await get(path, ceo.token);
      expect(res.status, path).toBe(422);
    }
    expect(calls.lazadaAttrs).toBe(before);
    const junk = await testPool().query("select 1 from channel.platform_categories where platform = 'lazada' and external_id in ('abc', '12a')");
    expect(junk.rows).toEqual([]);
  });
});
