import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';
import { receive } from '../inventory/helpers.ts';
import { createRequest, createSupplier } from '../purchasing/helpers.ts';
import { type AttributeBody, api, auditOf, createAttribute, createCategory, createProduct, type ProductBody, uniq, valueId } from './helpers.ts';

// Xoá hẳn sản phẩm (#204 spec mục 6, Documents/21 §17.2): chỉ khi mọi SKU chờ hoàn thiện, chưa dùng ở module nào, không
// sinh từ đề nghị nhập. Review Focus 3: sản phẩm đã dùng ở bất kỳ nguồn nào thì 409 và không xoá gì.
let companyId: string;
let token: string;
let color: AttributeBody;
beforeAll(async () => {
  const company = await createCompany({ optionalModules: ['channel', 'purchasing'] });
  companyId = company.companyId;
  token = company.ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng']);
});

async function product(): Promise<ProductBody> {
  const category = await createCategory(token, uniq('Xoá'), 'XH-{SEQ}-{VAL}');
  return createProduct(token, {
    name: uniq('SP xoá'),
    categoryId: category.id,
    variants: [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]],
  });
}

const remove = (p: { id: string }, version = 1) => api(token).delete(`/products/${p.id}?version=${version}`);

/** Số dòng còn lại của sản phẩm ở mọi bảng catalog và dòng tồn của SKU. */
async function rowsOf(p: ProductBody) {
  const ids = p.variants.map((v) => v.id);
  const { rows } = await testPool().query<Record<string, number>>(
    `select
       (select count(*)::int from product.products where id = $1) as products,
       (select count(*)::int from product.product_variants where product_id = $1) as variants,
       (select count(*)::int from product.variant_attribute_values where variant_id = any($2::uuid[])) as values,
       (select count(*)::int from product.product_images where product_id = $1) as images,
       (select count(*)::int from product.stock_levels where variant_id = any($2::uuid[])) as levels`,
    [p.id, ids],
  );
  return rows[0]!;
}

const expectInUse = async (p: ProductBody) => {
  const res = await remove(p);
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.type).toBe('/problems/product_in_use');
  expect((await rowsOf(p)).products).toBe(1);
  expect((await rowsOf(p)).variants).toBe(2);
};

describe('DELETE /catalog/products/:id (#204, xoá hẳn)', () => {
  it('sản phẩm chờ hoàn thiện chưa dùng → 204, hết dòng ở mọi bảng catalog và dòng tồn; nhật ký delete', async () => {
    const p = await product();
    const fileId = randomUUID();
    await testPool().query('insert into product.product_images (company_id, product_id, file_id, position) values ($1, $2, $3, 0)', [
      companyId,
      p.id,
      fileId,
    ]);
    await testPool().query('insert into product.stock_levels (company_id, variant_id, min_qty) values ($1, $2, 5)', [
      companyId,
      p.variants[0]!.id,
    ]);
    const res = await remove(p);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await rowsOf(p)).toEqual({ products: 0, variants: 0, values: 0, images: 0, levels: 0 });
    expect((await api(token).get(`/products/${p.id}`)).status).toBe(404);
    const deleted = (await auditOf(p.id)).find((r) => r.action === 'delete');
    expect(deleted).toMatchObject({ entity_type: 'product.products', before: { name: p.name, code: p.code, imageFileIds: [fileId] } });
  });

  it('sản phẩm có ảnh phân loại → 204, bảng ảnh phân loại không còn dòng của sản phẩm, tệp còn (#340, AC-S7)', async () => {
    const p = await product();
    await testPool().query('update product.products set image_attribute_id = $2 where id = $1', [p.id, color.id]);
    const fileId = randomUUID();
    await testPool().query(
      `insert into core.files (id, company_id, storage_key, file_name, content_type, size_bytes, purpose, uploaded_at)
       values ($1, $2, $3, 'anh.png', 'image/png', 2048, 'product_image', now())`,
      [fileId, companyId, `test/${fileId}.png`],
    );
    await testPool().query(
      `insert into product.product_attribute_value_images (company_id, product_id, attribute_id, attribute_value_id, file_id)
       values ($1, $2, $3, $4, $5)`,
      [companyId, p.id, color.id, valueId(color, 'Đen'), fileId],
    );
    const res = await remove(p);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    const { rows } = await testPool().query('select 1 from product.product_attribute_value_images where product_id = $1', [p.id]);
    expect(rows).toHaveLength(0);
    expect((await rowsOf(p)).products).toBe(0);
    expect((await testPool().query('select 1 from core.files where id = $1', [fileId])).rowCount).toBe(1);
  });

  it('có một SKU đã hoàn thiện → 409 product_in_use', async () => {
    const p = await product();
    await testPool().query('insert into product.product_images (company_id, product_id, file_id, position) values ($1, $2, $3, 0)', [
      companyId,
      p.id,
      randomUUID(),
    ]);
    const patched = await api(token).patch(`/products/${p.id}/variants/${p.variants[0]!.id}`, {
      version: 1,
      targetNetPrice: 150000,
      weightG: 200,
      lengthMm: 100,
      widthMm: 100,
      heightMm: 50,
    });
    expect(patched.status).toBe(200);
    await testPool().query('insert into product.stock_levels (company_id, variant_id, min_qty) values ($1, $2, 3)', [
      companyId,
      p.variants[0]!.id,
    ]);
    await expectInUse(p);
  });

  it('SKU có thẻ kho → 409 (nguồn inventory)', async () => {
    const p = await product();
    await receive(companyId, p.variants[0]!.id, 1, 100000);
    await expectInUse(p);
  });

  it('SKU có trên đề nghị nhập nháp → 409 (nguồn purchasing)', async () => {
    const p = await product();
    const supplier = await createSupplier(token);
    await createRequest(token, supplier.id, [{ variantId: p.variants[1]!.id, quantity: 1, unitCost: 1000 }]);
    await expectInUse(p);
  });

  it('SKU có trên đơn → 409 (nguồn order)', async () => {
    const p = await product();
    await createOrder(companyId, { lines: [{ variantId: p.variants[0]!.id, quantity: 1, unitPrice: 100000 }] });
    await expectInUse(p);
  });

  it('SKU chỉ có ở listing chờ duyệt ghép → 409 (nguồn channel)', async () => {
    const p = await product();
    const shop = await testPool().query<{ id: string }>(
      `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop Thử') returning id`,
      [companyId, randomUUID()],
    );
    const mapped = (await createVariant(companyId)).variantId;
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku,
         pending_variant_id, pending_mode, pending_requested_by, pending_requested_at)
       values ($1, $2, $3, 'live', $4, $5, 'mapped', $6, now())`,
      [companyId, shop.rows[0]!.id, mapped, `CMR-${randomUUID().slice(0, 8)}`, p.variants[1]!.id, randomUUID()],
    );
    await expectInUse(p);
  });

  it('SKU sinh từ đề nghị nhập → 409', async () => {
    const p = await product();
    await testPool().query('update product.product_variants set source_request_line_id = $2 where id = $1', [
      p.variants[0]!.id,
      randomUUID(),
    ]);
    await expectInUse(p);
  });

  it('sai version → 409 version_conflict kèm current; thiếu version → 422', async () => {
    const p = await product();
    const res = await remove(p, 7);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(res.body.current).toMatchObject({ id: p.id, version: 1 });
    expect((await api(token).delete(`/products/${p.id}`)).status).toBe(422);
    expect((await rowsOf(p)).products).toBe(1);
  });
});
