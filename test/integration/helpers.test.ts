import { describe, expect, it } from 'vitest';
import { createVariant } from './helpers/catalog.ts';
import { createCompany } from './helpers/company.ts';
import { asCompany } from './helpers/rls.ts';

// Helper dùng chung chạy được và tạo dữ liệu đúng như sản phẩm sẽ tạo (AC-13). PR sau thêm phần của mình.
describe('helper test dùng chung', () => {
  it('createVariant tạo danh mục, sản phẩm, biến thể của công ty; công ty khác không thấy', async () => {
    const { companyId } = await createCompany();
    const v = await createVariant(companyId, { sku: 'AO-0001', categoryName: 'Áo thun' });
    expect(v.sku).toBe('AO-0001');

    const seen = await asCompany(companyId, (c) =>
      c.query(
        `select v.sku, p.id as product_id, c.name as category from catalog.product_variants v
         join catalog.products p on p.id = v.product_id join catalog.categories c on c.id = p.category_id
         where v.id = $1`,
        [v.variantId],
      ),
    );
    expect(seen.rows).toEqual([{ sku: 'AO-0001', product_id: v.productId, category: 'Áo thun' }]);

    const other = await createCompany();
    const hidden = await asCompany(other.companyId, (c) =>
      c.query('select 1 from catalog.product_variants where id = $1', [v.variantId]),
    );
    expect(hidden.rowCount).toBe(0);
  });

  it('createVariant gọi nhiều lần trong một công ty không đụng tên, SKU', async () => {
    const { companyId } = await createCompany();
    const a = await createVariant(companyId);
    const b = await createVariant(companyId);
    expect(a.sku).not.toBe(b.sku);
    expect(a.categoryId).not.toBe(b.categoryId);
  });
});
