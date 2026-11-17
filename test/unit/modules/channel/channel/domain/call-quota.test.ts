import { describe, expect, it } from 'vitest';
import { companyCap, companyShare } from '#src/modules/channel/channel/domain/call-quota.ts';

// Luật chia hạn mức gọi sàn theo công ty (#215, Documents/21 §18.6.8).
describe('phần hạn mức của công ty', () => {
  it('theo tỉ lệ gian hàng active của công ty trên tổng gian hàng active của sàn, làm tròn xuống', () => {
    expect(companyShare(9000, 500, 3, 10)).toBe(2700);
    expect(companyShare(9000, 500, 1, 7)).toBe(1285);
  });

  it('không dưới mức tối thiểu CHANNEL_COMPANY_MIN_CALLS, kể cả công ty chưa có gian hàng active', () => {
    expect(companyShare(9000, 500, 1, 100)).toBe(500);
    expect(companyShare(9000, 500, 0, 10)).toBe(500);
  });

  it('sàn chưa có gian hàng active nào thì là mức tối thiểu (không chia cho 0)', () => {
    expect(companyShare(9000, 500, 0, 0)).toBe(500);
  });

  it('một công ty giữ mọi gian hàng active thì được cả trần chung', () => {
    expect(companyShare(9000, 500, 4, 4)).toBe(9000);
  });
});

describe('trần lượt theo loại lời gọi', () => {
  it('việc nền chạy tới 100% phần của công ty', () => {
    expect(companyCap(500, true)).toBe(500);
  });

  it('thao tác bấm tay dừng ở 90%: được gọi khi đã dùng dưới 90% phần', () => {
    expect(companyCap(500, false)).toBe(450);
    // 90% của 1285 là 1156,5: đã dùng 1156 thì còn gọi được lượt thứ 1157, đã dùng 1157 thì dừng.
    expect(companyCap(1285, false)).toBe(1157);
  });
});
