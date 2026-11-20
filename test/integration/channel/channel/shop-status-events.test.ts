// Gian hàng đổi trạng thái thì phát `channel.shop_status_changed` cùng giao dịch (#216, spec 5.4, AC7); ngắt gian hàng
// không phát sự kiện listing (D12).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { markNeedsReauth } from '#src/modules/channel/channel/service/shop-tokens.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { outboxOf } from '../../order/fulfillment/helpers.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
});

/** Nối bằng token; cùng token thì nối lại đúng gian hàng đó. */
async function connect(token: string): Promise<string> {
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: token });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.shop.id as string;
}
const newToken = () => `tok-${randomUUID().slice(0, 12)}`;
const shopEvents = (shopId: string) => outboxOf(shopId, 'channel.shop_status_changed');
const loseAuth = (shopId: string) => withCompany(company.companyId, () => markNeedsReauth(shopId, 'thử'));

describe('channel.shop_status_changed (#216 AC7)', () => {
  it('kết nối mới: một sự kiện null → connecting', async () => {
    const shopId = await connect(newToken());
    expect(await shopEvents(shopId)).toEqual([{ shopId, from: null, to: 'connecting' }]);
  });

  it('mất uỷ quyền: active → needs_reauth; gọi lại khi đã needs_reauth không phát thêm', async () => {
    const shopId = await connect(newToken());
    await activateShop(shopId);
    await loseAuth(shopId);
    await loseAuth(shopId);
    expect((await shopEvents(shopId)).slice(1)).toEqual([{ shopId, from: 'active', to: 'needs_reauth' }]);
  });

  it('nối lại gian hàng đã thiết lập: needs_reauth → active', async () => {
    const token = newToken();
    const shopId = await connect(token);
    await activateShop(shopId);
    await loseAuth(shopId);
    await connect(token);
    expect((await shopEvents(shopId)).at(-1)).toEqual({ shopId, from: 'needs_reauth', to: 'active' });
  });

  it('nối lại gian hàng chưa thiết lập: needs_reauth → connecting (resume_setup)', async () => {
    const token = newToken();
    const shopId = await connect(token);
    await loseAuth(shopId);
    await connect(token);
    expect((await shopEvents(shopId)).slice(1)).toEqual([
      { shopId, from: 'connecting', to: 'needs_reauth' },
      { shopId, from: 'needs_reauth', to: 'connecting' },
    ]);
  });

  it('nối lại khi đang active: không phát', async () => {
    const token = newToken();
    const shopId = await connect(token);
    await activateShop(shopId);
    const before = (await shopEvents(shopId)).length;
    await connect(token);
    expect(await shopEvents(shopId)).toHaveLength(before);
  });

  it('ngắt: active → disconnected; listing gỡ do ngắt không phát listing_sync_changed (D12)', async () => {
    const shopId = await connect(newToken());
    await activateShop(shopId);
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id, stock_sync)
       values ($1, $2, $3, $4, 'live', 'item-1', 'sku-1', 'synced')`,
      [company.companyId, shopId, randomUUID(), `SKU-${randomUUID().slice(0, 8)}`],
    );
    const { rows } = await testPool().query<{ version: number }>('select version from channel.shops where id = $1', [shopId]);
    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/disconnect`)).send({ version: rows[0]!.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await shopEvents(shopId)).at(-1)).toEqual({ shopId, from: 'active', to: 'disconnected' });
    const listing = await testPool().query<{ status: string }>('select status from channel.listings where shop_id = $1', [shopId]);
    expect(listing.rows).toEqual([{ status: 'delisted' }]);
    expect(await outboxOf(shopId, 'channel.listing_sync_changed')).toEqual([]);
  });
});
