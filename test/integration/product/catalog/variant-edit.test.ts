import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductDetail } from '#src/modules/product/catalog/api/schemas.ts';
import { getVariants } from '#src/modules/product/catalog/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { type AttributeBody, api, auditOf, createAttribute, createCategory, createProduct, uniq, valueId } from './helpers.ts';

// Sửa một SKU: giá chuẩn, giá muốn bán, cân nặng, kích thước gói (#204, Documents/21 §17.1, §17.2).
let companyId: string;
let token: string;
let color: AttributeBody;
beforeAll(async () => {
  const company = await createCompany();
  companyId = company.companyId;
  token = company.ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng']);
});

/** Sản phẩm một SKU không thuộc tính, danh mục riêng. */
const wallet = async () => {
  const category = await createCategory(token, uniq('Ví'), 'VI-{SEQ}');
  return createProduct(token, { name: uniq('Ví'), categoryId: category.id, variants: [[]] });
};

describe('chi tiết sản phẩm: trường của SKU (#204, Documents/21 §17.1)', () => {
  it('SKU mới có version 1, selling, chưa có giá và số đo; body khớp đúng schema ProductDetail', async () => {
    const product = await wallet();
    const res = await api(token).get(`/products/${product.id}`);
    expect(res.status).toBe(200);
    expect(res.body.variants[0]).toMatchObject({
      version: 1,
      businessStatus: 'selling',
      standardPrice: null,
      targetNetPrice: null,
      weightG: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
    // parse bỏ khoá thừa: bằng nhau là không thừa, không thiếu.
    expect(ProductDetail.parse(res.body)).toEqual(res.body);
  });
});

const patch = (productId: string, variantId: string, body: object) =>
  api(token).patch(`/products/${productId}/variants/${variantId}`, body);
const variantOf = async (productId: string) => (await api(token).get(`/products/${productId}`)).body.variants[0];
const FULL = { weightG: 250, lengthMm: 200, widthMm: 100, heightMm: 30, standardPrice: 180000, targetNetPrice: 150000 };

describe('PATCH /catalog/products/:id/variants/:variantId (#204, Documents/21 §17.2)', () => {
  it('đặt 4 số đo và hai giá → 200 ProductDetail; version SKU tăng, version cha giữ; getVariants thấy số đo', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    const res = await patch(product.id, variantId, { version: 1, ...FULL });
    expect(res.status).toBe(200);
    expect(res.body.variants[0]).toMatchObject({ ...FULL, version: 2 });
    expect(res.body.version).toBe(1);
    expect(ProductDetail.parse(res.body)).toEqual(res.body);
    const [v] = await withCompany(companyId, () => getVariants([variantId]));
    expect(v).toMatchObject({ weightG: 250, lengthMm: 200, widthMm: 100, heightMm: 30 });
  });

  it('bỏ trường là giữ nguyên, null là xoá', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, ...FULL });
    const res = await patch(product.id, variantId, { version: 2, weightG: null });
    expect(res.status).toBe(200);
    expect(res.body.variants[0]).toMatchObject({ ...FULL, weightG: null, version: 3 });
  });

  it('nhật ký update chỉ ghi trường đổi, theo dạng API', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, weightG: 250, targetNetPrice: 150000 });
    expect(await auditOf(variantId)).toEqual([
      {
        action: 'update',
        entity_type: 'product.product_variants',
        before: { weightG: null, targetNetPrice: null },
        after: { weightG: 250, targetNetPrice: 150000 },
      },
    ]);
  });

  it.each([
    ['cân nặng 0', { weightG: 0 }, 'weightG'],
    ['cân nặng âm', { weightG: -1 }, 'weightG'],
    ['chiều dài số lẻ', { lengthMm: 2.5 }, 'lengthMm'],
    ['chiều rộng là chuỗi', { widthMm: '250' }, 'widthMm'],
    ['chiều cao vượt integer của PostgreSQL', { heightMm: 2147483648 }, 'heightMm'],
    ['giá muốn bán số lẻ', { targetNetPrice: 150000.5 }, 'targetNetPrice'],
    ['giá chuẩn bằng 0', { standardPrice: 0 }, 'standardPrice'],
  ])('%s → 422 errors.<ô>', async (_case, body, field) => {
    const product = await wallet();
    const res = await patch(product.id, product.variants[0]!.id, { version: 1, ...body });
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(res.body.errors[field]).toBeTruthy();
    expect(await variantOf(product.id)).toMatchObject({ version: 1, weightG: null });
  });

  it('thiếu version → 422 errors.version', async () => {
    const product = await wallet();
    const res = await patch(product.id, product.variants[0]!.id, { weightG: 250 });
    expect(res.status).toBe(422);
    expect(res.body.errors.version).toBeTruthy();
  });

  it('trường lạ (imageFileId chưa nhận, spec D1) → 422, không ghi gì', async () => {
    const product = await wallet();
    const res = await patch(product.id, product.variants[0]!.id, { version: 1, weightG: 250, imageFileId: randomUUID() });
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(await variantOf(product.id)).toMatchObject({ version: 1, weightG: null });
  });

  it('sai version → 409 version_conflict kèm current mới nhất, không ghi gì', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, weightG: 250 });
    const res = await patch(product.id, variantId, { version: 1, weightG: 300 });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(res.body.current.variants[0]).toMatchObject({ weightG: 250, version: 2 });
    expect(await variantOf(product.id)).toMatchObject({ weightG: 250, version: 2 });
  });

  it('gửi lại PATCH đã thành công (version cũ, cùng giá trị) → 200, không ghi thêm', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    const body = { version: 1, ...FULL };
    expect((await patch(product.id, variantId, body)).status).toBe(200);
    const again = await patch(product.id, variantId, body);
    expect(again.status).toBe(200);
    expect(again.body.variants[0]).toMatchObject({ ...FULL, version: 2 });
    expect(await auditOf(variantId)).toHaveLength(1);
  });

  it('chỉ gửi version → 200, không đổi version', async () => {
    const product = await wallet();
    const res = await patch(product.id, product.variants[0]!.id, { version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.variants[0].version).toBe(1);
  });

  it('SKU đã ngừng bán vẫn sửa được để điền cho đủ', async () => {
    const category = await createCategory(token, uniq('Áo'), 'AO-{SEQ}-{VAL}');
    const product = await createProduct(token, {
      name: uniq('Áo'),
      categoryId: category.id,
      variants: [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]],
    });
    const stopped = product.variants[0]!;
    expect((await api(token).delete(`/products/${product.id}/variants/${stopped.id}`)).status).toBe(204);
    const res = await patch(product.id, stopped.id, { version: 2, weightG: 250 });
    expect(res.status).toBe(200);
    expect(res.body.variants.find((v: { id: string }) => v.id === stopped.id)).toMatchObject({ weightG: 250, version: 3 });
  });

  it('sản phẩm đã lưu trữ → 409 product_archived, kể cả khi version sai', async () => {
    const product = await wallet();
    expect((await api(token).delete(`/products/${product.id}?version=1`)).status).toBe(204);
    const res = await patch(product.id, product.variants[0]!.id, { version: 99, weightG: 250 });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/product_archived');
  });

  it.each([
    ['SKU của sản phẩm khác', async () => ({ productId: (await wallet()).id, variantId: (await wallet()).variants[0]!.id })],
    ['variantId không phải uuid', async () => ({ productId: (await wallet()).id, variantId: 'abc' })],
    ['sản phẩm không tồn tại', async () => ({ productId: randomUUID(), variantId: randomUUID() })],
  ])('%s → 404 not_found', async (_case, ids) => {
    const { productId, variantId } = await ids();
    const res = await patch(productId, variantId, { version: 1, weightG: 250 });
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
  });
});
