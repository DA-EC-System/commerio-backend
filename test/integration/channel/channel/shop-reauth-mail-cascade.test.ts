import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { shopReauthMails, shops } from '#src/modules/channel/channel/repository/schema.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';
import { pgError } from '#src/shared/db/pg-error.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// #398: xoá gian hàng đã ngắt. `commerio_app` không có DELETE trên `shop_reauth_mails` (#312), nên thư đi theo gian hàng
// bằng khoá ngoại `ON DELETE CASCADE` (hành động khoá ngoại chạy bằng quyền chủ bảng).

const db = testPool();

/** Gian hàng `disconnected` kèm một thư báo mất uỷ quyền, ghi bằng role chủ bảng. */
async function shopWithMail(companyId: string): Promise<{ shopId: string; mailId: string }> {
  const { rows } = await db.query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status)
     values ($1, 'lazada', $2, 'Shop Thử Xoá', 'disconnected') returning id`,
    [companyId, `seller-${randomUUID()}`],
  );
  const shopId = rows[0]!.id;
  const mail = await db.query<{ id: string }>(
    `insert into channel.shop_reauth_mails (company_id, shop_id, stage, deadline, seq)
     values ($1, $2, 'lost', now(), 1) returning id`,
    [companyId, shopId],
  );
  return { shopId, mailId: mail.rows[0]!.id };
}

const count = async (sql: string, id: string) => Number((await db.query<{ n: string }>(sql, [id])).rows[0]!.n);

describe('thư báo uỷ quyền xoá theo gian hàng (#398)', () => {
  it('xoá gian hàng dưới withCompany xoá luôn thư báo uỷ quyền', async () => {
    const { companyId } = await createCompany();
    const { shopId } = await shopWithMail(companyId);

    await withCompany(companyId, () => getDb().delete(shops).where(eq(shops.id, shopId)));

    expect(await count('select count(*) as n from channel.shop_reauth_mails where shop_id = $1', shopId)).toBe(0);
    expect(await count('select count(*) as n from channel.shops where id = $1', shopId)).toBe(0);
  });

  it('commerio_app vẫn không DELETE thẳng shop_reauth_mails', async () => {
    const { companyId } = await createCompany();
    const { mailId } = await shopWithMail(companyId);

    const err = await withCompany(companyId, () => getDb().delete(shopReauthMails).where(eq(shopReauthMails.id, mailId))).then(
      () => null,
      (e: unknown) => e,
    );

    expect(pgError(err).code).toBe('42501');
    expect(await count('select count(*) as n from channel.shop_reauth_mails where id = $1', mailId)).toBe(1);
  });
});
