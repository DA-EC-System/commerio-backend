import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';

// Supabase cho user `postgres` quyền CREATEROLE nhưng không phải superuser; migration và test chạy y như vậy
// để lỗi quyền (GRANT, SET ROLE, quyền mặc định) lộ ra ở CI thay vì lúc db:migrate:staging.
describe('role chạy migration và test', () => {
  it('không phải superuser, có CREATEROLE, là chủ các bảng đã tạo', async () => {
    const res = await testPool().query<{ super: boolean; createrole: boolean; owner: string; me: string }>(`
      select r.rolsuper as super, r.rolcreaterole as createrole, current_user as me,
             (select tableowner from pg_tables where schemaname = 'platform' and tablename = 'outbox_messages') as owner
      from pg_roles r where r.rolname = current_user`);
    const row = res.rows[0]!;
    expect(row).toMatchObject({ super: false, createrole: true });
    expect(row.owner).toBe(row.me);
  });
});
