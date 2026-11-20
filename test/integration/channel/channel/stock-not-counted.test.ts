// SKU kho chưa có số không đẩy tồn đè sàn (#460; Documents/25 §6.4 "Ghép listing có sẵn", §6.5). Cổng product thật
// (`countedOf`, `availableOf` của inventory), sàn giả bằng `registerAdapter`.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerSkuResult, PriceQuantity, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { productPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { lockPackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { settleHandover } from '#src/modules/order/fulfillment/service/handover-stock.ts';
import { createModuleContext } from '#src/wiring.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { seedPackage, stockOfVariant } from '../../order/fulfillment/helpers.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

setProductPort(null);
/** Tồn trên sàn theo SellerSku (sàn có sẵn 50 trước khi dùng app). */
const remote = new Map<string, number>();
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly PriceQuantity[]) =>
  items.map((i): PerSkuResult => ({ externalSkuId: i.externalSkuId, ok: true })),
);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop chưa kiểm kê', region: 'VN' };
    },
    async getSkus(_t, sellerSkus): Promise<RemoteSku[]> {
      return sellerSkus.flatMap((s) => {
        const q = remote.get(s);
        return q === undefined
          ? []
          : [{ externalProductId: `item-${s}`, externalSkuId: `sku-${s}`, sellerSku: s, title: s, state: 'live' as const, rejectReason: null, quantity: q, sellableQuantity: q }];
      });
    },
    updatePriceQuantity,
  }),
);
afterAll(() => resetAdapters());

let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const sync = () => syncListings(productPort(createModuleContext()), company.companyId, shopId);
const sentFor = (sku: string) => updatePriceQuantity.mock.calls.flatMap(([, items]) => items).find((i) => i.externalSkuId === `sku-${sku}`);

/** Listing của SKU sàn có sẵn vừa ghép: `live`, chờ đẩy tồn và giá (như `applyPatch` của ghép), sàn đang có 50. */
async function matched(stockSync: 'pending' | 'synced' = 'pending') {
  const { variantId, sku } = await createVariant(company.companyId);
  remote.set(sku, 50);
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status,
       content_source, stock_sync, platform_stock)
     values ($1, $2, $3, $4, $5, $6, 'live', 'platform', $7, 50)`,
    [company.companyId, shopId, variantId, `item-${sku}`, `sku-${sku}`, sku, stockSync],
  );
  return { variantId, sku };
}
async function listing(variantId: string) {
  const { rows } = await testPool().query('select * from channel.listings where shop_id = $1 and variant_id = $2', [shopId, variantId]);
  return rows[0];
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
});

beforeEach(() => {
  updatePriceQuantity.mockClear();
});

describe('SKU kho chưa có số (#460)', () => {
  it('ghép SKU chưa nhập: lượt đồng bộ không gửi tồn, giữ chờ kèm stock_not_counted, tồn sàn giữ 50', async () => {
    const { variantId, sku } = await matched();
    await sync();
    expect(sentFor(sku)?.quantity).toBeUndefined();
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'pending', platform_stock: 50, stock_sync_error: { code: 'stock_not_counted' } });
  });

  it('review Fable: ghép → đơn → bàn giao bắt buộc (tồn âm qua phiếu XK) → đồng bộ: sàn vẫn không nhận 0', async () => {
    const { variantId, sku } = await matched();
    const { packageId } = await seedPackage(company.companyId, {
      status: 'in_transit',
      handoverSource: 'marketplace',
      shopId,
      lines: [{ variantId, quantity: 1 }],
    });
    await withCompany(company.companyId, async () => settleHandover((await lockPackage(packageId))!, { actorId: null, mode: 'deduct' }));
    expect(await stockOfVariant(company.companyId, variantId)).toMatchObject({ onHand: -1 });

    await sync();
    expect(sentFor(sku)?.quantity).toBeUndefined();
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'pending', stock_sync_error: { code: 'stock_not_counted' } });
  });

  it('listing đã đồng bộ, sàn 50 cao hơn app 0: đối chiếu bỏ qua, không đẩy, không ghi platform_stock, không bật Lệch tồn', async () => {
    const { variantId, sku } = await matched('synced');
    remote.set(sku, 48);
    await sync();
    await sync();
    expect(sentFor(sku)).toBeUndefined();
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'synced', platform_stock: 50, stock_sync_error: null });
  });

  it('có phiếu nhận (thẻ kho tăng) thì lượt sau đẩy số có thể bán, hết nhãn', async () => {
    const { variantId, sku } = await matched();
    await sync();
    await receive(company.companyId, variantId, 4, 1000);
    updatePriceQuantity.mockClear();
    await sync();
    expect(sentFor(sku)).toMatchObject({ quantity: 4 });
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'synced', platform_stock: 4, stock_sync_error: null });
  });

  it('kiểm kê đã ghi sổ đếm 0 (không có thẻ kho) cũng là đã có số: đẩy 0', async () => {
    const { variantId, sku } = await matched();
    const doc = await testPool().query<{ id: string }>(
      `insert into product.stock_documents (company_id, number, kind, status, counted_at, posted_at)
       values ($1, $2, 'stocktake', 'posted', now(), now()) returning id`,
      [company.companyId, `KK-T${randomUUID().slice(0, 8)}`],
    );
    await testPool().query(
      `insert into product.stock_document_lines (company_id, document_id, variant_id, book_qty, counted_qty) values ($1, $2, $3, 0, 0)`,
      [company.companyId, doc.rows[0]!.id, variantId],
    );
    await sync();
    expect(sentFor(sku)).toMatchObject({ quantity: 0 });
  });
});
