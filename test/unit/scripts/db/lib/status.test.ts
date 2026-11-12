import { describe, expect, it } from 'vitest';
import { compareWithDb, formatStatus, type LocalMigration } from '../../../../../scripts/db/lib/status.ts';

const local = (tag: string, when: number): LocalMigration => ({ idx: 0, version: '7', when, tag, breakpoints: true, hash: `h-${tag}` });
const row = (id: number, m: LocalMigration, hash = m.hash) => ({ id, hash, created_at: String(m.when) });

const a = local('20261101000000_a', 1000);
const b = local('20261102000000_b', 2000);
const c = local('20261103000000_c', 3000);

describe('so journal với drizzle.__drizzle_migrations', () => {
  it('DB trống: mọi migration là chưa chạy, không có gì lệch', () => {
    const s = compareWithDb([a, b], []);
    expect(s.pending.map((m) => m.tag)).toEqual([a.tag, b.tag]);
    expect(s.outOfOrder).toEqual([]);
    expect(s.lastAppliedAt).toBeNull();
  });

  it('migration có when lớn hơn dòng mới nhất là chưa chạy, sẽ được chạy', () => {
    const s = compareWithDb([a, b, c], [row(1, a), row(2, b)]);
    expect(s.applied.map((m) => m.tag)).toEqual([a.tag, b.tag]);
    expect(s.pending.map((m) => m.tag)).toEqual([c.tag]);
    expect(s.outOfOrder).toEqual([]);
  });

  it('migration chưa chạy mà when nhỏ hơn dòng mới nhất là lệch thứ tự (drizzle bỏ qua im lặng)', () => {
    const s = compareWithDb([a, b, c], [row(1, a), row(2, c)]);
    expect(s.outOfOrder.map((m) => m.tag)).toEqual([b.tag]);
    expect(s.pending).toEqual([]);
    expect(formatStatus(s, true)).toContain(`Lệch thứ tự (drizzle sẽ bỏ qua im lặng): 1\n  ${b.tag}`);
  });

  it('migration chưa chạy có when bằng đúng dòng mới nhất cũng là lệch thứ tự', () => {
    const same = local('20261103000000_c-khac', 3000);
    const s = compareWithDb([a, same], [row(1, a), { id: 2, hash: 'cua-nhanh-khac', created_at: '3000' }]);
    // Khớp theo when nên coi là đã chạy, nhưng hash khác: báo để người đọc thấy.
    expect(s.hashChanged.map((m) => m.tag)).toEqual([same.tag]);
    const later = compareWithDb([a, local('x_d', 2500)], [row(1, a), { id: 2, hash: 'z', created_at: '3000' }]);
    expect(later.outOfOrder.map((m) => m.tag)).toEqual(['x_d']);
  });

  it('khớp theo when khi file đổi nội dung: vẫn là đã chạy, báo hash khác', () => {
    const s = compareWithDb([a, b], [row(1, a), row(2, b, 'hash-cu')]);
    expect(s.applied.map((m) => m.tag)).toEqual([a.tag, b.tag]);
    expect(s.hashChanged.map((m) => m.tag)).toEqual([b.tag]);
  });

  it('dòng trên DB không khớp migration nào được liệt kê riêng', () => {
    const s = compareWithDb([a], [row(1, a), { id: 9, hash: 'la', created_at: '5000' }]);
    expect(s.unknownRows.map((r) => r.id)).toEqual([9]);
    expect(s.lastAppliedAt).toBe(5000);
  });
});
