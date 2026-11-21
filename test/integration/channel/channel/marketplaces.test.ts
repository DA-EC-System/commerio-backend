// Danh mục sàn `channel.marketplaces` thay enum sàn (Documents/19 mục 3.3, 21/11/2026).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { listMarketplaces } from '#src/modules/channel/channel/repository/marketplaces.ts';
import { verifyMarketplaces } from '#src/modules/channel/channel/service/marketplace-check.ts';
import { testPool } from '../../helpers/db.ts';

describe('channel.marketplaces', () => {
  it('migration chèn đủ sàn, khớp registry adapter (worker khởi động không dừng)', async () => {
    expect(await listMarketplaces()).toEqual([
      { code: 'lazada', enabled: true },
      { code: 'mock', enabled: false },
      { code: 'shopee', enabled: false },
      { code: 'tiktok', enabled: true },
    ]);
    await expect(verifyMarketplaces()).resolves.toBeUndefined();
  });

  it('khoá ngoại chặn mã sàn không có trong danh mục', async () => {
    const err = await testPool()
      .query("insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'khong-co', $2, 'Shop')", [
        randomUUID(),
        randomUUID(),
      ])
      .catch((e: { code?: string; constraint?: string }) => e);
    expect(err).toMatchObject({ code: '23503', constraint: 'shops_platform_fk' });
  });

  it('kênh liên lạc của người mua: sàn phải có mã sàn, kênh khác không có', async () => {
    const insert = (source: string, platform: string | null) =>
      testPool()
        .query(
          `insert into "order".customer_identities (company_id, customer_id, source, platform, external_user_id)
           values ($1, $2, $3, $4, 'u1')`,
          [randomUUID(), randomUUID(), source, platform],
        )
        .catch((e: { code?: string; constraint?: string }) => e);
    expect(await insert('marketplace', null)).toMatchObject({ code: '23514', constraint: 'customer_identities_platform' });
    expect(await insert('messenger', 'lazada')).toMatchObject({ code: '23514', constraint: 'customer_identities_platform' });
  });
});
