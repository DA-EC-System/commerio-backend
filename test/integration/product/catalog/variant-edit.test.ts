import { beforeAll, describe, expect, it } from 'vitest';
import { ProductDetail } from '#src/modules/product/catalog/api/schemas.ts';
import { createCompany } from '../../helpers/company.ts';
import { api, createCategory, createProduct, uniq } from './helpers.ts';

// Sửa một SKU: giá chuẩn, giá muốn bán, cân nặng, kích thước gói (#204, Documents/21 §17.1, §17.2).
let token: string;
beforeAll(async () => {
  token = (await createCompany()).ceo.token;
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
