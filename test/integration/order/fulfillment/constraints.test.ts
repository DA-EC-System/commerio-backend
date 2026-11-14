import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';
import { seedPackage } from './helpers.ts';

const db = () => testPool();

const insertPackage = (c: string, cols: Record<string, unknown>) => {
  const all = { company_id: c, code: `KH-${randomUUID().slice(0, 8)}`, order_id: randomUUID(), status: 'reserved', ...cols };
  const keys = Object.keys(all);
  return db().query<{ id: string }>(
    `insert into "order".packages (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(all),
  );
};

const insertLine = (c: string, packageId: string, cols: Record<string, unknown>) => {
  const all = { company_id: c, package_id: packageId, order_line_id: randomUUID(), variant_id: randomUUID(), quantity: 3, ...cols };
  const keys = Object.keys(all);
  return db().query(
    `insert into "order".package_lines (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(all),
  );
};

// Kiện (Documents/19 mục 3.4; 25 §7.4, §8.3, §11).
describe('ràng buộc kiện', () => {
  it('có mã nhà vận chuyển mà thiếu tên thì bị chặn', async () => {
    await expect(insertPackage(randomUUID(), { carrier_code: 'GHN' })).rejects.toMatchObject({
      code: '23514', constraint: 'packages_carrier',
    });
  });

  it('kiện đã rời kho phải có thời điểm bàn giao', async () => {
    const c = randomUUID();
    await expect(insertPackage(c, { status: 'in_transit' })).rejects.toThrow(/"packages_handed_over"/);
    await expect(insertPackage(c, { status: 'in_transit', handed_over_at: new Date(), handover_source: 'scan' })).resolves.toBeDefined();
  });

  it('người xác nhận COD trùng người giao, người xác nhận thất lạc trùng người báo bị từ chối', async () => {
    const c = randomUUID();
    const u = randomUUID();
    await expect(insertPackage(c, { delivered_by: u, cod_confirmed_by: u })).rejects.toThrow(/"packages_cod_second_person"/);
    await expect(
      insertPackage(c, { lost_reported_by: u, lost_claim_code: 'KN-1', lost_confirmed_by: u }),
    ).rejects.toThrow(/"packages_lost_second_person"/);
  });

  it('báo thất lạc phải kèm mã khiếu nại; cờ chờ mở kiện phải kèm mục đích', async () => {
    const c = randomUUID();
    await expect(insertPackage(c, { lost_reported_by: randomUUID() })).rejects.toThrow(/"packages_lost_report"/);
    await expect(insertPackage(c, { needs_open: true })).rejects.toThrow(/"packages_open"/);
    await expect(insertPackage(c, { needs_open: true, open_purpose: 'cancel' })).resolves.toBeDefined();
  });

  it('một kiện sàn chỉ vào một lần cho mỗi đơn; kiện tạm (chưa có mã sàn) không bị chặn', async () => {
    const c = randomUUID();
    const shop = randomUUID();
    const order = randomUUID();
    await insertPackage(c, { shop_id: shop, order_id: order, platform_package_code: 'PKG1' });
    await expect(insertPackage(c, { shop_id: shop, order_id: order, platform_package_code: 'PKG1' })).rejects.toThrow(
      /packages_platform_code_order_uq/,
    );
    await expect(insertPackage(c, { shop_id: shop, order_id: randomUUID(), platform_package_code: 'PKG1' })).resolves.toBeDefined();
    await insertPackage(c, { shop_id: shop, order_id: order });
    await expect(insertPackage(c, { shop_id: shop, order_id: order })).resolves.toBeDefined();
  });
});

describe('ràng buộc dòng kiện', () => {
  it('giữ nguyên dòng: số giữ là 0 hoặc đủ số lượng', async () => {
    const c = randomUUID();
    const p = (await insertPackage(c, {})).rows[0]!.id;
    await expect(insertLine(c, p, { reserved_qty: 3 })).resolves.toBeDefined();
    await expect(insertLine(c, p, { reserved_qty: 2 })).rejects.toThrow(/"package_lines_reserved_whole"/);
  });

  it('dòng chưa ghép SKU không giữ hàng; đã trừ tồn phải có giá vốn chốt lúc bàn giao', async () => {
    const c = randomUUID();
    const p = (await insertPackage(c, {})).rows[0]!.id;
    await expect(insertLine(c, p, { variant_id: null, reserved_qty: 3 })).rejects.toThrow(/"package_lines_unmapped"/);
    await expect(insertLine(c, p, { stock_deducted: true })).rejects.toThrow(/"package_lines_deducted_cost"/);
    await expect(insertLine(c, p, { stock_deducted: true, unit_cost: '1000' })).resolves.toBeDefined();
  });

  it('số chờ bỏ nằm trong 0..số lượng (spec 205 §5.10)', async () => {
    const c = randomUUID();
    const p = (await insertPackage(c, {})).rows[0]!.id;
    await expect(insertLine(c, p, { pending_drop_qty: 4 })).rejects.toThrow(/"package_lines_pending_drop"/);
    await expect(insertLine(c, p, { pending_drop_qty: -1 })).rejects.toThrow(/"package_lines_pending_drop"/);
    await expect(insertLine(c, p, { pending_drop_qty: 3 })).resolves.toBeDefined();
  });
});

// Bất biến dòng kiện (spec 205 D1, D11, §5.1; Documents/25 §8): tổng một dòng đơn trên các kiện chưa huỷ không vượt số
// lượng dòng đơn. Constraint trigger hoãn tới commit, nên mỗi ca tự mở giao dịch.
describe('bất biến dòng kiện', () => {
  let companyId: string;
  let white: string;
  beforeAll(async () => {
    ({ companyId } = await createCompany());
    white = (await createVariant(companyId)).variantId;
  });

  /** Một đơn một dòng (áo trắng ×1) trong một kiện `backordered`; trả kiện, đơn và dòng đơn. */
  async function seeded() {
    const { packageId, orderId, lineIds } = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: white, quantity: 1 }] });
    const { rows } = await db().query<{ order_line_id: string }>('select order_line_id from "order".package_lines where id = $1', [lineIds[0]]);
    return { packageId, orderId, orderLineId: rows[0]!.order_line_id };
  }

  async function inTransaction(fn: (c: pg.PoolClient) => Promise<unknown>) {
    const c = await db().connect();
    try {
      await c.query('begin');
      await fn(c);
      return await c.query('commit');
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }

  const secondPackage = async (c: pg.PoolClient, orderId: string, status: string) => (await c.query<{ id: string }>(
    `insert into "order".packages (company_id, code, order_id, status) values ($1, $2, $3, $4) returning id`,
    [companyId, `KH-T-${randomUUID().slice(0, 8)}`, orderId, status],
  )).rows[0]!.id;
  const duplicateLine = (c: pg.PoolClient, packageId: string, orderLineId: string) => c.query(
    `insert into "order".package_lines (company_id, package_id, order_line_id, variant_id, quantity) values ($1, $2, $3, $4, 1)`,
    [companyId, packageId, orderLineId, white],
  );

  it('D2-S17 AC13: dòng đơn nằm trong hai kiện chưa huỷ, tổng vượt số lượng, thì commit bị chặn', async () => {
    const { orderId, orderLineId } = await seeded();

    await expect(inTransaction(async (c) => duplicateLine(c, await secondPackage(c, orderId, 'reserved'), orderLineId)))
      .rejects.toMatchObject({ code: '23514', constraint: 'package_lines_line_total' });
  });

  it('kiện đã huỷ không tính vào tổng', async () => {
    const { orderId, orderLineId } = await seeded();

    await expect(inTransaction(async (c) => duplicateLine(c, await secondPackage(c, orderId, 'cancelled'), orderLineId))).resolves.toBeDefined();
  });

  it('trạng thái trung gian trong giao dịch được phép, chỉ kiểm lúc commit', async () => {
    const { packageId, orderId, orderLineId } = await seeded();

    await expect(inTransaction(async (c) => {
      await duplicateLine(c, await secondPackage(c, orderId, 'reserved'), orderLineId);
      await c.query(`update "order".packages set status = 'cancelled' where id = $1`, [packageId]);
    })).resolves.toBeDefined();
  });

  it('dòng kiện không có dòng đơn thì bỏ qua', async () => {
    const p = (await insertPackage(companyId, {})).rows[0]!.id;

    await expect(inTransaction((c) => c.query(
      `insert into "order".package_lines (company_id, package_id, order_line_id, variant_id, quantity) values ($1, $2, $3, $4, 5)`,
      [companyId, p, randomUUID(), white],
    ))).resolves.toBeDefined();
  });

  it('chạy dưới commerio_app vẫn kiểm được', async () => {
    const { packageId, orderLineId } = await seeded();

    await asCompany(companyId, async (c) => {
      await c.query('set constraints "order".package_lines_line_total immediate');
      await expect(duplicateLine(c, packageId, orderLineId)).rejects.toMatchObject({ code: '23514', constraint: 'package_lines_line_total' });
    });
  });
});
