import { describe, expect, it } from 'vitest';
import { renderReauthMail, vnTime } from '#src/modules/channel/channel/service/reauth-mail-text.ts';

const shopId = '11111111-2222-4333-8444-555555555555';
const base = {
  shopId,
  shopName: 'Shop Áo\nThun',
  platform: 'lazada',
  authDeadline: new Date('2026-11-14T17:30:00.000Z'),
  lostAt: null,
  webUrl: 'https://app.example.test/',
};

// Nội dung thư báo mất uỷ quyền (#312 "Nội dung thư").
describe('renderReauthMail', () => {
  it('giờ Việt Nam là UTC+7, sang ngày khi qua 17:00 UTC', () => {
    expect(vnTime(new Date('2026-11-14T17:30:00.000Z'))).toBe('00:30 15/11/2026');
  });

  it('thư sắp hết: tên gian hàng một dòng, sàn, hạn giờ Việt Nam, hai hậu quả, link trang gian hàng', () => {
    const { subject, text } = renderReauthMail({ ...base, stage: 'expiring_3d' });
    expect(subject).toContain('Shop Áo Thun');
    expect(subject).toContain('sắp hết uỷ quyền');
    expect(text).toContain('Sàn: Lazada');
    expect(text).toContain('Hạn uỷ quyền: 00:30 15/11/2026 (giờ Việt Nam)');
    expect(text).toContain('Đơn mới của gian hàng này không về Commerio');
    expect(text).toContain('tạm ngừng cập nhật lên các gian hàng khác');
    expect(text).toContain(`https://app.example.test/channel/shops/${shopId}`);
  });

  it('thư đã mất quyền: ghi lúc mất quyền, nhắc mỗi 6 giờ; token dán tay không có hạn thì không có dòng hạn', () => {
    const { subject, text } = renderReauthMail({
      ...base,
      stage: 'lost',
      authDeadline: null,
      lostAt: new Date('2026-11-12T01:00:00.000Z'),
    });
    expect(subject).toContain('đã mất uỷ quyền');
    expect(text).toContain('Mất uỷ quyền lúc: 08:00 12/11/2026');
    expect(text).not.toContain('Hạn uỷ quyền');
    expect(text).toContain('mỗi 6 giờ');
  });

  it('chưa đặt PUBLIC_WEB_URL: vẫn chỉ đường tới trang gian hàng trong app', () => {
    const { text } = renderReauthMail({ ...base, stage: 'expiring_1d', webUrl: undefined });
    expect(text).toContain(`/channel/shops/${shopId}`);
  });
});
