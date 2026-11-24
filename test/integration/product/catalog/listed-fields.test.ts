import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BulkSaveResult } from '#src/modules/product/catalog/api/schemas.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { type AttributeBody, api, createAttribute, createGroup, createProduct, uniq, valueId } from './helpers.ts';

// SKU còn listing chưa gỡ thì không xoá trống trường bắt buộc chung (#204, review #345; US-SP-03 dòng 7, Documents/25
// §5.1, §5.2; Documents/21 §17.4 `listing_field_required`). Trường của SKU xét listing của chính SKU; ảnh xét mọi SKU.
let companyId: string;
let token: string;
let color: AttributeBody;
let shop: string;

beforeAll(async () => {
  const company = await createCompany({ optionalModules: [] });
  companyId = company.companyId;
  token = company.ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng']);
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop Thử') returning id`,
    [companyId, randomUUID()],
  );
  shop = rows[0]!.id;
});

const FULL = { targetNetPrice: 150000, weightG: 200, lengthMm: 100, widthMm: 100, heightMm: 50 };

/** Sản phẩm hai SKU (Đen, Trắng), SKU đã đủ giá muốn bán và số đo (`version` SKU = 2). */
async function product() {
  const group = await createGroup(token, uniq('Listing'), 'LS-{SEQ}-{VAL}');
  const p = await createProduct(token, {
    name: uniq('SP'),
    groupId: group.id,
    variants: [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]],
  });
  for (const v of p.variants) {
    const res = await patch(p.id, v.id, { version: 1, ...FULL });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return p;
}

const patch = (productId: string, variantId: string, body: object) =>
  api(token).patch(`/products/${productId}/variants/${variantId}`, body);

const listing = (variantId: string, status = 'live') =>
  testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku) values ($1, $2, $3, $4::channel.listing_status, $5)`,
    [companyId, shop, variantId, status, `CMR-${randomUUID().slice(0, 8)}`],
  );

const withImage = (productId: string) =>
  testPool().query('insert into product.product_images (company_id, product_id, file_id, position) values ($1, $2, $3, 0)', [
    companyId,
    productId,
    randomUUID(),
  ]);

const variantRow = async (id: string) =>
  (await testPool().query('select weight_g, target_net_price, height_mm, version from product.product_variants where id = $1', [id])).rows[0];

describe('PATCH SKU: SKU còn listing chưa gỡ (US-SP-03 dòng 7)', () => {
  it('gửi null cho cân nặng, giá muốn bán đang có → 409 listing_field_required kèm errors theo trường, không ghi gì', async () => {
    const p = await product();
    const v = p.variants[0]!;
    await listing(v.id);
    const res = await patch(p.id, v.id, { version: 2, weightG: null, targetNetPrice: null, lengthMm: 120 });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.type).toMatch(/\/listing_field_required$/);
    expect(Object.keys(res.body.errors).sort()).toEqual(['targetNetPrice', 'weightG']);
    expect(await variantRow(v.id)).toMatchObject({ weight_g: 200, target_net_price: '150000.00', version: 2 });
  });

  it('listing đang lỗi (rejected) cũng tính là chưa gỡ: xoá chiều cao → 409', async () => {
    const p = await product();
    const v = p.variants[0]!;
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku, reject_reason)
       values ($1, $2, $3, 'rejected', $4, 'Sai danh mục')`,
      [companyId, shop, v.id, `CMR-${randomUUID().slice(0, 8)}`],
    );
    const res = await patch(p.id, v.id, { version: 2, heightMm: null });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.errors).toEqual({ heightMm: expect.any(String) });
  });

  it('đổi sang số khác, hoặc gửi null cho ô đã trống → 200 (không phải xoá trống)', async () => {
    const p = await product();
    const v = p.variants[0]!;
    await listing(v.id);
    const changed = await patch(p.id, v.id, { version: 2, weightG: 300, standardPrice: null });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await variantRow(v.id)).toMatchObject({ weight_g: 300, version: 3 });
  });

  it('chỉ SKU anh em có listing: SKU này vẫn xoá trống được (mỗi SKU là một sản phẩm trên sàn)', async () => {
    const p = await product();
    await listing(p.variants[0]!.id);
    const res = await patch(p.id, p.variants[1]!.id, { version: 2, weightG: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('listing đã gỡ (delisted) không chặn', async () => {
    const p = await product();
    const v = p.variants[0]!;
    await listing(v.id, 'delisted');
    const res = await patch(p.id, v.id, { version: 2, targetNetPrice: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await variantRow(v.id)).toMatchObject({ target_net_price: null });
  });
});

describe('PATCH /variants/bulk: dòng xoá trống trường của SKU còn listing', () => {
  it('dòng đó lỗi listing_field_required kèm errors, dòng khác vẫn lưu; body khớp BulkSaveResult', async () => {
    const p = await product();
    const [listed, free] = p.variants;
    await listing(listed!.id);
    const res = await api(token).patch('/variants/bulk', {
      rows: [
        { variantId: listed!.id, version: 2, widthMm: null },
        { variantId: free!.id, version: 2, widthMm: null },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(BulkSaveResult.parse(res.body)).toEqual(res.body);
    expect(res.body.saved).toEqual([{ variantId: free!.id, version: 3, reorderVersion: null }]);
    expect(res.body.failed).toEqual([
      { variantId: listed!.id, code: 'listing_field_required', message: expect.any(String), errors: { widthMm: expect.any(String) } },
    ]);
    expect(await variantRow(listed!.id)).toMatchObject({ version: 2 });
  });
});

describe('PUT sản phẩm: gỡ hết ảnh khi còn listing chưa gỡ', () => {
  it('một SKU có listing, gửi imageFileIds rỗng → 409 errors.images, ảnh và version giữ nguyên', async () => {
    const p = await product();
    await withImage(p.id);
    await listing(p.variants[1]!.id);
    const res = await api(token).put(`/products/${p.id}`, { name: p.name, version: p.version, imageFileIds: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.type).toMatch(/\/listing_field_required$/);
    expect(res.body.errors).toEqual({ images: expect.any(String) });
    const { rows } = await testPool().query('select version from product.products where id = $1', [p.id]);
    expect(rows[0]).toEqual({ version: p.version });
    const images = await testPool().query('select 1 from product.product_images where product_id = $1', [p.id]);
    expect(images.rowCount).toBe(1);
  });

  it('không SKU nào có listing → gỡ hết ảnh được; bỏ imageFileIds khi có listing vẫn sửa tên được', async () => {
    const free = await product();
    await withImage(free.id);
    const cleared = await api(token).put(`/products/${free.id}`, { name: free.name, version: free.version, imageFileIds: [] });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.images).toEqual([]);

    const listed = await product();
    await withImage(listed.id);
    await listing(listed.variants[0]!.id);
    const renamed = await api(token).put(`/products/${listed.id}`, { name: uniq('Tên mới'), version: listed.version });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
  });
});
