import { describe, expect, it } from 'vitest';
import { addDays, eachDay, vnDay } from '#src/modules/insight/report/domain/days.ts';

describe('ngày giờ VN (C6)', () => {
  it('vnDay lấy ngày theo UTC+7, không theo giờ máy', () => {
    expect(vnDay('2026-10-18T16:59:59Z')).toBe('2026-10-18');
    expect(vnDay('2026-10-18T17:00:00Z')).toBe('2026-10-19');
    expect(vnDay(new Date('2026-12-31T20:00:00+07:00'))).toBe('2026-12-31');
  });

  it('addDays qua tháng, năm, năm nhuận', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });
});

describe('eachDay', () => {
  it('mọi ngày từ from tới to, cả hai đầu', () => {
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(eachDay('2026-10-18', '2026-10-18')).toEqual(['2026-10-18']);
  });
});
