// PATCH /channel/shops/:id: sửa hạn trả hàng sau thiết lập (commerio-backend#362, Documents/21 §18.4).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markNeedsReauth } from '#src/modules/channel/index.ts';
import { Shop } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const getSeller = async (accessToken: string) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' });
registerAdapter('lazada', fakeAdapter({ getSeller }));
registerAdapter(
  'tiktok',
  fakeAdapter({ capabilities: { listingReview: true, hideBy: 'deactivate', splitLevel: 'sku', returnWindow: 'platform_status' }, getSeller }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let co: Awaited<ReturnType<typeof createCompany>>;
beforeAll(async () => {
  co = await createCompany({ optionalModules: ['channel'] });
});

/** Gian hàng `active` mà `return_window_days` null, như gian hàng thiết lập trước khi bắt buộc. */
async function activeShop(platform = 'lazada', token = co.ceo.token): Promise<{ id: string; version: number }> {
  const res = await app()
    .post(`/api/v1/channel/shops/${platform}/token`)
    .set('Authorization', `Bearer ${token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status).toBe(201);
  const id = res.body.shop.id as string;
  await activateShop(id);
  const view = await app().get(`/api/v1/channel/shops/${id}`).set('Authorization', `Bearer ${token}`);
  expect(view.body).toMatchObject({ status: 'active', returnWindowDays: null });
  return { id, version: view.body.version };
}
const patch = (id: string, body: object, token = co.ceo.token) =>
  app().patch(`/api/v1/channel/shops/${id}`).set('Authorization', `Bearer ${token}`).send(body);

describe('PATCH /channel/shops/:id — returnWindowDays (#362)', () => {
  it('gian hàng active null: nhập 14 → 200 Shop, version tăng, đọc lại thấy 14, có nhật ký', async () => {
    const { id, version } = await activeShop();

    const res = await patch(id, { version, returnWindowDays: 14 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Shop.parse(res.body)).toMatchObject({ id, returnWindowDays: 14, version: version + 1 });
    const reread = await app().get(`/api/v1/channel/shops/${id}`).set('Authorization', `Bearer ${co.ceo.token}`);
    expect(reread.body).toMatchObject({ returnWindowDays: 14, version: version + 1 });
    const { rows } = await testPool().query(
      "select action, entity_label as label, before, after from core.audit_logs where entity_type = 'channel.shops' and entity_id = $1",
      [id],
    );
    // #352: nhãn là tên gian hàng, không phải tên bảng.
    expect(rows).toEqual([
      { action: 'update', label: reread.body.shopName, before: { returnWindowDays: null }, after: { returnWindowDays: 14 } },
    ]);
    expect(reread.body.shopName).toEqual(expect.any(String));
  });

  it('version cũ: 409 version_conflict kèm current, không đổi', async () => {
    const { id, version } = await activeShop();
    expect((await patch(id, { version, returnWindowDays: 7 })).status).toBe(200);

    const res = await patch(id, { version, returnWindowDays: 30 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'version_conflict', current: { id, returnWindowDays: 7, version: version + 1 } });
  });

  it('body sai: ngoài 1–60, lẻ, chuỗi, null, thiếu trường, thừa trường → 422 trước 404', async () => {
    const { id, version } = await activeShop();
    const bads = [0, 61, 1.5, '7', null].map((returnWindowDays) => ({ version, returnWindowDays }));
    for (const bad of [...bads, { version }]) {
      const res = await patch(id, bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(res.body.errors, JSON.stringify(bad)).toHaveProperty('returnWindowDays');
    }
    expect((await patch(id, { returnWindowDays: 7 })).body.errors).toHaveProperty('version');
    expect((await patch(id, { version, returnWindowDays: 7, shopName: 'x' })).status).toBe(422);
    expect((await patch(randomUUID(), { version, returnWindowDays: 0 })).status).toBe(422);
  });

  it('sàn returnWindow = platform_status: 422 errors.returnWindowDays, không đổi', async () => {
    const { id, version } = await activeShop('tiktok');

    const res = await patch(id, { version, returnWindowDays: 7 });

    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('returnWindowDays');
    expect((await testPool().query('select return_window_days, version from channel.shops where id = $1', [id])).rows[0]).toEqual({
      return_window_days: null,
      version,
    });
  });

  it('OpenAPI có PATCH /channel/shops/{id} với body ShopUpdateInput và 200, 404, 409, 422', async () => {
    const doc = (await app().get('/api/openapi.json')).body;
    const op = doc.paths['/api/v1/channel/shops/{id}'].patch;
    expect(JSON.stringify(op.requestBody)).toContain('ShopUpdateInput');
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '401', '403', '404', '409', '422']));
  });

  it('401 không token; 403 thiếu channel.shop.connect; 404 gian hàng công ty khác hoặc id sai', async () => {
    const { id, version } = await activeShop();
    expect((await app().patch(`/api/v1/channel/shops/${id}`).send({ version, returnWindowDays: 7 })).status).toBe(401);
    const viewer = await addMember(co.companyId, await createCustomRole(co.companyId, ['channel.shop.view']));
    expect((await patch(id, { version, returnWindowDays: 7 }, viewer.token)).status).toBe(403);
    expect((await patch(id, { returnWindowDays: 0 }, viewer.token)).status, '403 trước validate').toBe(403);
    const other = await createCompany({ optionalModules: ['channel'] });
    expect((await patch(id, { version, returnWindowDays: 7 }, other.ceo.token)).status).toBe(404);
    expect((await patch('khong-phai-uuid', { version, returnWindowDays: 7 })).status).toBe(404);
    expect((await patch(randomUUID(), { version, returnWindowDays: 7 })).status).toBe(404);
  });

  it('sửa hạn trả chen giữa lúc mất uỷ quyền: vẫn sang needs_reauth (khoá dòng, không mất cập nhật)', async () => {
    const { id } = await activeShop();

    await raceBehindLock(
      (holder) => holder.query('update channel.shops set return_window_days = 9, version = version + 1 where id = $1', [id]),
      1,
      () => withCompany(co.companyId, () => markNeedsReauth(id, 'refresh token hết hạn')),
    );

    const { rows } = await testPool().query('select status, return_window_days from channel.shops where id = $1', [id]);
    expect(rows[0]).toEqual({ status: 'needs_reauth', return_window_days: 9 });
  });
});
