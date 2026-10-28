import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

const db = () => testPool();
const number = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

/** Mỗi lần một NCC tên khác: tên NCC không trùng trong công ty (`suppliers_company_lower_name_uq`). */
async function supplier(companyId: string) {
  const r = await db().query<{ id: string }>('insert into product.suppliers (company_id, name) values ($1, $2) returning id', [
    companyId,
    number('NCC'),
  ]);
  return r.rows[0]!.id;
}

const insertRequest = (companyId: string, cols: Record<string, unknown>) => {
  const all = { company_id: companyId, number: number('DN'), ...cols };
  const keys = Object.keys(all);
  return db().query<{ id: string }>(
    `insert into product.purchase_requests (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(all),
  );
};

const insertLine = (companyId: string, requestId: string, cols: Record<string, unknown>) => {
  const all = { company_id: companyId, request_id: requestId, ordered_qty: 10, unit_price: '1000', ...cols };
  const keys = Object.keys(all);
  return db().query<{ id: string }>(
    `insert into product.purchase_request_lines (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(all),
  );
};

// Đề nghị nhập, phiếu nhận, phiếu trả NCC (Documents/19 mục 3.2; 25 §3, §4).
describe('ràng buộc đề nghị nhập', () => {
  it('nháp chưa cần NCC; chờ duyệt thiếu NCC bị từ chối', async () => {
    const c = randomUUID();
    await expect(insertRequest(c, { status: 'draft' })).resolves.toBeDefined();
    await expect(insertRequest(c, { status: 'pending_approval' })).rejects.toThrow(/"purchase_requests_supplier"/);
  });

  it('người duyệt trùng người lập bị từ chối, trừ khi đánh dấu tự duyệt', async () => {
    const c = randomUUID();
    const s = await supplier(c);
    const ceo = randomUUID();
    await expect(
      insertRequest(c, { supplier_id: s, status: 'approved', created_by: ceo, approved_by: ceo }),
    ).rejects.toThrow(/"purchase_requests_second_person"/);
    await expect(
      insertRequest(c, { supplier_id: s, status: 'approved', created_by: ceo, approved_by: ceo, self_approved: true }),
    ).resolves.toBeDefined();
    await expect(
      insertRequest(c, { supplier_id: s, status: 'approved', created_by: ceo, approved_by: randomUUID() }),
    ).resolves.toBeDefined();
  });

  it('dòng sản phẩm mới không cần SKU; dòng không có SKU lẫn tên sản phẩm mới bị từ chối', async () => {
    const c = randomUUID();
    const r = (await insertRequest(c, {})).rows[0]!.id;
    await expect(insertLine(c, r, { new_product_name: 'Hộp cơm 1L' })).resolves.toBeDefined();
    await expect(insertLine(c, r, {})).rejects.toThrow(/"purchase_request_lines_item"/);
  });

  it('còn chờ = đặt − nhận − lỗi − đóng thiếu không âm; số đặt 0, giá âm bị từ chối', async () => {
    const c = randomUUID();
    const r = (await insertRequest(c, {})).rows[0]!.id;
    const v = randomUUID();
    await expect(insertLine(c, r, { variant_id: v, received_qty: 7, defective_qty: 2, closed_short_qty: 1 })).resolves.toBeDefined();
    await expect(insertLine(c, r, { variant_id: v, received_qty: 8, defective_qty: 2, closed_short_qty: 1 })).rejects.toThrow(
      /"purchase_request_lines_outstanding"/,
    );
    await expect(insertLine(c, r, { variant_id: v, ordered_qty: 0 })).rejects.toThrow(/"purchase_request_lines_ordered"/);
    await expect(insertLine(c, r, { variant_id: v, unit_price: '-1' })).rejects.toThrow(/"purchase_request_lines_unit_price"/);
  });
});

describe('ràng buộc phiếu nhận', () => {
  async function receiptWithLine(c: string, line: { declared: number; accepted: number; defective: number; onSpot: number }) {
    const r = (await insertRequest(c, {})).rows[0]!.id;
    const rl = (await insertLine(c, r, { variant_id: randomUUID() })).rows[0]!.id;
    const g = await db().query<{ id: string }>(
      `insert into product.goods_receipts (company_id, number, request_id, delivery_mode) values ($1, $2, $3, 'driver_left') returning id`,
      [c, number('PNH'), r],
    );
    return db().query<{ shortage_qty: number }>(
      `insert into product.goods_receipt_lines
         (company_id, receipt_id, request_line_id, variant_id, declared_qty, accepted_qty, defective_qty, returned_on_spot_qty)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning shortage_qty`,
      [c, g.rows[0]!.id, rl, randomUUID(), line.declared, line.accepted, line.defective, line.onSpot],
    );
  }

  it('số thiếu tự tính = báo giao − đạt − lỗi − trả tại chỗ', async () => {
    const res = await receiptWithLine(randomUUID(), { declared: 100, accepted: 92, defective: 3, onSpot: 0 });
    expect(res.rows[0]!.shortage_qty).toBe(5);
  });

  it('đạt + lỗi + trả tại chỗ vượt số báo giao bị từ chối', async () => {
    await expect(receiptWithLine(randomUUID(), { declared: 10, accepted: 9, defective: 1, onSpot: 1 })).rejects.toThrow(
      /"goods_receipt_lines_within_declared"/,
    );
  });

  it('phiếu sang đã xử lý phải có kết quả giao thiếu; giao bù phải trỏ phiếu bù', async () => {
    const c = randomUUID();
    const r = (await insertRequest(c, {})).rows[0]!.id;
    const insert = (cols: string, vals: unknown[]) =>
      db().query(
        `insert into product.goods_receipts (company_id, number, request_id, delivery_mode, posted_at, ${cols})
         values ($1, $2, $3, 'driver_waiting', now(), ${vals.map((_, i) => `$${i + 4}`).join(', ')})`,
        [c, number('PNH'), r, ...vals],
      );
    await expect(insert('status', ['resolved'])).rejects.toThrow(/"goods_receipts_resolved"/);
    await expect(insert('status, short_resolution', ['resolved', 'follow_up'])).rejects.toThrow(/"goods_receipts_follow_up"/);
    await expect(insert('status, short_resolution', ['resolved', 'supplier_wrong'])).resolves.toBeDefined();
  });
});

describe('ràng buộc phiếu trả NCC', () => {
  const insertReturn = async (c: string, cols: Record<string, unknown>) => {
    const all = { company_id: c, number: number('TN'), source: 'manual', supplier_id: await supplier(c), ...cols };
    const keys = Object.keys(all);
    return db().query(
      `insert into product.supplier_returns (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(all),
    );
  };

  it('hoàn tiền bắt buộc số tiền ≥ 1; huỷ bắt buộc chọn cách xử lý hàng', async () => {
    const c = randomUUID();
    await expect(insertReturn(c, { status: 'refunded' })).rejects.toThrow(/"supplier_returns_refund"/);
    await expect(insertReturn(c, { status: 'refunded', refund_amount: '0' })).rejects.toThrow(/"supplier_returns_refund_amount"/);
    await expect(insertReturn(c, { status: 'refunded', refund_amount: '50000' })).resolves.toBeDefined();
    await expect(insertReturn(c, { status: 'cancelled' })).rejects.toThrow(/"supplier_returns_cancel"/);
    await expect(insertReturn(c, { status: 'cancelled', cancel_decision: 'restock' })).resolves.toBeDefined();
  });

  it('người ghi kết quả trùng người gửi bị từ chối', async () => {
    const c = randomUUID();
    const u = randomUUID();
    await expect(insertReturn(c, { status: 'returned_to_us', sent_by: u, result_by: u })).rejects.toThrow(
      /"supplier_returns_result_by"/,
    );
  });
});
