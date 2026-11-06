import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { reserve, ship, stockOf } from '#src/modules/product/index.ts';
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
    'select id, variant_id, quantity, unit_cost from product.stock_document_lines where document_id = $1 order by variant_id',
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

    const { ref, snapshot } = await withCompany(companyId, async () => {
      const ref = await ship(k3, [line(a, 3)], { actorId: actor });
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
    expect(lines).toEqual([{ id: expect.any(String), variant_id: a, quantity: 3, unit_cost: '80000.00' }]);
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

  it('AC5: gọi lại cùng kiện cùng dòng → trả phiếu cũ, không thêm phiếu, thẻ kho, sự kiện', async () => {
    const { companyId, a } = await skuWith(10, 3);
    const k3 = randomUUID();
    const first = await withCompany(companyId, () => ship(k3, [line(a, 3)], { actorId: null }));

    const again = await withCompany(companyId, () => ship(k3, [line(a, 3)], { actorId: null }));

    expect(again).toEqual(first);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 7, reserved: 0 });
    expect(await docsOfPackage(k3)).toEqual(['XK-000001']);
    expect(await movesOf(first.documentId)).toHaveLength(1);
    expect(await stockEvents(a)).toHaveLength(1);
  });

  it('gọi lặp với dòng tách khác: A×1 + A×2 rồi A×3 → cùng phiếu (lưới so theo dòng đã gộp)', async () => {
    const { companyId, a } = await skuWith(5, 3);
    const k = randomUUID();
    const first = await withCompany(companyId, () => ship(k, [line(a, 1), line(a, 2)], { actorId: null }));

    expect(await withCompany(companyId, () => ship(k, [line(a, 3)], { actorId: null }))).toEqual(first);
    expect(await docLines(first.documentId)).toMatchObject([{ variant_id: a, quantity: 3 }]);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 2, reserved: 0 });
  });

  it('AC6: đang Tồn âm (tồn 3 giữ 5) bàn giao thường 2 → tồn 1 giữ 3, vẫn invariant_broken', async () => {
    const { companyId, a } = await skuWith(3, 5);

    await withCompany(companyId, () => ship(randomUUID(), [line(a, 2)], { actorId: null }));

    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 1, reserved: 3, invariant_broken: true });
  });

  it('AC7a: bàn giao bắt buộc khi tồn 1 giữ 0 → tồn −2, invariant_broken, phiếu có ghi chú, không người lập', async () => {
    const { companyId, a } = await skuWith(1, 0);

    const ref = await withCompany(companyId, () => ship(randomUUID(), [line(a, 3)], { actorId: null, forced: true }));

    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: -2, reserved: 0, invariant_broken: true });
    expect(await docOf(ref.documentId)).toMatchObject({ note: 'Bàn giao bắt buộc theo sàn', created_by: null, posted_by: null });
    expect(await transitionsOf(ref.documentId)).toMatchObject([{ actor_id: null, source: 'system' }]);
  });

  it('AC7b: bàn giao bắt buộc khi đủ hàng (tồn 5, bắt buộc 3) → tồn 2, invariant_broken false', async () => {
    const { companyId, a } = await skuWith(5, 0);

    await withCompany(companyId, () => ship(randomUUID(), [line(a, 3)], { actorId: null, forced: true }));

    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 2, reserved: 0, invariant_broken: false });
  });

  it('AC7c: kiện chưa giữ hàng mà không forced → lỗi; tồn, phiếu, bộ đếm không đổi', async () => {
    const { companyId, a } = await skuWith(5, 0);
    const k = randomUUID();
    const before = await levelOf(companyId, a);

    await expect(withCompany(companyId, () => ship(k, [line(a, 2)], { actorId: null }))).rejects.toThrow(/chưa giữ hàng/);

    expect(await levelOf(companyId, a)).toEqual(before);
    expect(await docsOfPackage(k)).toEqual([]);
    expect(await counterOf(companyId, 'shipment')).toBeUndefined();
  });

  it('bàn giao bắt buộc SKU chưa có dòng tồn → tạo dòng tồn âm', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;

    await withCompany(companyId, () => ship(randomUUID(), [line(a, 1)], { actorId: null, forced: true }));

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
        withCompany(companyId, () => ship(randomUUID(), [line(a, 2)], { actorId: null })),
      ]),
    );

    expect(held).toEqual({ reserved: true });
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 3, reserved: 3, invariant_broken: false });
  });

  it('AC10c: tồn 5 giữ 2; hai lần bàn giao cùng kiện song song → cùng một phiếu, tồn 3, một dòng thẻ kho', async () => {
    const { companyId, a } = await skuWith(5, 2);
    const k6 = randomUUID();

    const [r1, r2] = await raceBehindLock(lockLevelRow(companyId, a), 2, () =>
      Promise.all([1, 2].map(() => withCompany(companyId, () => ship(k6, [line(a, 2)], { actorId: null })))),
    );

    expect(r1).toEqual(r2);
    expect(await levelOf(companyId, a)).toMatchObject({ on_hand: 3, reserved: 0 });
    expect(await docsOfPackage(k6)).toEqual(['XK-000001']);
    expect(await movesOf(r1!.documentId)).toHaveLength(1);
  });
});
