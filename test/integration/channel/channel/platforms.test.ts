import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ShopPlatformList } from '#src/modules/channel/channel/api/schemas.ts';
import { createLazadaAdapter, type LazadaConfig } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

// Môi trường test không đặt LAZADA_* (vitest.config.ts) nên adapter Lazada mặc định thiếu cấu hình.
const lazada: LazadaConfig = {
  appKey: 'k',
  appSecret: 'super-secret',
  redirectUrl: 'https://fe.test/channel/lazada/callback',
  apiUrl: 'https://api.internal.test/rest',
  authUrl: 'https://auth.internal.test',
};

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
const get = (path: string, bearer = company.ceo.token) => app().get(`/api/v1/channel${path}`).set('Authorization', `Bearer ${bearer}`);
const platforms = async () => {
  const res = await get('/shops/platforms');
  expect(res.status).toBe(200);
  return ShopPlatformList.parse(res.body).items;
};

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
});
afterEach(() => resetAdapters());

describe('GET /channel/shops/platforms (#163)', () => {
  it('chưa adapter nào đủ cấu hình thì 200 items rỗng', async () => {
    expect(await platforms()).toEqual([]);
  });

  it('Lazada đủ key, secret, redirect thì có Lazada với oauth và token, không lộ cấu hình', async () => {
    registerAdapter('lazada', createLazadaAdapter(lazada));
    const res = await get('/shops/platforms');
    expect(res.body).toEqual({ items: [{ platform: 'lazada', name: 'Lazada', connectable: true, methods: ['oauth', 'token'] }] });
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['connectable', 'methods', 'name', 'platform']);
    expect(JSON.stringify(res.body)).not.toMatch(/super-secret|internal\.test|fe\.test/);
  });

  it('Lazada thiếu redirect thì chỉ nối bằng token; authorize-url 422 marketplace_unsupported', async () => {
    registerAdapter('lazada', createLazadaAdapter({ ...lazada, redirectUrl: undefined }));
    expect(await platforms()).toEqual([{ platform: 'lazada', name: 'Lazada', connectable: true, methods: ['token'] }]);
    const res = await get('/shops/lazada/authorize-url');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('marketplace_unsupported');
  });

  it('Lazada thiếu app secret thì không có trong danh sách; authorize-url 422 marketplace_unsupported', async () => {
    registerAdapter('lazada', createLazadaAdapter({ ...lazada, appSecret: undefined }));
    expect(await platforms()).toEqual([]);
    const res = await get('/shops/lazada/authorize-url');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('marketplace_unsupported');
  });

  it('endpoint không rẽ nhánh theo sàn: adapter nào khai cách nối thì có, khai rỗng thì không', async () => {
    registerAdapter('lazada', createLazadaAdapter(lazada));
    registerAdapter('shopee', fakeAdapter({ name: 'Shopee', connectMethods: () => ['token'] }));
    registerAdapter('tiktok', fakeAdapter({ name: 'TikTok Shop' }));
    expect((await platforms()).map((p) => [p.platform, p.methods])).toEqual([
      ['lazada', ['oauth', 'token']],
      ['shopee', ['token']],
    ]);
  });

  it('route tĩnh không nuốt /shops/:id: gian hàng không có vẫn 404', async () => {
    const res = await get(`/shops/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('401 không token; 403 thiếu channel.shop.view; 403 module_disabled khi tắt phân hệ', async () => {
    expect((await app().get('/api/v1/channel/shops/platforms')).status).toBe(401);
    const warehouse = await addMember(company.companyId, 'warehouse');
    const denied = await get('/shops/platforms', warehouse.token);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('forbidden');
    const off = await createCompany();
    const disabled = await get('/shops/platforms', off.ceo.token);
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('module_disabled');
  });

  it('Swagger có đường dẫn danh sách sàn', async () => {
    const doc = (await app().get('/api/openapi.json')).body;
    const op = doc.paths['/api/v1/channel/shops/platforms']?.get;
    expect(op).toBeDefined();
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '401', '403']));
    expect(doc.components.schemas.ShopPlatformList).toBeDefined();
  });
});
