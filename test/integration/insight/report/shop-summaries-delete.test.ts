import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deleteShopSummaries } from '#src/modules/insight/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// #398: xoá gian hàng đã ngắt xoá số liệu theo ngày của gian hàng; gian hàng khác và dòng không gian hàng còn nguyên.

const db = testPool();

async function summary(companyId: string, day: string, shopId: string | null) {
  await db.query('insert into insight.daily_channel_summary (company_id, day, source, shop_id) values ($1, $2, $3, $4)', [
    companyId,
    day,
    shopId ? 'marketplace' : 'manual',
    shopId,
  ]);
}

describe('xoá số liệu của gian hàng (#398)', () => {
  it('xoá dòng tóm tắt của gian hàng, giữ gian hàng khác và dòng không gian hàng', async () => {
    const { companyId } = await createCompany();
    const shopId = randomUUID();
    await summary(companyId, '2026-11-01', shopId);
    await summary(companyId, '2026-11-02', shopId);
    await summary(companyId, '2026-11-01', randomUUID());
    await summary(companyId, '2026-11-01', null);

    expect(await withCompany(companyId, () => deleteShopSummaries(shopId))).toBe(2);

    const left = await db.query<{ shop_id: string | null }>('select shop_id from insight.daily_channel_summary where company_id = $1', [companyId]);
    expect(left.rowCount).toBe(2);
    expect(left.rows.some((r) => r.shop_id === shopId)).toBe(false);
  });
});
