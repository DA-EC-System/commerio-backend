import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { listingArchiveBlockers, listingPresenceOf } from '#src/modules/channel/index.ts';
import type { ListingStatus } from '#src/modules/channel/channel/domain/listing.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// Lý do chặn lưu trữ SKU phần sàn (#204, Documents/21 §17.3): listing đang đẩy lên sàn.
let companyId: string;
let shopId: string;
beforeAll(async () => {
  companyId = (await createCompany({ optionalModules: ['channel'] })).companyId;
  shopId = await newShop();
});

const newShop = async () => {
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop Thử') returning id`,
    [companyId, randomUUID()],
  );
  return rows[0]!.id;
};

const listing = async (variantId: string, status: ListingStatus, shop = shopId) => {
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku, reject_reason)
     values ($1, $2, $3, $4::channel.listing_status, $5, case when $4::text = 'rejected' then 'Sai danh mục' end)`,
    [companyId, shop, variantId, status, `CMR-${randomUUID().slice(0, 8)}`],
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

// Hiện diện trên sàn cho nhãn của catalog (#204 D8): live > error > pending > not_listed, `listingCount` bỏ dòng đã gỡ.
describe('listingPresenceOf (#204)', () => {
  it('gộp listing của SKU trên mọi gian hàng; Map đủ mọi id', async () => {
    const other = await newShop();
    const liveWithError = (await createVariant(companyId)).variantId;
    const onlyRejected = (await createVariant(companyId)).variantId;
    const onlyDelisted = (await createVariant(companyId)).variantId;
    const none = (await createVariant(companyId)).variantId;
    await listing(liveWithError, 'live');
    await listing(liveWithError, 'rejected', other);
    await listing(onlyRejected, 'rejected');
    await listing(onlyDelisted, 'delisted');
    await listing(onlyDelisted, 'delisted');

    const result = await withCompany(companyId, () => listingPresenceOf([liveWithError, onlyRejected, onlyDelisted, none]));
    expect(result).toEqual(
      new Map([
        [liveWithError, { presence: 'live', hasListingError: true, listingCount: 2 }],
        [onlyRejected, { presence: 'error', hasListingError: true, listingCount: 1 }],
        [onlyDelisted, { presence: 'not_listed', hasListingError: false, listingCount: 0 }],
        [none, { presence: 'not_listed', hasListingError: false, listingCount: 0 }],
      ]),
    );
  });

  it('listing chỉ `hidden` không tính là live nhưng vẫn đếm', async () => {
    const hidden = (await createVariant(companyId)).variantId;
    await listing(hidden, 'hidden');
    const result = await withCompany(companyId, () => listingPresenceOf([hidden]));
    expect(result.get(hidden)).toEqual({ presence: 'not_listed', hasListingError: false, listingCount: 1 });
  });

  it('danh sách rỗng trả Map rỗng', async () => {
    expect(await withCompany(companyId, () => listingPresenceOf([]))).toEqual(new Map());
  });
});
