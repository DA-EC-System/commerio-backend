import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const db = () => testPool();

const insertLevel = (c: string, cols: { on_hand: number; reserved?: number; quarantine?: number; invariant_broken?: boolean }) =>
  db().query(
    `insert into product.stock_levels (company_id, variant_id, on_hand, reserved, quarantine, invariant_broken)
     values ($1, $2, $3, $4, $5, $6)`,
    [c, randomUUID(), cols.on_hand, cols.reserved ?? 0, cols.quarantine ?? 0, cols.invariant_broken ?? false],
  );

// Bất biến tồn kiểu "không làm tệ hơn" (25 §7.1, Documents/19 mục 3.2).
describe('bất biến tồn', () => {
  it('tồn thực âm hoặc đang giữ vượt tồn thực bị từ chối khi chưa bật cờ Tồn âm', async () => {
    const c = randomUUID();
    await expect(insertLevel(c, { on_hand: -1 })).rejects.toThrow(/"stock_levels_invariant"/);
    await expect(insertLevel(c, { on_hand: 2, reserved: 3 })).rejects.toThrow(/"stock_levels_invariant"/);
    await expect(insertLevel(c, { on_hand: 3, reserved: 3 })).resolves.toBeDefined();
  });

  it('hai ngoại lệ (bàn giao bắt buộc, kiểm kê đã duyệt) ghi được khi bật cờ Tồn âm', async () => {
    await expect(insertLevel(randomUUID(), { on_hand: -2, invariant_broken: true })).resolves.toBeDefined();
  });

  it('chờ xử lý, đang giữ không bao giờ âm, kể cả khi bật cờ', async () => {
    const c = randomUUID();
    await expect(insertLevel(c, { on_hand: 0, quarantine: -1, invariant_broken: true })).rejects.toThrow(/"stock_levels_quarantine"/);
    await expect(insertLevel(c, { on_hand: 0, reserved: -1, invariant_broken: true })).rejects.toThrow(/"stock_levels_reserved"/);
  });
});

describe('thẻ kho chỉ thêm', () => {
  it('role ứng dụng ghi được, không sửa, không xoá', async () => {
    const c = randomUUID();
    const insert = (q: (s: string, v: unknown[]) => Promise<unknown>) =>
      q(
        `insert into product.stock_moves (company_id, variant_id, bucket, qty_change, balance_after, source_type, source_id)
         values ($1, $2, 'on_hand', 1, 1, 'stock_document', $3)`,
        [c, randomUUID(), randomUUID()],
      );
    await expect(asCompany(c, (x) => insert((s, v) => x.query(s, v)))).resolves.toBeDefined();
    await expect(
      asCompany(c, async (x) => {
        await insert((s, v) => x.query(s, v));
        await x.query('update product.stock_moves set qty_change = 2');
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asCompany(c, async (x) => {
        await insert((s, v) => x.query(s, v));
        await x.query('delete from product.stock_moves');
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('phiếu kho', () => {
  const insertDoc = (c: string, cols: Record<string, unknown>) => {
    const all = { company_id: c, number: `PK-${randomUUID().slice(0, 8)}`, kind: 'write_off', ...cols };
    const keys = Object.keys(all);
    return db().query<{ id: string }>(
      `insert into product.stock_documents (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(all),
    );
  };

  it('người duyệt trùng người lập bị từ chối; kiểm kê phải có thời điểm đếm; ghi sổ phải có thời điểm ghi sổ', async () => {
    const c = randomUUID();
    const u = randomUUID();
    await expect(insertDoc(c, { created_by: u, approved_by: u })).rejects.toThrow(/"stock_documents_second_person"/);
    await expect(insertDoc(c, { kind: 'stocktake' })).rejects.toThrow(/"stock_documents_counted_at"/);
    await expect(insertDoc(c, { status: 'posted' })).rejects.toThrow(/"stock_documents_posted"/);
  });

  it('phiếu xuất theo kiện phải trỏ kiện; kiểm kê đầu kỳ chỉ là phiếu kiểm kê', async () => {
    const c = randomUUID();
    await expect(insertDoc(c, { kind: 'shipment' })).rejects.toThrow(/"stock_documents_shipment_source"/);
    await expect(insertDoc(c, { kind: 'shipment', source_type: 'package', source_id: randomUUID() })).resolves.toBeDefined();
    await expect(insertDoc(c, { is_opening: true })).rejects.toThrow(/"stock_documents_opening"/);
  });

  it('dòng kiểm hàng về: bán lại + hỏng + trả NCC phải bằng số quét', async () => {
    const c = randomUUID();
    const doc = (await insertDoc(c, { kind: 'return_inspection' })).rows[0]!.id;
    const line = (scanned: number, resell: number, damaged: number, toSupplier: number) =>
      db().query(
        `insert into product.stock_document_lines
           (company_id, document_id, variant_id, expected_qty, scanned_qty, resell_qty, damaged_qty, to_supplier_qty)
         values ($1, $2, $3, 3, $4, $5, $6, $7)`,
        [c, doc, randomUUID(), scanned, resell, damaged, toSupplier],
      );
    await expect(line(3, 2, 1, 0)).resolves.toBeDefined();
    await expect(line(3, 2, 0, 0)).rejects.toThrow(/"stock_document_lines_inspection_sum"/);
  });
});
