// Trạng thái lượt Tải lại SKU sàn chạy nền (#361; Documents/21 §18.3 `remote-skus` trường `refresh`).
import { describe, expect, it } from 'vitest';
import {
  REFRESH_STALE_MS,
  RETRY_AFTER_FAILURE_MS,
  refreshState,
} from '#src/modules/channel/channel/domain/remote-skus-refresh.ts';

const now = new Date('2026-11-17T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const idleShop = { remoteSkusRefreshRequestedAt: null, remoteSkusFullFailedAt: null, remoteSkusFullError: null };
const error = { code: 'marketplace_rejected', platformCode: 'incomplete_list', message: 'Sàn từ chối yêu cầu' };

describe('refreshState', () => {
  it('không có lượt chờ, không có lỗi gần đây → idle', () => {
    expect(refreshState(idleShop, now)).toEqual({ status: 'idle', requestedAt: null, error: null, retryAfterSeconds: null });
  });

  it('có lượt chờ chưa quá 15 phút → running kèm `requestedAt`', () => {
    const requestedAt = ago(REFRESH_STALE_MS - 1000);
    expect(refreshState({ ...idleShop, remoteSkusRefreshRequestedAt: requestedAt }, now)).toEqual({
      status: 'running',
      requestedAt,
      error: null,
      retryAfterSeconds: null,
    });
  });

  it('lượt chờ quá 15 phút chưa xong → failed mã `refresh_stale`, không bắt chờ', () => {
    const requestedAt = ago(REFRESH_STALE_MS);
    const s = refreshState({ ...idleShop, remoteSkusRefreshRequestedAt: requestedAt }, now);
    expect(s.status).toBe('failed');
    expect(s.requestedAt).toEqual(requestedAt);
    expect(s.error).toMatchObject({ code: 'refresh_stale', platformCode: null });
    expect(s.retryAfterSeconds).toBeNull();
  });

  it('đọc trọn lỗi chưa quá 10 phút → failed kèm lỗi đã lưu và số giây chờ (làm tròn lên)', () => {
    const s = refreshState({ ...idleShop, remoteSkusFullFailedAt: ago(60_500), remoteSkusFullError: error }, now);
    expect(s).toEqual({ status: 'failed', requestedAt: null, error, retryAfterSeconds: 540 });
  });

  it('lỗi cũ chưa có mã (trước #361) → failed với mã chung', () => {
    const s = refreshState({ ...idleShop, remoteSkusFullFailedAt: ago(1000) }, now);
    expect(s.status).toBe('failed');
    expect(s.error).toMatchObject({ code: 'marketplace_unavailable', platformCode: null });
  });

  it('đọc trọn lỗi đã quá 10 phút → idle', () => {
    expect(refreshState({ ...idleShop, remoteSkusFullFailedAt: ago(RETRY_AFTER_FAILURE_MS), remoteSkusFullError: error }, now).status).toBe('idle');
  });

  it('`platformCode` vắng trong lỗi đã lưu → null', () => {
    const s = refreshState(
      { ...idleShop, remoteSkusFullFailedAt: ago(1000), remoteSkusFullError: { code: 'shop_not_connected', message: 'Gian hàng chưa kết nối' } },
      now,
    );
    expect(s.error).toEqual({ code: 'shop_not_connected', platformCode: null, message: 'Gian hàng chưa kết nối' });
  });
});
