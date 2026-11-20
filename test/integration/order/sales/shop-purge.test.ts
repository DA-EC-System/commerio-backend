import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { purgeShopOrders, shopOrderRefs } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

// #398: xoá gian hàng đã ngắt. Đơn của gian hàng là đơn có `shop_id`; yêu cầu trả của gian hàng là yêu cầu có `shop_id`
// hoặc trỏ đơn của gian hàng. Gian hàng khác và đơn tạo tay không bị đụng.

const db = testPool();
let companyId: string;
let variantId: string;

beforeAll(async () => {
  ({ companyId } = await createCompany());
  ({ variantId } = await createVariant(companyId));
});

async function shopOrder(shopId: string | null, lines: number): Promise<string> {
  const { orderId } = await createOrder(companyId, {
    source: shopId ? 'marketplace' : 'manual',
    lines: Array.from({ length: lines }, (_, i) => ({ variantId, quantity: i + 1, unitPrice: 100000 })),
  });
  await db.query('update "order".orders set shop_id = $2 where id = $1', [orderId, shopId]);
  return orderId;
}

/** Yêu cầu trả một dòng của đơn; `shopId` null là yêu cầu tạo tay. */
async function returnRequest(orderId: string, shopId: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into "order".return_requests (company_id, code, order_id, source, shop_id, external_return_id, reason)
     values ($1, $2, $3, $4, $5, $6, 'Khách đổi ý') returning id`,
    [companyId, `TR-${randomUUID().slice(0, 8)}`, orderId, shopId ? 'marketplace' : 'manual', shopId, shopId ? randomUUID() : null],
  );
  const line = await db.query<{ id: string }>('select id from "order".order_lines where order_id = $1 limit 1', [orderId]);
  await db.query(
    `insert into "order".return_request_lines (company_id, request_id, order_line_id, variant_id, quantity, unit_price)
     values ($1, $2, $3, $4, 1, 100000)`,
    [companyId, rows[0]!.id, line.rows[0]!.id, variantId],
  );
  return rows[0]!.id;
}

const count = async (sql: string, ids: string[]) => Number((await db.query<{ n: string }>(sql, [ids])).rows[0]!.n);

/** Hai gian hàng, một đơn tạo tay; gian hàng S1 có hai đơn, một yêu cầu trả theo gian hàng, một yêu cầu tạo tay trên đơn của nó. */
async function seed() {
  const s1 = randomUUID();
  const s2 = randomUUID();
  const o1 = await shopOrder(s1, 2);
  const o2 = await shopOrder(s1, 1);
  const other = await shopOrder(s2, 1);
  const manual = await shopOrder(null, 1);
  const r1 = await returnRequest(o1, s1);
  const r2 = await returnRequest(o2, null);
  const rOther = await returnRequest(other, s2);
  const rManual = await returnRequest(manual, null);
  return { s1, o1, o2, other, manual, r1, r2, rOther, rManual };
}

describe('đơn, yêu cầu trả của gian hàng (#398)', () => {
  it('tra đơn và yêu cầu trả của gian hàng', async () => {
    const s = await seed();

    const refs = await withCompany(companyId, () => shopOrderRefs(s.s1));

    expect([...refs.orderIds].sort()).toEqual([s.o1, s.o2].sort());
    expect([...refs.returnRequestIds].sort()).toEqual([s.r1, s.r2].sort());
  });

  it('xoá đơn, dòng đơn, yêu cầu trả, dòng yêu cầu trả', async () => {
    const s = await seed();

    const result = await withCompany(companyId, async () => purgeShopOrders(await shopOrderRefs(s.s1)));

    expect(result).toEqual({ orders: 2, orderLines: 3, returnRequests: 2, returnRequestLines: 2 });
    expect(await count('select count(*) as n from "order".orders where id = any($1)', [s.o1, s.o2])).toBe(0);
    expect(await count('select count(*) as n from "order".order_lines where order_id = any($1)', [s.o1, s.o2])).toBe(0);
    expect(await count('select count(*) as n from "order".return_requests where id = any($1)', [s.r1, s.r2])).toBe(0);
    expect(await count('select count(*) as n from "order".return_request_lines where request_id = any($1)', [s.r1, s.r2])).toBe(0);
    // Gian hàng khác và đơn tạo tay còn nguyên.
    expect(await count('select count(*) as n from "order".orders where id = any($1)', [s.other, s.manual])).toBe(2);
    expect(await count('select count(*) as n from "order".order_lines where order_id = any($1)', [s.other, s.manual])).toBe(2);
    expect(await count('select count(*) as n from "order".return_requests where id = any($1)', [s.rOther, s.rManual])).toBe(2);
    expect(await count('select count(*) as n from "order".return_request_lines where request_id = any($1)', [s.rOther, s.rManual])).toBe(2);
  });

  it('gỡ ảnh minh chứng gắn vào yêu cầu trả bị xoá (#437), giữ tệp và ảnh của yêu cầu khác', async () => {
    const s = await seed();
    const file = randomUUID();
    await db.query(
      `insert into core.files (id, company_id, storage_key, file_name, content_type, size_bytes, purpose, uploaded_at)
       values ($1, $2, $3, 'anh.jpg', 'image/jpeg', 2048, 'attachment', now())`,
      [file, companyId, `test/${file}.jpg`],
    );
    for (const id of [s.r1, s.rOther]) {
      await db.query(`insert into core.attachments (company_id, file_id, entity_type, entity_id) values ($1, $2, 'return_requests', $3)`, [companyId, file, id]);
    }

    await withCompany(companyId, async () => purgeShopOrders(await shopOrderRefs(s.s1)));

    expect(await count(`select count(*) as n from core.attachments where entity_type = 'return_requests' and entity_id = any($1)`, [s.r1])).toBe(0);
    expect(await count(`select count(*) as n from core.attachments where entity_type = 'return_requests' and entity_id = any($1)`, [s.rOther])).toBe(1);
    expect(await count('select count(*) as n from core.files where id = any($1)', [file])).toBe(1);
  });

  it('gian hàng không có đơn: không xoá gì', async () => {
    const refs = await withCompany(companyId, () => shopOrderRefs(randomUUID()));

    expect(refs).toEqual({ orderIds: [], returnRequestIds: [] });
    expect(await withCompany(companyId, () => purgeShopOrders(refs))).toEqual({ orders: 0, orderLines: 0, returnRequests: 0, returnRequestLines: 0 });
  });
});
