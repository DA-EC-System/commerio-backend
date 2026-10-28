import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { asCompany } from '../../helpers/rls.ts';

const insertHistory = (c: pg.PoolClient, companyId: string) =>
  c.query(
    `insert into fulfillment.order_status_history (company_id, order_id, to_status, source)
     values ($1, $2, 'confirmed', 'user')`,
    [companyId, randomUUID()],
  );

// Lịch sử chuyển trạng thái đơn chỉ thêm (plan chuẩn bị 4.2; AC-9).
describe('ràng buộc bảng fulfillment (AC-9)', () => {
  it('lịch sử trạng thái: role ứng dụng ghi được, không sửa, không xoá', async () => {
    const company = randomUUID();
    await expect(asCompany(company, (c) => insertHistory(c, company))).resolves.toBeDefined();
    await expect(
      asCompany(company, async (c) => {
        await insertHistory(c, company);
        await c.query("update fulfillment.order_status_history set reason = 'sửa'");
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asCompany(company, async (c) => {
        await insertHistory(c, company);
        await c.query('delete from fulfillment.order_status_history');
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('lịch sử trạng thái của công ty khác bị RLS chặn khi ghi', async () => {
    await expect(asCompany(randomUUID(), (c) => insertHistory(c, randomUUID()))).rejects.toThrow(
      /row-level security/,
    );
  });
});
