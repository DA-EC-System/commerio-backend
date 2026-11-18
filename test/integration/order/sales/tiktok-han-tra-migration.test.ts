import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

/** Câu bù của migration `tiktok-han-tra` (#236 PR 2, spec 5.3). */
const backfillSql = (): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_tiktok-han-tra.sql') || f.endsWith('-tiktok-han-tra.sql'));
  if (!file) throw new Error('Không thấy migration *_tiktok-han-tra.sql');
  const text = readFileSync(join(MIGRATIONS, file), 'utf8');
  const start = text.indexOf('update "order".orders o');
  if (start < 0) throw new Error('Migration tiktok-han-tra không có câu update "order".orders');
  return text.slice(start, text.indexOf(';', start) + 1);
};

describe('migration tiktok-han-tra (#236 PR 2, AC 12b)', () => {
  it('ghi mốc hết quyền trả từ raw_orders cho đơn TikTok processing đã COMPLETED/CANCELLED, không đụng đơn khác, chạy lại không đổi', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const T = new Date('2026-11-15T09:00:00Z');
    const S = new Date('2026-11-01T00:00:00Z');

    const client = await testPool().connect();
    try {
      await client.query('begin');
      const shop = async (platform: 'tiktok' | 'lazada') =>
        (
          await client.query<{ id: string }>(
            `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at)
             values ($1, $2, $3, 'Shop thử', 'active', now()) returning id`,
            [companyId, platform, `s-${randomUUID().slice(0, 8)}`],
          )
        ).rows[0]!.id;
      const tiktok = await shop('tiktok');
      const lazada = await shop('lazada');

      /** Đơn sàn kèm dòng `raw_orders` như sau lượt kéo của bản trước PR 2. */
      const order = async (
        c: PoolClient,
        o: { shop: string; raw: string; status?: 'processing' | 'completed'; ends?: Date | null; updatedAt?: Date | 'epoch' },
      ) => {
        const { orderId } = await createOrder(companyId, { lines: [{ variantId, quantity: 1, unitPrice: '100000' }], source: 'marketplace' });
        const ext = `E-${randomUUID().slice(0, 8)}`;
        const completed = o.status === 'completed';
        await c.query(
          `update "order".orders set shop_id = $2, external_order_id = $3, raw_marketplace_status = $4, status = $5,
                  return_window_ends_at = $6, outcome = $7, completed_at = $8 where id = $1`,
          [orderId, o.shop, ext, o.raw, o.status ?? 'processing', o.ends ?? null, completed ? 'full' : null, completed ? new Date() : null],
        );
        await c.query(
          `insert into channel.raw_orders (company_id, shop_id, order_id, external_order_id, external_status, payload, external_update_time)
           values ($1, $2, $3, $4, $5, '{}'::jsonb, $6)`,
          [companyId, o.shop, orderId, ext, o.raw, o.updatedAt ?? T],
        );
        return orderId;
      };
      const id = {
        completed: await order(client, { shop: tiktok, raw: 'COMPLETED' }),
        cancelled: await order(client, { shop: tiktok, raw: 'CANCELLED' }),
        delivered: await order(client, { shop: tiktok, raw: 'DELIVERED' }),
        alreadySet: await order(client, { shop: tiktok, raw: 'COMPLETED', ends: S }),
        appCompleted: await order(client, { shop: tiktok, raw: 'COMPLETED', status: 'completed', ends: S }),
        epoch: await order(client, { shop: tiktok, raw: 'COMPLETED', updatedAt: 'epoch' }),
        lazada: await order(client, { shop: lazada, raw: 'COMPLETED' }),
      };
      const ids = Object.values(id);
      const state = async () =>
        new Map(
          (
            await client.query<{ id: string; return_window_ends_at: Date | null; version: number }>(
              'select id, return_window_ends_at, version from "order".orders where id = any($1)',
              [ids],
            )
          ).rows.map((r) => [r.id, r]),
        );
      const before = await state();

      await client.query(backfillSql());
      const after = await state();

      expect(after.get(id.completed)).toMatchObject({ return_window_ends_at: T, version: before.get(id.completed)!.version + 1 });
      expect(after.get(id.cancelled)!.return_window_ends_at).toEqual(T);
      expect(after.get(id.delivered)!.return_window_ends_at).toBeNull();
      expect(after.get(id.alreadySet)!.return_window_ends_at).toEqual(S);
      expect(after.get(id.appCompleted)!.return_window_ends_at).toEqual(S);
      // Dấu ép kéo lại của migration trước: không ghi hạn trả năm 1970, lượt kéo sau ghi mốc thật (Review Focus 1).
      expect(after.get(id.epoch)!.return_window_ends_at).toBeNull();
      expect(after.get(id.lazada)!.return_window_ends_at).toBeNull();

      const again = await client.query(backfillSql());
      expect(again.rowCount).toBe(0);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
