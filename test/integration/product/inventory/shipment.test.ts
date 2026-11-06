import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { receiveGoods, reserve, reverseShipment, ship, stockOf } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { companyWithVariants, receive, setBuckets } from './helpers.ts';

// Bàn giao theo kiện (spec #206 mục 5.5, AC 4–7, 10b, 10c). Id kiện là uuid ngẫu nhiên: inventory không đọc bảng `order`.

async function levelOf(companyId: string, variantId: string) {
  const { rows } = await testPool().query(
    `select on_hand, reserved, avg_cost, invariant_broken from product.stock_levels where company_id = $1 and variant_id = $2`,
    [companyId, variantId],
  );
  return rows[0];
}

async function docOf(documentId: string) {
  const { rows } = await testPool().query(
    `select number, kind, status, source_type, source_id, created_by, posted_by, posted_at, note from product.stock_documents
     where id = $1`,
    [documentId],
  );
  return rows[0];
}

async function docLines(documentId: string) {
  const { rows } = await testPool().query(
    `select id, variant_id, quantity, unit_cost, source_line_id from product.stock_document_lines where document_id = $1
     order by variant_id, quantity`,
    [documentId],
  );
  return rows;
}

async function docsOfPackage(packageId: string) {
  const { rows } = await testPool().query('select number from product.stock_documents where source_id = $1 order by number', [packageId]);
  return rows.map((r) => r.number);
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

async function transitionsOf(entityId: string) {
  const { rows } = await testPool().query(
    'select entity_type, from_state, to_state, action, actor_id, source from core.state_transitions where entity_id = $1 order by id',
    [entityId],
  );
  return rows;
}

async function counterOf(companyId: string, docType: string) {
  const { rows } = await testPool().query('select next_number from product.doc_counters where company_id = $1 and doc_type = $2', [
    companyId,
    docType,
  ]);
  return rows[0];
}

const line = (variantId: string, quantity: number) => ({ variantId, quantity });

/** Dòng của `ship`: id dòng kiện mặc định ngẫu nhiên (mỗi lần gọi là dòng kiện mới). */
const pl = (variantId: string, quantity: number, packageLineId: string = randomUUID()) => ({ variantId, quantity, packageLineId });

const lockLevelRow = (companyId: string, variantId: string) => (holder: PoolClient) =>
  holder.query('select 1 from product.stock_levels where company_id = $1 and variant_id = $2 for update', [companyId, variantId]);

/** SKU có `onHand` cái giá `unitCost`, đang giữ `reserved`. */
async function skuWith(onHand: number, reserved: number, unitCost = 80000) {
  const { companyId, variants } = await companyWithVariants();
  const a = variants[0]!;
  if (onHand > 0) await receive(companyId, a, onHand, unitCost);
  if (reserved > 0) await setBuckets(companyId, a, { reserved, invariantBroken: reserved > onHand ? true : undefined });
  return { companyId, a };
}

describe('ship', () => {
  it('AC4: A tồn 10 giữ 3 giá vốn 80.000 → tồn 7 giữ 0, phiếu XK-000001 posted, thẻ kho trỏ dòng phiếu, một stock_changed', async () => {
    const { companyId, a } = await skuWith(10, 3);
    const k3 = randomUUID();
    const actor = randomUUID();
    const x1 = randomUUID();

    const { ref, snapshot } = await withCompany(companyId, async () => {
      const ref = await ship(k3, [pl(a, 3, x1)], { actorId: actor });
      return { ref, snapshot: (await stockOf([a])).get(a)! };
    });

    expect(ref).toEqual({ documentId: expect.any(String), number: 'XK-000001' });
    expect(snapshot.avgCost).toBe('80000.00');
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 7, reserved: 0, invariant_broken: false });
    expect(await docOf(ref.documentId)).toMatchObject({
      kind: 'shipment',
      status: 'posted',
      source_type: 'package',
      source_id: k3,
      created_by: actor,
      posted_by: actor,
      posted_at: expect.any(Date),
      note: null,
    });
    const lines = await docLines(ref.documentId);
    expect(lines).toEqual([{ id: expect.any(String), variant_id: a, quantity: 3, unit_cost: '80000.00', source_line_id: x1 }]);
    expect(await movesOf(ref.documentId)).toEqual([
      {
        bucket: 'on_hand',
        qty_change: -3,
        balance_after: 7,
        unit_cost: '80000.00',
        source_type: 'stock_document',
        source_line_id: lines[0].id,
        done_by: actor,
      },
    ]);
    expect(await stockEvents(a)).toEqual([{ variantId: a, onHand: 7, reserved: 0, available: 7 }]);
    expect(await transitionsOf(ref.documentId)).toEqual([
      { entity_type: 'stock_documents', from_state: null, to_state: 'posted', action: 'create', actor_id: actor, source: 'user' },
    ]);
  });

  it('AC5: gọi lại cùng kiện cùng dòng kiện → trả phiếu cũ, không thêm phiếu, thẻ kho, sự kiện', async () => {
    const { companyId, a } = await skuWith(10, 3);
    const k3 = randomUUID();
    const x1 = randomUUID();
    const first = await withCompany(companyId, () => ship(k3, [pl(a, 3, x1)], { actorId: null }));

    const again = await withCompany(companyId, () => ship(k3, [pl(a, 3, x1)], { actorId: null }));

    expect(again).toEqual(first);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 7, reserved: 0 });
    expect(await docsOfPackage(k3)).toEqual(['XK-000001']);
    expect(await movesOf(first.documentId)).toHaveLength(1);
    expect(await stockEvents(a)).toHaveLength(1);
  });

  it('AC5: lẫn dòng kiện đã trừ với dòng mới → lỗi có id dòng đã trừ, không ghi gì', async () => {
    const { companyId, a } = await skuWith(10, 4);
    const k = randomUUID();
    const x1 = randomUUID();
    await withCompany(companyId, () => ship(k, [pl(a, 3, x1)], { actorId: null }));

    await expect(withCompany(companyId, () => ship(k, [pl(a, 3, x1), pl(a, 1)], { actorId: null }))).rejects.toThrow(x1);

    expect(await docsOfPackage(k)).toEqual(['XK-000001']);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 7, reserved: 1 });
  });

  it('AC12: dòng ghép SKU sau trùng SKU, số với lần trừ trước → phiếu mới, trừ tồn (25 §8.4 quy tắc 3)', async () => {
    const { companyId, a } = await skuWith(5, 0);
    const k7 = randomUUID();

    const xk1 = await withCompany(companyId, () => ship(k7, [pl(a, 1)], { actorId: null, forced: true }));
    const xk2 = await withCompany(companyId, () => ship(k7, [pl(a, 1)], { actorId: null, forced: true }));

    expect([xk1.number, xk2.number]).toEqual(['XK-000001', 'XK-000002']);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 3, reserved: 0 });
  });

  it('gọi lặp không kể thứ tự dòng; hai dòng kiện cùng SKU thành hai dòng phiếu, hai dòng thẻ kho, một sự kiện', async () => {
    const { companyId, a } = await skuWith(5, 3);
    const k = randomUUID();
    const [x, y] = [randomUUID(), randomUUID()];

    const first = await withCompany(companyId, () => ship(k, [pl(a, 1, x), pl(a, 2, y)], { actorId: null }));

    expect(await withCompany(companyId, () => ship(k, [pl(a, 2, y), pl(a, 1, x)], { actorId: null }))).toEqual(first);
    const lines = await docLines(first.documentId);
    expect(lines).toMatchObject([
      { variant_id: a, quantity: 1, source_line_id: x },
      { variant_id: a, quantity: 2, source_line_id: y },
    ]);
    const moves = await movesOf(first.documentId);
    expect(moves.map((m) => [m.qty_change, m.source_line_id])).toEqual([
      [-1, lines[0].id],
      [-2, lines[1].id],
    ]);
    expect(moves.map((m) => m.balance_after)).toEqual([4, 2]);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 2, reserved: 0 });
    expect(await stockEvents(a)).toEqual([{ variantId: a, onHand: 2, reserved: 0, available: 2 }]);
  });

  it('một id dòng kiện xuất hiện hai lần trong một lần gọi → lỗi, không ghi gì', async () => {
    const { companyId, a } = await skuWith(5, 3);
    const k = randomUUID();
    const x = randomUUID();

    await expect(withCompany(companyId, () => ship(k, [pl(a, 1, x), pl(a, 2, x)], { actorId: null }))).rejects.toThrow(x);
    expect(await docsOfPackage(k)).toEqual([]);
  });

  it('AC6: đang Tồn âm (tồn 3 giữ 5) bàn giao thường 2 → tồn 1 giữ 3, vẫn invariant_broken', async () => {
    const { companyId, a } = await skuWith(3, 5);

    await withCompany(companyId, () => ship(randomUUID(), [pl(a, 2)], { actorId: null }));

    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 1, reserved: 3, invariant_broken: true });
  });

  it('AC7a: bàn giao bắt buộc khi tồn 1 giữ 0 → tồn −2, invariant_broken, phiếu có ghi chú, không người lập', async () => {
    const { companyId, a } = await skuWith(1, 0);

    const ref = await withCompany(companyId, () => ship(randomUUID(), [pl(a, 3)], { actorId: null, forced: true }));

    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: -2, reserved: 0, invariant_broken: true });
    expect(await docOf(ref.documentId)).toMatchObject({ note: 'Bàn giao bắt buộc theo sàn', created_by: null, posted_by: null });
    expect(await transitionsOf(ref.documentId)).toMatchObject([{ actor_id: null, source: 'system' }]);
  });

  it('AC7b: bàn giao bắt buộc khi đủ hàng (tồn 5, bắt buộc 3) → tồn 2, invariant_broken false', async () => {
    const { companyId, a } = await skuWith(5, 0);

    await withCompany(companyId, () => ship(randomUUID(), [pl(a, 3)], { actorId: null, forced: true }));

    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 2, reserved: 0, invariant_broken: false });
  });

  it('AC7c: kiện chưa giữ hàng mà không forced → lỗi; tồn, phiếu không đổi', async () => {
    const { companyId, a } = await skuWith(5, 0);
    const k = randomUUID();
    const before = await levelOf(companyId, a);

    await expect(withCompany(companyId, () => ship(k, [pl(a, 2)], { actorId: null }))).rejects.toThrow(/chưa giữ hàng/);

    expect(await levelOf(companyId, a)).toEqual(before);
    expect(await docsOfPackage(k)).toEqual([]);
  });

  it('AC7c: bên gọi bắt lỗi rồi vẫn commit giao dịch → bộ đếm số phiếu không tăng, không có phiếu', async () => {
    const { companyId, a } = await skuWith(5, 0);
    const k = randomUUID();

    await withCompany(companyId, async () => {
      await ship(k, [pl(a, 2)], { actorId: null }).catch(() => undefined);
    });

    expect(await counterOf(companyId, 'shipment')).toBeUndefined();
    expect(await docsOfPackage(k)).toEqual([]);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 5, reserved: 0 });
  });

  it('bàn giao bắt buộc SKU chưa có dòng tồn → tạo dòng tồn âm', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;

    await withCompany(companyId, () => ship(randomUUID(), [pl(a, 1)], { actorId: null, forced: true }));

    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: -1, reserved: 0, invariant_broken: true });
  });

  it('không có dòng nào → lỗi lập trình', async () => {
    const { companyId } = await companyWithVariants(0);

    await expect(withCompany(companyId, () => ship(randomUUID(), [], { actorId: null }))).rejects.toThrow();
  });

  it('AC10b: tồn 5 giữ 2; giữ A×3 cho kiện khác và bàn giao A×2 song song → cả hai qua, tồn 3 giữ 3', async () => {
    const { companyId, a } = await skuWith(5, 2);

    const [held] = await raceBehindLock(lockLevelRow(companyId, a), 2, () =>
      Promise.all([
        withCompany(companyId, () => reserve(randomUUID(), [line(a, 3)])),
        withCompany(companyId, () => ship(randomUUID(), [pl(a, 2)], { actorId: null })),
      ]),
    );

    expect(held).toEqual({ reserved: true });
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 3, reserved: 3, invariant_broken: false });
  });

  it('AC10c: tồn 5 giữ 2; hai lần bàn giao cùng kiện song song → cùng một phiếu, tồn 3, một dòng thẻ kho', async () => {
    const { companyId, a } = await skuWith(5, 2);
    const k6 = randomUUID();
    const y1 = randomUUID();

    const [r1, r2] = await raceBehindLock(lockLevelRow(companyId, a), 2, () =>
      Promise.all([1, 2].map(() => withCompany(companyId, () => ship(k6, [pl(a, 2, y1)], { actorId: null })))),
    );

    expect(r1).toEqual(r2);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 3, reserved: 0 });
    expect(await docsOfPackage(k6)).toEqual(['XK-000001']);
    expect(await movesOf(r1!.documentId)).toHaveLength(1);
  });
});

describe('reverseShipment', () => {
  const received = (variantId: string, accepted: number, unitCost: string) => [
    { lineId: randomUUID(), variantId, accepted, defective: 0, unitCost },
  ];

  it('AC8: đảo theo giá của lượt, giá vốn tính lại 90.000,00; gọi lại lỗi; bàn giao lại rồi đảo lần hai lấy giá 90.000', async () => {
    const { companyId, a } = await skuWith(10, 3);
    const k3 = randomUUID();
    const actor = randomUUID();
    const x3 = randomUUID();
    await withCompany(companyId, () => ship(k3, [pl(a, 3, x3)], { actorId: actor }));
    await withCompany(companyId, () => receiveGoods(randomUUID(), received(a, 10, '100000'), actor));
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 17, avg_cost: '91764.71' });

    const dx1 = await withCompany(companyId, () => reverseShipment(k3, [line(a, 3)], { actorId: actor, reason: 'Quét nhầm kiện' }));

    expect(dx1).toEqual({ documentId: expect.any(String), number: 'DX-000001' });
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 20, reserved: 3, avg_cost: '90000.00', invariant_broken: false });
    expect(await docOf(dx1.documentId)).toMatchObject({
      kind: 'shipment_reversal',
      status: 'posted',
      source_id: k3,
      note: 'Quét nhầm kiện',
      created_by: actor,
    });
    expect(await docLines(dx1.documentId)).toMatchObject([{ variant_id: a, quantity: 3, unit_cost: '80000.00' }]);
    expect(await movesOf(dx1.documentId)).toMatchObject([{ qty_change: 3, balance_after: 20, unit_cost: '80000.00', done_by: actor }]);
    expect((await stockEvents(a)).at(-1)).toEqual({ variantId: a, onHand: 20, reserved: 3, available: 17 });
    expect(await transitionsOf(dx1.documentId)).toMatchObject([{ to_state: 'posted', action: 'create', actor_id: actor }]);

    await expect(withCompany(companyId, () => reverseShipment(k3, [line(a, 3)], { actorId: actor, reason: 'Lần nữa' }))).rejects.toThrow(
      /không có lượt bàn giao/,
    );

    const xk2 = await withCompany(companyId, () => ship(k3, [pl(a, 3, x3)], { actorId: actor }));
    expect(xk2.number).toBe('XK-000002');
    expect(await docLines(xk2.documentId)).toMatchObject([{ unit_cost: '90000.00' }]);
    const dx2 = await withCompany(companyId, () => reverseShipment(k3, [line(a, 3)], { actorId: actor, reason: 'Nhầm lần hai' }));
    expect(dx2.number).toBe('DX-000002');
    expect(await docLines(dx2.documentId)).toMatchObject([{ unit_cost: '90000.00' }]);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 20, reserved: 3, avg_cost: '90000.00' });
  });

  it('hai SKU, lượt có phiếu bắt buộc và phiếu thường giá khác nhau: thẻ kho trỏ đúng dòng phiếu, giá đảo bình quân cả lượt', async () => {
    const { companyId, variants } = await companyWithVariants(2);
    const [a, b] = variants as [string, string];
    await receive(companyId, a, 10, 100);
    await receive(companyId, b, 10, 200);
    const k = randomUUID();
    const actor = randomUUID();
    await withCompany(companyId, () => ship(k, [pl(a, 2)], { actorId: null, forced: true }));
    await withCompany(companyId, () => receiveGoods(randomUUID(), received(a, 10, '300'), actor));
    await setBuckets(companyId, a, { reserved: 1 });
    await setBuckets(companyId, b, { reserved: 1 });

    const xk2 = await withCompany(companyId, () => ship(k, [pl(a, 1), pl(b, 1)], { actorId: actor }));

    expect(xk2.number).toBe('XK-000002');
    const xkLines = new Map((await docLines(xk2.documentId)).map((l) => [l.variant_id, l]));
    expect(xkLines.get(a)).toMatchObject({ quantity: 1, unit_cost: '211.11' });
    expect(xkLines.get(b)).toMatchObject({ quantity: 1, unit_cost: '200.00' });
    const { rows: moves } = await testPool().query('select variant_id, source_line_id, balance_after from product.stock_moves where source_id = $1', [
      xk2.documentId,
    ]);
    expect(new Map(moves.map((m) => [m.variant_id, m.source_line_id]))).toEqual(new Map([[a, xkLines.get(a).id], [b, xkLines.get(b).id]]));
    expect((await stockEvents(b)).at(-1)).toEqual({ variantId: b, onHand: 9, reserved: 0, available: 9 });

    const dx = await withCompany(companyId, () => reverseShipment(k, [line(a, 3), line(b, 1)], { actorId: actor, reason: 'Quét nhầm kiện' }));

    const dxLines = new Map((await docLines(dx.documentId)).map((l) => [l.variant_id, l]));
    expect(dxLines.get(a)).toMatchObject({ quantity: 3, unit_cost: '137.04' });
    expect(dxLines.get(b)).toMatchObject({ quantity: 1, unit_cost: '200.00' });
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 20, reserved: 3, avg_cost: '200.00' });
    expect(await levelOf(companyId, b)).toMatchObject({ on_hand: 10, reserved: 1, avg_cost: '200.00' });
  });

  it('lý do chỉ có khoảng trắng hoặc dài 501 ký tự → lỗi, không có phiếu đảo; dài đúng 500 thì được', async () => {
    const { companyId, a } = await skuWith(5, 3);
    const k = randomUUID();
    await withCompany(companyId, () => ship(k, [pl(a, 3)], { actorId: null }));

    for (const reason of ['   ', 'x'.repeat(501)]) {
      await expect(withCompany(companyId, () => reverseShipment(k, [line(a, 3)], { actorId: randomUUID(), reason }))).rejects.toThrow(/lý do/i);
    }
    expect(await docsOfPackage(k)).toEqual(['XK-000001']);

    await withCompany(companyId, () => reverseShipment(k, [line(a, 3)], { actorId: randomUUID(), reason: 'x'.repeat(500) }));
    expect(await docsOfPackage(k)).toEqual(['DX-000001', 'XK-000001']);
  });

  it('đảo SKU không có trong lượt, hoặc nhiều hơn số đã xuất → lỗi, không có phiếu đảo', async () => {
    const { companyId, variants } = await companyWithVariants(2);
    const [a, b] = variants as [string, string];
    await receive(companyId, a, 5, 1000);
    await setBuckets(companyId, a, { reserved: 2 });
    const k = randomUUID();
    await withCompany(companyId, () => ship(k, [pl(a, 2)], { actorId: null }));
    const reverse = (lines: { variantId: string; quantity: number }[]) =>
      withCompany(companyId, () => reverseShipment(k, lines, { actorId: randomUUID(), reason: 'Nhầm' }));

    await expect(reverse([line(a, 3)])).rejects.toThrow(/chỉ xuất 2/);
    await expect(reverse([line(b, 1)])).rejects.toThrow(/chỉ xuất 0/);
    expect(await docsOfPackage(k)).toEqual(['XK-000001']);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 3, reserved: 0 });
  });

  it('kiện chưa từng bàn giao → lỗi', async () => {
    const { companyId, a } = await skuWith(5, 0);

    await expect(
      withCompany(companyId, () => reverseShipment(randomUUID(), [line(a, 1)], { actorId: randomUUID(), reason: 'Nhầm' })),
    ).rejects.toThrow(/không có lượt bàn giao/);
  });
});
