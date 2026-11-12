// Đẩy tồn lên sàn bằng cổng `availableOf` thật của inventory (#222), không thay cổng product bằng bản giả.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PerSkuResult, PriceQuantity } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { markStockPending, onAvailableChanged, syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { runStockPush } from '#src/modules/channel/channel/service/background.ts';
import { awaitingStocktakeShops } from '#src/modules/channel/index.ts';
import { onStockChanged } from '#src/modules/order/fulfillment/service/allocation.ts';
import { productPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createModuleContext } from '#src/wiring.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive, setBuckets } from '../../product/inventory/helpers.ts';
import { outboxOf } from '../../order/fulfillment/helpers.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

setProductPort(null);
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly PriceQuantity[]) =>
  items.map((i): PerSkuResult => ({ externalSkuId: i.externalSkuId, ok: true })),
);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    getSkus: async () => [],
    updatePriceQuantity,
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
const sync = () => syncListings(productPort(createModuleContext()), company.companyId, shopId);

/** Listing đã trên sàn, chờ đẩy tồn; ghi thẳng vì luồng đẩy sản phẩm đã có test riêng. */
async function liveListing(variantId: string, sellerSku: string) {
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status)
     values ($1, $2, $3, $4, $5, $6, 'live')`,
    [company.companyId, shopId, variantId, `item-${sellerSku}`, `sku-${sellerSku}`, sellerSku],
  );
}
async function listing(variantId: string) {
  const { rows } = await testPool().query('select * from channel.listings where shop_id = $1 and variant_id = $2', [
    shopId,
    variantId,
  ]);
  return rows[0];
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({
    accessToken: `tok-${randomUUID().slice(0, 12)}`,
  });
  shopId = res.body.shop.id;
});

describe('đẩy tồn bằng số có thể bán của inventory', () => {
  it('tồn thực 5, đang giữ 2 → sàn nhận 3, đọc lại synced với platform_stock 3', async () => {
    const { variantId, sku } = await createVariant(company.companyId);
    await receive(company.companyId, variantId, 5, 1000);
    await setBuckets(company.companyId, variantId, { reserved: 2 });
    await liveListing(variantId, sku);
    updatePriceQuantity.mockClear();

    await sync();
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [
      { externalProductId: `item-${sku}`, externalSkuId: `sku-${sku}`, quantity: 3 },
    ]);
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'synced', platform_stock: 3 });
  });

  it('biến thể không có trong Map (không còn trong catalog) → không gửi SKU đó, giữ stock_sync pending', async () => {
    const ghost = randomUUID();
    await liveListing(ghost, 'GHOST-1');
    updatePriceQuantity.mockClear();

    await sync();
    const sent = updatePriceQuantity.mock.calls.flatMap(([, items]) => items);
    expect(sent.find((i) => i.externalSkuId === 'sku-GHOST-1')).toBeUndefined();
    const row = await listing(ghost);
    expect(row).toMatchObject({ stock_sync: 'pending', platform_stock: null });
    expect(row.stock_sync_error).toMatchObject({ code: 'variant_missing' });
  });

  it('tồn đổi giữa lúc đọc số và lúc ghi kết quả → dòng vẫn pending, lượt sau đẩy số mới', async () => {
    const { variantId, sku } = await createVariant(company.companyId);
    await receive(company.companyId, variantId, 5, 1000);
    await liveListing(variantId, sku);
    updatePriceQuantity.mockImplementationOnce(async (_t, items) => {
      // Phiếu kho giảm tồn trong lúc chờ sàn: consumer đánh dấu lại pending.
      await setBuckets(company.companyId, variantId, { onHand: 1 });
      await withCompany(company.companyId, () => markStockPending([variantId]));
      return items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true }));
    });
    await sync();
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'pending', platform_stock: null });

    updatePriceQuantity.mockClear();
    await sync();
    // Listing ca trước chưa có giá chuẩn nên cũng nằm trong lượt này; chỉ xét SKU của ca này.
    const sent = updatePriceQuantity.mock.calls.flatMap(([, items]) => items);
    expect(sent.find((i) => i.externalSkuId === `sku-${sku}`)).toEqual({
      externalProductId: `item-${sku}`,
      externalSkuId: `sku-${sku}`,
      quantity: 1,
    });
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'synced', platform_stock: 1 });
  });

  it('listing không ghép SKU (unmanaged) → không đẩy tồn', async () => {
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, mode, external_product_id, external_sku_id, seller_sku, status, approved_by)
       values ($1, $2, 'unmanaged', 'item-UM-1', 'sku-UM-1', 'UM-1', 'live', $3)`,
      [company.companyId, shopId, randomUUID()],
    );
    updatePriceQuantity.mockClear();
    await sync();
    const sent = updatePriceQuantity.mock.calls.flatMap(([, items]) => items);
    expect(sent.find((i) => i.externalSkuId === 'sku-UM-1')).toBeUndefined();
  });
});

// Chuỗi nối thật giữa ba module (#223 mục 5): tồn đổi → consumer phân hàng của fulfillment → `allocation_done` → consumer
// đẩy tồn của channel → việc `channel.stock_push`. Gọi đúng handler mà `startBackground` đăng ký, không sửa module khác.
describe('chuỗi tồn đổi → phân hàng → allocation_done → đẩy tồn', () => {
  it('SKU không có kiện: nhập 7 → listing pending, có việc channel.stock_push; chạy việc thì sàn nhận 7', async () => {
    // `channel.stock_push` chỉ chạy cho gian hàng `active` (các ca trên đồng bộ lúc gian hàng còn `connecting`).
    await activateShop(shopId);
    const { variantId, sku } = await createVariant(company.companyId);
    await liveListing(variantId, sku);
    await testPool().query(`update channel.listings set stock_sync = 'synced' where shop_id = $1 and variant_id = $2`, [shopId, variantId]);
    await testPool().query("delete from pgboss.job where name = 'channel.stock_push' and data->>'shopId' = $1", [shopId]);
    await receive(company.companyId, variantId, 7, 1000);

    // inventory phát `inventory.stock_changed { variantId }`; fulfillment chạy một lượt phân hàng rồi phát allocation_done.
    await withCompany(company.companyId, () => onStockChanged({ stockHoldOf: awaitingStocktakeShops })({ payload: { variantId } }));
    const done = (await outboxOf(company.companyId, 'fulfillment.allocation_done')).filter((p) =>
      (p.variantIds as string[]).includes(variantId),
    );
    expect(done).toEqual([{ variantIds: [variantId] }]);

    await withCompany(company.companyId, () => onAvailableChanged(done[0] as { variantIds: string[] }));
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'pending' });
    const jobs = await testPool().query("select data from pgboss.job where name = 'channel.stock_push' and data->>'shopId' = $1", [shopId]);
    expect(jobs.rows).toEqual([{ data: { companyId: company.companyId, shopId } }]);

    updatePriceQuantity.mockClear();
    await runStockPush(productPort(createModuleContext()), jobs.rows[0].data);
    const sent = updatePriceQuantity.mock.calls.flatMap(([, items]) => items);
    expect(sent.find((i) => i.externalSkuId === `sku-${sku}`)).toMatchObject({ quantity: 7 });
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'synced', platform_stock: 7 });
  });
});
