import { describe, expect, it } from 'vitest';
import { vnDayParam } from '#src/shared/http/vn-day.ts';

// Tham số ngày `yyyy-mm-dd` của API lọc theo trọn ngày giờ Việt Nam (Documents/21 C6).
describe('vnDayParam', () => {
  it('from: đầu ngày VN; to: đầu ngày hôm sau VN', () => {
    expect(vnDayParam('Từ ngày').parse('2026-10-19')).toEqual(new Date('2026-10-18T17:00:00Z'));
    expect(vnDayParam('Đến ngày', true).parse('2026-10-19')).toEqual(new Date('2026-10-19T17:00:00Z'));
  });

  it('bỏ trống được; sai dạng thì báo lỗi kèm nhãn', () => {
    expect(vnDayParam('Từ ngày').parse(undefined)).toBeUndefined();
    const res = vnDayParam('Từ ngày').safeParse('19/10/2026');
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.message).toBe('Từ ngày dạng yyyy-mm-dd');
  });
});
