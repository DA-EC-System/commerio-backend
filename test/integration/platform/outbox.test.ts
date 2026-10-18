import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';
import { asCompany } from '../helpers/rls.ts';

const insertOutbox = (c: pg.PoolClient, companyId: string | null) =>
  c.query(
    `insert into platform.outbox_messages (event_id, company_id, type, topic, key, payload)
     values ($1, $2, 'inventory.stock_changed', 'commerio.inventory', $3, '{}')`,
    [randomUUID(), companyId, randomUUID()],
  );

describe('bảng outbox (AC-9)', () => {
  it('trong công ty ghi thêm được sự kiện của chính công ty, không cần RETURNING', async () => {
    const company = randomUUID();
    const res = await asCompany(company, (c) => insertOutbox(c, company));
    expect(res.rowCount).toBe(1);
  });

  it('role ứng dụng không đọc, không sửa outbox', async () => {
    const company = randomUUID();
    await expect(asCompany(company, (c) => c.query('select 1 from platform.outbox_messages'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asCompany(company, (c) => c.query('update platform.outbox_messages set published_at = now()')),
    ).rejects.toThrow(/permission denied/);
  });

  it('không ghi được sự kiện mang công ty khác hay sự kiện cấp nền tảng', async () => {
    const company = randomUUID();
    await expect(asCompany(company, (c) => insertOutbox(c, randomUUID()))).rejects.toThrow(/row-level security/);
    await expect(asCompany(company, (c) => insertOutbox(c, null))).rejects.toThrow(/row-level security/);
  });

  it('event_id không trùng', async () => {
    const eventId = randomUUID();
    const insert = () =>
      testPool().query(
        `insert into platform.outbox_messages (event_id, type, topic, key, payload)
         values ($1, 'platform.x', 'commerio.platform', 'k', '{}')`,
        [eventId],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it('processed_events: thêm được, trùng (consumer, event_id) bị từ chối, không sửa không xoá', async () => {
    const company = randomUUID();
    await asCompany(company, async (c) => {
      const eventId = randomUUID();
      await c.query("insert into platform.processed_events (consumer, event_id) values ('report', $1)", [eventId]);
      await expect(
        c.query("insert into platform.processed_events (consumer, event_id) values ('report', $1)", [eventId]),
      ).rejects.toThrow(/duplicate key/);
    });
    await expect(asCompany(company, (c) => c.query('delete from platform.processed_events'))).rejects.toThrow(
      /permission denied/,
    );
  });
});
