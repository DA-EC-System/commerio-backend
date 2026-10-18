import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8')) as { entries: JournalEntry[] };

// drizzle-kit migrate chỉ chạy migration có `when` lớn hơn migration cuối đã chạy trên DB: migration sinh
// trên nhánh khác rồi merge sau mà không sinh lại sẽ bị bỏ qua im lặng (db/CLAUDE.md).
describe('db/migrations/meta/_journal.json', () => {
  it('idx liên tục từ 0 và trùng số đầu của tag', () => {
    journal.entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(e.tag.startsWith(String(i).padStart(4, '0'))).toBe(true);
    });
  });

  it('when tăng ngặt theo idx: migration merge sau phải được sinh lại', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const [prev, cur] = [journal.entries[i - 1]!, journal.entries[i]!];
      expect(cur.when, `${cur.tag} sinh trước ${prev.tag}: xoá, rebase, sinh lại`).toBeGreaterThan(prev.when);
    }
  });
});
