// `returnPoliciesOf` cho sales tính hạn trả theo gian hàng (commerio-backend#236, #390).
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { returnPoliciesOf } from '#src/modules/channel/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';

async function shop(companyId: string, platform: string, days: number | null, status = 'connecting'): Promise<string> {
  const r = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, return_window_days)
     values ($1, $2, $3, 'Shop thử', $4, $5) returning id`,
    [companyId, platform, randomUUID(), status, days],
  );
  return r.rows[0]!.id;
}

describe('returnPoliciesOf (#236)', () => {
  const a = randomUUID();
  const b = randomUUID();
  let lazada15: string, lazadaNull: string, tiktok: string, disconnected: string, other: string;

  beforeAll(async () => {
    lazada15 = await shop(a, 'lazada', 15);
    lazadaNull = await shop(a, 'lazada', null);
    tiktok = await shop(a, 'tiktok', null);
    disconnected = await shop(a, 'lazada', 10, 'disconnected');
    other = await shop(b, 'lazada', 20);
  });

  it('trả cách tính hạn của sàn và số ngày đã lưu, kể cả gian hàng đã ngắt', async () => {
    const map = await withCompany(a, () => returnPoliciesOf([lazada15, lazadaNull, tiktok, disconnected]));

    expect(map.get(lazada15)).toEqual({ returnWindow: 'days', returnWindowDays: 15 });
    expect(map.get(lazadaNull)).toEqual({ returnWindow: 'days', returnWindowDays: null });
    expect(map.get(tiktok)).toEqual({ returnWindow: 'platform_status', returnWindowDays: null });
    expect(map.get(disconnected)).toEqual({ returnWindow: 'days', returnWindowDays: 10 });
  });

  it('gian hàng của công ty khác và id lạ vắng mặt', async () => {
    const map = await withCompany(a, () =>
      returnPoliciesOf([lazada15, lazadaNull, tiktok, disconnected, other, randomUUID()]),
    );

    expect([...map.keys()].sort()).toEqual([lazada15, lazadaNull, tiktok, disconnected].sort());
  });

  it('danh sách rỗng: Map rỗng', async () => {
    const map = await withCompany(a, () => returnPoliciesOf([]));

    expect(map.size).toBe(0);
  });
});
