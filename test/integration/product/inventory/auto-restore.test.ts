import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { receiveBack, receiveGoods } from '#src/modules/product/inventory/index.ts';
import { onVariantStatusChanged } from '#src/modules/product/inventory/service/background.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { archiveVariant, companyWithVariants, receive } from './helpers.ts';

// Hàng vào SKU đã lưu trữ thì SKU tự về Ngừng nhập (#204, Documents/21 §17.3 dòng "(hệ thống)", US-SP-07 dòng 4);
// inventory xét lại ngưỡng khi trạng thái kinh doanh đổi (Documents/21 V31, 25 §7.5).

const statusOf = async (variantId: string) =>
  (await testPool().query('select business_status, archived_at from product.product_variants where id = $1', [variantId])).rows[0];
const history = async (variantId: string) =>
  (
    await testPool().query(
      'select from_state, to_state, action, actor_id, source from core.state_transitions where entity_type = $1 and entity_id = $2',
      ['product_variants', variantId],
    )
  ).rows;
const statusEvents = async (variantId: string) =>
  (
    await testPool().query("select payload from core.outbox_messages where type = 'catalog.variant_status_changed' and key = $1", [
      variantId,
    ])
  ).rows.map((r) => r.payload);

const goods = (variantId: string, accepted: number) => [
  { lineId: randomUUID(), variantId, accepted, defective: 0, unitCost: '100000.00' },
];

describe('tự khôi phục SKU lưu trữ khi có hàng vào (#204)', () => {
  it('nhận hàng NCC vào tồn thực → SKU về discontinued, lịch sử hệ thống, sự kiện', async () => {
    const { companyId, variants } = await companyWithVariants(1);
    const v = variants[0]!;
    await archiveVariant(v);
    await withCompany(companyId, () => receiveGoods(randomUUID(), goods(v, 2), null));
    expect(await statusOf(v)).toEqual({ business_status: 'discontinued', archived_at: null });
    expect(await history(v)).toEqual([{ from_state: 'archived', to_state: 'discontinued', action: 'restore', actor_id: null, source: 'system' }]);
    expect(await statusEvents(v)).toEqual([
      { variantId: v, productId: expect.any(String), from: 'archived', to: 'discontinued', changedAt: expect.any(String) },
    ]);
  });

  it('hàng hoàn vào chờ xử lý (receiveBack) → SKU về discontinued', async () => {
    const { companyId, variants } = await companyWithVariants(1);
    const v = variants[0]!;
    await archiveVariant(v);
    await withCompany(companyId, () => receiveBack({ type: 'package', id: randomUUID() }, [{ variantId: v, expected: 1, scanned: 1 }]));
    expect((await statusOf(v)).business_status).toBe('discontinued');
  });

  it('SKU đang bán nhận hàng → không có dòng lịch sử nào', async () => {
    const { companyId, variants } = await companyWithVariants(1);
    const v = variants[0]!;
    await withCompany(companyId, () => receiveGoods(randomUUID(), goods(v, 2), null));
    expect((await statusOf(v)).business_status).toBe('selling');
    expect(await history(v)).toEqual([]);
  });
});

describe('onVariantStatusChanged: inventory xét lại ngưỡng (#204)', () => {
  const event = (variantId: string, from: string, to: string) =>
    ({
      payload: { variantId, productId: randomUUID(), from, to, changedAt: new Date().toISOString() },
    }) as Parameters<typeof onVariantStatusChanged>[0];
  const alertActive = async (companyId: string, variantId: string) =>
    (await testPool().query('select alert_active from product.stock_levels where company_id = $1 and variant_id = $2', [companyId, variantId]))
      .rows[0].alert_active;
  const belowThreshold = async (variantId: string) =>
    (await testPool().query("select 1 from core.outbox_messages where type = 'inventory.below_threshold' and key = $1", [variantId])).rowCount;

  it('sang Ngừng nhập thì tắt cảnh báo; quay lại Kinh doanh khi đang dưới ngưỡng thì báo lại', async () => {
    const { companyId, variants } = await companyWithVariants(1);
    const v = variants[0]!;
    await receive(companyId, v, 1, 1000);
    await testPool().query('update product.stock_levels set min_qty = 5, alert_active = true where company_id = $1 and variant_id = $2', [
      companyId,
      v,
    ]);
    await testPool().query("update product.product_variants set business_status = 'discontinued' where id = $1", [v]);
    await withCompany(companyId, () => onVariantStatusChanged(event(v, 'selling', 'discontinued')));
    expect(await alertActive(companyId, v)).toBe(false);

    await testPool().query("update product.product_variants set business_status = 'selling' where id = $1", [v]);
    await withCompany(companyId, () => onVariantStatusChanged(event(v, 'discontinued', 'selling')));
    expect(await alertActive(companyId, v)).toBe(true);
    expect(await belowThreshold(v)).toBe(1);
  });
});
