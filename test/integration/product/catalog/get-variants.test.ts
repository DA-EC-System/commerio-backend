import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVariants, targetNetPricesOf } from '#src/modules/product/catalog/index.ts';
import { env } from '#src/shared/config/env.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { archiveSku, createAttribute, createGroup, createProduct, valueId } from './helpers.ts';

// `catalog.getVariants(ids?)` cho inventory, pricing, sales, channel (Documents/21 §11; plan #12 S-5, B10).
describe('getVariants', () => {
  it('đủ trường, thuộc tính theo position, archived khi biến thể ngừng bán hoặc sản phẩm lưu trữ, không thấy công ty khác', async () => {
    const { companyId, ceo } = await createCompany();
    const color = await createAttribute(ceo.token, 'Màu', ['Đen', 'Trắng']);
    const size = await createAttribute(ceo.token, 'Size', ['XL']);
    const group = await createGroup(ceo.token, 'Áo', 'AO-{SEQ:4}-{VAL}');
    const shirt = await createProduct(ceo.token, {
      name: 'Áo thun',
      groupId: group.id,
      variants: [
        [valueId(color, 'Đen'), valueId(size, 'XL')],
        [valueId(color, 'Trắng'), valueId(size, 'XL')],
      ],
    });
    await archiveSku(ceo.token, shirt.id, shirt.variants[1]!.id);
    const old = await createProduct(ceo.token, { name: 'Áo cũ', groupId: group.id, variants: [[valueId(color, 'Đen')]] });
    await archiveSku(ceo.token, old.id, old.variants[0]!.id);

    const other = await createCompany();
    const otherGroup = await createGroup(other.ceo.token, 'Của B', 'B-{SEQ}');
    const theirs = await createProduct(other.ceo.token, { name: 'Của B', groupId: otherGroup.id, variants: [[]] });

    const all = await withCompany(companyId, () => getVariants());
    expect(all).toEqual([
      {
        id: shirt.variants[0]!.id,
        productId: shirt.id,
        productName: 'Áo thun',
        productCode: shirt.code,
        sku: 'AO-0001-DEN-XL',
        groupId: group.id,
        groupName: 'Áo',
        archived: false,
        businessStatus: 'selling',
        description: '',
        weightG: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        originCountry: null,
        brand: null,
        image: null,
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

  it('lọc theo productIds: đúng biến thể của các sản phẩm đó (RLS), kèm productCode; [] là rỗng (#400 AC-S11)', async () => {
    const { companyId, ceo } = await createCompany();
    const color = await createAttribute(ceo.token, 'Màu', ['Đen', 'Trắng']);
    const group = await createGroup(ceo.token, 'Áo', 'AO-{SEQ:4}-{VAL}');
    const a = await createProduct(ceo.token, { name: 'Áo A', groupId: group.id, variants: [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]] });
    const b = await createProduct(ceo.token, { name: 'Áo B', groupId: group.id, variants: [[valueId(color, 'Đen')]] });
    const c = await createProduct(ceo.token, { name: 'Áo C', groupId: group.id, variants: [[valueId(color, 'Đen')]] });
    const other = await createCompany();
    const otherGroup = await createGroup(other.ceo.token, 'Của B', 'B-{SEQ}');
    const theirs = await createProduct(other.ceo.token, { name: 'Của B', groupId: otherGroup.id, variants: [[]] });

    const rows = await withCompany(companyId, () => getVariants(undefined, { productIds: [a.id, b.id, theirs.id, randomUUID(), 'abc'] }));
    expect(rows.map((v) => [v.id, v.productId, v.productCode])).toEqual([
      [a.variants[0]!.id, a.id, a.code],
      [a.variants[1]!.id, a.id, a.code],
      [b.variants[0]!.id, b.id, b.code],
    ]);
    expect(a.code).not.toBe(b.code);
    expect(await withCompany(companyId, () => getVariants(undefined, { productIds: [] }))).toEqual([]);
    // Có cả `ids` và `productIds` thì lấy giao.
    const both = await withCompany(companyId, () => getVariants([a.variants[1]!.id, c.variants[0]!.id], { productIds: [a.id] }));
    expect(both.map((v) => v.id)).toEqual([a.variants[1]!.id]);
  });

  it('trả cân nặng, kích thước của SKU và mô tả của sản phẩm (#204, Lazada cần để tính phí ship)', async () => {
    const { companyId, ceo } = await createCompany();
    const group = await createGroup(ceo.token, 'Ví', 'VI-{SEQ}');
    const wallet = await createProduct(ceo.token, { name: 'Ví da', groupId: group.id, variants: [[]] });
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
    const group = await createGroup(ceo.token, 'Ví', 'VI-{SEQ}');
    const priced = (await createProduct(ceo.token, { name: 'Ví có giá', groupId: group.id, variants: [[]] })).variants[0]!.id;
    const unpriced = (await createProduct(ceo.token, { name: 'Ví chưa giá', groupId: group.id, variants: [[]] })).variants[0]!.id;
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

// Ảnh phân loại và thông tin cha theo SKU (#340, Documents/21 §11, §17.2): channel gửi ảnh theo từng SKU (#295).
describe('getVariants: ảnh phân loại, xuất xứ, thương hiệu (#340)', () => {
  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const { companyId, ceo } = await createCompany();
    const color = await createAttribute(ceo.token, 'Màu', ['Trắng', 'Đen']);
    const size = await createAttribute(ceo.token, 'Size', ['M', 'L']);
    const group = await createGroup(ceo.token, 'Áo', 'AO-{SEQ}-{VAL}');
    const make = (name: string) =>
      createProduct(ceo.token, {
        name,
        groupId: group.id,
        variants: ['Trắng', 'Đen'].flatMap((c) => ['M', 'L'].map((s) => [valueId(color, c), valueId(size, s)])),
      });
    return { companyId, color, make };
  }
  const chooseColor = (productId: string, colorId: string) =>
    testPool().query('update product.products set image_attribute_id = $2 where id = $1', [productId, colorId]);
  async function image(companyId: string, productId: string, attributeId: string, attributeValueId: string) {
    const fileId = randomUUID();
    await testPool().query(
      `insert into core.files (id, company_id, storage_key, file_name, content_type, size_bytes, purpose, uploaded_at)
       values ($1, $2, $3, 'anh.png', 'image/png', 2048, 'product_image', now())`,
      [fileId, companyId, `test/${fileId}.png`],
    );
    await testPool().query(
      `insert into product.product_attribute_value_images (company_id, product_id, attribute_id, attribute_value_id, file_id)
       values ($1, $2, $3, $4, $5)`,
      [companyId, productId, attributeId, attributeValueId, fileId],
    );
    return fileId;
  }
  /** `getVariants` và số câu SQL của riêng lời gọi đó (spy bật, tháo bên trong `withCompany`). */
  const counted = (companyId: string, ids: string[]) =>
    withCompany(companyId, async () => {
      const spy = vi.spyOn(pg.Client.prototype, 'query');
      const rows = await getVariants(ids);
      const queries = spy.mock.calls.length;
      spy.mockRestore();
      return { rows, queries };
    });

  it('SKU Trắng có ảnh, SKU Đen null; chưa chọn thuộc tính thì mọi SKU null; không ảnh nào thì 2 câu (AC-11)', async () => {
    const { companyId, color, make } = await setup();
    const p = await make('Áo thun');
    const ids = p.variants.map((v) => v.id);

    const none = await counted(companyId, ids);
    expect(none.rows.map((v) => v.image)).toEqual([null, null, null, null]);
    expect(none.queries).toBe(2);

    await chooseColor(p.id, color.id);
    const fileId = await image(companyId, p.id, color.id, valueId(color, 'Trắng'));
    const some = await counted(companyId, ids);
    const white = { attributeValueId: valueId(color, 'Trắng'), fileId, url: `https://files.commerio.test/test/${fileId}.png` };
    expect(some.rows.map((v) => v.image)).toEqual([white, white, null, null]);
    expect(some.queries).toBe(3);
  });

  it('hai sản phẩm cùng dùng giá trị Trắng, chỉ sản phẩm 1 có ảnh: SKU Trắng của sản phẩm 2 null (AC-11)', async () => {
    const { companyId, color, make } = await setup();
    const one = await make('Áo một');
    const two = await make('Áo hai');
    await chooseColor(one.id, color.id);
    await chooseColor(two.id, color.id);
    await image(companyId, one.id, color.id, valueId(color, 'Trắng'));
    const rows = await withCompany(companyId, () => getVariants(two.variants.map((v) => v.id)));
    expect(rows.map((v) => v.image)).toEqual([null, null, null, null]);
  });

  it('thiếu S3_PUBLIC_URL thì url rỗng (AC-11)', async () => {
    const { companyId, color, make } = await setup();
    const p = await make('Áo thun');
    await chooseColor(p.id, color.id);
    const fileId = await image(companyId, p.id, color.id, valueId(color, 'Đen'));
    const saved = env.S3_PUBLIC_URL;
    env.S3_PUBLIC_URL = undefined;
    try {
      const rows = await withCompany(companyId, () => getVariants([p.variants[2]!.id]));
      expect(rows[0]!.image).toEqual({ attributeValueId: valueId(color, 'Đen'), fileId, url: '' });
    } finally {
      env.S3_PUBLIC_URL = saved;
    }
  });

  it('xuất xứ, thương hiệu của sản phẩm cha cho mọi SKU, null khi chưa đặt, vẫn 2 câu (AC-17)', async () => {
    const { companyId, make } = await setup();
    const p = await make('Áo thun');
    const ids = p.variants.map((v) => v.id);
    expect((await counted(companyId, ids)).rows.map((v) => [v.originCountry, v.brand])).toEqual(Array(4).fill([null, null]));
    await testPool().query("update product.products set origin_country = 'VN', brand = 'Coolmate' where id = $1", [p.id]);
    const after = await counted(companyId, ids);
    expect(after.rows.map((v) => [v.originCountry, v.brand])).toEqual(Array(4).fill(['VN', 'Coolmate']));
    expect(after.queries).toBe(2);
  });
});
