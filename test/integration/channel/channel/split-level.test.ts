// Mức tách kiện của gian hàng cho fulfillment (spec 205 D6, §5.3): đọc `capabilities.splitLevel` theo sàn của gian hàng.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { marketplaceSplitLevel } from '#src/modules/channel/index.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

async function shop(companyId: string, platform: 'lazada' | 'tiktok'): Promise<string> {
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, $2, $3, 'Shop Thử') returning id`,
    [companyId, platform, randomUUID()],
  );
  return rows[0]!.id;
}

describe('marketplaceSplitLevel', () => {
  it('Lazada là unit, TikTok là sku', async () => {
    const { companyId } = await createCompany();
    const lazadaId = await shop(companyId, 'lazada');
    const tiktokId = await shop(companyId, 'tiktok');

    expect(await marketplaceSplitLevel(companyId, lazadaId)).toBe('unit');
    expect(await marketplaceSplitLevel(companyId, tiktokId)).toBe('sku');
  });

  it('gian hàng không có, id sai dạng hoặc của công ty khác là none', async () => {
    const { companyId } = await createCompany();
    const other = await createCompany();
    const lazadaId = await shop(companyId, 'lazada');

    expect(await marketplaceSplitLevel(companyId, randomUUID())).toBe('none');
    expect(await marketplaceSplitLevel(companyId, 'khong-phai-uuid')).toBe('none');
    expect(await marketplaceSplitLevel(other.companyId, lazadaId)).toBe('none');
  });
});
