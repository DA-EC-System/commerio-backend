import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { listingArchiveBlockers } from '#src/modules/channel/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// Lý do chặn lưu trữ SKU phần sàn (#204, Documents/21 §17.3): listing đang đẩy lên sàn.
let companyId: string;
let shopId: string;
beforeAll(async () => {
  companyId = (await createCompany({ optionalModules: ['channel'] })).companyId;
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop Thử') returning id`,
    [companyId, randomUUID()],
  );
  shopId = rows[0]!.id;
});

const listing = async (variantId: string, status: 'pushing' | 'live') => {
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku)
     values ($1, $2, $3, $4::channel.listing_status, $5)`,
    [companyId, shopId, variantId, status, `CMR-${randomUUID().slice(0, 8)}`],
  );
};

describe('listingArchiveBlockers (#204)', () => {
  it('listing đang đẩy lên sàn chặn lưu trữ; listing live không tính', async () => {
    const pushing = (await createVariant(companyId)).variantId;
    const live = (await createVariant(companyId)).variantId;
    await listing(pushing, 'pushing');
    await listing(live, 'live');
    const result = await withCompany(companyId, () => listingArchiveBlockers([pushing, live]));
    expect(result).toEqual(new Map([[pushing, ['Còn 1 listing đang đẩy lên sàn']]]));
  });
});
