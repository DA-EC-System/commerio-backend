import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyMoves } from '#src/modules/product/inventory/service/posting.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { act, createSupplier, orderedRequest } from '../purchasing/helpers.ts';
import { companyWithVariants, inv, receive } from './helpers.ts';

// Cảnh báo dưới ngưỡng (V31, Documents/25 mục 7.5): chạm ngưỡng báo một lần, lên trên ngưỡng mới báo lại.

async function alerts(variantId: string) {
  const { rows } = await testPool().query(
    "select payload from core.outbox_messages where type = 'inventory.below_threshold' and key = $1 order by id",
    [variantId],
  );
  return rows.map((r) => r.payload);
}

async function alertActive(companyId: string, variantId: string): Promise<boolean> {
  const { rows } = await testPool().query('select alert_active from product.stock_levels where company_id = $1 and variant_id = $2', [
    companyId,
    variantId,
  ]);
  return rows[0].alert_active;
}

/** Tăng hoặc giảm tồn thực như một phiếu kho đã ghi sổ. */
const adjust = (companyId: string, variantId: string, qty: number) =>
  withCompany(companyId, () =>
    applyMoves({ type: 'stock_document', id: randomUUID() }, [{ variantId, bucket: 'on_hand', qty, unitCost: null, sourceLineId: null }], null),
  );

async function setMin(token: string, variantId: string, minQty: number | null) {
  const current = (await inv(token).get(`/stock/${variantId}`)).body.level.reorderVersion;
  const res = await inv(token).put(`/stock/${variantId}/reorder-rule`, { minQty, version: current });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe('cảnh báo dưới ngưỡng', () => {
  it('ghi sổ: chạm ngưỡng báo một lần, xuống tiếp không báo, lên trên ngưỡng rồi chạm lại thì báo lại', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    await receive(c.companyId, v, 10, 1000);
    await setMin(c.ceo.token, v, 5);
    expect(await alerts(v)).toEqual([]);

    await adjust(c.companyId, v, -5);
    expect(await alerts(v)).toEqual([{ variantId: v, available: 5, minQty: 5 }]);
    expect(await alertActive(c.companyId, v)).toBe(true);

    await adjust(c.companyId, v, -1);
    expect(await alerts(v)).toHaveLength(1);

    await adjust(c.companyId, v, 1);
    expect(await alertActive(c.companyId, v)).toBe(true);
    await adjust(c.companyId, v, 1);
    expect(await alertActive(c.companyId, v)).toBe(false);

    await adjust(c.companyId, v, -1);
    expect(await alerts(v)).toEqual([
      { variantId: v, available: 5, minQty: 5 },
      { variantId: v, available: 5, minQty: 5 },
    ]);
  });

  it('đặt ngưỡng khi đã ở dưới thì báo ngay; bỏ ngưỡng thì tắt cờ, không báo', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    await receive(c.companyId, v, 2, 1000);
    await setMin(c.ceo.token, v, 5);
    expect(await alerts(v)).toEqual([{ variantId: v, available: 2, minQty: 5 }]);
    await setMin(c.ceo.token, v, 4);
    expect(await alerts(v)).toHaveLength(1);
    await setMin(c.ceo.token, v, null);
    expect(await alertActive(c.companyId, v)).toBe(false);
    expect(await alerts(v)).toHaveLength(1);
  });

  it('đặt NCC làm đang về vượt ngưỡng thì tắt cờ; huỷ đề nghị thì đang về mất, chạm ngưỡng lại và báo', async () => {
    const c = await createCompany();
    const kho = (await addMember(c.companyId, 'warehouse')).token;
    const { variantId: v } = await createVariant(c.companyId);
    await receive(c.companyId, v, 3, 1000);
    await setMin(c.ceo.token, v, 5);
    expect(await alerts(v)).toHaveLength(1);

    const supplier = await createSupplier(c.ceo.token);
    const ordered = await orderedRequest({ requester: kho, ceo: c.ceo.token }, supplier.id, [{ variantId: v, quantity: 10, unitCost: 1000 }]);
    expect(await alertActive(c.companyId, v)).toBe(false);

    const cancelled = await act(c.ceo.token, ordered.id, 'cancel', { version: ordered.version, reason: 'NCC hết hàng' });
    expect(cancelled.status).toBe(200);
    expect(await alerts(v)).toEqual([
      { variantId: v, available: 3, minQty: 5 },
      { variantId: v, available: 3, minQty: 5 },
    ]);
  });

  it('SKU ngừng bán không báo dù chạm ngưỡng', async () => {
    const { companyId, variants } = await companyWithVariants();
    const v = variants[0]!;
    await receive(companyId, v, 10, 1000);
    await testPool().query('update product.stock_levels set min_qty = 5 where company_id = $1 and variant_id = $2', [companyId, v]);
    await testPool().query("update product.product_variants set business_status = 'discontinued' where id = $1", [v]);
    await adjust(companyId, v, -8);
    expect(await alerts(v)).toEqual([]);
  });
});
