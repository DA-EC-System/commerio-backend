import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

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
  it('kiện đã rời kho phải có thời điểm bàn giao', async () => {
    const c = randomUUID();
    await expect(insertPackage(c, { status: 'in_transit' })).rejects.toThrow(/"packages_handed_over"/);
    await expect(insertPackage(c, { status: 'in_transit', handed_over_at: new Date() })).resolves.toBeDefined();
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
});
