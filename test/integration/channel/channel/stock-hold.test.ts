import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { awaitingStocktakeShops } from '#src/modules/channel/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';

/** Gian hàng; `awaiting` thì đang chờ kiểm kê đầu kỳ (có phiếu, có mốc). */
async function shop(companyId: string, awaiting: boolean): Promise<string> {
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, opening_stocktake_id, opening_stocktake_number, order_cutoff_at)
     values ($1, 'lazada', $2, 'Shop Thử', $3, $4, $5) returning id`,
    [companyId, randomUUID(), awaiting ? randomUUID() : null, awaiting ? 'KK-000001' : null, awaiting ? new Date() : null],
  );
  return rows[0]!.id;
}

// Trạng thái chờ kiểm kê của gian hàng cho fulfillment (spec 199b §5.6).
describe('awaitingStocktakeShops', () => {
  it('chỉ trả gian hàng đang chờ kiểm kê trong danh sách; gian hàng công ty khác không có', async () => {
    const { companyId } = await createCompany();
    const other = await createCompany();
    const waiting = await shop(companyId, true);
    const active = await shop(companyId, false);
    const foreign = await shop(other.companyId, true);

    const got = await withCompany(companyId, () => awaitingStocktakeShops([waiting, active, foreign]));
    expect([...got]).toEqual([waiting]);
    expect(await withCompany(companyId, () => awaitingStocktakeShops([]))).toEqual(new Set());
  });

  it('lock: true khoá FOR SHARE: phải đợi giao dịch thoát chờ (for no key update) xong', async () => {
    const { companyId } = await createCompany();
    const id = await shop(companyId, true);
    const got = await raceBehindLock(
      (holder) => holder.query('select id from channel.shops where id = $1 for no key update', [id]),
      1,
      () => withCompany(companyId, () => awaitingStocktakeShops([id], { lock: true })),
    );
    expect(got.has(id)).toBe(true);
  });
});
