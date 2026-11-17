import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getVariants, targetNetPricesOf } from '#src/modules/product/catalog/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { archiveSku, createAttribute, createCategory, createProduct, valueId } from './helpers.ts';

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
    await archiveSku(ceo.token, shirt.id, shirt.variants[1]!.id);
    const old = await createProduct(ceo.token, { name: 'Áo cũ', categoryId: category.id, variants: [[valueId(color, 'Đen')]] });
    await archiveSku(ceo.token, old.id, old.variants[0]!.id);

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
        businessStatus: 'selling',
        description: '',
        weightG: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        attributes: [
          { attributeId: color.id, attributeName: 'Màu', valueId: valueId(color, 'Đen'), value: 'Đen', code: 'DEN' },
          { attributeId: size.id, attributeName: 'Size', valueId: valueId(size, 'XL'), value: 'XL', code: 'XL' },
        ],
      },
      expect.objectContaining({ id: shirt.variants[1]!.id, sku: 'AO-0002-TRANG-XL', archived: true, businessStatus: 'archived' }),
      expect.objectContaining({ id: old.variants[0]!.id, archived: true }),
    ]);

    const some = await withCompany(companyId, () =>
      getVariants([shirt.variants[0]!.id, theirs.variants[0]!.id, randomUUID(), 'abc']),
    );
    expect(some.map((v) => v.id)).toEqual([shirt.variants[0]!.id]);
    expect(await withCompany(companyId, () => getVariants([]))).toEqual([]);
  });

  it('trả cân nặng, kích thước của SKU và mô tả của sản phẩm (#204, Lazada cần để tính phí ship)', async () => {
    const { companyId, ceo } = await createCompany();
    const category = await createCategory(ceo.token, 'Ví', 'VI-{SEQ}');
    const wallet = await createProduct(ceo.token, { name: 'Ví da', categoryId: category.id, variants: [[]] });
    const variantId = wallet.variants[0]!.id;
    await testPool().query(
      'update product.product_variants set weight_g = 250, length_mm = 200, width_mm = 100, height_mm = 30 where id = $1',
      [variantId],
    );
    await testPool().query("update product.products set description = 'Da bò' where id = $1", [wallet.id]);
    const [v] = await withCompany(companyId, () => getVariants([variantId]));
    expect(v).toMatchObject({ description: 'Da bò', weightG: 250, lengthMm: 200, widthMm: 100, heightMm: 30 });
  });

  it('targetNetPricesOf: đủ mọi id, chưa đặt giá hay id lạ thì null (#204, #225)', async () => {
    const { companyId, ceo } = await createCompany();
    const category = await createCategory(ceo.token, 'Ví', 'VI-{SEQ}');
    const priced = (await createProduct(ceo.token, { name: 'Ví có giá', categoryId: category.id, variants: [[]] })).variants[0]!.id;
    const unpriced = (await createProduct(ceo.token, { name: 'Ví chưa giá', categoryId: category.id, variants: [[]] })).variants[0]!.id;
    await testPool().query('update product.product_variants set target_net_price = 150000 where id = $1', [priced]);
    const stray = randomUUID();
    const prices = await withCompany(companyId, () => targetNetPricesOf([priced, unpriced, stray]));
    expect([...prices.keys()]).toEqual([priced, unpriced, stray]);
    expect(prices.get(priced)!.eq(150000)).toBe(true);
    expect(prices.get(unpriced)).toBeNull();
    expect(prices.get(stray)).toBeNull();
  });

  it('gọi ngoài withCompany thì báo lỗi, không trả biến thể của mọi công ty', async () => {
    await expect(getVariants()).rejects.toThrow('getVariants phải gọi trong withCompany');
  });
});
