import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PickList } from '#src/modules/order/fulfillment/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { channelShop, packingApp, seedPackage } from './helpers.ts';

let company: Awaited<ReturnType<typeof createCompany>>;
let warehouse: string;
let sale: string;
let a: string;
let b: string;
let first: string;

beforeAll(async () => {
  company = await createCompany();
  const { companyId } = company;
  warehouse = (await addMember(companyId, 'warehouse')).token;
  sale = (await addMember(companyId, 'sale')).token;
  a = (await createVariant(companyId, { sku: 'NHAT-A' })).variantId;
  b = (await createVariant(companyId, { sku: 'NHAT-B' })).variantId;
  first = (await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: a, quantity: 2 }] })).packageId;
  await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: a, quantity: 1 }, { variantId: b, quantity: 1 }] });
  await seedPackage(companyId, { status: 'reserved', orderStatus: 'unpaid', lines: [{ variantId: a, quantity: 3 }] });
  await seedPackage(companyId, { status: 'packed', lines: [{ variantId: b, quantity: 5 }] });
});

const get = (path: string, token = warehouse) => packingApp().get(`/api/v1/fulfillment${path}`).set('Authorization', `Bearer ${token}`);

describe('danh sách nhặt và nhà vận chuyển', () => {
  it('US-DH-06 AC1: mặc định gộp kiện tab reserved theo biến thể, kèm số kiện', async () => {
    const res = await get('/pick-list');
    expect(res.status).toBe(200);
    expect(PickList.parse(res.body)).toMatchObject({
      items: [{ variantId: a, quantity: 3, packageCount: 2 }, { variantId: b, quantity: 1, packageCount: 1 }],
      packageCount: 2, truncated: false,
    });
  });

  it('ids chỉ lấy các kiện đã chọn của công ty', async () => {
    const { companyId } = await createCompany();
    const variant = await createVariant(companyId);
    const { packageId } = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: variant.variantId, quantity: 1 }] });
    const res = await get(`/pick-list?ids=${first},${packageId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [{ variantId: a, quantity: 2, packageCount: 1 }], packageCount: 1, truncated: false });
    expect(res.body.items).toHaveLength(1);
  });

  it.each([() => Array.from({ length: 201 }, () => randomUUID()).join(','), () => `${first},${first}`])('ids quá giới hạn hoặc trùng trả 422', async (ids) => {
    const res = await get(`/pick-list?ids=${ids()}`);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ type: '/problems/validation_failed', errors: { ids: expect.any(String) } });
  });

  it('kiện đơn tay trả danh sách rỗng mà không gọi cổng', async () => {
    const { packageId } = await seedPackage(company.companyId, { status: 'packed', manual: true, lines: [{ variantId: a, quantity: 1 }] });
    const res = await get(`/packages/${packageId}/carriers`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('kiện sàn gọi cổng với mã đơn và mã món sàn của kiện', async () => {
    const { companyId } = company;
    const shopId = await channelShop(companyId, false);
    const { packageId, orderId } = await seedPackage(companyId, { status: 'packed', shopId, lines: [{ variantId: a, quantity: 1 }] });
    const { rows: [row] } = await testPool().query(`select o.external_order_id, l.external_line_id from "order".orders o join "order".order_lines l on l.order_id = o.id where o.id = $1`, [orderId]);
    const items = [{ code: 'LEX', name: 'LEX VN', isDefault: true }];
    const carriers = vi.fn(async () => items);
    const res = await packingApp({ carriers }).get(`/api/v1/fulfillment/packages/${packageId}/carriers`).set('Authorization', `Bearer ${warehouse}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items });
    expect(carriers).toHaveBeenCalledWith(companyId, shopId, { externalOrderId: row.external_order_id, externalLineIds: [row.external_line_id] });
  });

  it('D2-03q: Sale không được xem danh sách nhặt và nhà vận chuyển', async () => {
    for (const path of ['/pick-list', `/packages/${first}/carriers`]) {
      const res = await get(path, sale);
      expect(res.status).toBe(403);
      expect(res.body.type).toBe('/problems/forbidden');
    }
  });
});
