import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

/** Câu `UPDATE` điền `before_cutoff` trong migration thêm `handover_source` (spec 199a §5.1). */
const backfillSql = (): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_ban-giao-tru-ton.sql'));
  if (!file) throw new Error('Không thấy migration *_ban-giao-tru-ton.sql');
  const text = readFileSync(join(MIGRATIONS, file), 'utf8');
  const start = text.indexOf('UPDATE "order"."packages"');
  if (start < 0) throw new Error('Migration không có câu UPDATE điền before_cutoff');
  return text.slice(start, text.indexOf(';', start) + 1);
};

// Kiện đã rời kho trước #199 chưa qua `ship`: migration ghi là chỉ lưu (AC14).
describe('migration bàn giao trừ tồn', () => {
  it('AC14: kiện rời kho mà thiếu handover_source bị CHECK chặn', async () => {
    const insert = testPool().query(
      `insert into "order".packages (company_id, code, order_id, status, handed_over_at)
       values ($1, $2, $3, 'in_transit', now())`,
      [randomUUID(), `KH-${randomUUID().slice(0, 8)}`, randomUUID()],
    );
    await expect(insert).rejects.toMatchObject({ code: '23514', constraint: 'packages_handover_source' });
  });

  it('AC14: câu UPDATE của migration điền before_cutoff cho kiện đã rời kho', async () => {
    const client = await testPool().connect();
    try {
      await client.query('begin');
      await client.query('alter table "order".packages drop constraint packages_handover_source');
      const c = randomUUID();
      const insert = (status: string, handedOver: boolean) =>
        client.query<{ id: string }>(
          `insert into "order".packages (company_id, code, order_id, status, handed_over_at)
           values ($1, $2, $3, $4, $5) returning id`,
          [c, `KH-${randomUUID().slice(0, 8)}`, randomUUID(), status, handedOver ? new Date() : null],
        );
      const delivered = (await insert('delivered', true)).rows[0]!.id;
      const reserved = (await insert('reserved', false)).rows[0]!.id;
      await client.query(backfillSql());
      const { rows } = await client.query<{ id: string; handover_source: string | null }>(
        'select id, handover_source from "order".packages where company_id = $1',
        [c],
      );
      const sourceOf = new Map(rows.map((r) => [r.id, r.handover_source]));
      expect(sourceOf.get(delivered)).toBe('before_cutoff');
      expect(sourceOf.get(reserved)).toBeNull();
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
