import { describe, expect, it } from 'vitest';
import { countErrors, fromDbMode, shortOf, toDbMode } from '#src/modules/product/purchasing/domain/receipt.ts';

const count = { announced: 10, accepted: 10, defectKept: 0, returnedOnSpot: 0, reason: '' };

// Luật kiểm đếm một dòng phiếu nhận (spec #109 mục 6.7 "Kiểm PUT").
describe('số thiếu', () => {
  it('= báo giao − đạt − lỗi giữ − trả tại chỗ', () => {
    expect(shortOf({ announced: 60, accepted: 55, defectKept: 0, returnedOnSpot: 0 })).toBe(5);
    expect(shortOf({ announced: 10, accepted: 6, defectKept: 2, returnedOnSpot: 1 })).toBe(1);
  });
});

describe('kiểm số một dòng', () => {
  it('đạt + lỗi + trả vượt báo giao → lỗi ở ô accepted', () => {
    expect(countErrors({ announced: 5, accepted: 4, defectKept: 2, returnedOnSpot: 0, reason: 'x' }, 1)).toEqual({
      'lines.1.accepted': 'Nhận đạt, lỗi giữ, trả tại chỗ cộng lại vượt số báo giao',
    });
  });

  it('có thiếu, lỗi hoặc trả tại chỗ mà lý do trống → lỗi ở ô reason', () => {
    const msg = 'Ghi lý do khi có thiếu, lỗi hoặc trả tại chỗ';
    expect(countErrors({ ...count, accepted: 9, reason: ' ' }, 0)).toEqual({ 'lines.0.reason': msg });
    expect(countErrors({ ...count, accepted: 8, defectKept: 2 }, 2)).toEqual({ 'lines.2.reason': msg });
    expect(countErrors({ ...count, accepted: 9, returnedOnSpot: 1 }, 0)).toEqual({ 'lines.0.reason': msg });
  });

  it('đủ, không lỗi thì không cần lý do', () => {
    expect(countErrors(count, 0)).toEqual({});
  });
});

describe('cách giao', () => {
  it('API waiting/left ↔ DB driver_waiting/driver_left', () => {
    expect([toDbMode('waiting'), toDbMode('left')]).toEqual(['driver_waiting', 'driver_left']);
    expect([fromDbMode('driver_waiting'), fromDbMode('driver_left')]).toEqual(['waiting', 'left']);
  });
});
