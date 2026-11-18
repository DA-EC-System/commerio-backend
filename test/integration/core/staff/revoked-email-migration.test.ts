// Xoá email, họ tên chưa qua OTP của link đã huỷ từ `open` trước #403 (migration `*_xoa-email-link-huy-chua-xac-minh.sql`).
// Dựng đúng trạng thái code cũ để lại: người cầm link xin mã (ghi email), Admin huỷ (nhật ký `open → revoked`, giữ email).
// Chạy câu lệnh của migration trong giao dịch rồi rollback, như `supplier-payment-migration.test.ts`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { createCompany, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { accountIdOf, claimLink, joinApi, newLink } from './helpers.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');
const app = testApp();
const join_ = joinApi(app);

const migration = (): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_xoa-email-link-huy-chua-xac-minh.sql'));
  if (!file) throw new Error('Không thấy migration *_xoa-email-link-huy-chua-xac-minh.sql');
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

async function rolledBack(fn: (c: pg.PoolClient) => Promise<void>) {
  const c = await testPool().connect();
  try {
    await c.query('begin');
    await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** Huỷ như code trước #403: chỉ đổi trạng thái, giữ email; nhật ký ghi trạng thái trước. */
async function oldRevoke(companyId: string, actorId: string, id: string) {
  const db = testPool();
  const { rows } = await db.query<{ status: string }>('select status from core.invitations where id = $1', [id]);
  await db.query(
    "update core.invitations set status = 'revoked', decided_by = $2, decided_at = now(), version = version + 1 where id = $1",
    [id, actorId],
  );
  await db.query(
    `insert into core.audit_logs (company_id, actor_id, action, entity_type, entity_id, before, after)
     values ($1, $2, 'update', 'core.invitations', $3, jsonb_build_object('status', $4::text), '{"status":"revoked"}')`,
    [companyId, actorId, id, rows[0]!.status],
  );
}

let company: Awaited<ReturnType<typeof createCompany>>;
let ceoId: string;

beforeAll(async () => {
  company = await createCompany();
  ceoId = await accountIdOf(company.ceo.email);
});

describe('xoá email chưa qua OTP của link đã huỷ từ open (#403)', () => {
  it('link huỷ từ open: email, họ tên về null; link huỷ từ claimed giữ nguyên; chạy lại không đổi gì', async () => {
    const sale = [BUILTIN_ROLES.sale.id];
    const open = await newLink(app, company.ceo.token, sale);
    const typed = uniqueEmail('go-thu');
    await join_.otp(open.token, typed, 'Người Gõ Thử');
    await oldRevoke(company.companyId, ceoId, open.id);

    const claimed = await newLink(app, company.ceo.token, sale);
    const verified = uniqueEmail('da-xac-minh');
    await claimLink(app, claimed.token, verified);
    await oldRevoke(company.companyId, ceoId, claimed.id);

    const rowsOf = (c: pg.PoolClient) =>
      c.query<{ id: string; email: string | null; full_name: string | null }>(
        'select id, email, full_name from core.invitations where id = any($1) order by id',
        [[open.id, claimed.id]],
      );
    await rolledBack(async (c) => {
      expect((await rowsOf(c)).rows.find((r) => r.id === open.id)?.email).toBe(typed);
      await c.query(migration());
      const after = new Map((await rowsOf(c)).rows.map((r) => [r.id, r]));
      expect(after.get(open.id)).toMatchObject({ email: null, full_name: null });
      expect(after.get(claimed.id)?.email).toBe(verified);
      await c.query(migration());
      expect((await rowsOf(c)).rows.find((r) => r.id === claimed.id)?.email).toBe(verified);
    });
  });
});
