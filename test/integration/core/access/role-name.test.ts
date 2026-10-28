import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

const insertRole = (companyId: string | null, name: string, kind = 'custom') =>
  testPool().query('insert into access.roles (company_id, name, kind) values ($1, $2, $3)', [companyId, name, kind]);

// Index roles_company_lower_name_uq (migration 0005, Documents/21 D3).
describe('tên vai trò không phân biệt hoa thường (AC-9)', () => {
  it('cùng công ty: "Kế toán" rồi "kế toán" bị từ chối', async () => {
    const company = randomUUID();
    await insertRole(company, 'Kế toán');
    await expect(insertRole(company, 'kế toán')).rejects.toThrow(/roles_company_lower_name_uq/);
  });

  it('khác công ty thì trùng tên được', async () => {
    await insertRole(randomUUID(), 'Thủ kho');
    await expect(insertRole(randomUUID(), 'thủ kho')).resolves.toBeDefined();
  });

  it('vai trò có sẵn (company_id trống) cũng không trùng tên theo chữ thường', async () => {
    await expect(insertRole(null, 'sale', 'builtin')).rejects.toThrow(/roles_company_lower_name_uq/);
  });
});
