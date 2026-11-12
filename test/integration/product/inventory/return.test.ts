import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { receiveBack, stockOf } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { companyWithVariants, receive } from './helpers.ts';

// Hàng quay về kho (spec #206 mục 5.5, Q19, AC 9; #208 đổi 11/11/2026, Documents/21 §11.1, §15.3): lập phiếu kiểm hàng hoàn
// nháp có số dự kiến, số quét; chờ xử lý tăng ngay theo số quét, tồn thực chưa đổi.

async function levelOf(companyId: string, variantId: string) {
  const { rows } = await testPool().query(
    'select on_hand, reserved, quarantine, avg_cost, version from product.stock_levels where company_id = $1 and variant_id = $2',
    [companyId, variantId],
  );
  return rows[0];
}

async function docOf(documentId: string) {
  const { rows } = await testPool().query(
    'select kind, status, source_type, source_id, created_by, posted_at from product.stock_documents where id = $1',
    [documentId],
  );
  return rows[0];
}

async function docLines(documentId: string) {
  const { rows } = await testPool().query(
    'select variant_id, quantity, expected_qty, scanned_qty, unit_cost from product.stock_document_lines where document_id = $1 order by created_at',
    [documentId],
  );
  return rows;
}

async function docsOfSource(sourceId: string) {
  const { rows } = await testPool().query('select number from product.stock_documents where source_id = $1', [sourceId]);
  return rows;
}

async function outboxOf(variantId: string) {
  const { rows } = await testPool().query('select type from core.outbox_messages where key = $1', [variantId]);
  return rows;
}

async function transitionsOf(entityId: string) {
  const { rows } = await testPool().query('select to_state, actor_id, source from core.state_transitions where entity_id = $1', [entityId]);
  return rows;
}

/** Món quét đủ số dự kiến. */
const line = (variantId: string, quantity: number, scanned = quantity) => ({ variantId, expected: quantity, scanned });

async function movesOf(documentId: string) {
  const { rows } = await testPool().query(
    'select variant_id, bucket, qty_change, balance_after, done_by from product.stock_moves where source_id = $1 order by id',
    [documentId],
  );
  return rows;
}

describe('receiveBack', () => {
  it('AC9: lập phiếu KT-000001 nháp, một dòng gộp theo SKU; chờ xử lý tăng đúng số quét, tồn thực và outbox không đổi; gọi lại cùng nguồn trả phiếu cũ, không cộng lần nữa', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;
    await receive(companyId, a, 5, 1000);
    const before = await levelOf(companyId, a);
    const k5 = randomUUID();

    const kt1 = await withCompany(companyId, () => receiveBack({ type: 'package', id: k5 }, [line(a, 2), line(a, 1)]));

    expect(kt1).toEqual({ documentId: expect.any(String), number: 'KT-000001' });
    expect(await docOf(kt1.documentId)).toEqual({
      kind: 'return_inspection',
      status: 'draft',
      source_type: 'package',
      source_id: k5,
      created_by: null,
      posted_at: null,
    });
    expect(await docLines(kt1.documentId)).toEqual([{ variant_id: a, quantity: null, expected_qty: 3, scanned_qty: 3, unit_cost: null }]);
    const after = await levelOf(companyId, a);
    expect(after).toMatchObject({ on_hand: before.on_hand, reserved: before.reserved, quarantine: before.quarantine + 3, avg_cost: before.avg_cost });
    expect(await movesOf(kt1.documentId)).toEqual([
      { variant_id: a, bucket: 'quarantine', qty_change: 3, balance_after: before.quarantine + 3, done_by: null },
    ]);
    expect(await outboxOf(a)).toEqual([]);
    expect(await transitionsOf(kt1.documentId)).toEqual([{ to_state: 'draft', actor_id: null, source: 'system' }]);

    expect(await withCompany(companyId, () => receiveBack({ type: 'package', id: k5 }, [line(a, 3)]))).toEqual(kt1);
    expect(await docsOfSource(k5)).toHaveLength(1);
    expect(await levelOf(companyId, a)).toEqual(after);
  });

  it('món nguồn vắng (quét 0) tính là thiếu, món ngoài nguồn (dự kiến 0) vẫn nhận; chờ xử lý chỉ tăng theo số quét; người quét ghi trên phiếu và thẻ kho', async () => {
    const { companyId, variants } = await companyWithVariants(3);
    const [a, b, c] = variants as [string, string, string];
    const scanner = randomUUID();
    const ref = await withCompany(companyId, () =>
      receiveBack(
        { type: 'return_request', id: randomUUID() },
        [line(a, 2, 1), line(b, 1, 0), { variantId: c, expected: 0, scanned: 2 }],
        { actorId: scanner, number: 'YCT-000009' },
      ),
    );
    expect(await docLines(ref.documentId)).toEqual([
      { variant_id: a, quantity: null, expected_qty: 2, scanned_qty: 1, unit_cost: null },
      { variant_id: b, quantity: null, expected_qty: 1, scanned_qty: 0, unit_cost: null },
      { variant_id: c, quantity: null, expected_qty: 0, scanned_qty: 2, unit_cost: null },
    ]);
    expect(await docOf(ref.documentId)).toMatchObject({ created_by: scanner });
    expect((await movesOf(ref.documentId)).map((m) => [m.variant_id, m.qty_change, m.done_by]).sort()).toEqual(
      [
        [a, 1, scanner],
        [c, 2, scanner],
      ].sort(),
    );
    expect((await levelOf(companyId, b))?.quarantine ?? 0).toBe(0);
  });

  it('kiện trả không khớp: dự kiến bằng số quét, cộng chờ xử lý một lần; gắn vào yêu cầu thì phiếu chuyển nguồn, đặt lại dự kiến, không cộng lần hai', async () => {
    const { companyId, variants } = await companyWithVariants(2);
    const [a, b] = variants as [string, string];
    const parcel = randomUUID();
    const request = randomUUID();
    const kt = await withCompany(companyId, () => receiveBack({ type: 'unmatched_parcel', id: parcel }, [{ variantId: a, expected: 0, scanned: 2 }]));
    expect(await docLines(kt.documentId)).toEqual([{ variant_id: a, quantity: null, expected_qty: 2, scanned_qty: 2, unit_cost: null }]);
    expect(await withCompany(companyId, () => receiveBack({ type: 'unmatched_parcel', id: parcel }, [{ variantId: a, expected: 0, scanned: 2 }]))).toEqual(kt);
    expect((await levelOf(companyId, a)).quarantine).toBe(2);

    const moved = await withCompany(companyId, () =>
      receiveBack({ type: 'return_request', id: request }, [line(a, 3, 2), line(b, 1, 0)], {
        fromUnmatchedParcelId: parcel,
        number: 'YCT-000010',
        unitCosts: { [b]: '45000.00' },
      }),
    );
    expect(moved).toEqual(kt);
    expect(await docOf(kt.documentId)).toMatchObject({ source_type: 'return_request', source_id: request });
    expect(await docLines(kt.documentId)).toEqual([
      { variant_id: a, quantity: null, expected_qty: 3, scanned_qty: 2, unit_cost: null },
      { variant_id: b, quantity: null, expected_qty: 1, scanned_qty: 0, unit_cost: '45000.00' },
    ]);
    expect((await levelOf(companyId, a)).quarantine).toBe(2);
    expect(await movesOf(kt.documentId)).toHaveLength(1);
    expect(await docsOfSource(parcel)).toEqual([]);
    // Gắn lại lần nữa (gọi lặp): vẫn phiếu đó
    expect(
      await withCompany(companyId, () => receiveBack({ type: 'return_request', id: request }, [line(a, 3, 2)], { fromUnmatchedParcelId: parcel })),
    ).toEqual(kt);
  });

  it('kiện trả không khớp chưa món nào rõ SKU: vẫn có phiếu nháp không dòng, chưa cộng chờ xử lý', async () => {
    const { companyId } = await companyWithVariants();
    const kt = await withCompany(companyId, () => receiveBack({ type: 'unmatched_parcel', id: randomUUID() }, []));
    expect(await docLines(kt.documentId)).toEqual([]);
    expect(await movesOf(kt.documentId)).toEqual([]);
  });

  it('hai lần gọi song song cùng nguồn → cùng một phiếu, không nhảy số KT, giao dịch bên gọi vẫn dùng được', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;
    // Phiếu của nguồn khác để có sẵn dòng đếm KT cho giao dịch giữ khoá.
    await withCompany(companyId, () => receiveBack({ type: 'package', id: randomUUID() }, [line(a, 1)]));
    const k = randomUUID();
    // Đọc thêm sau `receiveBack` trong cùng giao dịch: bên thua đụng unique thì giao dịch của bên gọi vẫn phải chạy tiếp.
    const call = () =>
      withCompany(companyId, async () => {
        const ref = await receiveBack({ type: 'package', id: k }, [line(a, 2)]);
        await stockOf([a]);
        return ref;
      });

    const [first, second] = await raceBehindLock(
      (holder) =>
        holder.query("select 1 from product.doc_counters where company_id = $1 and doc_type = 'return_inspection' for update", [companyId]),
      2,
      () => Promise.all([call(), call()]),
    );

    expect(second).toEqual(first);
    expect(first.number).toBe('KT-000002');
    expect(await docsOfSource(k)).toHaveLength(1);
    const { rows } = await testPool().query(
      "select next_number from product.doc_counters where company_id = $1 and doc_type = 'return_inspection'",
      [companyId],
    );
    expect(rows).toEqual([{ next_number: 3 }]);
  });

  it('AC9: nguồn là yêu cầu trả khác → phiếu mới KT-000002', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;
    await withCompany(companyId, () => receiveBack({ type: 'package', id: randomUUID() }, [line(a, 1)]));

    const kt2 = await withCompany(companyId, () => receiveBack({ type: 'return_request', id: randomUUID() }, [line(a, 1)]));

    expect(kt2.number).toBe('KT-000002');
    expect(await docOf(kt2.documentId)).toMatchObject({ source_type: 'return_request' });
  });

  it('SKU của công ty khác → lỗi, không lập phiếu', async () => {
    const A = await companyWithVariants(0);
    const B = await companyWithVariants(1);
    const k = randomUUID();

    await expect(withCompany(A.companyId, () => receiveBack({ type: 'package', id: k }, [line(B.variants[0]!, 1)]))).rejects.toThrow(
      /không thuộc công ty/,
    );
    expect(await docsOfSource(k)).toEqual([]);
  });

  it('không có dòng nào, hoặc loại nguồn lạ → lỗi lập trình', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;

    await expect(withCompany(companyId, () => receiveBack({ type: 'package', id: randomUUID() }, []))).rejects.toThrow(/không có dòng/);
    await expect(
      withCompany(companyId, () => receiveBack({ type: 'order' as 'package', id: randomUUID() }, [line(a, 1)])),
    ).rejects.toThrow(/không hợp lệ/);
  });
});
