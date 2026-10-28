import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getVariants } from '#src/modules/product/catalog/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { api, createAttribute, createCategory, createProduct, valueId } from './helpers.ts';

// `catalog.getVariants(ids?)` cho inventory, pricing, sales, channel (Documents/21 §11; plan #12 S-5, B10).
describe('getVariants', () => {
  it('đủ trường, thuộc tính theo position, archived khi biến thể ngừng bán hoặc sản phẩm lưu trữ, không thấy công ty khác', async () => {
    const { companyId, ceo } = await createCompany();
    const color = await createAttribute(ceo.token, 'Màu', ['Đen', 'Trắng']);
    const size = await createAttribute(ceo.token, 'Size', ['XL']);
    const category = await createCategory(ceo.token, 'Áo', 'AO-{SEQ:4}-{VAL}');
    const shirt = await createProduct(ceo.token, {
      name: 'Áo thun',
      categoryId: category.id,
      variants: [
        [valueId(color, 'Đen'), valueId(size, 'XL')],
        [valueId(color, 'Trắng'), valueId(size, 'XL')],
      ],
    });
    await api(ceo.token).delete(`/products/${shirt.id}/variants/${shirt.variants[1]!.id}`);
    const old = await createProduct(ceo.token, { name: 'Áo cũ', categoryId: category.id, variants: [[valueId(color, 'Đen')]] });
    await api(ceo.token).delete(`/products/${old.id}?version=1`);

    const other = await createCompany();
    const otherCategory = await createCategory(other.ceo.token, 'Của B', 'B-{SEQ}');
    const theirs = await createProduct(other.ceo.token, { name: 'Của B', categoryId: otherCategory.id, variants: [[]] });

    const all = await withCompany(companyId, () => getVariants());
    expect(all).toEqual([
      {
        id: shirt.variants[0]!.id,
        productId: shirt.id,
        productName: 'Áo thun',
        sku: 'AO-0001-DEN-XL',
        categoryId: category.id,
        categoryName: 'Áo',
        archived: false,
        attributes: [
          { attributeId: color.id, attributeName: 'Màu', valueId: valueId(color, 'Đen'), value: 'Đen', code: 'DEN' },
          { attributeId: size.id, attributeName: 'Size', valueId: valueId(size, 'XL'), value: 'XL', code: 'XL' },
        ],
      },
      expect.objectContaining({ id: shirt.variants[1]!.id, sku: 'AO-0002-TRANG-XL', archived: true }),
      expect.objectContaining({ id: old.variants[0]!.id, archived: true }),
    ]);

    const some = await withCompany(companyId, () =>
      getVariants([shirt.variants[0]!.id, theirs.variants[0]!.id, randomUUID(), 'abc']),
    );
    expect(some.map((v) => v.id)).toEqual([shirt.variants[0]!.id]);
    expect(await withCompany(companyId, () => getVariants([]))).toEqual([]);
  });

  it('gọi ngoài withCompany thì báo lỗi, không trả biến thể của mọi công ty', async () => {
    await expect(getVariants()).rejects.toThrow('getVariants phải gọi trong withCompany');
  });
});
