import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { orderArchiveBlockers, orderInUse } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

// Lý do chặn lưu trữ SKU phần đơn (#204, Documents/21 §17.3, spec 204 D9): đơn `unpaid`, `processing`; yêu cầu trả mở.
let companyId: string;
beforeAll(async () => {
  companyId = (await createCompany()).companyId;
});

const sku = async () => (await createVariant(companyId)).variantId;
const blockersOf = (ids: string[]) => withCompany(companyId, () => orderArchiveBlockers(ids));
const orderWith = async (variantId: string, status?: 'unpaid' | 'processing' | 'completed' | 'cancelled') => {
  const order = await createOrder(companyId, { lines: [{ variantId, quantity: 2, unitPrice: 100000 }] });
  if (status) {
    // Đơn hoàn tất phải có kết quả (CHECK `orders_outcome`).
    await testPool().query(
      `update "order".orders set status = $2::"order".order_status,
         outcome = case when $2::text = 'completed' then 'full'::"order".order_outcome end where id = $1`,
      [order.orderId, status],
    );
  }
  return order.orderId;
};

/** Yêu cầu trả ở `status` của đơn (đơn đặt `completed`), một dòng mang SKU. */
async function returnRequest(variantId: string, status: 'requested' | 'closed') {
  const orderId = await orderWith(variantId, 'completed');
  const line = await testPool().query<{ id: string }>('select id from "order".order_lines where order_id = $1', [orderId]);
  const req = await testPool().query<{ id: string }>(
    `insert into "order".return_requests (company_id, code, order_id, source, status, reason, close_result)
     values ($1, $2, $3, 'manual', $4::"order".return_status, 'Khách đổi ý', case when $4::text = 'closed' then 'inspected'::"order".return_close_result end)
     returning id`,
    [companyId, `TH-T${randomUUID().slice(0, 8)}`, orderId, status],
  );
  await testPool().query(
    `insert into "order".return_request_lines (company_id, request_id, order_line_id, variant_id, quantity, unit_price)
     values ($1, $2, $3, $4, 1, 100000)`,
    [companyId, req.rows[0]!.id, line.rows[0]!.id, variantId],
  );
}

describe('orderArchiveBlockers (#204)', () => {
  it.each(['unpaid', 'processing'] as const)('đơn %s có SKU → còn đơn chưa xong', async (status) => {
    const v = await sku();
    await orderWith(v, status);
    expect(await blockersOf([v])).toEqual(new Map([[v, ['Còn 1 đơn chưa xong']]]));
  });

  it.each(['completed', 'cancelled'] as const)('đơn %s không tính', async (status) => {
    const v = await sku();
    await orderWith(v, status);
    expect(await blockersOf([v])).toEqual(new Map());
  });

  it('dòng đã huỷ hết (cancelled_qty = quantity) không tính', async () => {
    const v = await sku();
    const orderId = await orderWith(v, 'processing');
    await testPool().query('update "order".order_lines set cancelled_qty = quantity where order_id = $1', [orderId]);
    expect(await blockersOf([v])).toEqual(new Map());
  });

  it('yêu cầu trả đang mở có SKU; yêu cầu đã đóng không tính', async () => {
    const open = await sku();
    const closed = await sku();
    await returnRequest(open, 'requested');
    await returnRequest(closed, 'closed');
    expect(await blockersOf([open, closed])).toEqual(new Map([[open, ['Còn 1 yêu cầu trả đang mở']]]));
  });
});

// SKU đã dùng (#204 spec mục 6): dòng đơn, yêu cầu trả, dòng kiện, kiện trả không khớp ở mọi trạng thái.
describe('orderInUse (#204)', () => {
  const inUse = (ids: string[]) => withCompany(companyId, () => orderInUse(ids));

  it('SKU mới không có; đơn đã huỷ vẫn tính; chỉ có trong kiện trả không khớp cũng tính', async () => {
    const [fresh, cancelled, parcel] = [await sku(), await sku(), await sku()];
    await orderWith(cancelled, 'cancelled');
    const p = await testPool().query<{ id: string }>(
      `insert into "order".unmatched_return_parcels (company_id, code, scanned_code) values ($1, $2, $3) returning id`,
      [companyId, `KL-T${randomUUID().slice(0, 8)}`, randomUUID()],
    );
    await testPool().query(
      `insert into "order".unmatched_return_parcel_lines (company_id, parcel_id, variant_id, quantity) values ($1, $2, $3, 1)`,
      [companyId, p.rows[0]!.id, parcel],
    );
    expect(await inUse([fresh, cancelled, parcel])).toEqual(new Set([cancelled, parcel]));
    expect(await inUse([])).toEqual(new Set());
  });
});
