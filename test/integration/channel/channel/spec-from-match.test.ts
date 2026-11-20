// Ghép SKU dựng spec từ category trên sàn (#400 lát 12, Documents/19 mục 3.3): việc nền `channel.spec_from_match` đọc
// category và attribute của sản phẩm trên sàn (ngoài giao dịch), luôn ghi `listings.external_category_id` (không tăng
// `version`), sản phẩm chưa có spec của sàn thì tạo spec `source = 'match'`, `version = 1`, trục `__custom`, attribute đổi sang
// mã lựa chọn của leaf; spec có sẵn giữ nguyên. Việc xếp cùng giao dịch ghép (ghép tay có hiệu lực, CEO duyệt, thiết lập).
import { randomInt, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { replaceLeaf } from '#src/modules/channel/channel/repository/platform-categories.ts';
import { MarketplaceError, type RemoteProductCategory } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, type ProductPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { runSpecFromMatch, sendSpecFromMatch } from '#src/modules/channel/channel/service/spec-from-match.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { withCompany } from '#src/shared/db/client.ts';
import request from 'supertest';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const variants: ListingVariant[] = [];
const port: ProductPort = {
  variants: async (ids, opts) => variants.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  productImageUrls: async () => new Map(),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 5])),
};
setProductPort(port);

const leaf = String(randomInt(800_000_000, 900_000_000));
const attr = (code: string, input: PlatformAttribute['input'], options: { id: string; label: string }[], extra: Partial<PlatformAttribute> = {}): PlatformAttribute => ({
  code,
  label: code,
  kind: 'property',
  input,
  options,
  allowCustom: false,
  required: false,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw: {},
  ...extra,
});
const remote = new Map<string, RemoteProductCategory>();
const productCategory = vi.fn(async (_t: string, externalProductId: string) => remote.get(externalProductId) ?? null);
registerAdapter(
  'lazada',
  fakeAdapter({
    getSeller: async (accessToken) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' }),
    categoriesNeedToken: false,
    productCategory,
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

let companyId: string;
let shopId: string;

function variant(attributes: ListingVariant['attributes'] = []) {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Bình giữ nhiệt',
    sku: `SM-${randomUUID().slice(0, 8)}`,
    attributesLabel: '',
    productCode: 'SP-TEST',
    attributes,
    archived: false,
    businessStatus: 'selling',
    description: null,
    weightG: 200,
    lengthMm: 100,
    widthMm: 100,
    heightMm: 100,
  };
  variants.push(v);
  return v;
}
async function listing(variantId: string | null, externalProductId: string | null) {
  const id = randomUUID().slice(0, 8);
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, mode, external_sku_id, external_product_id, seller_sku, status, content_source, approved_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'live', 'platform', $8) returning id`,
    [companyId, shopId, variantId, variantId ? 'mapped' : 'unmanaged', `sku-${id}`, externalProductId, `LZ-${id}`, variantId ? null : randomUUID()],
  );
  return rows[0]!.id;
}
const run = (listingIds: string[]) => runSpecFromMatch(port, { companyId, shopId, listingIds });
const specOf = async (productId: string) =>
  (await testPool().query('select * from channel.product_specs where product_id = $1 and platform = $2', [productId, 'lazada'])).rows[0];
const listingRow = async (id: string) => (await testPool().query('select external_category_id, version from channel.listings where id = $1', [id])).rows[0];

beforeAll(async () => {
  await testPool().query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at)
     values ('lazada', $1, 'Bình', true, 'Nhà cửa > Bình', 'nha cua > binh', now())`,
    [leaf],
  );
  await replaceLeaf('lazada', leaf, {
    attributes: [
      attr('material', 'select', [{ id: '11', label: 'Thép không gỉ' }], { raw: { options: [{ id: 11, name: 'Thép không gỉ', en_name: 'Stainless Steel' }] } }),
      attr('features', 'multiselect', [
        { id: '21', label: 'Giữ nhiệt' },
        { id: '22', label: 'Chống tràn' },
      ]),
      attr('capacity', 'text', []),
      attr('brand', 'select', [{ id: '1', label: 'No Brand' }], { tier: 'product' }),
      attr('color_family', 'select', [{ id: '31', label: 'Trắng' }], { kind: 'sales' }),
    ],
    sizeChartRule: null,
    fetchedAt: new Date(),
  });
  const c = await createCompany({ optionalModules: [] });
  companyId = c.companyId;
  const shop = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${c.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = shop.body.shop.id;
  await activateShop(shopId);
});

beforeEach(() => productCategory.mockClear());

describe('runSpecFromMatch', () => {
  it('chưa có spec: tạo spec match version 1, attribute category đổi sang mã lựa chọn, trục __custom; ghi external_category_id không tăng version', async () => {
    const v = variant([{ attributeId: 'A-COLOR', attributeName: 'Màu', valueId: 'V1', value: 'Trắng' }]);
    remote.set('item-1', {
      externalCategoryId: leaf,
      attributes: [
        { code: 'material', values: [{ id: null, name: 'Stainless Steel' }] },
        { code: 'features', values: [{ id: null, name: 'Giữ nhiệt' }, { id: null, name: 'Chống tràn' }] },
        { code: 'capacity', values: [{ id: null, name: '750ml' }] },
        { code: 'brand', values: [{ id: null, name: 'No Brand' }] },
        { code: 'color_family', values: [{ id: null, name: 'Trắng' }] },
        { code: 'khong_co', values: [{ id: null, name: 'x' }] },
      ],
    });
    const id = await listing(v.id, 'item-1');
    const before = (await listingRow(id)).version;
    await run([id]);
    const spec = await specOf(v.productId);
    expect(spec).toMatchObject({
      external_category_id: leaf,
      source: 'match',
      version: 1,
      attributes: { material: '11', features: ['21', '22'], capacity: '750ml' },
      axis_map: { 'A-COLOR': '__custom' },
      value_map: {},
      category_status: 'ok',
    });
    expect(await listingRow(id)).toEqual({ external_category_id: leaf, version: before });
  });

  it('spec có sẵn: giữ nguyên, vẫn ghi external_category_id', async () => {
    const v = variant();
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, attributes, source, version)
       values ($1, $2, 'lazada', 'OTHER', '{"a":"b"}', 'push', 3)`,
      [companyId, v.productId],
    );
    remote.set('item-2', { externalCategoryId: leaf, attributes: [{ code: 'material', values: [{ id: null, name: 'Stainless Steel' }] }] });
    const id = await listing(v.id, 'item-2');
    await run([id]);
    expect(await specOf(v.productId)).toMatchObject({ external_category_id: 'OTHER', version: 3, attributes: { a: 'b' }, source: 'push' });
    expect((await listingRow(id)).external_category_id).toBe(leaf);
  });

  it('nhiều listing cùng sản phẩm sàn: gọi sàn một lần; listing "không quản tồn" chỉ ghi cột; listing chưa có mã sàn bỏ qua', async () => {
    const v = variant();
    remote.set('item-3', { externalCategoryId: leaf, attributes: [] });
    const a = await listing(v.id, 'item-3');
    const b = await listing(null, 'item-3');
    const c = await listing(variant().id, null);
    await run([a, b, c]);
    expect(productCategory).toHaveBeenCalledTimes(1);
    expect((await listingRow(b)).external_category_id).toBe(leaf);
    expect((await listingRow(c)).external_category_id).toBeNull();
    expect(await specOf(v.productId)).toMatchObject({ source: 'match', attributes: {} });
  });

  it('sàn không trả category: không ghi gì; sàn lỗi tạm: ném để thử lại', async () => {
    const v = variant();
    const id = await listing(v.id, 'item-none');
    await run([id]);
    expect(await specOf(v.productId)).toBeUndefined();
    productCategory.mockRejectedValueOnce(new MarketplaceError('unavailable'));
    await expect(run([id])).rejects.toBeInstanceOf(MarketplaceError);
  });

  it('sàn từ chối (vd sản phẩm đã xoá): bỏ qua listing đó, không ném', async () => {
    const v = variant();
    const id = await listing(v.id, 'item-gone');
    productCategory.mockRejectedValueOnce(new MarketplaceError('rejected', '207'));
    await expect(run([id])).resolves.toBeUndefined();
  });
});

describe('sendSpecFromMatch', () => {
  it('xếp việc mang danh sách listing, đi chung giao dịch: rollback thì không có việc', async () => {
    const id = randomUUID();
    await withCompany(companyId, () => sendSpecFromMatch(companyId, shopId, [id]));
    await withCompany(companyId, async () => {
      await sendSpecFromMatch(companyId, shopId, [randomUUID()]);
      throw new Error('rollback');
    }).catch(() => {});
    const { rows } = await testPool().query<{ data: { listingIds: string[] } }>(
      "select data from pgboss.job where name = 'channel.spec_from_match' and data->>'shopId' = $1",
      [shopId],
    );
    expect(rows.map((r) => r.data.listingIds)).toEqual([[id]]);
  });
});
