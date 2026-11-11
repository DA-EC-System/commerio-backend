import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** Số migration đặt tên theo số thứ tự (0000–0028), trước khi đổi sang tên theo thời điểm sinh. */
const INDEX_PREFIXED_COUNT = 29;

const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8')) as { entries: JournalEntry[] };

// drizzle-kit migrate chỉ chạy migration có `when` lớn hơn migration cuối đã chạy trên DB: migration sinh
// trên nhánh khác rồi merge sau mà không sinh lại sẽ bị bỏ qua im lặng (db/CLAUDE.md).
describe('db/migrations/meta/_journal.json', () => {
  it('idx liên tục từ 0', () => {
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
  });

  // 29 migration đầu (0000–0028) giữ tên theo số thứ tự; từ 11/11/2026 tên bắt đầu bằng thời điểm sinh (UTC).
  it('tag: số thứ tự cho idx < 29, sau đó <năm tháng ngày giờ phút giây>_<tên> khớp when', () => {
    journal.entries.forEach((e, i) => {
      if (i < INDEX_PREFIXED_COUNT) {
        expect(e.tag.startsWith(`${String(i).padStart(4, '0')}_`), e.tag).toBe(true);
        return;
      }
      expect(e.tag, `${e.tag}: sinh bằng npm run db:generate, không đặt tên tay`).toMatch(/^\d{14}_[a-z0-9-]+$/);
      // drizzle-kit lấy tên và `when` ở hai lần đọc đồng hồ sát nhau: cho lệch tối đa 2 giây.
      const n = (from: number, to: number): number => Number(e.tag.slice(from, to));
      const fromTag = Date.UTC(n(0, 4), n(4, 6) - 1, n(6, 8), n(8, 10), n(10, 12), n(12, 14));
      expect(Math.abs(e.when - fromTag), `${e.tag}: tên không khớp when trong journal`).toBeLessThan(2000);
    });
  });

  it('when tăng ngặt theo idx: migration merge sau phải được sinh lại', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const [prev, cur] = [journal.entries[i - 1]!, journal.entries[i]!];
      expect(cur.when, `${cur.tag} sinh trước ${prev.tag}: xoá, rebase, sinh lại`).toBeGreaterThan(prev.when);
    }
  });
});
