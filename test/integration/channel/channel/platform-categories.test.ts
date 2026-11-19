// Cây category, attribute của leaf sàn (#400 lát 5): tìm trigram (AC-4), đồng bộ cây đánh `removed` (AC-S9 phần dữ liệu),
// `replaceLeaf` thay cả tập ngoài `withCompany` (A3), chi tiết leaf dùng lại 7 ngày, bản cũ khi sàn lỗi (AC-S6).
// DB test dùng chung: sàn `shopee` (adapter giả đăng ký trong test) chỉ file này dùng, dữ liệu Lazada có mã ngẫu nhiên.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import {
  CategoryTreeShrunkError,
  childrenOf,
  findCategory,
  leafAttributesOf,
  replaceLeaf,
  searchLeaves,
  SPEC_PRODUCTS_LIMIT,
  specsOnCategory,
  syncTree,
} from '#src/modules/channel/channel/repository/platform-categories.ts';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { leafDetail, listPlatformCategories } from '#src/modules/channel/channel/service/platform-categories.ts';
import { currentCompanyId, withCompany } from '#src/shared/db/client.ts';
import { createModuleContext } from '#src/wiring.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

afterEach(() => resetAdapters());

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
  raw: { name: code },
  ...extra,
});

/** Chèn node đã đồng bộ (không qua `syncTree`, để không đánh `removed` dữ liệu Lazada của file khác). */
async function insertNode(
  platform: string,
  n: { id: string; parent?: string | null; name: string; path: string; leaf?: boolean; status?: string; synced?: boolean },
) {
  const { normalizePath } = await import('#src/modules/channel/channel/domain/product-spec.ts');
  await testPool().query(
    `insert into channel.platform_categories (platform, external_id, parent_external_id, name, is_leaf, path, path_search, status, synced_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [platform, n.id, n.parent ?? null, n.name, n.leaf ?? true, n.path, normalizePath(n.path), n.status ?? 'active', n.synced === false ? null : new Date()],
  );
}

async function insertSpec(companyId: string, productId: string, platform: string, categoryId: string) {
  await testPool().query(
    `insert into channel.product_specs (company_id, product_id, platform, external_category_id, source) values ($1, $2, $3, $4, 'push')`,
    [companyId, productId, platform, categoryId],
  );
}

describe('sàn chưa có dòng nào', () => {
  it('items rỗng, syncedAt null (AC-4)', async () => {
    registerAdapter('shopee', fakeAdapter({}));
    expect(await listPlatformCategories('shopee', {})).toEqual({ items: [], syncedAt: null });
  });
});

describe('syncTree', () => {
  it('node vắng (kể cả dòng tạm) → removed, spec trỏ tới → categoryStatus removed; cây rỗng thì không ghi', async () => {
    const t1 = new Date('2026-11-18T19:00:00Z');
    const root = { externalId: 'S1', parentExternalId: null, name: 'Đồng hồ', isLeaf: false, path: 'Đồng hồ' };
    const keep = { externalId: 'S2', parentExternalId: 'S1', name: 'Đồng hồ nam', isLeaf: true, path: 'Đồng hồ > Đồng hồ nam' };
    const gone = { externalId: 'S3', parentExternalId: 'S1', name: 'Đồng hồ nữ', isLeaf: true, path: 'Đồng hồ > Đồng hồ nữ' };
    expect(await syncTree('shopee', [root, keep, gone], t1)).toEqual({ upserted: 3, removed: 0, specsRemoved: 0, specsRestored: 0, skipped: false });
    await replaceLeaf('shopee', 'S9', { attributes: [], sizeChartRule: null, fetchedAt: t1 });
    expect(await findCategory('shopee', 'S9')).toMatchObject({ syncedAt: null, status: 'active', isLeaf: true });

    const { companyId } = await createCompany();
    const { productId } = await createVariant(companyId);
    await insertSpec(companyId, productId, 'shopee', 'S3');

    const t2 = new Date('2026-11-19T19:00:00Z');
    const renamed = { ...keep, name: 'Đồng hồ Nam', path: 'Đồng hồ > Đồng hồ Nam' };
    expect(await syncTree('shopee', [root, renamed], t2)).toEqual({ upserted: 2, removed: 2, specsRemoved: 1, specsRestored: 0, skipped: false });
    expect(await findCategory('shopee', 'S2')).toMatchObject({ name: 'Đồng hồ Nam', pathSearch: 'dong ho > dong ho nam', status: 'active', syncedAt: t2 });
    expect(await findCategory('shopee', 'S3')).toMatchObject({ status: 'removed' });
    expect(await findCategory('shopee', 'S9')).toMatchObject({ status: 'removed' });
    const { rows } = await testPool().query('select category_status from channel.product_specs where product_id = $1', [productId]);
    expect(rows).toEqual([{ category_status: 'removed' }]);

    // Category quay lại cây thì active lại và spec về ok (review BE1 P2-3); sàn trả trùng mã trong lô thì khử trùng (P2-4).
    const t3 = new Date('2026-11-20T19:00:00Z');
    expect(await syncTree('shopee', [root, renamed, gone, { ...gone }], t3)).toEqual({
      upserted: 3,
      removed: 0,
      specsRemoved: 0,
      specsRestored: 1,
      skipped: false,
    });
    expect(await findCategory('shopee', 'S3')).toMatchObject({ status: 'active' });
    const restored = await testPool().query('select category_status from channel.product_specs where product_id = $1', [productId]);
    expect(restored.rows).toEqual([{ category_status: 'ok' }]);

    // Lượt cũ hơn lượt đã ghi (hai lượt chồng nhau) không ghi gì: synced_at chỉ tiến, node không bị đánh removed (P2-4).
    expect(await syncTree('shopee', [root], t2)).toEqual({ upserted: 0, removed: 0, specsRemoved: 0, specsRestored: 0, skipped: true });
    expect(await findCategory('shopee', 'S3')).toMatchObject({ status: 'active', syncedAt: t3 });

    await expect(syncTree('shopee', [], t2)).rejects.toThrow(/cây rỗng/);
    await expect(withCompany(companyId, () => syncTree('shopee', [root], t2))).rejects.toThrow(/ngoài withCompany/);
  });

  it('listPlatformCategories: cấp gốc, con trực tiếp, syncedAt là lần đồng bộ gần nhất', async () => {
    registerAdapter('shopee', fakeAdapter({}));
    const roots = await listPlatformCategories('shopee', {});
    expect(roots.items).toEqual([{ externalId: 'S1', parentExternalId: null, name: 'Đồng hồ', path: 'Đồng hồ', isLeaf: false, status: 'active' }]);
    expect(roots.syncedAt).toEqual(new Date('2026-11-20T19:00:00Z'));
    const kids = await listPlatformCategories('shopee', { parentId: 'S1' });
    expect(kids.items.map((c) => c.externalId)).toEqual(['S2', 'S3']);
  });

  it('cây thiếu bất thường (bỏ hơn 5% node active, cây từ 100 node) thì không ghi gì; allowShrink thì ghi (review BE1 P2-3)', async () => {
    const t4 = new Date('2026-11-21T19:00:00Z');
    const base = [
      { externalId: 'S1', parentExternalId: null, name: 'Đồng hồ', isLeaf: false, path: 'Đồng hồ' },
      { externalId: 'S2', parentExternalId: 'S1', name: 'Đồng hồ Nam', isLeaf: true, path: 'Đồng hồ > Đồng hồ Nam' },
      { externalId: 'S3', parentExternalId: 'S1', name: 'Đồng hồ nữ', isLeaf: true, path: 'Đồng hồ > Đồng hồ nữ' },
    ];
    const big = Array.from({ length: 120 }, (_, i) => ({
      externalId: `SX${i}`,
      parentExternalId: 'S1',
      name: `Loại ${i}`,
      isLeaf: true,
      path: `Đồng hồ > Loại ${i}`,
    }));
    expect(await syncTree('shopee', [...base, ...big], t4)).toMatchObject({ upserted: 123, removed: 0 });

    const t5 = new Date('2026-11-22T19:00:00Z');
    const cut = [...base, ...big.slice(0, 100)];
    await expect(syncTree('shopee', cut, t5)).rejects.toBeInstanceOf(CategoryTreeShrunkError);
    expect(await findCategory('shopee', 'SX119')).toMatchObject({ status: 'active', syncedAt: t4 });
    expect(await findCategory('shopee', 'S2')).toMatchObject({ syncedAt: t4 });

    expect(await syncTree('shopee', cut, t5, { allowShrink: true })).toMatchObject({ upserted: 103, removed: 20 });
    expect(await findCategory('shopee', 'SX119')).toMatchObject({ status: 'removed' });
  });
});

describe('tìm leaf (AC-4)', () => {
  const tok = `zq${randomUUID().slice(0, 6)}`;
  const id = (s: string) => `${tok}-${s}`;

  it('có dấu, không dấu, đ/d cùng tập; chỉ leaf active đã đồng bộ; khớp có dấu trước; tối đa 50', async () => {
    await insertNode('lazada', { id: id('root'), name: `Thời trang ${tok}`, path: `Thời trang ${tok}`, leaf: false });
    await insertNode('lazada', { id: id('a1'), parent: id('root'), name: `Áo thun ${tok}`, path: `Thời trang > Áo thun ${tok}` });
    await insertNode('lazada', { id: id('a2'), parent: id('root'), name: `Ao thun ${tok}`, path: `Thời trang > Ao thun ${tok}` });
    await insertNode('lazada', { id: id('gone'), parent: id('root'), name: 'Áo thun cũ', path: `Thời trang ${tok} > Áo thun cũ`, status: 'removed' });
    await insertNode('lazada', { id: id('tmp'), name: id('tmp'), path: `Thời trang ${tok} > Áo thun tạm`, synced: false });
    await insertNode('lazada', { id: id('dh'), parent: id('root'), name: 'Đồng hồ', path: `Thời trang ${tok} > Đồng hồ` });

    const ids = async (q: string) => (await searchLeaves('lazada', q)).map((r) => r.externalId);
    // Cùng `word_similarity` (cùng `path_search`): đường dẫn có dấu chứa nguyên chuỗi gõ lên trước.
    expect(await ids(`Áo thun ${tok}`)).toEqual([id('a1'), id('a2')]);
    expect(await ids(`ao thun ${tok}`)).toEqual([id('a2'), id('a1')]);
    expect(await ids(`${tok} đồng hồ`)).toEqual([id('dh')]);
    expect(await ids(`${tok} dong ho`)).toEqual([id('dh')]);

    for (let i = 0; i < 55; i++) {
      const n = String(i).padStart(2, '0');
      await insertNode('lazada', { id: id(`v${n}`), parent: id('root'), name: `Ví ${n}`, path: `Thời trang ${tok} > Ví ${n}` });
    }
    expect(await searchLeaves('lazada', `${tok} vi`)).toHaveLength(50);
    expect((await childrenOf('lazada', id('root'))).map((r) => r.externalId)).toContain(id('gone'));
  });
});

describe('replaceLeaf', () => {
  it('thay cả tập: bỏ code sàn đã bỏ, giữ thứ tự bắt buộc trước; 0 attribute vẫn ghi attributes_fetched_at', async () => {
    const leaf = `L-${randomUUID().slice(0, 8)}`;
    const t1 = new Date('2026-11-19T01:00:00Z');
    await replaceLeaf('shopee', leaf, {
      attributes: [attr('b'), attr('a', { required: true, options: [{ id: '1', label: 'Một' }] }), attr('c', { kind: 'sales' })],
      sizeChartRule: 'required',
      fetchedAt: t1,
    });
    expect((await leafAttributesOf('shopee', leaf)).map((a) => a.code)).toEqual(['a', 'b', 'c']);
    expect(await findCategory('shopee', leaf)).toMatchObject({ sizeChartRule: 'required', attributesFetchedAt: t1 });
    // Không truyền luật (sàn không có, hay hỏi lỗi) thì giữ luật đang có (review BE1 P2-2).
    await replaceLeaf('shopee', leaf, { attributes: [attr('b'), attr('a', { required: true, options: [{ id: '1', label: 'Một' }] }), attr('c', { kind: 'sales' })], fetchedAt: t1 });
    expect(await findCategory('shopee', leaf)).toMatchObject({ sizeChartRule: 'required' });

    const t2 = new Date('2026-11-27T01:00:00Z');
    await replaceLeaf('shopee', leaf, { attributes: [attr('a', { label: 'A mới' })], sizeChartRule: null, fetchedAt: t2 });
    expect(await leafAttributesOf('shopee', leaf)).toEqual([attr('a', { label: 'A mới' })]);
    await replaceLeaf('shopee', leaf, { attributes: [], sizeChartRule: null, fetchedAt: t2 });
    expect(await leafAttributesOf('shopee', leaf)).toEqual([]);
    expect(await findCategory('shopee', leaf)).toMatchObject({ sizeChartRule: null, attributesFetchedAt: t2 });

    const { companyId } = await createCompany();
    await expect(withCompany(companyId, () => replaceLeaf('shopee', leaf, { attributes: [], sizeChartRule: null, fetchedAt: t2 }))).rejects.toThrow(
      /ngoài withCompany/,
    );
  });
});

describe('leafDetail (AC-5, AC-S6)', () => {
  const ctx = createModuleContext();
  const now = new Date('2026-11-19T03:00:00Z');
  const later = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  function counting(attrs: () => PlatformAttribute[] | Promise<PlatformAttribute[]>, needToken = false) {
    const calls: (string | null)[] = [];
    registerAdapter(
      'shopee',
      fakeAdapter({
        categoriesNeedToken: needToken,
        responsibleFields: { org_name: 'name', org_addr: 'address' },
        leafAttributes: async (token, _id) => {
          calls.push(token);
          return attrs();
        },
      }),
    );
    return calls;
  }

  it('lần đầu gọi sàn, lần hai trong 7 ngày không gọi; quá 7 ngày lấy lại và bỏ attribute sàn đã bỏ', async () => {
    const { companyId } = await createCompany();
    const leaf = `D-${randomUUID().slice(0, 8)}`;
    let current = [attr('keep', { required: true }), attr('drop')];
    const calls = counting(() => current);

    const first = await leafDetail(ctx, companyId, 'shopee', leaf, { now });
    expect(calls).toEqual([null]);
    expect(first).toMatchObject({ stale: false, fetchedAt: now, products: [] });
    expect(first.category).toMatchObject({ externalId: leaf, isLeaf: true, sizeChartRule: null });
    expect(first.attributes.map((a) => a.code)).toEqual(['keep', 'drop']);
    expect(first.attributes[0]).not.toHaveProperty('raw');

    await leafDetail(ctx, companyId, 'shopee', leaf, { now: later(6) });
    expect(calls).toHaveLength(1);

    current = [attr('keep', { required: true })];
    const third = await leafDetail(ctx, companyId, 'shopee', leaf, { now: later(8) });
    expect(calls).toHaveLength(2);
    expect(third.attributes.map((a) => a.code)).toEqual(['keep']);
  });

  it('leaf không có attribute nào cũng không gọi lại trong 7 ngày', async () => {
    const { companyId } = await createCompany();
    const leaf = `E-${randomUUID().slice(0, 8)}`;
    const calls = counting(() => []);
    await leafDetail(ctx, companyId, 'shopee', leaf, { now });
    await leafDetail(ctx, companyId, 'shopee', leaf, { now: later(1) });
    expect(calls).toHaveLength(1);
  });

  it('sàn lỗi: còn bản cũ thì stale, chưa có bản nào thì 503', async () => {
    const { companyId } = await createCompany();
    const leaf = `F-${randomUUID().slice(0, 8)}`;
    let fail = false;
    counting(() => {
      if (fail) throw new MarketplaceError('unavailable', 'http_502');
      return [attr('a')];
    });
    await leafDetail(ctx, companyId, 'shopee', leaf, { now });
    fail = true;
    const old = await leafDetail(ctx, companyId, 'shopee', leaf, { now: later(8) });
    expect(old).toMatchObject({ stale: true, fetchedAt: now });
    expect(old.attributes.map((a) => a.code)).toEqual(['a']);

    await expect(leafDetail(ctx, companyId, 'shopee', `G-${randomUUID().slice(0, 8)}`, { now })).rejects.toMatchObject({
      status: 503,
      code: 'marketplace_unavailable',
    });
  });

  it('sàn cần token mà công ty không có gian hàng active: 409 shop_not_connected, không gọi sàn; còn bản cũ thì stale', async () => {
    const { companyId } = await createCompany();
    const leaf = `H-${randomUUID().slice(0, 8)}`;
    const calls = counting(() => [attr('a')], true);
    await expect(leafDetail(ctx, companyId, 'shopee', leaf, { now })).rejects.toMatchObject({ status: 409, code: 'shop_not_connected' });
    expect(calls).toEqual([]);

    counting(() => [attr('a')]);
    await leafDetail(ctx, companyId, 'shopee', leaf, { now });
    counting(() => [attr('a')], true);
    expect(await leafDetail(ctx, companyId, 'shopee', leaf, { now: later(8) })).toMatchObject({ stale: true });
  });

  it('node không phải lá: 422 category_not_leaf; sàn không có leafAttributes: 422 marketplace_unsupported', async () => {
    const { companyId } = await createCompany();
    const parent = `P-${randomUUID().slice(0, 8)}`;
    await insertNode('shopee', { id: parent, name: 'Cha', path: 'Cha', leaf: false });
    counting(() => []);
    await expect(leafDetail(ctx, companyId, 'shopee', parent, { now })).rejects.toMatchObject({ status: 422, code: 'category_not_leaf' });
    registerAdapter('shopee', fakeAdapter({}));
    await expect(leafDetail(ctx, companyId, 'shopee', `Q-${randomUUID().slice(0, 8)}`, { now })).rejects.toMatchObject({
      status: 422,
      code: 'marketplace_unsupported',
    });
  });

  it('tier company lấy defaultValue từ hồ sơ công ty; products là sản phẩm của công ty có spec trỏ tới leaf (RLS)', async () => {
    const { companyId } = await createCompany();
    const other = await createCompany();
    const leaf = `R-${randomUUID().slice(0, 8)}`;
    counting(() => [attr('org_name', { tier: 'company', required: true }), attr('org_addr', { tier: 'company' }), attr('x')]);
    const mine = await createVariant(companyId);
    const theirs = await createVariant(other.companyId);
    await leafDetail(ctx, companyId, 'shopee', leaf, { now });
    await insertSpec(companyId, mine.productId, 'shopee', leaf);
    await insertSpec(other.companyId, theirs.productId, 'shopee', leaf);
    await testPool().query("update core.companies set name = 'Công ty Demo', address = null, responsible_name = null, responsible_address = null where id = $1", [companyId]);

    const detail = await leafDetail(ctx, companyId, 'shopee', leaf, { now: later(1) });
    const { rows } = await testPool().query<{ code: string; name: string }>('select code, name from product.products where id = $1', [mine.productId]);
    expect(detail.products).toEqual([{ productId: mine.productId, code: rows[0]!.code, name: rows[0]!.name, source: 'push' }]);
    expect(detail.attributes.map((a) => [a.code, a.defaultValue])).toEqual([
      ['org_name', 'Công ty Demo'],
      ['org_addr', null],
      ['x', null],
    ]);
  });

  it('sàn cần token: gọi sàn ngoài giao dịch (P1-2), luật bảng kích cỡ lỗi tạm giữ luật cũ (P2-2), shopId công ty khác 404 cả khi bảng còn hạn (P2-7)', async () => {
    const inTx: (string | null)[] = [];
    let rulesFail = false;
    registerAdapter(
      'shopee',
      fakeAdapter({
        categoriesNeedToken: true,
        async getSeller(accessToken) {
          return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
        },
        leafAttributes: async () => {
          inTx.push(currentCompanyId());
          return [attr('a')];
        },
        categoryRules: async () => {
          inTx.push(currentCompanyId());
          if (rulesFail) throw new MarketplaceError('unavailable', 'http_502');
          return { sizeChart: 'required' };
        },
      }),
    );
    const app = testApp();
    const shopeeShop = async (token: string) => {
      const res = await request(app)
        .post('/api/v1/channel/shops/shopee/token')
        .set('Authorization', `Bearer ${token}`)
        .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      const id = res.body.shops[0].shop.id as string;
      await activateShop(id);
      return id;
    };
    const { companyId, ceo } = await createCompany({ optionalModules: ['channel'] });
    const shopId = await shopeeShop(ceo.token);
    const leaf = `T-${randomUUID().slice(0, 8)}`;

    const first = await leafDetail(ctx, companyId, 'shopee', leaf, { shopId, now });
    expect(first.category.sizeChartRule).toBe('required');
    expect(inTx).toEqual([null, null]);

    rulesFail = true;
    const again = await leafDetail(ctx, companyId, 'shopee', leaf, { now: later(8) });
    expect(again).toMatchObject({ stale: false, fetchedAt: later(8) });
    expect(again.category.sizeChartRule).toBe('required');
    expect(inTx).toEqual([null, null, null, null]);

    const other = await createCompany({ optionalModules: ['channel'] });
    const theirs = await shopeeShop(other.ceo.token);
    for (const id of [theirs, randomUUID()]) {
      await expect(leafDetail(ctx, companyId, 'shopee', leaf, { shopId: id, now: later(9) })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    }
    expect(inTx).toHaveLength(4);
  });

  it('specsOnCategory chặn 200 dòng, cũ trước (review BE1 P2-6)', async () => {
    const { companyId } = await createCompany();
    const leaf = `S-${randomUUID().slice(0, 8)}`;
    const ids = Array.from({ length: SPEC_PRODUCTS_LIMIT + 1 }, () => randomUUID());
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, source, created_at)
       select $1, p, 'shopee', $2, 'push', now() + ord * interval '1 second' from unnest($3::uuid[]) with ordinality as t(p, ord)`,
      [companyId, leaf, ids],
    );
    const rows = await withCompany(companyId, () => specsOnCategory('shopee', leaf));
    expect(SPEC_PRODUCTS_LIMIT).toBe(200);
    expect(rows).toHaveLength(200);
    expect(rows[0]!.productId).toBe(ids[0]);
    expect(rows.at(-1)!.productId).toBe(ids[199]);
  });
});
