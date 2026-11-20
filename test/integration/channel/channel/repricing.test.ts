import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { onConfigActivated, onStockChanged, onVariantPriceChanged } from '#src/modules/channel/channel/service/repricing.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// Tính lại giá theo gian hàng (#225, Documents/25 §6.2, 21 §11.2): đổi giá muốn bán, kích hoạt cấu hình phí, thuế, lãi
// tối thiểu thì có bản chờ xác nhận; giá đang bán không tự đổi.
const db = () => testPool();
const FEE = { fixedPct: 4, transactionPct: 5, servicePct: 3, optionalPct: 2, returnFee: 0, perItemFee: 3000, roundStep: 10000, roundEnding: 9000 };

async function shop(companyId: string) {
  const { rows } = await db().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at)
     values ($1, 'lazada', $2, 'Shop Thử', 'active', now()) returning id`,
    [companyId, randomUUID()],
  );
  return rows[0]!.id;
}

async function activeConfig(companyId: string, kind: string, shopId: string | null, payload: object) {
  const { rows } = await db().query<{ id: string }>(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, $2, $3, 'active', $4, '2026-10-01', $5, $6, now()) returning id`,
    [companyId, kind, shopId, JSON.stringify(payload), randomUUID(), randomUUID()],
  );
  return rows[0]!.id;
}

async function listedVariant(companyId: string, shopIds: string[], target: string | null) {
  const { variantId, productId } = await createVariant(companyId);
  await db().query('update product.product_variants set target_net_price = $2 where id = $1', [variantId, target]);
  for (const shopId of shopIds) {
    await db().query(
      `insert into channel.listings (company_id, shop_id, variant_id, status, external_sku_id) values ($1, $2, $3, 'live', $4)`,
      [companyId, shopId, variantId, randomUUID()],
    );
  }
  return { variantId, productId };
}

const pendingOf = async (shopId: string, variantId: string) =>
  (
    await db().query(
      `select rounded_price, net_received, below_floor, cost, fee_pct, tax_pct, trigger, fee_version_id from channel.price_calculations
       where shop_id = $1 and variant_id = $2 and status = 'pending_confirm'`,
      [shopId, variantId],
    )
  ).rows;

const priceChanged = (companyId: string, v: { variantId: string; productId: string }, to: string | null) =>
  withCompany(companyId, () => onVariantPriceChanged({ ...v, from: null, to, changedAt: new Date().toISOString() }));

const activated = (companyId: string, configVersionId: string, kind: 'fee' | 'tax_rules' | 'mismatch_threshold', shopId: string | null) =>
  withCompany(companyId, () => onConfigActivated({ configVersionId, kind, shopId, effectiveFrom: '2026-10-01', supersededId: null }));

describe('đổi giá muốn bán', () => {
  it('có bản chờ theo bộ lọc giá trên mỗi gian hàng có phí: (200.000 + 3.000) / 0,86 → 239.000', async () => {
    const { companyId } = await createCompany();
    const s = await shop(companyId);
    const feeId = await activeConfig(companyId, 'fee', s, FEE);
    const v = await listedVariant(companyId, [s], '200000');
    await priceChanged(companyId, v, '200000');
    expect(await pendingOf(s, v.variantId)).toEqual([
      {
        rounded_price: '239000.00',
        net_received: '202540.00',
        below_floor: null,
        cost: null,
        fee_pct: '14.00',
        tax_pct: '0.0000',
        trigger: 'target_changed',
        fee_version_id: feeId,
      },
    ]);
  });

  it('giá mới dưới giá thấp nhất vẫn có bản chờ, kèm cờ', async () => {
    const { companyId } = await createCompany();
    const s = await shop(companyId);
    await activeConfig(companyId, 'fee', s, FEE);
    await activeConfig(companyId, 'min_margin', null, { pct: 10 });
    const v = await listedVariant(companyId, [s], '150000');
    await db().query('insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, 3, 150000)', [
      companyId,
      v.variantId,
    ]);
    await priceChanged(companyId, v, '150000');
    // (150.000 + 3.000) / 0,86 = 177.907 → 179.000, thực nhận 150.940 < 165.000
    expect(await pendingOf(s, v.variantId)).toMatchObject([{ rounded_price: '179000.00', below_floor: true, cost: '150000.00' }]);
  });

  it('gian hàng chưa có phí: không có bản chờ (dùng giá chuẩn)', async () => {
    const { companyId } = await createCompany();
    const s = await shop(companyId);
    const v = await listedVariant(companyId, [s], '200000');
    await priceChanged(companyId, v, '200000');
    expect(await pendingOf(s, v.variantId)).toEqual([]);
  });

  it('xoá giá muốn bán thì bỏ bản chờ; tính lại thay bản chờ cũ', async () => {
    const { companyId } = await createCompany();
    const s = await shop(companyId);
    await activeConfig(companyId, 'fee', s, FEE);
    const v = await listedVariant(companyId, [s], '200000');
    await priceChanged(companyId, v, '200000');
    await db().query('update product.product_variants set target_net_price = 300000 where id = $1', [v.variantId]);
    await priceChanged(companyId, v, '300000');
    expect(await pendingOf(s, v.variantId)).toMatchObject([{ rounded_price: '359000.00' }]);
    await db().query('update product.product_variants set target_net_price = null where id = $1', [v.variantId]);
    await priceChanged(companyId, v, null);
    expect(await pendingOf(s, v.variantId)).toEqual([]);
  });

  it('giá tính ra trùng giá đang bán (lần tính đã xác nhận) thì không thêm bản chờ', async () => {
    const { companyId } = await createCompany();
    const s = await shop(companyId);
    await activeConfig(companyId, 'fee', s, FEE);
    const v = await listedVariant(companyId, [s], '200000');
    await priceChanged(companyId, v, '200000');
    await db().query(
      `with c as (update channel.price_calculations set status = 'confirmed', confirmed_by = $3, confirmed_at = now()
                  where shop_id = $1 and variant_id = $2 returning id)
       update channel.listings set price_calc_id = (select id from c) where shop_id = $1 and variant_id = $2`,
      [s, v.variantId, randomUUID()],
    );
    await priceChanged(companyId, v, '200000');
    expect(await pendingOf(s, v.variantId)).toEqual([]);
  });
});

describe('kích hoạt cấu hình', () => {
  it('phí của một gian hàng: bản chờ cho mọi listing của gian hàng đó, không đụng gian hàng khác', async () => {
    const { companyId } = await createCompany();
    const [a, b] = [await shop(companyId), await shop(companyId)];
    const feeId = await activeConfig(companyId, 'fee', a, FEE);
    await activeConfig(companyId, 'fee', b, FEE);
    const v1 = await listedVariant(companyId, [a, b], '200000');
    const v2 = await listedVariant(companyId, [a], '100000');
    await activated(companyId, feeId, 'fee', a);
    expect(await pendingOf(a, v1.variantId)).toMatchObject([{ rounded_price: '239000.00', trigger: 'config_activated' }]);
    expect(await pendingOf(a, v2.variantId)).toMatchObject([{ rounded_price: '129000.00' }]);
    expect(await pendingOf(b, v1.variantId)).toEqual([]);
  });

  it('quy tắc thuế (cấp công ty): tính lại mọi gian hàng; hộ kinh doanh cộng 1,5%', async () => {
    const { companyId } = await createCompany();
    const [a, b] = [await shop(companyId), await shop(companyId)];
    await activeConfig(companyId, 'fee', a, FEE);
    await activeConfig(companyId, 'fee', b, FEE);
    await activeConfig(companyId, 'tax_regime', null, { regime: 'household' });
    const rulesId = await activeConfig(companyId, 'tax_rules', null, { vatPct: 1, pitPct: 0.5, outputVatPct: 10, milestones: [] });
    const v = await listedVariant(companyId, [a, b], '200000');
    await activated(companyId, rulesId, 'tax_rules', null);
    // (200.000 + 3.000) / 0,845 = 240.237 → 249.000
    for (const s of [a, b]) expect(await pendingOf(s, v.variantId)).toMatchObject([{ rounded_price: '249000.00', tax_pct: '1.5000' }]);
  });

  it('ngưỡng lệch quyết toán không liên quan giá: không tính lại', async () => {
    const { companyId } = await createCompany();
    const s = await shop(companyId);
    await activeConfig(companyId, 'fee', s, FEE);
    const id = await activeConfig(companyId, 'mismatch_threshold', null, { abs: 1000, pct: 1, resolveLimit: 0 });
    const v = await listedVariant(companyId, [s], '200000');
    await activated(companyId, id, 'mismatch_threshold', null);
    expect(await pendingOf(s, v.variantId)).toEqual([]);
  });
});

// Giá vốn tăng làm listing đang bán rơi dưới giá thấp nhất (#225 A1; 25 §6.2 "cảnh báo và đề xuất giá mới; không tự đổi").
describe('giá vốn đổi', () => {
  /** Listing đang bán giá 239.000 (thực nhận 202.540) trên gian hàng phí 14% + 3.000, lãi tối thiểu 10%; giá vốn bình quân `cost`. */
  async function selling(target: string | null, cost: number | null) {
    const { companyId } = await createCompany();
    const s = await shop(companyId);
    await activeConfig(companyId, 'fee', s, FEE);
    await activeConfig(companyId, 'min_margin', null, { pct: 10 });
    const { variantId, productId } = await createVariant(companyId);
    await db().query('update product.product_variants set target_net_price = $2 where id = $1', [variantId, target]);
    if (cost !== null) {
      await db().query('insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, 5, $3)', [companyId, variantId, cost]);
    }
    await db().query(
      `insert into channel.listings (company_id, shop_id, variant_id, status, external_sku_id, listed_price) values ($1, $2, $3, 'live', $4, 239000)`,
      [companyId, s, variantId, randomUUID()],
    );
    const changed = () => withCompany(companyId, () => onStockChanged({ variantId, onHand: 5, reserved: 0, available: 5 }));
    return { companyId, s, variantId, productId, changed };
  }

  it('giá vốn 190.000 (giá thấp nhất 209.000) mà đang bán thực nhận 202.540: bản chờ trigger cost, giá đủ giá thấp nhất', async () => {
    const t = await selling('200000', 190000);
    await t.changed();
    // Thực nhận cần ≥ 209.000: (209.000 + 3.000) / 0,86 = 246.512 → làm tròn lên 249.000, thực nhận 211.140.
    expect(await pendingOf(t.s, t.variantId)).toMatchObject([{ rounded_price: '249000.00', net_received: '211140.00', below_floor: false, cost: '190000.00', trigger: 'cost' }]);
  });

  it('giá muốn bán cao hơn giá thấp nhất thì đề xuất theo giá muốn bán', async () => {
    const t = await selling('230000', 190000);
    await t.changed();
    // (230.000 + 3.000) / 0,86 = 270.930 → 279.000.
    expect(await pendingOf(t.s, t.variantId)).toMatchObject([{ rounded_price: '279000.00', below_floor: false, trigger: 'cost' }]);
  });

  it('giá đang bán còn đủ giá thấp nhất (giá vốn 150.000): không có bản chờ', async () => {
    const t = await selling('200000', 150000);
    await t.changed();
    expect(await pendingOf(t.s, t.variantId)).toEqual([]);
  });

  it('đã có bản chờ đủ giá thấp nhất (đổi giá muốn bán trước đó): giữ bản đó', async () => {
    const t = await selling('240000', 190000);
    await priceChanged(t.companyId, { variantId: t.variantId, productId: t.productId }, '240000');
    await t.changed();
    expect(await pendingOf(t.s, t.variantId)).toMatchObject([{ trigger: 'target_changed' }]);
  });

  it('chưa có giá vốn: không đề xuất', async () => {
    const t = await selling('200000', null);
    await t.changed();
    expect(await pendingOf(t.s, t.variantId)).toEqual([]);
  });
});
