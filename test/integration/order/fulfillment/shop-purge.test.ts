import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { purgeOrderPackages, purgeShopOrders } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, seedPackage, stockOfVariant } from './helpers.ts';

// #398: xoá gian hàng đã ngắt. Kiện của đơn gian hàng: nhả giữ hàng (không ghi thẻ kho) rồi xoá kiện, dòng kiện; kiện trả
// lạc gắn yêu cầu trả của gian hàng cũng xoá. Xoá dòng kiện phải đi cùng giao dịch với xoá dòng đơn (trigger kiểm bằng
// `package_lines_line_total` hoãn tới commit).

const db = testPool();
let companyId: string;
let variantId: string;

beforeAll(async () => {
  ({ companyId } = await createCompany());
  ({ variantId } = await createVariant(companyId));
  await receive(companyId, variantId, 10, 100000);
});

const count = async (sql: string, params: unknown[]) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
const movesOf = (id: string) => count('select count(*) as n from product.stock_moves where company_id = $1 and variant_id = $2', [companyId, id]);
const packagesOf = (orderIds: string[]) => count('select count(*) as n from "order".packages where order_id = any($1)', [orderIds]);

describe('xoá kiện của đơn gian hàng (#398)', () => {
  it('nhả giữ hàng rồi xoá kiện của đơn', async () => {
    const shopId = await channelShop(companyId, false);
    const held = await seedPackage(companyId, { status: 'reserved', shopId, lines: [{ variantId, quantity: 2, reserved: true }] });
    const done = await seedPackage(companyId, { status: 'delivered', shopId, lines: [{ variantId, quantity: 1 }] });
    const before = await stockOfVariant(companyId, variantId);
    const moves = await movesOf(variantId);
    const refs = { orderIds: [held.orderId, done.orderId], returnRequestIds: [] };

    const result = await withCompany(companyId, async () => {
      const out = await purgeOrderPackages(refs);
      await purgeShopOrders(refs);
      return out;
    });

    expect(result).toMatchObject({ packages: 2, packageLines: 2, returnParcels: 0, parcelIds: [] });
    expect([...result.packageIds].sort()).toEqual([held.packageId, done.packageId].sort());
    const after = await stockOfVariant(companyId, variantId);
    expect(after.reserved).toBe(before.reserved - 2);
    expect(after.onHand).toBe(before.onHand);
    expect(await movesOf(variantId)).toBe(moves);
    expect(await packagesOf(refs.orderIds)).toBe(0);
    expect(await count('select count(*) as n from "order".package_lines where package_id = any($1)', [result.packageIds])).toBe(0);
    // Xếp một lượt phân hàng cho SKU vừa nhả, cùng giao dịch.
    expect(
      await count(
        `select count(*) as n from pgboss.job where name = 'fulfillment.allocation' and data->>'companyId' = $1 and data->'variantIds' ? $2`,
        [companyId, variantId],
      ),
    ).toBeGreaterThan(0);
  });

  it('không đụng kiện của đơn khác', async () => {
    const shopId = await channelShop(companyId, false);
    const mine = await seedPackage(companyId, { status: 'delivered', shopId, lines: [{ variantId, quantity: 1 }] });
    const other = await seedPackage(companyId, { status: 'reserved', shopId, lines: [{ variantId, quantity: 1, reserved: true }] });
    const before = await stockOfVariant(companyId, variantId);
    const refs = { orderIds: [mine.orderId], returnRequestIds: [] };

    await withCompany(companyId, async () => {
      await purgeOrderPackages(refs);
      await purgeShopOrders(refs);
    });

    expect(await packagesOf([other.orderId])).toBe(1);
    expect(await count('select count(*) as n from "order".package_lines where package_id = $1', [other.packageId])).toBe(1);
    expect((await stockOfVariant(companyId, variantId)).reserved).toBe(before.reserved);
  });

  it('xoá kiện trả lạc gắn yêu cầu trả của gian hàng, giữ kiện trả lạc khác', async () => {
    const shopId = await channelShop(companyId, false);
    const pkg = await seedPackage(companyId, { status: 'delivered', shopId, lines: [{ variantId, quantity: 1 }] });
    const request = await db.query<{ id: string }>(
      `insert into "order".return_requests (company_id, code, order_id, source, shop_id, external_return_id, reason)
       values ($1, $2, $3, 'marketplace', $4, $5, 'Khách đổi ý') returning id`,
      [companyId, `TR-${randomUUID().slice(0, 8)}`, pkg.orderId, shopId, randomUUID()],
    );
    const requestId = request.rows[0]!.id;
    const parcel = async (returnRequestId: string | null) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into "order".unmatched_return_parcels (company_id, code, scanned_code, status, return_request_id, resolved_at)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [companyId, `KL-${randomUUID().slice(0, 8)}`, randomUUID(), returnRequestId ? 'attached' : 'open', returnRequestId, returnRequestId ? new Date() : null],
      );
      await db.query(
        'insert into "order".unmatched_return_parcel_lines (company_id, parcel_id, variant_id, quantity) values ($1, $2, $3, 1)',
        [companyId, rows[0]!.id, variantId],
      );
      return rows[0]!.id;
    };
    const attached = await parcel(requestId);
    const open = await parcel(null);
    const refs = { orderIds: [pkg.orderId], returnRequestIds: [requestId] };

    const result = await withCompany(companyId, async () => {
      const out = await purgeOrderPackages(refs);
      await purgeShopOrders(refs);
      return out;
    });

    expect(result).toMatchObject({ returnParcels: 1, parcelIds: [attached] });
    expect(await count('select count(*) as n from "order".unmatched_return_parcels where id = any($1)', [[attached, open]])).toBe(1);
    expect(await count('select count(*) as n from "order".unmatched_return_parcel_lines where parcel_id = $1', [attached])).toBe(0);
    expect(await count('select count(*) as n from "order".unmatched_return_parcel_lines where parcel_id = $1', [open])).toBe(1);
  });
});
