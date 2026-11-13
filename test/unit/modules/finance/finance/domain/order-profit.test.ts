import { describe, expect, it } from 'vitest';
import { appliedTimeline, pickEffective } from '#src/modules/finance/finance/domain/config-version.ts';
import { marginPct } from '#src/modules/finance/finance/domain/order-profit.ts';

// Lãi theo danh sách đơn (#231; Documents/25 §10.2, §6.2).
describe('marginPct', () => {
  it('lãi gộp chia thực nhận, một chữ số thập phân', () => {
    expect(marginPct('93000', '33000')).toBe(35.5);
    expect(marginPct(200000, -20000)).toBe(-10);
  });
  it('thực nhận không dương thì không có biên', () => {
    expect(marginPct(0, -5000)).toBeNull();
    expect(marginPct(-1000, -5000)).toBeNull();
  });
});

describe('appliedTimeline', () => {
  const v = (id: string, status: 'active' | 'expired' | 'scheduled', effectiveFrom: string, effectiveTo: string | null, supersedesId: string | null = null) => ({
    id,
    status,
    effectiveFrom,
    effectiveTo,
    supersedesId,
  });
  it('chỉ bản đã áp, bỏ bản bị sửa lỗi thay, mới trước; khớp pickEffective', () => {
    const versions = [v('a', 'expired', '2026-01-01', '2026-05-31'), v('b', 'active', '2026-06-01', null), v('c', 'scheduled', '2026-12-01', null), v('d', 'active', '2026-01-01', '2026-05-31', 'a')];
    expect(appliedTimeline(versions).map((x) => x.id)).toEqual(['b', 'd']);
    expect(pickEffective(versions, '2026-03-01')?.id).toBe('d');
    expect(pickEffective(versions, '2026-07-01')?.id).toBe('b');
  });
});
