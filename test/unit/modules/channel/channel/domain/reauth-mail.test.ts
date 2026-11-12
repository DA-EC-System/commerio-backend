import { describe, expect, it } from 'vitest';
import { dueReauthMail, isCurrentMail, type ReauthMailShop } from '#src/modules/channel/channel/domain/reauth-mail.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = new Date('2026-11-12T03:00:00.000Z');
const inMs = (ms: number) => new Date(now.getTime() + ms);

const active = (left: number | null): ReauthMailShop => ({ status: 'active', deadline: left === null ? null : inMs(left), lostAt: null });
const lost = (ago: number, deadline: Date | null = null): ReauthMailShop => ({ status: 'needs_reauth', deadline, lostAt: inMs(-ago) });

// Luật mốc thư báo mất uỷ quyền (#312, DoD "Unit test luật mốc với `now` truyền vào").
describe('dueReauthMail', () => {
  it('còn 4 ngày tới hạn: không gửi', () => {
    expect(dueReauthMail(active(4 * DAY), now)).toBeNull();
  });

  it('còn đúng 3 ngày: chưa gửi, cùng ngưỡng nhãn "Sắp hết hạn" (`tokenExpiringSoon` dùng < 3 ngày)', () => {
    expect(dueReauthMail(active(3 * DAY), now)).toBeNull();
  });

  it('còn 3 ngày (dưới ngưỡng một phút): thư 1, hạn đang tính là hạn uỷ quyền', () => {
    expect(dueReauthMail(active(3 * DAY - MIN), now)).toEqual({ stage: 'expiring_3d', deadline: inMs(3 * DAY - MIN), seq: 0 });
  });

  it('còn hơn 1 ngày: vẫn là thư 1 (cùng khoá, unique của CSDL bỏ qua)', () => {
    expect(dueReauthMail(active(DAY + MIN), now)?.stage).toBe('expiring_3d');
  });

  it('còn 1 ngày: thư 2', () => {
    expect(dueReauthMail(active(DAY - MIN), now)).toEqual({ stage: 'expiring_1d', deadline: inMs(DAY - MIN), seq: 0 });
  });

  it('đã qua hạn mà còn active: không gửi thư trước hạn, chờ việc nền làm mới token chuyển needs_reauth', () => {
    expect(dueReauthMail(active(0), now)).toBeNull();
    expect(dueReauthMail(active(-HOUR), now)).toBeNull();
  });

  it('đã mất quyền: thư ngay lúc chuyển (nhịp 0, hạn đang tính là lúc mất quyền)', () => {
    expect(dueReauthMail(lost(0), now)).toEqual({ stage: 'lost', deadline: now, seq: 0 });
  });

  it('sau 5 giờ 59 phút chưa có thư mới: vẫn nhịp 0', () => {
    // Cùng (hạn đang tính, mốc, nhịp) với thư lúc chuyển: unique của CSDL bỏ qua, không có thư thứ hai.
    expect(dueReauthMail(lost(6 * HOUR - MIN), now)).toEqual({ stage: 'lost', deadline: inMs(-(6 * HOUR - MIN)), seq: 0 });
  });

  it('sau 6 giờ: thư tiếp (nhịp 1), sau 12 giờ nhịp 2', () => {
    expect(dueReauthMail(lost(6 * HOUR), now)?.seq).toBe(1);
    expect(dueReauthMail(lost(12 * HOUR), now)?.seq).toBe(2);
  });

  it('đồng hồ máy app chậm hơn lúc ghi chuyển trạng thái: vẫn nhịp 0, không âm', () => {
    expect(dueReauthMail(lost(-50), now)?.seq).toBe(0);
  });

  it('sàn thu hồi quyền trước hạn: vào thẳng nhịp 6 giờ, không có thư trước hạn', () => {
    expect(dueReauthMail(lost(0, inMs(10 * DAY)), now)).toEqual({ stage: 'lost', deadline: now, seq: 0 });
  });

  it('nối lại (connecting khi chạy lại thiết lập): dừng', () => {
    expect(dueReauthMail({ status: 'connecting', deadline: inMs(HOUR), lostAt: inMs(-HOUR) }, now)).toBeNull();
  });

  it('nối lại về active với hạn mới xa: dừng; sắp hết lần nữa thì tính lại theo hạn mới', () => {
    expect(dueReauthMail(active(30 * DAY), now)).toBeNull();
    const again = dueReauthMail(active(2 * DAY), now);
    expect(again).toEqual({ stage: 'expiring_3d', deadline: inMs(2 * DAY), seq: 0 });
  });

  it('ngắt: dừng', () => {
    expect(dueReauthMail({ status: 'disconnected', deadline: null, lostAt: inMs(-7 * HOUR) }, now)).toBeNull();
  });

  it('token dán tay không có hạn: không có thư trước hạn, chỉ có thư sau khi mất quyền', () => {
    expect(dueReauthMail(active(null), now)).toBeNull();
    expect(dueReauthMail(lost(0, null), now)).toEqual({ stage: 'lost', deadline: now, seq: 0 });
  });
});

// Thư đã xếp còn đúng mốc lúc gửi, lúc xếp lại (#312, review lỗi 1 và 2).
describe('isCurrentMail', () => {
  const mail = { stage: 'expiring_3d' as const, deadline: inMs(2 * DAY), seq: 0 };

  it('hạn lệch vài giây sau khi làm mới token: vẫn là thư đó', () => {
    expect(isCurrentMail(mail, { ...mail, deadline: inMs(2 * DAY + 1_500) })).toBe(true);
    expect(isCurrentMail(mail, { ...mail, deadline: inMs(2 * DAY - 59 * MIN) })).toBe(true);
  });

  it('hạn gia hạn thật (cách từ 1 giờ): thư cũ', () => {
    expect(isCurrentMail(mail, { ...mail, deadline: inMs(2 * DAY + HOUR) })).toBe(false);
  });

  it('mốc sau đã thay, hoặc không còn mốc nào: thư cũ', () => {
    expect(isCurrentMail(mail, { ...mail, stage: 'expiring_1d' })).toBe(false);
    expect(isCurrentMail(mail, null)).toBe(false);
  });

  it('thư lost: phải đúng lúc chuyển trạng thái và đúng nhịp', () => {
    const lostMail = { stage: 'lost' as const, deadline: now, seq: 0 };
    expect(isCurrentMail(lostMail, { ...lostMail })).toBe(true);
    expect(isCurrentMail(lostMail, { ...lostMail, seq: 1 })).toBe(false);
    expect(isCurrentMail(lostMail, { ...lostMail, deadline: inMs(1) })).toBe(false);
  });
});
