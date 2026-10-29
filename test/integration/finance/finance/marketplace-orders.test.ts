import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findMarketplaceOrders } from '#src/modules/order/sales/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

// Tìm đơn sàn theo (gian hàng, mã đơn sàn) cho đối soát (plan #30 lát 3, A6).
async function marketplaceOrder(companyId: string, unitPrice = 120000) {
  const v = await createVariant(companyId);
  const order = await createOrder(companyId, {
    source: 'marketplace',
    lines: [{ variantId: v.variantId, quantity: 1, unitPrice }],
  });
  const { rows } = await testPool().query<{ shop_id: string; external_order_id: string }>(
    'select shop_id, external_order_id from "order".orders where id = $1',
    [order.orderId],
  );
  return { ...order, shopId: rows[0]!.shop_id, externalOrderId: rows[0]!.external_order_id };
}

describe('findMarketplaceOrders', () => {
  it('trả đơn theo mã đơn sàn của đúng gian hàng, kèm tổng đơn', async () => {
    const { companyId } = await createCompany();
    const o = await marketplaceOrder(companyId);
    const found = await withCompany(companyId, () => findMarketplaceOrders(o.shopId, [o.externalOrderId, 'khong-co']));
    expect([...found.keys()]).toEqual([o.externalOrderId]);
    expect(found.get(o.externalOrderId)!.id).toBe(o.orderId);
    expect(found.get(o.externalOrderId)!.total.toFixed(2)).toBe('120000.00');
  });

  it('cùng mã đơn sàn nhưng gian hàng khác thì không thấy', async () => {
    const { companyId } = await createCompany();
    const o = await marketplaceOrder(companyId);
    const found = await withCompany(companyId, () => findMarketplaceOrders(randomUUID(), [o.externalOrderId]));
    expect(found.size).toBe(0);
  });

  it('đơn của công ty khác không thấy (RLS)', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const o = await marketplaceOrder(a.companyId);
    const found = await withCompany(b.companyId, () => findMarketplaceOrders(o.shopId, [o.externalOrderId]));
    expect(found.size).toBe(0);
  });

  it('gian hàng không phải uuid hoặc danh sách rỗng thì rỗng, không lỗi', async () => {
    const { companyId } = await createCompany();
    await expect(withCompany(companyId, () => findMarketplaceOrders('x', ['a']))).resolves.toEqual(new Map());
    await expect(withCompany(companyId, () => findMarketplaceOrders(randomUUID(), []))).resolves.toEqual(new Map());
  });
});
