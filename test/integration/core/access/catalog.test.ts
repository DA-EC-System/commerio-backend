import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { BUILTIN_ROLES, PERMISSIONS, permissionModule } from '#src/modules/core/access/domain/catalog.ts';

const pool = new pg.Pool({ connectionString: inject('databaseUrl') });
afterAll(() => pool.end());

describe('seed danh mục quyền và vai trò có sẵn (AC-16)', () => {
  it('access.permissions khớp đúng danh mục, kể cả phân hệ của từng quyền', async () => {
    const { rows } = await pool.query<{ code: string; module_code: string; description: string }>(
      'select code, module_code, description from access.permissions order by code',
    );
    const expected = PERMISSIONS.map((p) => ({ code: p.code, module_code: permissionModule(p.code), description: p.description }));
    expect(rows).toEqual(expected.sort((a, b) => a.code.localeCompare(b.code)));
  });

  it('bốn vai trò có sẵn không thuộc công ty nào, quyền khớp từng cột của mục 8', async () => {
    for (const role of Object.values(BUILTIN_ROLES)) {
      const r = await pool.query('select name, kind, company_id from access.roles where id = $1', [role.id]);
      expect(r.rows[0]).toEqual({ name: role.name, kind: 'builtin', company_id: null });
      const p = await pool.query<{ permission_code: string }>(
        'select permission_code from access.role_permissions where role_id = $1',
        [role.id],
      );
      expect(p.rows.map((x) => x.permission_code).sort()).toEqual([...role.permissions].sort());
    }
  });

  it('CEO có mọi quyền, gồm hai quyền chỉ vai trò có sẵn mới mang', () => {
    expect([...BUILTIN_ROLES.ceo.permissions].sort()).toEqual(PERMISSIONS.map((p) => p.code).sort());
  });
});
