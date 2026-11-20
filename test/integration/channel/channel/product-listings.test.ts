// Listing của một sản phẩm ở mọi gian hàng cho trang sản phẩm (#467 PR2; Documents/21 §18.5
// `GET /channel/products/:productId/listings`, US-SP-11).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductListingListWithSeparate } from '#src/modules/channel/channel/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

const db = () => testPool();
const get = (token: string, productId: string) =>
  request(testApp()).get(`/api/v1/channel/products/${productId}/listings`).set('Authorization', `Bearer ${token}`);

async function shop(companyId: string, name: string, status: 'active' | 'disconnected') {
  const { rows } = await db().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at)
     values ($1, 'lazada', $2, $3, $4, now()) returning id`,
    [companyId, randomUUID(), name, status],
  );
  return rows[0]!.id;
}

let c: Awaited<ReturnType<typeof createCompany>>;
let first: string;
let second: string;
let main: Awaited<ReturnType<typeof createVariant>>;
let sibling: string;
let archived: string;
let other: Awaited<ReturnType<typeof createVariant>>;

beforeAll(async () => {
  c = await createCompany();
  // Thứ tự tạo quyết định thứ tự gian hàng trong kết quả.
  first = await shop(c.companyId, 'Shop A', 'active');
  second = await shop(c.companyId, 'Shop B', 'active');
  await shop(c.companyId, 'Shop đã ngắt', 'disconnected');
  main = await createVariant(c.companyId);
  const { rows } = await db().query<{ id: string }>(
    `insert into product.product_variants (company_id, product_id, sku) values ($1, $2, $3) returning id`,
    [c.companyId, main.productId, `${main.sku}-B`],
  );
  sibling = rows[0]!.id;
  const { rows: arch } = await db().query<{ id: string }>(
    `insert into product.product_variants (company_id, product_id, sku, business_status, archived_at)
     values ($1, $2, $3, 'archived', now()) returning id`,
    [c.companyId, main.productId, `${main.sku}-X`],
  );
  archived = arch[0]!.id;
  other = await createVariant(c.companyId);
  await db().query(
    `insert into channel.listings (company_id, shop_id, variant_id, status, external_product_id, external_sku_id, external_category_id)
     values ($1, $2, $3, 'live', 'item-1', 'sku-1', '10001'), ($1, $2, $4, 'live', 'item-2', 'sku-2', null)`,
    [c.companyId, first, main.variantId, other.variantId],
  );
});

describe('listing theo sản phẩm', () => {
  it('mỗi biến thể chưa lưu trữ × mỗi gian hàng chưa ngắt, xếp theo gian hàng rồi biến thể; thân khớp ProductListingListWithSeparate', async () => {
    const res = await get(c.ceo.token, main.productId);
    expect(res.status).toBe(200);
    const { items } = ProductListingListWithSeparate.parse(res.body);
    expect(items.map((i) => [i.shopName, i.variantId])).toEqual(
      expect.arrayContaining([
        ['Shop A', main.variantId],
        ['Shop A', sibling],
        ['Shop B', main.variantId],
        ['Shop B', sibling],
      ]),
    );
    expect(items).toHaveLength(4);
    expect(items.slice(0, 2).every((i) => i.shopId === first) && items.slice(2).every((i) => i.shopId === second)).toBe(true);
    expect(items.some((i) => i.variantId === archived || i.variantId === other.variantId)).toBe(false);
    expect(items.every((i) => i.platform === 'lazada' && i.productId === main.productId)).toBe(true);
  });

  it('dòng có listing mang listing và category trên sàn; dòng chưa lên sàn listing null', async () => {
    const { items } = ProductListingListWithSeparate.parse((await get(c.ceo.token, main.productId)).body);
    const live = items.find((i) => i.shopId === first && i.variantId === main.variantId)!;
    expect(live.listing).toMatchObject({ status: 'live', externalProductId: 'item-1', externalSkuId: 'sku-1' });
    expect(live.externalCategoryId).toBe('10001');
    const none = items.find((i) => i.shopId === second && i.variantId === main.variantId)!;
    expect(none).toMatchObject({ listing: null, externalCategoryId: null, categoryChange: null, specStatus: 'missing' });
  });

  it('sản phẩm không có, của công ty khác, hoặc id sai dạng → 404 not_found', async () => {
    const b = await createCompany();
    const foreign = await createVariant(b.companyId);
    for (const id of [randomUUID(), foreign.productId, 'abc']) {
      const res = await get(c.ceo.token, id);
      expect(res.status).toBe(404);
      expect(res.body.type).toContain('not_found');
    }
  });

  it('Sale (có channel.shop.view) đọc được; thân không có trường giá vốn', async () => {
    const sale = (await addMember(c.companyId, 'sale')).token;
    const res = await get(sale, main.productId);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/avgCost|floorPrice|cost"/);
  });
});
