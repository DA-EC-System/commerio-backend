import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { packageStatusOf } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { seedPackage } from './helpers.ts';

let companyId: string;
let variantId: string;

beforeAll(async () => {
  ({ companyId } = await createCompany());
  ({ variantId } = await createVariant(companyId));
});

describe('packageStatusOf cho finance (spec 199c §5.6, E139)', () => {
  it('AC15: trả orderId, status, deliveredAt ISO; kiện chưa giao deliveredAt null', async () => {
    const deliveredAt = new Date('2026-11-08T03:00:00Z');
    const done = await seedPackage(companyId, { status: 'delivered', deliveredAt, lines: [{ variantId, quantity: 1 }] });
    const moving = await seedPackage(companyId, { status: 'in_transit', lines: [{ variantId, quantity: 1 }] });

    const map = await withCompany(companyId, () => packageStatusOf([done.packageId, moving.packageId]));

    expect(map.size).toBe(2);
    expect(map.get(done.packageId)).toEqual({ orderId: done.orderId, status: 'delivered', deliveredAt: deliveredAt.toISOString() });
    expect(map.get(moving.packageId)).toEqual({ orderId: moving.orderId, status: 'in_transit', deliveredAt: null });
  });

  it('AC15: id công ty khác, id không phải uuid không có trong Map', async () => {
    const own = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId, quantity: 1 }] });
    const other = await createCompany();
    const foreign = await seedPackage(other.companyId, {
      status: 'reserved',
      lines: [{ variantId: (await createVariant(other.companyId)).variantId, quantity: 1 }],
    });

    const map = await withCompany(companyId, () => packageStatusOf([own.packageId, foreign.packageId, 'khong-phai-uuid', randomUUID()]));

    expect([...map.keys()]).toEqual([own.packageId]);
  });

  it('AC15: danh sách rỗng trả Map rỗng, không truy vấn', async () => {
    const queries = vi.spyOn(pg.Client.prototype, 'query');
    try {
      // Đếm trong fn: bỏ các câu mở, đóng giao dịch của `withCompany`.
      const map = await withCompany(companyId, async () => {
        queries.mockClear();
        const m = await packageStatusOf([]);
        expect(queries).not.toHaveBeenCalled();
        return m;
      });
      expect(map.size).toBe(0);
    } finally {
      queries.mockRestore();
    }
  });

  it('AC15: chỉ id sai dạng cũng không truy vấn', async () => {
    const queries = vi.spyOn(pg.Client.prototype, 'query');
    try {
      const map = await withCompany(companyId, async () => {
        queries.mockClear();
        const m = await packageStatusOf(['abc']);
        expect(queries).not.toHaveBeenCalled();
        return m;
      });
      expect(map.size).toBe(0);
    } finally {
      queries.mockRestore();
    }
  });
});
