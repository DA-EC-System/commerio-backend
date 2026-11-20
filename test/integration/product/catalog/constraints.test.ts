import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { testPool } from '../../helpers/db.ts';

const db = () => testPool();

async function insertGroup(companyId: string, name: string): Promise<string> {
  const res = await db().query<{ id: string }>(
    'insert into product.product_groups (company_id, name) values ($1, $2) returning id',
    [companyId, name],
  );
  return res.rows[0]!.id;
}

async function insertAttribute(companyId: string, name: string): Promise<string> {
  const res = await db().query<{ id: string }>(
    'insert into product.attributes (company_id, name) values ($1, $2) returning id',
    [companyId, name],
  );
  return res.rows[0]!.id;
}

const insertValue = (companyId: string, attributeId: string, value: string, code: string) =>
  db().query('insert into product.attribute_values (company_id, attribute_id, value, code) values ($1, $2, $3, $4)', [
    companyId,
    attributeId,
    value,
    code,
  ]);

// Ràng buộc của catalog (plan chuẩn bị 4.2, 4.3; AC-9).
describe('ràng buộc bảng catalog (AC-9)', () => {
  it('hai nhóm hàng "Áo" và "áo" cùng công ty bị từ chối, khác công ty thì được', async () => {
    const company = randomUUID();
    await insertGroup(company, 'Áo');
    await expect(insertGroup(company, 'áo')).rejects.toThrow(/product_groups_company_lower_name_uq/);
    await expect(insertGroup(randomUUID(), 'áo')).resolves.toBeDefined();
  });

  // #447: mẫu SKU và số {SEQ} là của công ty (một dòng mỗi công ty), không còn nằm ở nhóm hàng.
  it('cài đặt sản phẩm của công ty mới có mẫu SKU mặc định, số thứ tự SKU bắt đầu từ 1, mỗi công ty một dòng', async () => {
    const company = randomUUID();
    const res = await db().query('insert into product.company_product_settings (company_id) values ($1) returning sku_pattern, sku_next_seq', [company]);
    expect(res.rows[0]).toEqual({ sku_pattern: 'SP{SEQ:5}-{VAL}', sku_next_seq: 1 });
    await expect(db().query('insert into product.company_product_settings (company_id) values ($1)', [company])).rejects.toMatchObject({ code: '23505' });
    await expect(db().query('update product.company_product_settings set sku_next_seq = 0 where company_id = $1', [company])).rejects.toMatchObject({
      code: '23514',
      constraint: 'company_product_settings_sku_next_seq',
    });
  });

  it('tên thuộc tính không trùng theo chữ thường trong một công ty', async () => {
    const company = randomUUID();
    await insertAttribute(company, 'Màu');
    await expect(insertAttribute(company, 'MÀU')).rejects.toThrow(/attributes_company_lower_name_uq/);
  });

  it('giá trị thuộc tính không trùng theo chữ thường, mã không trùng trong một thuộc tính', async () => {
    const company = randomUUID();
    const attr = await insertAttribute(company, 'Size');
    await insertValue(company, attr, 'Xanh navy', 'XANHNA');
    await expect(insertValue(company, attr, 'xanh NAVY', 'XANHN2')).rejects.toThrow(/attribute_values_attribute_lower_value_uq/);
    await expect(insertValue(company, attr, 'Xanh nhạt', 'XANHNA')).rejects.toThrow(/duplicate key/);
    const other = await insertAttribute(company, 'Màu phụ');
    await expect(insertValue(company, other, 'Xanh navy', 'XANHNA')).resolves.toBeDefined();
  });

  it('mã giá trị chỉ gồm A-Z, 0-9, tối đa 6 ký tự', async () => {
    const company = randomUUID();
    const attr = await insertAttribute(company, 'Chất liệu');
    for (const bad of ['xanh', 'XANHNAV', 'XA-NH', '']) {
      await expect(insertValue(company, attr, `Giá trị ${bad}`, bad), bad).rejects.toThrow(/check constraint/);
    }
  });

  it('tên sản phẩm không trùng theo chữ thường trong một công ty', async () => {
    const company = randomUUID();
    const group = await insertGroup(company, 'Giày');
    const insert = (name: string) =>
      db().query('insert into product.products (company_id, group_id, name, code) values ($1, $2, $3, $4)', [
        company,
        group,
        name,
        `G-${randomUUID().slice(0, 8)}`,
      ]);
    await insert('Giày chạy bộ');
    await expect(insert('GIÀY CHẠY BỘ')).rejects.toThrow(/products_company_lower_name_uq/);
  });

  it('mã cha không trùng trong một công ty, khác công ty thì được (#204 D5)', async () => {
    const insert = async (companyId: string, name: string) =>
      db().query('insert into product.products (company_id, group_id, name, code) values ($1, $2, $3, $4)', [
        companyId,
        await insertGroup(companyId, `Dép ${name}`),
        name,
        'DEP-0001',
      ]);
    const company = randomUUID();
    await insert(company, 'Dép lê');
    await expect(insert(company, 'Dép tổ ong')).rejects.toThrow(/products_company_code_uq/);
    await expect(insert(randomUUID(), 'Dép lê')).resolves.toBeDefined();
  });

  it('SKU không trùng trong một công ty, khác công ty thì được', async () => {
    const company = randomUUID();
    await createVariant(company, { sku: 'MU-0001' });
    await expect(createVariant(company, { sku: 'MU-0001' })).rejects.toMatchObject({
      cause: { constraint: 'product_variants_company_id_sku_unique' },
    });
    await expect(createVariant(randomUUID(), { sku: 'MU-0001' })).resolves.toBeDefined();
  });
});

// Ảnh phân loại, xuất xứ, thương hiệu (#340, Documents/19 §3.2): CSDL tự chặn ảnh nằm sai thuộc tính và giá trị sai dạng.
describe('ràng buộc ảnh phân loại, xuất xứ, thương hiệu (#340, AC-S4)', () => {
  async function seed() {
    const company = randomUUID();
    const color = await insertAttribute(company, `Màu ${randomUUID().slice(0, 8)}`);
    const size = await insertAttribute(company, `Size ${randomUUID().slice(0, 8)}`);
    const value = async (attributeId: string, v: string, code: string) =>
      (
        await db().query<{ id: string }>(
          'insert into product.attribute_values (company_id, attribute_id, value, code) values ($1, $2, $3, $4) returning id',
          [company, attributeId, v, code],
        )
      ).rows[0]!.id;
    const white = await value(color, 'Trắng', 'TRANG');
    const black = await value(color, 'Đen', 'DEN');
    const m = await value(size, 'M', 'M');
    const group = await insertGroup(company, `Áo ${randomUUID()}`);
    const product = (
      await db().query<{ id: string }>(
        'insert into product.products (company_id, group_id, name, code) values ($1, $2, $3, $4) returning id',
        [company, group, `Áo ${randomUUID()}`, `A-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0]!.id;
    const image = (attributeId: string, valueId: string) =>
      db().query(
        `insert into product.product_attribute_value_images (company_id, product_id, attribute_id, attribute_value_id, file_id)
         values ($1, $2, $3, $4, $5)`,
        [company, product, attributeId, valueId, randomUUID()],
      );
    const setImageAttribute = (id: string | null) =>
      db().query('update product.products set image_attribute_id = $2 where id = $1', [product, id]);
    return { color, size, white, black, m, product, image, setImageAttribute };
  }
  const fk = (constraint: string) => ({ code: '23503', constraint });
  const check = (constraint: string) => ({ code: '23514', constraint });

  it('sản phẩm chưa chọn thuộc tính gắn ảnh thì không chèn được ảnh', async () => {
    const s = await seed();
    await expect(s.image(s.color, s.white)).rejects.toMatchObject(fk('pavi_product_fk'));
  });

  it('ảnh mang thuộc tính khác thuộc tính gắn ảnh, hoặc giá trị của thuộc tính khác, bị chặn', async () => {
    const s = await seed();
    await s.setImageAttribute(s.color);
    await expect(s.image(s.size, s.m)).rejects.toMatchObject(fk('pavi_product_fk'));
    await expect(s.image(s.color, s.m)).rejects.toMatchObject(fk('pavi_value_fk'));
    await s.image(s.color, s.white);
    await expect(s.image(s.color, s.white)).rejects.toMatchObject({ code: '23505', constraint: 'pavi_product_value_uq' });
  });

  it('đổi hoặc bỏ thuộc tính gắn ảnh khi còn ảnh bị chặn; xoá ảnh rồi đổi thì được', async () => {
    const s = await seed();
    await s.setImageAttribute(s.color);
    await s.image(s.color, s.black);
    await expect(s.setImageAttribute(s.size)).rejects.toMatchObject(fk('pavi_product_fk'));
    await expect(s.setImageAttribute(null)).rejects.toMatchObject(fk('pavi_product_fk'));
    await db().query('delete from product.product_attribute_value_images where product_id = $1', [s.product]);
    await expect(s.setImageAttribute(s.size)).resolves.toBeDefined();
  });

  it('xuất xứ chỉ nhận 2 chữ in hoa, thương hiệu tối đa 100 ký tự; null cả hai qua', async () => {
    const s = await seed();
    const set = (origin: string | null, brand: string | null) =>
      db().query('update product.products set origin_country = $2, brand = $3 where id = $1', [s.product, origin, brand]);
    for (const bad of ['vn', 'VNM', 'V1']) {
      await expect(set(bad, null), bad).rejects.toMatchObject(check('products_origin_country'));
    }
    await expect(set(null, 'x'.repeat(101))).rejects.toMatchObject(check('products_brand_length'));
    await expect(set('VN', 'x'.repeat(100))).resolves.toBeDefined();
    await expect(set(null, null)).resolves.toBeDefined();
  });
});

// Thông số sản phẩm (#510, Documents/19 §3.2): ràng buộc DB của trục chuẩn và giá trị thông số.
describe('ràng buộc thông số sản phẩm (#510)', () => {
  async function field(companyId: string, code: string, input = 'select') {
    const res = await db().query<{ id: string }>(
      'insert into product.spec_fields (company_id, code, name, input) values ($1, $2, $2, $3) returning id',
      [companyId, code, input],
    );
    return res.rows[0]!.id;
  }
  async function option(companyId: string, fieldId: string, value: string) {
    const res = await db().query<{ id: string }>(
      'insert into product.spec_field_options (company_id, field_id, value, position) values ($1, $2, $3, 0) returning id',
      [companyId, fieldId, value],
    );
    return res.rows[0]!.id;
  }
  const insertSpecValue = (companyId: string, productId: string, fieldId: string, optionId: string | null, text: string | null) =>
    db().query('insert into product.product_spec_values (company_id, product_id, field_id, option_id, value_text) values ($1, $2, $3, $4, $5)', [
      companyId,
      productId,
      fieldId,
      optionId,
      text,
    ]);

  it('nhóm đặt trục 2 khi trục 1 trống bị CHECK chặn; hai trục trùng thuộc tính bị chặn', async () => {
    const company = randomUUID();
    const group = await insertGroup(company, 'Nhóm trục');
    const a = await insertAttribute(company, 'Màu trục');
    await expect(db().query('update product.product_groups set axis2_attribute_id = $2 where id = $1', [group, a])).rejects.toThrow(
      /product_groups_axis_order/,
    );
    await expect(
      db().query('update product.product_groups set axis1_attribute_id = $2, axis2_attribute_id = $2 where id = $1', [group, a]),
    ).rejects.toThrow(/product_groups_axis_distinct/);
  });

  it('giá trị thông số có cả option_id lẫn value_text (hoặc không có gì) bị CHECK chặn', async () => {
    const companyId = randomUUID();
    const { productId } = await createVariant(companyId);
    const f = await field(companyId, 'rb_one_of');
    const o = await option(companyId, f, 'A');
    await expect(insertSpecValue(companyId, productId, f, o, 'chữ')).rejects.toThrow(/product_spec_values_one_of/);
    await expect(insertSpecValue(companyId, productId, f, null, null)).rejects.toThrow(/product_spec_values_one_of/);
    await expect(insertSpecValue(companyId, productId, f, o, null)).resolves.toBeDefined();
  });

  it('lựa chọn của thông số khác bị khoá ngoại ghép chặn; xoá lựa chọn đang dùng bị chặn', async () => {
    const companyId = randomUUID();
    const { productId } = await createVariant(companyId);
    const f1 = await field(companyId, 'rb_fk_1');
    const f2 = await field(companyId, 'rb_fk_2');
    const o2 = await option(companyId, f2, 'B');
    await expect(insertSpecValue(companyId, productId, f1, o2, null)).rejects.toThrow(/psv_option_fk/);
    await insertSpecValue(companyId, productId, f2, o2, null);
    await expect(db().query('delete from product.spec_field_options where id = $1', [o2])).rejects.toThrow(/psv_option_fk/);
  });
});
