import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { runListingSync, runOpenOrderPull, runOrderPull, runStockPush, runTokenRefresh } from '#src/modules/channel/channel/service/background.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import type { ProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { handleReauthMail } from '#src/modules/channel/channel/service/reauth-mail.ts';
import { runRemoteSkusRefresh } from '#src/modules/channel/channel/service/remote-skus.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

// #398: `commerio_app` không xoá được việc pg-boss; việc còn chờ của gian hàng đã xoá gặp gian hàng (listing, thư) không
// còn thì bỏ qua, không ném (không vào trang việc lỗi). Chốt hành vi đã có của từng handler.

registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: `seller-${accessToken.slice(4)}`, shopName: 'Shop xoá', region: 'VN' };
    },
  }),
);
afterAll(() => resetAdapters());

/** Handler không được chạm tới cổng sản phẩm khi gian hàng đã mất. */
const port = new Proxy({} as ProductPort, {
  get: () => {
    throw new Error('không được gọi cổng sản phẩm');
  },
});

/** Gian hàng đã ngắt rồi xoá qua route; trả công ty, id gian hàng, id listing, id thư đã xoá cùng nó. */
async function deletedShop() {
  const company = await createCompany({ optionalModules: ['channel'] });
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
  const res = await auth(request(testApp()).post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  const shopId = res.body.shop.id as string;
  const db = testPool();
  const { rows } = await db.query<{ version: number }>(
    `update channel.shops set status = 'disconnected', access_token_enc = null, refresh_token_enc = null, disconnected_at = now(),
       version = version + 1 where id = $1 returning version`,
    [shopId],
  );
  const listing = await db.query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, push_started_at) values ($1, $2, $3, 'SKU-X', 'pushing', now()) returning id`,
    [company.companyId, shopId, randomUUID()],
  );
  const mail = await db.query<{ id: string }>(
    `insert into channel.shop_reauth_mails (company_id, shop_id, stage, deadline, seq) values ($1, $2, 'lost', now(), 1) returning id`,
    [company.companyId, shopId],
  );
  const del = await auth(request(testApp()).delete(`/api/v1/channel/shops/${shopId}`)).send({ confirm: 'XOA', version: rows[0]!.version });
  expect(del.status).toBe(200);
  return { companyId: company.companyId, shopId, listingId: listing.rows[0]!.id, mailId: mail.rows[0]!.id };
}

describe('việc nền còn chờ của gian hàng đã xoá (#398)', () => {
  it('mọi handler theo gian hàng trả về, không ném', async () => {
    const { companyId, shopId, listingId, mailId } = await deletedShop();
    const job = { companyId, shopId };

    await expect(runOrderPull(job)).resolves.toBeUndefined();
    await expect(runOpenOrderPull(job)).resolves.toBeUndefined();
    await expect(runListingSync(port, job)).resolves.toBeUndefined();
    await expect(runStockPush(port, job)).resolves.toBeUndefined();
    await expect(runTokenRefresh(job)).resolves.toBeUndefined();
    await expect(runListingPush(port, { ...job, listingId, imageUrls: [] })).resolves.toBeUndefined();
    await expect(runRemoteSkusRefresh(job, { attempt: 1, lastAttempt: false })).resolves.toBeUndefined();
    await expect(
      withCompany(companyId, () =>
        handleReauthMail({
          eventId: randomUUID(),
          type: 'channel.shop_reauth_mail',
          companyId,
          aggregateId: shopId,
          occurredAt: new Date().toISOString(),
          payload: { mailId, shopId },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
