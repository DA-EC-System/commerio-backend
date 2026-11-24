import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductPage } from '#src/modules/product/catalog/api/schemas.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { type AttributeBody, api, archiveSku, createAttribute, createGroup, createProduct, uniq, valueId } from './helpers.ts';

// Độ phủ sàn ở danh sách sản phẩm (FE#464): mỗi gian hàng chưa ngắt một phần tử, `listed` như readiness, `missing` còn thiếu.
let companyId: string;
let token: string;
let color: AttributeBody;
let shopA: string;
let shopB: string;
let shopOff: string;

const newShop = async (shopName: string, displayName: string | null = null, status = 'active') => {
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, display_name, status, order_cutoff_at)
     values ($1, 'lazada', $2, $3, $4, $5::channel.shop_status, now()) returning id`,
    [companyId, randomUUID(), shopName, displayName, status],
  );
  return rows[0]!.id;
};

const listing = (variantId: string, status: string, shop: string) =>
  testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku, reject_reason)
     values ($1, $2, $3, $4::channel.listing_status, $5, case when $4::text = 'rejected' then 'Sai danh mục' end)`,
    [companyId, shop, variantId, status, `CMR-${randomUUID().slice(0, 8)}`],
  );

beforeAll(async () => {
  const company = await createCompany({ optionalModules: [] });
  companyId = company.companyId;
  token = company.ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng', 'Xám', 'Nâu']);
  shopA = await newShop('Shop A', 'Đùi Gà Store');
  shopB = await newShop('Shop B');
  shopOff = await newShop('Shop ngắt', null, 'disconnected');
});

async function product(n: number, name = uniq('SP')) {
  const group = await createGroup(token, uniq('Phủ'), 'PH-{SEQ}-{VAL}');
  const colors = ['Đen', 'Trắng', 'Xám', 'Nâu'].slice(0, n);
  return createProduct(token, { name, groupId: group.id, variants: colors.map((c) => [valueId(color, c)]) });
}

const listItem = async (t: string, name: string) => {
  const res = await api(t).get(`/products?search=${encodeURIComponent(name)}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(ProductPage.parse(res.body)).toEqual(res.body);
  return res.body.items.find((i: { name: string }) => i.name === name);
};

describe('GET /products: channelCoverage', () => {
  it('đếm theo gian hàng chưa ngắt; listing lỗi, đã gỡ không tính; SKU lưu trữ không tính; tên hiển thị thay tên sàn', async () => {
    const p = await product(4);
    const [v1, v2, v3, v4] = p.variants.map((v: { id: string }) => v.id);
    await listing(v1!, 'live', shopA);
    await listing(v2!, 'under_review', shopA);
    await listing(v3!, 'hidden', shopA);
    await listing(v4!, 'live', shopA);
    await listing(v1!, 'pushing', shopB);
    await listing(v2!, 'push_failed', shopB);
    await listing(v3!, 'delisted', shopB);
    await listing(v1!, 'live', shopOff);
    await archiveSku(token, p.id, v4!);

    const item = await listItem(token, p.name);
    expect(item.variantCount).toBe(3);
    expect(item.channelCoverage).toEqual([
      { shopId: shopA, shopName: 'Đùi Gà Store', platform: 'lazada', listed: 3, missing: 0 },
      { shopId: shopB, shopName: 'Shop B', platform: 'lazada', listed: 1, missing: 2 },
    ]);
  });

  it('sản phẩm chưa đăng đâu: mỗi gian hàng còn đủ số SKU', async () => {
    const p = await product(2);
    expect((await listItem(token, p.name)).channelCoverage).toEqual([
      expect.objectContaining({ shopId: shopA, listed: 0, missing: 2 }),
      expect.objectContaining({ shopId: shopB, listed: 0, missing: 2 }),
    ]);
  });

  it('không có `channel.shop.view`: mảng rỗng', async () => {
    const p = await product(1);
    await listing(p.variants[0]!.id, 'live', shopA);
    const role = await createCustomRole(companyId, ['catalog.product.view']);
    const viewer = (await addMember(companyId, role)).token;
    expect((await listItem(viewer, p.name)).channelCoverage).toEqual([]);
  });

  it('công ty chưa có gian hàng: mảng rỗng', async () => {
    const other = await createCompany({ optionalModules: [] });
    const attr = await createAttribute(other.ceo.token, 'Màu', ['Đen']);
    const group = await createGroup(other.ceo.token, uniq('Phủ'), 'PX-{SEQ}-{VAL}');
    const name = uniq('SP');
    await createProduct(other.ceo.token, { name, groupId: group.id, variants: [[valueId(attr, 'Đen')]] });
    expect((await listItem(other.ceo.token, name)).channelCoverage).toEqual([]);
  });
});
