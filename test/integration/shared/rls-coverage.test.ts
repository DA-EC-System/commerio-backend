import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
const ALL: readonly Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/** Bảng có `company_id` mà cố ý không bật RLS. Thêm bảng vào đây phải có lý do, người review thấy trong diff. */
const RLS_EXCEPTIONS: Record<string, string> = {
  'identity.refresh_tokens': 'chỉ luồng xác thực đọc, chạy bằng role chủ bảng; commerio_app không có quyền nào',
};

/** Quyền của commerio_app khác mặc định (SELECT, INSERT, UPDATE, DELETE). */
const EXPECTED_PRIVILEGES: Record<string, readonly Privilege[]> = {
  'identity.refresh_tokens': [],
  'platform.companies': ['SELECT'],
  'access.permissions': ['SELECT'],
  'audit.audit_logs': ['SELECT', 'INSERT'],
  'platform.outbox_messages': ['INSERT'],
  'platform.processed_events': ['SELECT', 'INSERT'],
  // Tài khoản dùng chung mọi công ty, không RLS: request trong công ty chỉ đọc và tạo (mời nhân viên), không sửa, không xoá (#62).
  'staff.accounts': ['SELECT', 'INSERT'],
  // Thẻ kho chỉ thêm, sai thì lập phiếu ngược (Documents/21 K10).
  'inventory.stock_moves': ['SELECT', 'INSERT'],
  // Lịch sử chuyển trạng thái đơn chỉ thêm.
  'fulfillment.order_status_history': ['SELECT', 'INSERT'],
};

interface TableInfo {
  name: string;
  has_company_id: boolean;
  rls: boolean;
  has_policy: boolean;
}

async function tables(): Promise<TableInfo[]> {
  const res = await testPool().query<TableInfo>(`
    select n.nspname || '.' || c.relname as name,
           exists (select 1 from information_schema.columns col
                   where col.table_schema = n.nspname and col.table_name = c.relname
                     and col.column_name = 'company_id') as has_company_id,
           c.relrowsecurity as rls,
           exists (select 1 from pg_policies p
                   where p.schemaname = n.nspname and p.tablename = c.relname
                     and p.policyname = 'company_isolation') as has_policy
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast', 'drizzle', 'public')
    order by 1`);
  return res.rows;
}

// Quét mọi bảng sau khi chạy đủ migration: bảng mới quên RLS hay lệch quyền thì đỏ (AC-8).
describe('phủ RLS và quyền commerio_app trên mọi bảng', () => {
  it('bảng có company_id bật RLS và có policy company_isolation, trừ danh sách ngoại lệ', async () => {
    const missing = (await tables())
      .filter((t) => t.has_company_id && !(t.name in RLS_EXCEPTIONS))
      .filter((t) => !t.rls || !t.has_policy)
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('bảng trong danh sách ngoại lệ vẫn đúng là không có RLS (danh sách không cũ đi)', async () => {
    const all = await tables();
    for (const name of Object.keys(RLS_EXCEPTIONS)) {
      expect(all.find((t) => t.name === name), name).toMatchObject({ has_company_id: true, rls: false });
    }
  });

  it('commerio_app có đúng quyền mong đợi trên từng bảng', async () => {
    const all = await tables();
    expect(all.length).toBeGreaterThan(10);
    for (const name of Object.keys(EXPECTED_PRIVILEGES)) expect(all.map((t) => t.name)).toContain(name);
    for (const { name } of all) {
      const res = await testPool().query<{ privilege: Privilege; ok: boolean }>(
        `select p as privilege, has_table_privilege('commerio_app', $1, p) as ok from unnest($2::text[]) p`,
        [name, ALL],
      );
      const actual = res.rows.filter((r) => r.ok).map((r) => r.privilege);
      expect(actual, name).toEqual(EXPECTED_PRIVILEGES[name] ?? ALL);
    }
  });
});
