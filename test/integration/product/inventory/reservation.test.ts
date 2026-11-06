import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { release, reserve } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { companyWithVariants, receive } from './helpers.ts';

// Giữ và nhả hàng cho kiện (spec #206 mục 5.5, AC 1, 2, 3, 10a). Import qua index của module lớn `product` để số đang về
// của purchasing đã được nối cho phần xét ngưỡng.

async function levelOf(companyId: string, variantId: string) {
  const { rows } = await testPool().query(
    'select on_hand, reserved, version from product.stock_levels where company_id = $1 and variant_id = $2',
    [companyId, variantId],
  );
  return rows[0];
}

async function outboxOf(variantId: string) {
  const { rows } = await testPool().query('select type, payload from core.outbox_messages where key = $1 order by id', [variantId]);
  return rows;
}

const setMinQty = (companyId: string, variantId: string, minQty: number) =>
  testPool().query('update product.stock_levels set min_qty = $3 where company_id = $1 and variant_id = $2', [companyId, variantId, minQty]);

const line = (variantId: string, quantity: number) => ({ variantId, quantity });

const lockLevelRow = (companyId: string, variantId: string) => (holder: PoolClient) =>
  holder.query('select 1 from product.stock_levels where company_id = $1 and variant_id = $2 for update', [companyId, variantId]);

describe('reserve', () => {
  it('AC1: thiếu một dòng thì không giữ gì; đủ hết thì giữ cả kiện, không phát stock_changed, có below_threshold của A', async () => {
    const { companyId, variants } = await companyWithVariants(2);
    const [a, b] = variants as [string, string];
    await receive(companyId, a, 5, 1000);
    await setMinQty(companyId, a, 2);
    await receive(companyId, b, 1, 1000);
    const k1 = randomUUID();
    const before = [await levelOf(companyId, a), await levelOf(companyId, b)];

    expect(await withCompany(companyId, () => reserve(k1, [line(a, 3), line(b, 2)]))).toEqual({ reserved: false });
    expect([await levelOf(companyId, a), await levelOf(companyId, b)]).toEqual(before);
    expect([...(await outboxOf(a)), ...(await outboxOf(b))]).toEqual([]);

    await receive(companyId, b, 1, 1000);
    expect(await withCompany(companyId, () => reserve(k1, [line(a, 3), line(b, 2)]))).toEqual({ reserved: true });
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 5, reserved: 3 });
    expect(await levelOf(companyId, b)).toMatchObject({ on_hand: 2, reserved: 2 });
    expect(await outboxOf(a)).toEqual([{ type: 'inventory.below_threshold', payload: { variantId: a, available: 2, minQty: 2 } }]);
    expect(await outboxOf(b)).toEqual([]);
  });

  it('AC2: gộp dòng cùng SKU: A tồn 4, giữ A×2 và A×3 trong một kiện → false', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;
    await receive(companyId, a, 4, 1000);

    expect(await withCompany(companyId, () => reserve(randomUUID(), [line(a, 2), line(a, 3)]))).toEqual({ reserved: false });
    expect(await levelOf(companyId, a)).toMatchObject({ reserved: 0 });
  });

  it('AC10a: A tồn 1, hai kiện cùng giữ A×1 song song → đúng một kiện được giữ, đang giữ 1', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;
    await receive(companyId, a, 1, 1000);

    const results = await raceBehindLock(lockLevelRow(companyId, a), 2, () =>
      Promise.all([1, 2].map(() => withCompany(companyId, () => reserve(randomUUID(), [line(a, 1)])))),
    );

    expect(results.map((r) => r.reserved).sort()).toEqual([false, true]);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 1, reserved: 1 });
  });

  it('SKU chưa có dòng tồn → false', async () => {
    const { companyId, variants } = await companyWithVariants();

    expect(await withCompany(companyId, () => reserve(randomUUID(), [line(variants[0]!, 1)]))).toEqual({ reserved: false });
  });

  it('quantity 0 → lỗi lập trình, không tạo dòng tồn', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;

    await expect(withCompany(companyId, () => reserve(randomUUID(), [line(a, 0)]))).rejects.toThrow(a);
    expect(await levelOf(companyId, a)).toBeUndefined();
  });

  it('SKU của công ty khác → lỗi, không tạo dòng tồn cho SKU đó', async () => {
    const A = await companyWithVariants(0);
    const B = await companyWithVariants(1);
    const foreign = B.variants[0]!;

    await expect(withCompany(A.companyId, () => reserve(randomUUID(), [line(foreign, 1)]))).rejects.toThrow(/không thuộc công ty/);
    expect(await levelOf(A.companyId, foreign)).toBeUndefined();
  });

  it('không có dòng nào: reserve trả true, release không làm gì', async () => {
    const { companyId } = await companyWithVariants(0);

    expect(await withCompany(companyId, () => reserve(randomUUID(), []))).toEqual({ reserved: true });
    await expect(withCompany(companyId, () => release(randomUUID(), []))).resolves.toBeUndefined();
  });
});

describe('release', () => {
  it('AC3: nhả đưa đang giữ về 0, không phát stock_changed; nhả quá số đang giữ → lỗi có mã kiện, DB không đổi', async () => {
    const { companyId, variants } = await companyWithVariants(2);
    const [a, b] = variants as [string, string];
    await receive(companyId, a, 5, 1000);
    await receive(companyId, b, 2, 1000);
    const k1 = randomUUID();
    await withCompany(companyId, () => reserve(k1, [line(a, 3), line(b, 2)]));

    await withCompany(companyId, () => release(k1, [line(a, 3), line(b, 2)]));

    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 5, reserved: 0 });
    expect(await levelOf(companyId, b)).toMatchObject({ on_hand: 2, reserved: 0 });
    const types = [...(await outboxOf(a)), ...(await outboxOf(b))].map((r) => r.type);
    expect(types).not.toContain('inventory.stock_changed');

    const before = await levelOf(companyId, a);
    await expect(withCompany(companyId, () => release(k1, [line(a, 1)]))).rejects.toThrow(k1);
    expect(await levelOf(companyId, a)).toEqual(before);
  });
});
