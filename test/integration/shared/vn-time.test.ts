import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '#src/shared/db/client.ts';
import { inVnDays, vnDayOf } from '#src/shared/db/vn-time.ts';

// Ngày theo giờ Việt Nam (UTC+7) trong SQL cho báo cáo: 17:00 UTC là 00:00 hôm sau ở VN.
describe('giờ Việt Nam trong SQL', () => {
  const at = (iso: string) => sql`${iso}::timestamptz`;

  it('vnDayOf: ngày VN của một thời điểm', async () => {
    const res = await getDb().execute<{ a: string; b: string }>(
      sql`select ${vnDayOf(at('2026-10-18T16:59:59Z'))} as a, ${vnDayOf(at('2026-10-18T17:00:00Z'))} as b`,
    );
    expect(res.rows[0]).toEqual({ a: '2026-10-18', b: '2026-10-19' });
  });

  it('inVnDays: [from 00:00, to + 1 ngày 00:00) giờ VN', async () => {
    const res = await getDb().execute<Record<string, boolean>>(sql`
      select ${inVnDays(at('2026-10-17T16:59:59Z'), '2026-10-18', '2026-10-19')} as truoc,
             ${inVnDays(at('2026-10-17T17:00:00Z'), '2026-10-18', '2026-10-19')} as dau,
             ${inVnDays(at('2026-10-19T16:59:59Z'), '2026-10-18', '2026-10-19')} as cuoi,
             ${inVnDays(at('2026-10-19T17:00:00Z'), '2026-10-18', '2026-10-19')} as sau`);
    expect(res.rows[0]).toEqual({ truoc: false, dau: true, cuoi: true, sau: false });
  });
});
