// Đồng bộ cây category của sàn (#400 lát 7, AC-S9): route xếp một lượt mỗi sàn, lượt chạy ghi cây, sàn cần token mượn
// phiên gian hàng `active` và lời gọi chỉ tính trần chung (`appOnly` giữ qua `forCompany` của lớp bọc token, A4).
// Dùng sàn `mock` (adapter giả đăng ký trong file): file khác không ghi cây của sàn này.
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { reservePlatformCall } from '#src/modules/channel/channel/repository/api-usage.ts';
import { findCategory } from '#src/modules/channel/channel/repository/platform-categories.ts';
import { borrowCandidates, mappedGroupsOf, treeSyncStateOf } from '#src/modules/channel/channel/repository/category-sync-state.ts';
import { onShopConnecting, runPermissionsSync } from '#src/modules/channel/channel/service/category-permissions-sync.ts';
import { ensureCategoryTree, runCategorySync } from '#src/modules/channel/channel/service/category-sync.ts';
import { suggestedGroupsOf } from '#src/modules/channel/channel/service/suggested-groups.ts';
import { callScope } from '#src/modules/channel/channel/service/marketplaces/call-scope.ts';
import { MarketplaceError, reserveOrThrow, type PlatformCategoryNode } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { inBackground, registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const app = testApp();
afterAll(() => resetAdapters());

// Ngày riêng ở tương lai xa để đếm `api_usage` không lẫn file khác.
const day = new Date(Date.UTC(3100 + randomInt(0, 90), randomInt(0, 12), randomInt(1, 28), 5));
const reserve = () => {
  const { companyId, background } = callScope();
  return reservePlatformCall('mock', 100_000, { companyId, background, companyMin: 1000, at: day });
};
const usage = async () => {
  const { rows } = await testPool().query<{ company_id: string | null; calls: number }>(
    'select company_id, calls from channel.api_usage where platform = $1 and day = $2::date',
    ['mock', day.toISOString().slice(0, 10)],
  );
  return rows;
};

const tok = randomUUID().slice(0, 6);
const tree: PlatformCategoryNode[] = [
  { externalId: `${tok}-r`, parentExternalId: null, name: 'Gốc', isLeaf: false, path: 'Gốc' },
  { externalId: `${tok}-a`, parentExternalId: `${tok}-r`, name: 'Lá A', isLeaf: true, path: 'Gốc > Lá A' },
];
const seen: { token: string | null; scope: ReturnType<typeof callScope> }[] = [];
function register(needToken: boolean) {
  registerAdapter(
    'mock',
    fakeAdapter({
      categoriesNeedToken: needToken,
      async getSeller(accessToken) {
        return { externalShopId: accessToken.slice(4), shopName: 'Shop mock', region: 'VN' };
      },
      async categoryTree(token) {
        seen.push({ token, scope: callScope() });
        await reserveOrThrow(reserve, 'Mock');
        return tree;
      },
    }),
  );
}

describe('route đồng bộ cây', () => {
  it('202 queued, bấm lần hai queued false; sàn không đọc được cây 422', async () => {
    register(false);
    const { ceo } = await createCompany({ optionalModules: [] });
    const post = (platform: string) =>
      request(app).post(`/api/v1/channel/platforms/${platform}/categories/sync`).set('Authorization', `Bearer ${ceo.token}`);
    const first = await post('mock');
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ queued: true });
    expect((await post('mock')).body).toEqual({ queued: false });

    registerAdapter('mock', fakeAdapter({}));
    const unsupported = await post('mock');
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.type).toBe('/problems/marketplace_unsupported');
  });
});

describe('runCategorySync (AC-S9)', () => {
  it('sàn cần token mà không có gian hàng cho mượn: không gọi sàn, trạng thái failed kèm câu lỗi', async () => {
    register(true);
    const n = seen.length;
    // Không đọc gian hàng thật: file khác có thể nối gian hàng `mock` active trên DB dùng chung (review BE1 P2-8).
    await inBackground(() => runCategorySync({ platform: 'mock' }, undefined, { borrow: async () => [] }));
    expect(seen).toHaveLength(n);
    expect(await treeSyncStateOf('mock')).toMatchObject({ state: 'failed', error: expect.stringContaining('Kết nối lại') });
  });

  it('mượn phiên gian hàng active: dòng công ty không tăng, dòng tổng tăng; ghi cây', async () => {
    register(true);
    const { ceo, companyId } = await createCompany({ optionalModules: [] });
    const access = `tok-${randomUUID().slice(0, 12)}`;
    const res = await request(app).post('/api/v1/channel/shops/mock/token').set('Authorization', `Bearer ${ceo.token}`).send({ accessToken: access });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await activateShop(res.body.shops[0].shop.id);

    const before = await usage();
    await inBackground(() => runCategorySync({ platform: 'mock' }));
    expect(seen.at(-1)!.token).toBeTruthy();
    expect(seen.at(-1)!.scope).toEqual({ companyId: null, background: true });
    const after = await usage();
    const total = (rows: typeof before) => rows.find((r) => r.company_id === null)?.calls ?? 0;
    expect(total(after)).toBe(total(before) + 1);
    expect(after.find((r) => r.company_id === companyId)).toBeUndefined();
    expect(await findCategory('mock', `${tok}-a`)).toMatchObject({ isLeaf: true, path: 'Gốc > Lá A', pathSearch: 'goc > la a', status: 'active' });
  });

  it('sàn không cần token (Lazada) gọi không token, chỉ tính trần chung', async () => {
    register(false);
    await inBackground(() => runCategorySync({ platform: 'mock' }));
    expect(seen.at(-1)).toEqual({ token: null, scope: { companyId: null, background: true } });
  });
});

// #569 (Documents/21 §18.5 "Đồng bộ category khi nối gian hàng").
async function connectShop(ceoToken: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/channel/shops/mock/token')
    .set('Authorization', `Bearer ${ceoToken}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.shops[0].shop.id as string;
}
const categorySync = (token: string, shopId: string) =>
  request(app).get(`/api/v1/channel/shops/${shopId}/category-sync`).set('Authorization', `Bearer ${token}`);
const seller = async (accessToken: string) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop mock', region: 'VN' });

describe('trạng thái đồng bộ category (#569)', () => {
  it('lượt chạy xong: idle; GET trả cây ready, permissions null khi sàn không có quyền theo gian hàng', async () => {
    register(false);
    await inBackground(() => runCategorySync({ platform: 'mock' }));
    expect((await treeSyncStateOf('mock')).state).toBe('idle');
    const { ceo } = await createCompany({ optionalModules: [] });
    const shopId = await connectShop(ceo.token);
    const res = await categorySync(ceo.token, shopId);
    expect(res.status).toBe(200);
    expect(res.body.tree).toMatchObject({ state: 'ready', error: null });
    expect(res.body.tree.leafCount).toBeGreaterThanOrEqual(1);
    expect(res.body.tree.syncedAt).toEqual(expect.any(String));
    expect(res.body.permissions).toBeNull();
  });

  it('gian hàng của công ty khác: 404', async () => {
    register(false);
    const a = await createCompany({ optionalModules: [] });
    const b = await createCompany({ optionalModules: [] });
    const shopId = await connectShop(a.ceo.token);
    const res = await categorySync(b.ceo.token, shopId);
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
  });

  it('sàn từ chối token của gian hàng đầu: mượn gian hàng kế, ghi cây', async () => {
    const bad = `tok-bad-${randomUUID().slice(0, 8)}`;
    registerAdapter(
      'mock',
      fakeAdapter({
        categoriesNeedToken: true,
        getSeller: seller,
        async categoryTree(token) {
          seen.push({ token, scope: callScope() });
          if (token === bad) throw new MarketplaceError('unauthorized', 'x', 'token hỏng');
          return tree;
        },
      }),
    );
    const one = await createCompany({ optionalModules: [] });
    const two = await createCompany({ optionalModules: [] });
    const resBad = await request(app).post('/api/v1/channel/shops/mock/token').set('Authorization', `Bearer ${one.ceo.token}`).send({ accessToken: bad });
    const first = { id: resBad.body.shops[0].shop.id as string, companyId: one.companyId };
    const second = { id: await connectShop(two.ceo.token), companyId: two.companyId };
    await activateShop(first.id);
    await activateShop(second.id);
    const n = seen.length;
    await inBackground(() => runCategorySync({ platform: 'mock' }, undefined, { borrow: async () => [first, second] }));
    expect(seen.slice(n).map((s) => s.token === bad)).toEqual([true, false]);
    expect((await treeSyncStateOf('mock')).state).toBe('idle');
  });

  it('lỗi còn lượt thử: queued kèm câu lỗi và ném; lần cuối: failed', async () => {
    registerAdapter(
      'mock',
      fakeAdapter({
        categoriesNeedToken: false,
        async categoryTree() {
          throw new MarketplaceError('unavailable', '500', 'sàn bận');
        },
      }),
    );
    await expect(inBackground(() => runCategorySync({ platform: 'mock' }))).rejects.toThrow();
    expect(await treeSyncStateOf('mock')).toMatchObject({ state: 'queued', error: expect.stringContaining('không phản hồi') });
    await expect(inBackground(() => runCategorySync({ platform: 'mock' }, { lastAttempt: true }))).rejects.toThrow();
    expect((await treeSyncStateOf('mock')).state).toBe('failed');
  });

  it('nối gian hàng mà sàn đã có cây: không xếp lượt, giữ trạng thái', async () => {
    register(false);
    await inBackground(() => runCategorySync({ platform: 'mock' }));
    await ensureCategoryTree('mock', randomUUID());
    expect((await treeSyncStateOf('mock')).state).toBe('idle');
  });

  it('sàn không đọc được cây: unsupported, GET trả unsupported', async () => {
    registerAdapter('mock', fakeAdapter({ getSeller: seller }));
    const { ceo } = await createCompany({ optionalModules: [] });
    const shopId = await connectShop(ceo.token);
    await ensureCategoryTree('mock', shopId);
    expect((await treeSyncStateOf('mock')).state).toBe('unsupported');
    expect((await categorySync(ceo.token, shopId)).body.tree).toMatchObject({ state: 'unsupported', leafCount: 0 });
    // Trả lại trạng thái cho ca khác của sàn `mock`.
    register(false);
    await inBackground(() => runCategorySync({ platform: 'mock' }));
  });

  it('quyền theo gian hàng: nối xếp lượt (queued), lượt chạy ghi quyền mọi leaf rồi ready', async () => {
    registerAdapter(
      'mock',
      fakeAdapter({
        categoriesNeedToken: false,
        categoryPermissionsPerShop: true,
        getSeller: seller,
        async categoryTree() {
          return tree.map((n) => (n.isLeaf ? { ...n, permissionStatuses: ['AVAILABLE'] } : n));
        },
      }),
    );
    const { ceo, companyId } = await createCompany({ optionalModules: [] });
    const shopId = await connectShop(ceo.token);
    await inBackground(() => onShopConnecting({ shopId, to: 'connecting' }));
    expect((await categorySync(ceo.token, shopId)).body.permissions).toMatchObject({ state: 'queued', availableCount: 0 });
    await inBackground(() => runPermissionsSync({ shopId, companyId }));
    const res = await categorySync(ceo.token, shopId);
    expect(res.body.permissions).toMatchObject({ state: 'ready', availableCount: 1, error: null });
    expect(res.body.permissions.checkedAt).toEqual(expect.any(String));
  });

  it('đọc quyền mà gian hàng đã ngắt: failed, không ném', async () => {
    registerAdapter(
      'mock',
      fakeAdapter({
        categoryPermissionsPerShop: true,
        getSeller: seller,
        async categoryTree() {
          return tree;
        },
      }),
    );
    const { ceo, companyId } = await createCompany({ optionalModules: [] });
    const shopId = await connectShop(ceo.token);
    await testPool().query("update channel.shops set status = 'disconnected', access_token_enc = null, refresh_token_enc = null where id = $1", [shopId]);
    await inBackground(() => runPermissionsSync({ shopId, companyId }));
    expect((await categorySync(ceo.token, shopId)).body.permissions).toMatchObject({ state: 'failed', error: expect.any(String) });
  });
});

describe('danh mục chuẩn gợi ý theo category sàn (#569)', () => {
  it('lấy dòng ánh xạ sâu nhất trên đường lên gốc; danh mục bị ẩn thì không gợi ý', async () => {
    register(false);
    await inBackground(() => runCategorySync({ platform: 'mock' }));
    const { rows: groups } = await testPool().query<{ id: string }>(
      "select id from product.product_groups where company_id is null and name in ('Đồ chơi', 'Khác') order by name",
    );
    const [toy, other] = groups.map((g) => g.id);
    await testPool().query(
      `insert into channel.platform_category_group_maps (platform, external_category_id, group_id)
       values ('mock', $1, $2), ('mock', $3, $4) on conflict do nothing`,
      [`${tok}-r`, other, `${tok}-a`, toy],
    );
    expect(await mappedGroupsOf('mock', [`${tok}-a`])).toEqual(new Map([[`${tok}-a`, toy]]));
    await testPool().query("delete from channel.platform_category_group_maps where platform = 'mock' and external_category_id = $1", [`${tok}-a`]);
    expect(await mappedGroupsOf('mock', [`${tok}-a`, 'khong-co'])).toEqual(new Map([[`${tok}-a`, other]]));
    const { companyId } = await createCompany({ optionalModules: [] });
    const hidden = await withCompany(companyId, () => suggestedGroupsOf({ visibleGroupIds: async () => new Set() }, 'mock', [`${tok}-a`]));
    expect(hidden.size).toBe(0);
  });

  it('migration ghi ánh xạ mặc định cho cả hai sàn', async () => {
    const { rows } = await testPool().query<{ platform: string; n: number }>(
      "select platform, count(*)::int as n from channel.platform_category_group_maps where platform in ('lazada', 'tiktok') group by platform order by platform",
    );
    expect(rows).toEqual([
      { platform: 'lazada', n: 41 },
      { platform: 'tiktok', n: 34 },
    ]);
  });
});

describe('Thử lại của trình thiết lập (#569, review #582)', () => {
  const syncRoute = (token: string, body: object) =>
    request(app).post('/api/v1/channel/platforms/mock/categories/sync').set('Authorization', `Bearer ${token}`).send(body);

  it('gian hàng đang nối duy nhất: route nhận shopId, việc mượn token của gian hàng đó rồi ghi cây', async () => {
    register(true);
    const { ceo, companyId } = await createCompany({ optionalModules: [] });
    const shopId = await connectShop(ceo.token);
    const other = await createCompany({ optionalModules: [] });
    const otherConnecting = await connectShop(other.ceo.token);
    const res = await syncRoute(ceo.token, { shopId });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    // Gian hàng `connecting` chỉ được mượn khi chính việc mang nó; gian hàng đang nối của công ty khác thì không.
    const candidates = await borrowCandidates('mock', shopId);
    expect(candidates.at(-1)).toEqual({ id: shopId, companyId });
    expect(candidates.map((c) => c.id)).not.toContain(otherConnecting);
    expect((await borrowCandidates('mock')).map((c) => c.id)).not.toContain(shopId);
    // Không phụ thuộc gian hàng `active` của ca khác trên DB dùng chung: chỉ để lại gian hàng của việc.
    const onlyJobShop = async (p: string, id?: string) => (await borrowCandidates(p, id)).filter((c) => c.id === id);
    await inBackground(() => runCategorySync({ platform: 'mock', shopId }, undefined, { borrow: onlyJobShop }));
    expect((await treeSyncStateOf('mock')).state).toBe('idle');
  });

  it('shopId của công ty khác: 404, không xếp', async () => {
    register(true);
    const a = await createCompany({ optionalModules: [] });
    const b = await createCompany({ optionalModules: [] });
    const shopId = await connectShop(a.ceo.token);
    const res = await syncRoute(b.ceo.token, { shopId });
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
  });

  it('Thử lại quyền: 202 kèm trạng thái queued; gian hàng đã ngắt 409; sàn không có quyền theo gian hàng 422', async () => {
    registerAdapter(
      'mock',
      fakeAdapter({
        categoryPermissionsPerShop: true,
        getSeller: seller,
        async categoryTree() {
          return tree;
        },
      }),
    );
    const { ceo } = await createCompany({ optionalModules: [] });
    const shopId = await connectShop(ceo.token);
    const refresh = () =>
      request(app).post(`/api/v1/channel/shops/${shopId}/category-permissions/refresh`).set('Authorization', `Bearer ${ceo.token}`);
    const ok = await refresh();
    expect(ok.status).toBe(202);
    expect(ok.body.permissions).toMatchObject({ state: 'queued' });

    await testPool().query("update channel.shops set status = 'disconnected', access_token_enc = null, refresh_token_enc = null where id = $1", [shopId]);
    const gone = await refresh();
    expect(gone.status).toBe(409);
    expect(gone.body.type).toBe('/problems/shop_not_connected');

    register(false);
    const unsupported = await refresh();
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.type).toBe('/problems/marketplace_unsupported');
  });
});
