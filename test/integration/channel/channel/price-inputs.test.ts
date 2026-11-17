import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { costsOf, shopPriceConfig } from '#src/modules/channel/channel/service/price-inputs.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// Đầu vào của bộ lọc giá theo gian hàng (#225, Documents/25 §6.2).

async function activeConfig(companyId: string, kind: string, shopId: string | null, payload: object) {
  await testPool().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, $2, $3, 'active', $4, '2026-10-01', $5, $6, now())`,
    [companyId, kind, shopId, JSON.stringify(payload), randomUUID(), randomUUID()],
  );
}

/** Đề nghị nhập đã duyệt có một dòng giá `unitPrice` cho biến thể. */
async function approvedRequest(companyId: string, variantId: string, unitPrice: string, createdAt: string) {
  const db = testPool();
  const { rows: s } = await db.query(`insert into product.suppliers (company_id, name) values ($1, $2) returning id`, [companyId, `NCC ${randomUUID()}`]);
  const { rows: r } = await db.query(
    `insert into product.purchase_requests (company_id, number, status, supplier_id, created_at)
     values ($1, $2, 'approved', $3, $4) returning id`,
    [companyId, `DN-${randomUUID().slice(0, 8)}`, s[0].id, createdAt],
  );
  await db.query(
    `insert into product.purchase_request_lines (company_id, request_id, variant_id, ordered_qty, unit_price) values ($1, $2, $3, 5, $4)`,
    [companyId, r[0].id, variantId, unitPrice],
  );
}

describe('shopPriceConfig', () => {
  it('cộng bốn mức phí, đọc phí mỗi món, làm tròn, thuế hộ kinh doanh và lãi tối thiểu của công ty', async () => {
    const { companyId } = await createCompany();
    const shopId = randomUUID();
    await activeConfig(companyId, 'fee', shopId, {
      fixedPct: 4,
      transactionPct: 5,
      servicePct: 3,
      optionalPct: 2,
      returnFee: 0,
      perItemFee: 3000,
      roundStep: 10000,
      roundEnding: 9000,
    });
    await activeConfig(companyId, 'tax_regime', null, { regime: 'household' });
    await activeConfig(companyId, 'tax_rules', null, { vatPct: 1, pitPct: 0.5, outputVatPct: 10, milestones: [] });
    await activeConfig(companyId, 'min_margin', null, { pct: 10 });
    const c = await withCompany(companyId, () => shopPriceConfig(shopId, new Date('2026-11-17T03:00:00Z')));
    expect(c.fee).toEqual({ feePct: '14', perItemFee: 3000, roundStep: 10000, roundEnding: 9000 });
    expect(c.feeConfigId).not.toBeNull();
    expect(c.taxPct.toString()).toBe('1.5');
    expect(c.minMarginPct).toBe(10);
  });

  it('gian hàng chưa có phí: fee null; chưa có thuế, lãi tối thiểu: 0', async () => {
    const { companyId } = await createCompany();
    const c = await withCompany(companyId, () => shopPriceConfig(randomUUID()));
    expect(c).toMatchObject({ fee: null, feeConfigId: null, minMarginPct: 0 });
    expect(c.taxPct.toString()).toBe('0');
  });
});

describe('shopPriceConfig: cộng phần trăm bằng Decimal (review #225 P1)', () => {
  it('4,15 + 3,3 + 1,2 + 0,55 = 9,2 đúng, không ra 9,200000000000001; phần thuế giữ 4 chữ số như cột tax_pct', async () => {
    const { companyId } = await createCompany();
    const shopId = randomUUID();
    await activeConfig(companyId, 'fee', shopId, { fixedPct: 4.15, transactionPct: 3.3, servicePct: 1.2, optionalPct: 0.55, returnFee: 0 });
    await activeConfig(companyId, 'tax_regime', null, { regime: 'company' });
    await activeConfig(companyId, 'tax_rules', null, { vatPct: 1, pitPct: 0.5, outputVatPct: 10, milestones: [] });
    const c = await withCompany(companyId, () => shopPriceConfig(shopId));
    expect(String(c.fee!.feePct)).toBe('9.2');
    expect(c.taxPct.toString()).toBe('9.0909');
  });
});

describe('costsOf', () => {
  it('còn tồn: giá vốn bình quân; hết tồn: giá đề nghị nhập gần nhất; không có cả hai: null', async () => {
    const { companyId } = await createCompany();
    const inStock = await createVariant(companyId);
    const soldOut = await createVariant(companyId);
    const never = await createVariant(companyId);
    await testPool().query(
      `insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, 4, 150000), ($1, $3, 0, 90000)`,
      [companyId, inStock.variantId, soldOut.variantId],
    );
    await approvedRequest(companyId, soldOut.variantId, '120000', '2026-10-01T00:00:00Z');
    await approvedRequest(companyId, soldOut.variantId, '125000', '2026-11-01T00:00:00Z');
    const costs = await withCompany(companyId, () => costsOf([inStock.variantId, soldOut.variantId, never.variantId]));
    expect(costs.get(inStock.variantId)).toBe('150000.00');
    expect(costs.get(soldOut.variantId)).toBe('125000.00');
    expect(costs.get(never.variantId)).toBeNull();
  });
});
