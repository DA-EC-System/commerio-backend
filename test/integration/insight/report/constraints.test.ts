import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

const insertDay = (companyId: string, source: string, shopId: string | null) =>
  testPool().query(
    "insert into insight.daily_channel_summary (company_id, day, source, shop_id) values ($1, '2026-10-18', $2, $3)",
    [companyId, source, shopId],
  );

// Số liệu báo cáo theo ngày và gian hàng (plan chuẩn bị A7; V28, D18; AC-9).
describe('ràng buộc bảng report (AC-9)', () => {
  it('một dòng mỗi (công ty, ngày, nguồn, gian hàng); hai dòng đơn tay không gian hàng bị từ chối', async () => {
    const company = randomUUID();
    await insertDay(company, 'manual', null);
    await expect(insertDay(company, 'manual', null)).rejects.toThrow(/daily_channel_summary_company_id_day_source_shop_id_unique/);
  });

  it('hai gian hàng khác nhau cùng ngày thì được; số liệu mặc định 0, phí sàn chưa chờ', async () => {
    const company = randomUUID();
    await insertDay(company, 'marketplace', randomUUID());
    await insertDay(company, 'marketplace', randomUUID());
    const res = await testPool().query(
      'select revenue, profit, fees_pending from insight.daily_channel_summary where company_id = $1',
      [company],
    );
    expect(res.rows).toEqual([
      { revenue: '0.00', profit: '0.00', fees_pending: false },
      { revenue: '0.00', profit: '0.00', fees_pending: false },
    ]);
  });
});
