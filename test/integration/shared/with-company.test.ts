import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { currentCompanyId, getDb, inTransaction, withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../helpers/db.ts';

const pool = testPool();

const companyA = randomUUID();
const companyB = randomUUID();

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await getDb().execute(query)).rows as T[];
}

beforeAll(async () => {
  // Role đăng nhập là chủ bảng nên bỏ qua RLS: dựng một membership cho mỗi công ty.
  for (const company of [companyA, companyB]) {
    const account = await pool.query<{ id: string }>(
      'insert into core.accounts (email, full_name) values ($1, $2) returning id',
      [`${company}@test.vn`, 'Người thử'],
    );
    await pool.query('insert into core.memberships (company_id, account_id) values ($1, $2)', [
      company,
      account.rows[0]!.id,
    ]);
  }
});

describe('withCompany (AC-6)', () => {
  it('chạy dưới commerio_app với app.company_id của công ty, truy vấn không lọc chỉ ra dòng của công ty đó', async () => {
    await withCompany(companyA, async () => {
      const [who] = await rows<{ role: string; company: string }>(
        sql`select current_user as role, current_setting('app.company_id', true) as company`,
      );
      expect(who).toEqual({ role: 'commerio_app', company: companyA });
      const members = await rows<{ company_id: string }>(sql`select company_id from core.memberships`);
      expect(members.map((m) => m.company_id)).toEqual([companyA]);
      expect(currentCompanyId()).toBe(companyA);
    });
  });

  it('xong giao dịch thì kết nối trả về không còn mang role ứng dụng hay công ty', async () => {
    await withCompany(companyA, async () => undefined);
    const [who] = await rows<{ role: string; company: string | null }>(
      sql`select current_user as role, nullif(current_setting('app.company_id', true), '') as company`,
    );
    expect(who!.role).not.toBe('commerio_app');
    expect(who!.company).toBeNull();
    expect(currentCompanyId()).toBeNull();
  });

  it('lồng cùng công ty thì dùng lại giao dịch đang mở', async () => {
    await withCompany(companyA, async (outer) => {
      await withCompany(companyA, async (inner) => {
        expect(inner).toBe(outer);
      });
      await inTransaction(async (tx) => {
        expect(tx).toBe(outer);
      });
    });
  });

  it('lồng khác công ty thì ném lỗi lập trình', async () => {
    await expect(withCompany(companyA, () => withCompany(companyB, async () => undefined))).rejects.toThrow(
      /không lồng được/,
    );
  });

  it('lồng trong giao dịch của role chủ bảng (luồng đăng ký) thì ném lỗi, không đổi role giữa chừng', async () => {
    await expect(inTransaction(() => withCompany(companyA, async () => undefined))).rejects.toThrow(/không lồng được/);
  });

  it('lỗi giữa chừng thì rollback cả giao dịch', async () => {
    await expect(
      withCompany(companyA, async () => {
        await getDb().execute(sql`insert into core.audit_logs (company_id, action, entity_type, entity_id)
          values (${companyA}, 'create', 'test.rollback', ${randomUUID()})`);
        throw new Error('lỗi giả');
      }),
    ).rejects.toThrow('lỗi giả');
    const left = await pool.query("select 1 from core.audit_logs where entity_type = 'test.rollback'");
    expect(left.rowCount).toBe(0);
  });

  it('ngoài withCompany thì không có công ty', () => {
    expect(currentCompanyId()).toBeNull();
  });
});
