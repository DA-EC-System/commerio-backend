// Dữ liệu mặc định khi lập công ty (#447 AC-1, Documents/21 mục 11.3 `seedCompanyDefaults`): tạo cùng giao dịch đăng ký.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTRIBUTES, DEFAULT_GROUPS } from '#src/modules/product/index.ts';
import { registerCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

describe('dữ liệu mặc định của công ty mới (#447)', () => {
  it('đăng ký công ty → 12 nhóm hàng, "Màu sắc" (color, 8 giá trị), "Kích cỡ" (size, 5), "Dung tích", "Hương vị", cài đặt SKU mặc định', async () => {
    const { companyId } = await registerCompany();
    const db = testPool();
    const groups = await db.query<{ name: string }>('select name from product.product_groups where company_id = $1 order by created_at, id', [companyId]);
    expect(groups.rows.map((g) => g.name)).toEqual([
      'Thời trang nam',
      'Thời trang nữ',
      'Giày dép',
      'Túi ví',
      'Phụ kiện',
      'Mỹ phẩm & làm đẹp',
      'Nhà cửa & đời sống',
      'Điện tử',
      'Thực phẩm',
      'Mẹ & bé',
      'Thể thao',
      'Khác',
    ]);
    const attrs = await db.query<{ name: string; platform_kind: string; values: [string, string][] }>(
      `select a.name, a.platform_kind,
         (select json_agg(json_build_array(v.value, v.code) order by v.created_at, v.id) from product.attribute_values v
           where v.attribute_id = a.id and v.company_id = a.company_id) as values
       from product.attributes a where a.company_id = $1 order by a.created_at, a.id`,
      [companyId],
    );
    expect(attrs.rows).toEqual([
      {
        name: 'Màu sắc',
        platform_kind: 'color',
        values: [
          ['Đen', 'DEN'],
          ['Trắng', 'TRANG'],
          ['Đỏ', 'DO'],
          ['Xanh dương', 'XANHDU'],
          ['Vàng', 'VANG'],
          ['Hồng', 'HONG'],
          ['Xám', 'XAM'],
          ['Be', 'BE'],
        ],
      },
      { name: 'Kích cỡ', platform_kind: 'size', values: ['S', 'M', 'L', 'XL', 'XXL'].map((s) => [s, s]) },
      {
        name: 'Dung tích',
        platform_kind: 'volume',
        values: ['30ml', '50ml', '100ml', '250ml', '500ml', '1L', '100g', '250g', '500g', '1kg'].map((v) => [v, v.toUpperCase()]),
      },
      {
        name: 'Hương vị',
        platform_kind: 'flavor',
        values: [
          ['Nguyên bản', 'NGBAN'],
          ['Socola', 'SOCOLA'],
          ['Dâu', 'DAU'],
          ['Vani', 'VANI'],
          ['Matcha', 'MATCHA'],
          ['Cà phê', 'CAPHE'],
        ],
      },
    ]);
    const settings = await db.query('select sku_pattern, sku_next_seq, margin_coefficient, price_rounding, reorder_lead_days, reorder_safety_qty, reorder_default_qty from product.company_product_settings where company_id = $1', [companyId]);
    expect(settings.rows).toEqual([
      {
        sku_pattern: 'SP{SEQ:5}-{VAL}',
        sku_next_seq: 1,
        margin_coefficient: null,
        price_rounding: null,
        reorder_lead_days: null,
        reorder_safety_qty: null,
        reorder_default_qty: null,
      },
    ]);
  });

  it('hằng số trong code khớp migration dữ liệu cho công ty cũ (`*_nhom-hang-du-lieu`)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'db', 'migrations');
    const sql = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('_nhom-hang-du-lieu.sql'))!), 'utf8');
    for (const g of DEFAULT_GROUPS) expect(sql).toContain(`'${g}')`);
    // "Dung tích", "Hương vị" (#510) nằm ở `*_thong-so-du-lieu`, test `spec-defaults.test.ts`.
    for (const a of DEFAULT_ATTRIBUTES.filter((x) => x.kind === 'color' || x.kind === 'size')) {
      expect(sql).toContain(`'${a.kind}', '${a.name}')`);
      a.values.forEach(([value, code], i) => expect(sql).toContain(`('${a.kind}', ${i}, '${value}', '${code}')`));
    }
  });
});
