import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../helpers/catalog.ts';
import { testPool } from '../helpers/db.ts';

const db = () => testPool();

async function insertCategory(companyId: string, name: string): Promise<string> {
  const res = await db().query<{ id: string }>(
    `insert into catalog.categories (company_id, name, sku_pattern) values ($1, $2, 'AO-{SEQ}') returning id`,
    [companyId, name],
  );
  return res.rows[0]!.id;
}

async function insertAttribute(companyId: string, name: string): Promise<string> {
  const res = await db().query<{ id: string }>(
    'insert into catalog.attributes (company_id, name) values ($1, $2) returning id',
    [companyId, name],
  );
  return res.rows[0]!.id;
}

const insertValue = (companyId: string, attributeId: string, value: string, code: string) =>
  db().query('insert into catalog.attribute_values (company_id, attribute_id, value, code) values ($1, $2, $3, $4)', [
    companyId,
    attributeId,
    value,
    code,
  ]);

// Ràng buộc của catalog (plan chuẩn bị 4.2, 4.3; AC-9).
describe('ràng buộc bảng catalog (AC-9)', () => {
  it('hai danh mục "Áo" và "áo" cùng công ty bị từ chối, khác công ty thì được', async () => {
    const company = randomUUID();
    await insertCategory(company, 'Áo');
    await expect(insertCategory(company, 'áo')).rejects.toThrow(/categories_company_lower_name_uq/);
    await expect(insertCategory(randomUUID(), 'áo')).resolves.toBeDefined();
  });

  it('danh mục mới có số thứ tự SKU bắt đầu từ 1', async () => {
    const id = await insertCategory(randomUUID(), 'Quần');
    const res = await db().query('select sku_next_seq from catalog.categories where id = $1', [id]);
    expect(res.rows[0]).toEqual({ sku_next_seq: 1 });
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
    const category = await insertCategory(company, 'Giày');
    const insert = (name: string) =>
      db().query('insert into catalog.products (company_id, category_id, name) values ($1, $2, $3)', [
        company,
        category,
        name,
      ]);
    await insert('Giày chạy bộ');
    await expect(insert('GIÀY CHẠY BỘ')).rejects.toThrow(/products_company_lower_name_uq/);
  });

  it('tên của sản phẩm đã lưu trữ dùng lại được (#12 B1)', async () => {
    const company = randomUUID();
    const category = await insertCategory(company, 'Dép');
    const insert = (name: string, archived: boolean) =>
      db().query(
        `insert into catalog.products (company_id, category_id, name, archived_at)
         values ($1, $2, $3, case when $4 then now() end)`,
        [company, category, name, archived],
      );
    await insert('Dép lê', true);
    await insert('dép lê', true);
    await expect(insert('Dép Lê', false)).resolves.toBeDefined();
    await expect(insert('DÉP LÊ', false)).rejects.toThrow(/products_company_lower_name_uq/);
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
