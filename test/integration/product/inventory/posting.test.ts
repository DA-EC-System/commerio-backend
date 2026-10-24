import { describe, expect, it } from 'vitest';
import { reserve } from '#src/modules/product/inventory/index.ts';
import { stockReceiptLines, stockReceipts } from '#src/modules/product/inventory/repository/schema.ts';
import { applyStockMoves } from '#src/modules/product/inventory/service/posting.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import {
  alertActive,
  companyWithVariants,
  eventsOf,
  issueManual,
  levelOf,
  movesOf,
  receive,
  setRule,
} from './helpers.ts';

const orderId = () => crypto.randomUUID();

// Khung ghi sổ `applyStockMoves` (plan #16 A6, A9): giá vốn, khả dụng, khoá dòng, thẻ kho, ngưỡng và sự kiện.
describe('ghi sổ: giá vốn bình quân (AC-5, AC-17)', () => {
  it('nhập 10 × 100.000 rồi 5 × 130.000 ra 110.000; xuất 3 giữ giá vốn và ghi giá vốn lên dòng xuất, thẻ kho', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 10, 100000);
    await receive(companyId, v!, 5, 130000);
    expect(await levelOf(companyId, v!)).toEqual({ onHand: 15, reserved: 0, avgCost: '110000.00' });

    const issueId = await issueManual(companyId, [{ variantId: v!, quantity: 3 }]);
    expect(await levelOf(companyId, v!)).toEqual({ onHand: 12, reserved: 0, avgCost: '110000.00' });
    const line = await testPool().query('select unit_cost from inventory.stock_issue_lines where issue_id = $1', [issueId]);
    expect(line.rows[0].unit_cost).toBe('110000.00');
    const moves = await movesOf(companyId, v!);
    expect(moves.map((m) => [m.qty_change, m.on_hand_after, m.unit_cost])).toEqual([
      [10, 10, '100000.00'],
      [5, 15, '130000.00'],
      [-3, 12, '110000.00'],
    ]);
  });

  it('làm tròn nửa lên 2 chữ số: 3 × 100.000 + 2 × 100.001 lưu 100000.40', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 3, 100000);
    await receive(companyId, v!, 2, 100001);
    expect((await levelOf(companyId, v!))!.avgCost).toBe('100000.40');
  });
});

describe('ghi sổ: khả dụng (AC-6, AC-7)', () => {
  it('xuất vượt khả dụng → 422 insufficient_stock theo dòng, không đổi tồn, không ghi thẻ kho', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 8, 1000);
    await withCompany(companyId, () => reserve(orderId(), [{ variantId: v!, quantity: 5 }]));

    await expect(issueManual(companyId, [{ variantId: v!, quantity: 4 }])).rejects.toMatchObject({
      status: 422,
      code: 'insufficient_stock',
      extensions: { errors: { 'lines.0.quantity': 'Chỉ còn 3 khả dụng' } },
    });
    expect(await levelOf(companyId, v!)).toEqual({ onHand: 8, reserved: 5, avgCost: '1000.00' });
    expect(await movesOf(companyId, v!)).toHaveLength(1);
  });

  it('biến thể chưa từng nhập: xuất báo "Chỉ còn 0 khả dụng" và không sinh dòng tồn', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await expect(issueManual(companyId, [{ variantId: v!, quantity: 1 }])).rejects.toMatchObject({
      code: 'insufficient_stock',
      extensions: { errors: { 'lines.0.quantity': 'Chỉ còn 0 khả dụng' } },
    });
    expect(await levelOf(companyId, v!)).toBeNull();
  });

  it('hai phiếu xuất 3 cái cùng lúc khi chỉ còn 5: đúng một phiếu thành công, tồn giảm đúng 3', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 5, 1000);
    const results = await Promise.allSettled([
      issueManual(companyId, [{ variantId: v!, quantity: 3 }]),
      issueManual(companyId, [{ variantId: v!, quantity: 3 }]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 422, code: 'insufficient_stock' });
    expect((await levelOf(companyId, v!))!.onHand).toBe(2);
    expect(await movesOf(companyId, v!)).toHaveLength(2);
  });

  it('hai phiếu hai dòng đảo thứ tự biến thể chạy cùng lúc không deadlock', async () => {
    const { companyId, variants: [a, b] } = await companyWithVariants(2);
    await receive(companyId, a!, 10, 1000);
    await receive(companyId, b!, 10, 1000);
    await Promise.all([
      issueManual(companyId, [{ variantId: a!, quantity: 1 }, { variantId: b!, quantity: 1 }]),
      issueManual(companyId, [{ variantId: b!, quantity: 1 }, { variantId: a!, quantity: 1 }]),
    ]);
    expect((await levelOf(companyId, a!))!.onHand).toBe(8);
    expect((await levelOf(companyId, b!))!.onHand).toBe(8);
  });
});

describe('ghi sổ: ngưỡng và sự kiện (AC-12, AC-18, V31)', () => {
  it('mỗi lần ghi sổ đổi khả dụng phát một inventory.stock_changed với số sau ghi sổ', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 6, 1000);
    await issueManual(companyId, [{ variantId: v!, quantity: 2 }]);
    expect(await eventsOf(companyId, 'inventory.stock_changed')).toEqual([
      { variantId: v, onHand: 6, reserved: 0, available: 6 },
      { variantId: v, onHand: 4, reserved: 0, available: 4 },
    ]);
  });

  it('cảnh báo dưới ngưỡng phát một lần khi vừa xuống, không phát lại khi xuống tiếp, phát lại sau khi đã lên ≥ ngưỡng', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 6, 1000);
    await setRule(companyId, v!, 5);

    await issueManual(companyId, [{ variantId: v!, quantity: 2 }]); // 6 → 4: xuống dưới
    expect(await eventsOf(companyId, 'inventory.below_threshold')).toEqual([{ variantId: v, available: 4, minQty: 5 }]);
    expect(await alertActive(companyId, v!)).toBe(true);

    await issueManual(companyId, [{ variantId: v!, quantity: 1 }]); // 4 → 3: vẫn dưới
    expect(await eventsOf(companyId, 'inventory.below_threshold')).toHaveLength(1);

    await receive(companyId, v!, 2, 1000); // 3 → 5: lên lại bằng ngưỡng
    expect(await alertActive(companyId, v!)).toBe(false);

    await issueManual(companyId, [{ variantId: v!, quantity: 1 }]); // 5 → 4: xuống lại
    expect(await eventsOf(companyId, 'inventory.below_threshold')).toHaveLength(2);
  });

  it('giao dịch ghi sổ rollback sau khi đã phát sự kiện thì outbox không còn sự kiện nào', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await setRule(companyId, v!, 5);
    const failed = withCompany(companyId, async () => {
      const [doc] = await getDb()
        .insert(stockReceipts)
        .values({ companyId, number: 'PN-ROLLBACK', kind: 'manual', status: 'done' })
        .returning({ id: stockReceipts.id });
      const [line] = await getDb()
        .insert(stockReceiptLines)
        .values({ companyId, receiptId: doc!.id, variantId: v!, quantity: 1, unitCost: '1000' })
        .returning({ id: stockReceiptLines.id });
      await applyStockMoves({ direction: 'in', cost: 'weighted', doneBy: null, lines: [{ variantId: v!, quantity: 1, lineId: line!.id, unitCost: 1000 }] });
      // Lỗi sau khi khung đã phát sự kiện (role ứng dụng không SELECT được outbox; đối chứng là ca kế tiếp).
      throw new Error('lỗi giữa chừng');
    });
    await expect(failed).rejects.toThrow('lỗi giữa chừng');
    expect(await eventsOf(companyId, 'inventory.stock_changed')).toEqual([]);
    expect(await eventsOf(companyId, 'inventory.below_threshold')).toEqual([]);
    expect(await levelOf(companyId, v!)).toBeNull();
  });

  it('cùng luồng không lỗi thì có sự kiện (đối chứng cho ca rollback)', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await setRule(companyId, v!, 5);
    await receive(companyId, v!, 1, 1000);
    expect(await eventsOf(companyId, 'inventory.stock_changed')).toHaveLength(1);
    expect(await eventsOf(companyId, 'inventory.below_threshold')).toHaveLength(1);
  });

  it('ghi sổ ngoài withCompany bị từ chối, không đổi gì', async () => {
    await expect(
      applyStockMoves({ direction: 'in', cost: 'weighted', doneBy: null, lines: [] }),
    ).rejects.toThrow();
  });
});
