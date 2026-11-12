// Index cho "gian hàng đã nhận đơn có món mang SellerSku này" (`hasOrdersWithSellerSku`, #220 đợt 2): truy vấn chạy mỗi
// lần đổi ghép, `raw_orders` lớn dần theo số đơn nên không được quét cả bảng.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hasOrdersWithSellerSku } from '#src/modules/channel/channel/repository/raw-orders.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';

describe('raw_orders: tra đơn theo SellerSku', () => {
  it('dùng index GIN `raw_orders_lines_gin`, không quét cả bảng; kết quả đúng', async () => {
    const companyId = randomUUID();
    const shop = await testPool().query<{ id: string }>(
      "insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop') returning id",
      [companyId, randomUUID()],
    );
    const shopId = shop.rows[0]!.id;
    await testPool().query(
      `insert into channel.raw_orders (company_id, shop_id, external_order_id, payload)
       select $1, $2, 'o-' || g, jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('externalLineId', '1', 'sellerSku', 'SKU-' || g)))
         from generate_series(1, 5000) g`,
      [companyId, shopId],
    );
    await testPool().query('analyze channel.raw_orders');
    const plan = await testPool().query<{ 'QUERY PLAN': string }>(
      `explain select id from channel.raw_orders where shop_id = $1 and payload -> 'lines' @> $2::jsonb limit 1`,
      [shopId, JSON.stringify([{ sellerSku: 'SKU-7' }])],
    );
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toContain('raw_orders_lines_gin');
    expect(text).not.toMatch(/Seq Scan on raw_orders/);
    expect(await withCompany(companyId, () => hasOrdersWithSellerSku(shopId, 'SKU-7'))).toBe(true);
    expect(await withCompany(companyId, () => hasOrdersWithSellerSku(shopId, 'SKU-khong-co'))).toBe(false);
  });
});
