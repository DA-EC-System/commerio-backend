import { describe, expect, it } from 'vitest';
import { type SetupInput, setupOf } from '#src/modules/channel/channel/domain/shop-setup.ts';

const now = new Date('2026-11-06T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const HOUR = 3600_000;
const base: SetupInput = {
  status: 'active',
  openingStockMode: 'push',
  openingStocktakeId: null,
  unmatchedSkuCount: 3,
  openOrdersPulledAt: null,
  stockPushedAt: null,
  openOrderPullFailedAt: null,
  listingSyncFailedAt: null,
};
const step = (key: string, status: string, blockedBy: string | null = null) => ({ key, status, blockedBy });

describe('tiến độ thiết lập gian hàng (#198 AC-24, Documents/21 §18.7.7)', () => {
  it('gian hàng chưa thiết lập: chỉ bước ghép `pending`', () => {
    expect(setupOf({ ...base, status: 'connecting', openingStockMode: null, unmatchedSkuCount: null }, now)).toEqual({
      steps: [step('match', 'pending')],
      unmatchedCount: 0,
    });
  });

  it('`push` vừa thiết lập: đơn mở đang chạy, đẩy tồn chờ đơn mở, không có bước kiểm kê', () => {
    expect(setupOf(base, now)).toEqual({
      steps: [step('match', 'done'), step('open_orders', 'running'), step('push_stock', 'blocked', 'open_orders')],
      unmatchedCount: 3,
    });
  });

  it('`stocktake` chờ phiếu: bước kiểm kê `pending`, đẩy tồn chờ kiểm kê kể cả khi đơn mở xong', () => {
    const s = setupOf({ ...base, openingStockMode: 'stocktake', openingStocktakeId: 'doc', openOrdersPulledAt: ago(HOUR) }, now);
    expect(s?.steps).toEqual([
      step('match', 'done'),
      step('opening_stock', 'pending'),
      step('open_orders', 'done'),
      step('push_stock', 'blocked', 'opening_stock'),
    ]);
  });

  it('đơn mở xong thì đẩy tồn `running`, đẩy xong thì `done`', () => {
    expect(setupOf({ ...base, openOrdersPulledAt: ago(HOUR) }, now)?.steps.at(-1)).toEqual(step('push_stock', 'running'));
    expect(setupOf({ ...base, openOrdersPulledAt: ago(HOUR), stockPushedAt: ago(HOUR) }, now)?.steps.map((s) => s.status)).toEqual([
      'done',
      'done',
      'done',
    ]);
  });

  it('việc hết lượt thử thì `failed`: lượt đơn mở; đồng bộ listing lỗi sau khi đơn mở xong (lỗi cũ hơn không tính)', () => {
    expect(setupOf({ ...base, openOrderPullFailedAt: ago(HOUR) }, now)?.steps[1]).toEqual(step('open_orders', 'failed'));
    const pulled = { ...base, openOrdersPulledAt: ago(2 * HOUR) };
    expect(setupOf({ ...pulled, listingSyncFailedAt: ago(HOUR) }, now)?.steps.at(-1)).toEqual(step('push_stock', 'failed'));
    expect(setupOf({ ...pulled, listingSyncFailedAt: ago(3 * HOUR) }, now)?.steps.at(-1)).toEqual(step('push_stock', 'running'));
  });

  it('null khi thiết lập trước #198, khi đã ngắt, khi mọi bước xong quá 24 giờ', () => {
    expect(setupOf({ ...base, openingStockMode: null, unmatchedSkuCount: null }, now)).toBeNull();
    expect(setupOf({ ...base, status: 'disconnected' }, now)).toBeNull();
    const done = { ...base, openOrdersPulledAt: ago(30 * HOUR), stockPushedAt: ago(25 * HOUR) };
    expect(setupOf(done, now)).toBeNull();
    expect(setupOf({ ...done, stockPushedAt: ago(23 * HOUR) }, now)).not.toBeNull();
  });
});
