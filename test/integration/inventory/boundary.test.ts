import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueForOrder, receiveReturn, release, reserve } from '#src/modules/inventory/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../helpers/db.ts';
import { companyWithVariants, eventsOf, levelOf, movesOf, receive } from './helpers.ts';

// Thân 4 hàm biên cho sales (#24), fulfillment (#25) gọi (plan #16 A10, A11, A17; S-4, S-5, S-6).
const reservationsOf = async (orderId: string) =>
  (
    await testPool().query<{ variant_id: string; quantity: number; status: string }>(
      'select variant_id, quantity, status from inventory.reservations where order_id = $1 order by variant_id',
      [orderId],
    )
  ).rows;

describe('reserve, release (S-4)', () => {
  it('giữ phần có được, báo dòng thiếu; khả dụng giảm, phát stock_changed', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 4, 1000);
    const order = randomUUID();
    const res = await withCompany(companyId, () => reserve(order, [{ variantId: v!, quantity: 6 }]));
    expect(res.shortLines).toEqual([{ variantId: v, requested: 6, available: 4 }]);
    expect(await levelOf(companyId, v!)).toMatchObject({ onHand: 4, reserved: 4 });
    expect(await reservationsOf(order)).toEqual([{ variant_id: v, quantity: 4, status: 'active' }]);
    expect((await eventsOf(companyId, 'inventory.stock_changed')).at(-1)).toEqual({ variantId: v, onHand: 4, reserved: 4, available: 0 });
  });

  it('gọi lại cùng đơn là giữ tới số yêu cầu, không cộng dồn; có hàng thêm thì giữ bù', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 4, 1000);
    const order = randomUUID();
    await withCompany(companyId, () => reserve(order, [{ variantId: v!, quantity: 6 }]));
    await receive(companyId, v!, 10, 1000);
    const again = await withCompany(companyId, () => reserve(order, [{ variantId: v!, quantity: 6 }]));
    expect(again.shortLines).toEqual([]);
    expect(await reservationsOf(order)).toEqual([{ variant_id: v, quantity: 6, status: 'active' }]);
    const third = await withCompany(companyId, () => reserve(order, [{ variantId: v!, quantity: 6 }]));
    expect(third.shortLines).toEqual([]);
    expect(await levelOf(companyId, v!)).toMatchObject({ onHand: 14, reserved: 6 });
  });

  it('biến thể chưa từng nhập hoặc của công ty khác: vào shortLines, không sinh dòng tồn, không sinh giữ chỗ', async () => {
    const a = await companyWithVariants();
    const b = await companyWithVariants();
    await receive(b.companyId, b.variants[0]!, 5, 1000);
    const order = randomUUID();
    const res = await withCompany(a.companyId, () =>
      reserve(order, [
        { variantId: a.variants[0]!, quantity: 2 },
        { variantId: b.variants[0]!, quantity: 2 },
      ]),
    );
    expect(res.shortLines).toHaveLength(2);
    expect(res.shortLines.every((l) => l.available === 0)).toBe(true);
    expect(await levelOf(a.companyId, a.variants[0]!)).toBeNull();
    expect(await levelOf(a.companyId, b.variants[0]!)).toBeNull();
    expect(await levelOf(b.companyId, b.variants[0]!)).toMatchObject({ onHand: 5, reserved: 0 });
    expect(await reservationsOf(order)).toEqual([]);
  });

  it('release trả hết giữ chỗ của đơn; gọi lại không lỗi', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 5, 1000);
    const order = randomUUID();
    await withCompany(companyId, () => reserve(order, [{ variantId: v!, quantity: 3 }]));
    await withCompany(companyId, () => release(order));
    await withCompany(companyId, () => release(order));
    expect(await levelOf(companyId, v!)).toMatchObject({ onHand: 5, reserved: 0 });
    expect(await reservationsOf(order)).toEqual([{ variant_id: v, quantity: 3, status: 'released' }]);
  });

  it('giữ hàng làm khả dụng xuống dưới ngưỡng thì phát below_threshold (A9)', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 6, 1000);
    await testPool().query('insert into inventory.reorder_rules (company_id, variant_id, min_qty) values ($1, $2, 5)', [companyId, v]);
    await withCompany(companyId, () => reserve(randomUUID(), [{ variantId: v!, quantity: 2 }]));
    expect(await eventsOf(companyId, 'inventory.below_threshold')).toEqual([{ variantId: v, available: 4, minQty: 5 }]);
  });

  it('gọi ngoài withCompany thì lỗi, không giữ gì', async () => {
    await expect(reserve(randomUUID(), [{ variantId: randomUUID(), quantity: 1 }])).rejects.toThrow();
  });
});

describe('issueForOrder (S-5)', () => {
  it('lập phiếu xuất theo đơn đã ghi sổ từ giữ chỗ, giá vốn lúc xuất; tồn và giữ chỗ cùng giảm, khả dụng không đổi', async () => {
    const { companyId, variants: [a, b] } = await companyWithVariants(2);
    await receive(companyId, a!, 10, 100000);
    await receive(companyId, b!, 4, 50000);
    const order = randomUUID();
    const actor = randomUUID();
    await withCompany(companyId, () =>
      reserve(order, [
        { variantId: a!, quantity: 3 },
        { variantId: b!, quantity: 1 },
      ]),
    );
    const changedBefore = (await eventsOf(companyId, 'inventory.stock_changed')).length;

    const issue = await withCompany(companyId, () => issueForOrder(order, { actorId: actor }));
    expect(issue.number).toMatch(/^PX-\d{6}$/);
    expect(issue.lines.map((l) => [l.variantId, l.quantity, l.unitCost.toFixed(2)]).sort()).toEqual(
      [
        [a, 3, '100000.00'],
        [b, 1, '50000.00'],
      ].sort(),
    );
    const doc = await testPool().query('select kind, status, order_id, posted_by from inventory.stock_issues where id = $1', [issue.issueId]);
    expect(doc.rows[0]).toEqual({ kind: 'order', status: 'done', order_id: order, posted_by: actor });
    expect(await levelOf(companyId, a!)).toMatchObject({ onHand: 7, reserved: 0 });
    expect(await levelOf(companyId, b!)).toMatchObject({ onHand: 3, reserved: 0 });
    expect((await reservationsOf(order)).map((r) => r.status)).toEqual(['consumed', 'consumed']);
    expect((await movesOf(companyId, a!)).at(-1)).toEqual({ qty_change: -3, on_hand_after: 7, unit_cost: '100000.00', done_by: actor });
    expect(await eventsOf(companyId, 'inventory.stock_changed')).toHaveLength(changedBefore);
    expect(await eventsOf(companyId, 'inventory.issue_posted')).toEqual([
      expect.objectContaining({ issueId: issue.issueId, number: issue.number, kind: 'order', orderId: order }),
    ]);
  });

  it('gọi lại (kể cả cùng lúc) trả đúng phiếu đã có, không xuất hai lần', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 5, 1000);
    const order = randomUUID();
    await withCompany(companyId, () => reserve(order, [{ variantId: v!, quantity: 2 }]));
    const [x, y] = await Promise.all([
      withCompany(companyId, () => issueForOrder(order)),
      withCompany(companyId, () => issueForOrder(order)),
    ]);
    const z = await withCompany(companyId, () => issueForOrder(order));
    expect(new Set([x.issueId, y.issueId, z.issueId]).size).toBe(1);
    expect(z.lines).toEqual([expect.objectContaining({ variantId: v, quantity: 2 })]);
    expect((await levelOf(companyId, v!))!.onHand).toBe(3);
  });

  it('đơn không có giữ chỗ → 409 not_reserved', async () => {
    const { companyId } = await companyWithVariants(0);
    await expect(withCompany(companyId, () => issueForOrder(randomUUID()))).rejects.toMatchObject({
      status: 409,
      code: 'not_reserved',
    });
  });
});

describe('receiveReturn (S-6)', () => {
  async function issuedOrder() {
    const { companyId, variants: [a, b] } = await companyWithVariants(2);
    await receive(companyId, a!, 10, 100000);
    await receive(companyId, b!, 10, 30000);
    const order = randomUUID();
    await withCompany(companyId, () =>
      reserve(order, [
        { variantId: a!, quantity: 3 },
        { variantId: b!, quantity: 2 },
      ]),
    );
    await withCompany(companyId, () => issueForOrder(order));
    await receive(companyId, a!, 1, 120000); // giá vốn đổi sau khi xuất
    return { companyId, a: a!, b: b!, order };
  }

  it('nhập hoàn đã ghi sổ theo giá vốn hiện tại, không đổi bình quân; bỏ dòng số 0; lưu ghi chú và người làm', async () => {
    const { companyId, a, b, order } = await issuedOrder();
    const before = await levelOf(companyId, a);
    const actor = randomUUID();
    const res = await withCompany(companyId, () =>
      receiveReturn(
        order,
        [
          { variantId: a, quantity: 2 },
          { variantId: b, quantity: 0 },
        ],
        { note: 'khách trả thiếu', actorId: actor },
      ),
    );
    expect(res.number).toMatch(/^PN-\d{6}$/);
    const doc = await testPool().query('select kind, status, order_id, note, posted_by from inventory.stock_receipts where id = $1', [res.receiptId]);
    expect(doc.rows[0]).toEqual({ kind: 'delivery_return', status: 'done', order_id: order, note: 'khách trả thiếu', posted_by: actor });
    const lines = await testPool().query('select variant_id, quantity, unit_cost from inventory.stock_receipt_lines where receipt_id = $1', [res.receiptId]);
    expect(lines.rows).toEqual([{ variant_id: a, quantity: 2, unit_cost: before!.avgCost }]);
    expect(await levelOf(companyId, a)).toEqual({ onHand: before!.onHand + 2, reserved: 0, avgCost: before!.avgCost });
    expect(await eventsOf(companyId, 'inventory.receipt_posted')).toContainEqual({
      receiptId: res.receiptId,
      number: res.number,
      kind: 'delivery_return',
      lines: [{ variantId: a, quantity: 2 }],
    });
  });

  it('nhận đủ số đã xuất thì không cần ghi chú', async () => {
    const { companyId, a, b, order } = await issuedOrder();
    await expect(
      withCompany(companyId, () =>
        receiveReturn(order, [
          { variantId: a, quantity: 3 },
          { variantId: b, quantity: 2 },
        ]),
      ),
    ).resolves.toMatchObject({ number: expect.stringMatching(/^PN-/) });
  });

  it('dữ liệu sai → 422 theo ô: mọi dòng 0, vượt số đã xuất, biến thể không có trong phiếu xuất, lệch số mà không ghi chú', async () => {
    const { companyId, a, b, order } = await issuedOrder();
    const call = (lines: { variantId: string; quantity: number }[], note?: string) =>
      withCompany(companyId, () => receiveReturn(order, lines, note ? { note } : undefined));
    await expect(call([{ variantId: a, quantity: 0 }])).rejects.toMatchObject({ status: 422, code: 'validation_failed', extensions: { errors: { lines: expect.any(String) } } });
    await expect(call([{ variantId: a, quantity: 4 }], 'x')).rejects.toMatchObject({ extensions: { errors: { 'lines.0.quantity': expect.any(String) } } });
    await expect(call([{ variantId: randomUUID(), quantity: 1 }], 'x')).rejects.toMatchObject({ extensions: { errors: { 'lines.0.variantId': expect.any(String) } } });
    await expect(call([{ variantId: a, quantity: 1 }, { variantId: b, quantity: 2 }])).rejects.toMatchObject({ extensions: { errors: { note: expect.any(String) } } });
    expect(await movesOf(companyId, a)).toHaveLength(3);
  });

  it('đơn đã có phiếu nhập hoàn → 409 already_processed nêu số phiếu', async () => {
    const { companyId, a, b, order } = await issuedOrder();
    const lines = [
      { variantId: a, quantity: 3 },
      { variantId: b, quantity: 2 },
    ];
    const first = await withCompany(companyId, () => receiveReturn(order, lines));
    const second = withCompany(companyId, () => receiveReturn(order, lines));
    await expect(second).rejects.toMatchObject({ status: 409, code: 'already_processed' });
    await expect(second).rejects.toThrow(first.number);
  });

  it('đơn chưa có phiếu xuất đã ghi sổ → 409 not_issued', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await expect(withCompany(companyId, () => receiveReturn(randomUUID(), [{ variantId: v!, quantity: 1 }]))).rejects.toMatchObject({
      status: 409,
      code: 'not_issued',
    });
  });
});
