import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyMoves, InsufficientStock, type ReceivedLine, receiveGoods } from '#src/modules/product/inventory/service/posting.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { archiveVariant, companyWithVariants, receive } from './helpers.ts';

// Lõi ghi sổ của inventory và receiveGoods (spec #111 mục 5.4, 9).

async function levelOf(companyId: string, variantId: string) {
  const { rows } = await testPool().query(
    `select on_hand, reserved, quarantine, avg_cost, invariant_broken, version from product.stock_levels
     where company_id = $1 and variant_id = $2`,
    [companyId, variantId],
  );
  return rows[0];
}

async function movesOf(sourceId: string) {
  const { rows } = await testPool().query(
    `select bucket, qty_change, balance_after, unit_cost, source_type, source_line_id, done_by from product.stock_moves
     where source_id = $1 order by id`,
    [sourceId],
  );
  return rows;
}

async function stockEvents(variantId: string) {
  const { rows } = await testPool().query(
    "select payload from core.outbox_messages where type = 'inventory.stock_changed' and key = $1 order by id",
    [variantId],
  );
  return rows.map((r) => r.payload);
}

const line = (variantId: string, accepted: number, defective = 0, unitCost = '100000'): ReceivedLine => ({
  lineId: randomUUID(),
  variantId,
  accepted,
  defective,
  unitCost,
});

describe('receiveGoods', () => {
  it('AC1: SKU có 10 cái giá 80.000, nhập 5 đạt giá 100.000', async () => {
    const { companyId, variants } = await companyWithVariants();
    const v = variants[0]!;
    await receive(companyId, v, 10, 80000);
    const receiptId = randomUUID();
    const actor = randomUUID();
    const l = line(v, 5);
    await withCompany(companyId, () => receiveGoods(receiptId, [l], actor));

    expect(await levelOf(companyId, v)).toMatchObject({ on_hand: 15, quarantine: 0, avg_cost: '86666.67', invariant_broken: false });
    expect(await movesOf(receiptId)).toEqual([
      {
        bucket: 'on_hand',
        qty_change: 5,
        balance_after: 15,
        unit_cost: '100000.00',
        source_type: 'goods_receipt',
        source_line_id: l.lineId,
        done_by: actor,
      },
    ]);
    expect(await stockEvents(v)).toEqual([{ variantId: v, onHand: 15, reserved: 0, available: 15 }]);
  });

  it('AC2: chỉ có hàng lỗi → chờ xử lý +2, giá vốn giữ nguyên, thẻ kho ngăn quarantine, không phát stock_changed', async () => {
    const { companyId, variants } = await companyWithVariants();
    const v = variants[0]!;
    await receive(companyId, v, 10, 80000);
    const receiptId = randomUUID();
    await withCompany(companyId, () => receiveGoods(receiptId, [line(v, 0, 2)], null));

    expect(await levelOf(companyId, v)).toMatchObject({ on_hand: 10, quarantine: 2, avg_cost: '80000.00' });
    expect(await movesOf(receiptId)).toMatchObject([{ bucket: 'quarantine', qty_change: 2, balance_after: 2, unit_cost: '100000.00' }]);
    expect(await stockEvents(v)).toEqual([]);
  });

  it('AC3: tồn −3 đang invariant_broken, nhập 5 giá 50.000 → tồn 2, giá vốn 50.000, tắt invariant_broken', async () => {
    const { companyId, variants } = await companyWithVariants();
    const v = variants[0]!;
    await testPool().query(
      `insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost, invariant_broken)
       values ($1, $2, -3, '80000', true)`,
      [companyId, v],
    );
    await withCompany(companyId, () => receiveGoods(randomUUID(), [line(v, 5, 0, '50000')], null));

    expect(await levelOf(companyId, v)).toMatchObject({ on_hand: 2, avg_cost: '50000.00', invariant_broken: false });
  });

  it('AC6: hai receiveGoods song song cùng SKU → tồn bằng tổng, balance_after liên tiếp', async () => {
    const { companyId, variants } = await companyWithVariants();
    const v = variants[0]!;
    await withCompany(companyId, () => receiveGoods(randomUUID(), [line(v, 1)], null));
    const [r1, r2] = [randomUUID(), randomUUID()];
    await raceBehindLock(
      (h) => h.query('select 1 from product.stock_levels where company_id = $1 and variant_id = $2 for update', [companyId, v]),
      2,
      () =>
        Promise.all([
          withCompany(companyId, () => receiveGoods(r1, [line(v, 3)], null)),
          withCompany(companyId, () => receiveGoods(r2, [line(v, 4)], null)),
        ]),
    );

    expect((await levelOf(companyId, v)).on_hand).toBe(8);
    const balances = [...(await movesOf(r1)), ...(await movesOf(r2))].map((m) => m.balance_after as number).sort((a, b) => a - b);
    expect(balances[1]).toBe(8);
    expect([4, 5]).toContain(balances[0]);
  });

  it('biến thể của công ty khác → lỗi, không tạo dòng tồn nào', async () => {
    const a = await companyWithVariants();
    const b = await companyWithVariants();
    const theirs = b.variants[0]!;
    await expect(withCompany(a.companyId, () => receiveGoods(randomUUID(), [line(theirs, 1)], null))).rejects.toThrow();
    expect(await levelOf(a.companyId, theirs)).toBeUndefined();
    expect(await levelOf(b.companyId, theirs)).toBeUndefined();
  });

  it('SKU đã lưu trữ vẫn nhận được hàng về', async () => {
    const { companyId, variants } = await companyWithVariants();
    const v = variants[0]!;
    await archiveVariant(v);
    await withCompany(companyId, () => receiveGoods(randomUUID(), [line(v, 4)], null));
    expect((await levelOf(companyId, v)).on_hand).toBe(4);
  });
});

describe('applyMoves', () => {
  it('AC4: giảm tồn thực xuống dưới 0 → InsufficientStock, tồn và thẻ kho không đổi', async () => {
    const { companyId, variants } = await companyWithVariants();
    const v = variants[0]!;
    await receive(companyId, v, 2, 1000);
    const before = await levelOf(companyId, v);
    const sourceId = randomUUID();
    const err = await withCompany(companyId, () =>
      applyMoves({ type: 'stock_document', id: sourceId }, [{ variantId: v, bucket: 'on_hand', qty: -5, unitCost: null, sourceLineId: null }], null),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InsufficientStock);
    expect((err as InsufficientStock).variantIds).toEqual([v]);
    expect(await levelOf(companyId, v)).toEqual(before);
    expect(await movesOf(sourceId)).toEqual([]);
  });

  it('chờ xử lý xuống dưới 0 cũng là InsufficientStock', async () => {
    const { companyId, variants } = await companyWithVariants();
    const v = variants[0]!;
    const err = await withCompany(companyId, () =>
      applyMoves(
        { type: 'stock_document', id: randomUUID() },
        [{ variantId: v, bucket: 'quarantine', qty: -1, unitCost: null, sourceLineId: null }],
        null,
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientStock);
  });
});
