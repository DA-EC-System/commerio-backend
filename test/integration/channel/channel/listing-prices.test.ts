import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { listListings } from '#src/modules/channel/channel/service/listings.ts';
import { productPort } from '#src/modules/channel/channel/service/product-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import type { ModuleContext } from '#src/shared/module.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// Giá theo gian hàng trên trang listing (#225, Documents/21 §18.6.7): ghi đè tay > giá đã xác nhận > giá chuẩn; thực nhận
// và cờ Dưới giá thấp nhất tính từ giá đang bán, không trả giá vốn.
const db = () => testPool();
const port = productPort({} as ModuleContext);
const FEE = { fixedPct: 4, transactionPct: 5, servicePct: 3, optionalPct: 2, returnFee: 0, perItemFee: 3000, roundStep: 10000, roundEnding: 9000 };

async function setup(withFee = true) {
  const { companyId } = await createCompany();
  const { rows } = await db().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at)
     values ($1, 'lazada', $2, 'Shop Thử', 'active', now()) returning id`,
    [companyId, randomUUID()],
  );
  const shopId = rows[0]!.id;
  if (withFee)
    await db().query(
      `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
       values ($1, 'fee', $2, 'active', $3, '2026-10-01', $4, $5, now()), ($1, 'min_margin', null, 'active', '{"pct":10}', '2026-10-01', $4, $5, now())`,
      [companyId, shopId, JSON.stringify(FEE), randomUUID(), randomUUID()],
    );
  const { variantId } = await createVariant(companyId);
  await db().query('update product.product_variants set standard_price = 250000 where id = $1', [variantId]);
  await db().query('insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, 2, 150000)', [companyId, variantId]);
  const { rows: l } = await db().query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, status, external_sku_id) values ($1, $2, $3, 'live', $4) returning id`,
    [companyId, shopId, variantId, randomUUID()],
  );
  return { companyId, shopId, variantId, listingId: l[0]!.id };
}

async function calc(s: { companyId: string; shopId: string; variantId: string }, price: number, status: string) {
  const { rows } = await db().query<{ id: string }>(
    `insert into channel.price_calculations (company_id, shop_id, variant_id, cost, target_net, raw_price, rounded_price, net_received,
       margin_pct, below_floor, fee_pct, tax_pct, trigger, status, confirmed_by, fee_version_id)
     values ($1, $2, $3, 150000, 200000, $4, $4, 0, 0, false, 14, 0, 'target_changed', $5, $6, $7) returning id`,
    [s.companyId, s.shopId, s.variantId, price, status, status === 'pending_confirm' ? null : randomUUID(), randomUUID()],
  );
  return rows[0]!.id;
}

const rowOf = async (s: { companyId: string; shopId: string; variantId: string }) =>
  (await withCompany(s.companyId, () => listListings(port, s.shopId))).items.find((i) => i.variantId === s.variantId)!;

describe('giá theo gian hàng trên ListingRow', () => {
  it('gian hàng chưa có phí: giá chuẩn, không có thực nhận, cờ', async () => {
    const s = await setup(false);
    expect(await rowOf(s)).toMatchObject({
      price: 250000,
      priceSource: 'standard',
      shopPrice: null,
      pendingPrice: null,
      netReceived: null,
      belowFloor: null,
      feeWarning: null,
    });
  });

  it('chưa xác nhận giá theo gian hàng: giá chuẩn, thực nhận theo phí của gian hàng', async () => {
    const s = await setup();
    // 250.000 × 0,86 − 3.000 = 212.000 ≥ 165.000
    expect(await rowOf(s)).toMatchObject({ price: 250000, priceSource: 'standard', netReceived: 212000, belowFloor: false });
  });

  it('lần tính đã xác nhận: giá theo gian hàng; bản chờ hiện ở pendingPrice kèm phiên bản phí', async () => {
    const s = await setup();
    const id = await calc(s, 239000, 'confirmed');
    await db().query('update channel.listings set price_calc_id = $2 where id = $1', [s.listingId, id]);
    await calc(s, 189000, 'pending_confirm');
    const row = await rowOf(s);
    // 189.000 × 0,86 − 3.000 = 159.540 < 165.000 nhưng cờ tính theo giá đang bán (239.000)
    expect(row).toMatchObject({ price: 239000, priceSource: 'shop', shopPrice: 239000, pendingPrice: 189000, netReceived: 202540, belowFloor: false });
    expect(row.configVersionId).toEqual(expect.any(String));
  });

  it('ghi đè tay thắng giá theo gian hàng; dưới giá thấp nhất thì bật cờ, không trả giá vốn', async () => {
    const s = await setup();
    const id = await calc(s, 239000, 'confirmed');
    await db().query('update channel.listings set price_calc_id = $2, manual_price = 195000 where id = $1', [s.listingId, id]);
    const row = await rowOf(s);
    expect(row).toMatchObject({ price: 195000, priceSource: 'override', shopPrice: 239000, netReceived: 164700, belowFloor: true });
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['cost']));
    expect(JSON.stringify(row)).not.toMatch(/150000|165000/);
  });
});
