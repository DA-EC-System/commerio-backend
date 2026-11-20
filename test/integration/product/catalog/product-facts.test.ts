// Cổng `fillProductFacts` (#497, Documents/21 §11.3): ghép SKU sàn điền trường dùng chung **đang trống** của sản phẩm (xuất xứ,
// thương hiệu, mô tả; cân nặng, kích thước của SKU). Trường đã có giá trị giữ nguyên; có ghi thì tăng `version` bản ghi được
// ghi, nhật ký người làm hệ thống kèm gian hàng nguồn; SKU ghi mà sản phẩm không đổi thì chỉ đổi `updated_at` sản phẩm (P7).
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { fillProductFacts } from '#src/modules/product/catalog/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

let companyId: string;
const source = { shopId: randomUUID(), shopName: 'Shop Lazada thử' };
const fill = (productId: string, facts: Parameters<typeof fillProductFacts>[1]) =>
  withCompany(companyId, () => fillProductFacts(productId, facts, source));
const product = async (id: string) =>
  (await testPool().query('select origin_country, brand, description, version, updated_at from product.products where id = $1', [id])).rows[0];
const variant = async (id: string) =>
  (await testPool().query('select weight_g, length_mm, width_mm, height_mm, version from product.product_variants where id = $1', [id])).rows[0];
const audits = async (id: string) =>
  (await testPool().query('select actor_id, entity_type, before, after from core.audit_logs where entity_id = $1 order by created_at, id', [id])).rows;

beforeAll(async () => {
  companyId = (await createCompany({ optionalModules: [] })).companyId;
});

describe('fillProductFacts', () => {
  it('điền trường trống, tăng version, nhật ký hệ thống kèm gian hàng nguồn', async () => {
    const v = await createVariant(companyId);
    const p0 = await product(v.productId);
    const res = await fill(v.productId, {
      originCountry: 'vn',
      brand: ' Lock&Lock ',
      description: 'Bình giữ nhiệt',
      variants: [{ variantId: v.variantId, weightG: 450, lengthMm: 250, widthMm: 80, heightMm: 80 }],
    });
    expect(res.filled.sort()).toEqual(
      ['brand', 'description', 'originCountry', ...['heightMm', 'lengthMm', 'weightG', 'widthMm'].map((f) => `variants.${v.variantId}.${f}`)].sort(),
    );
    expect(await product(v.productId)).toMatchObject({ origin_country: 'VN', brand: 'Lock&Lock', description: 'Bình giữ nhiệt', version: p0.version + 1 });
    expect(await variant(v.variantId)).toMatchObject({ weight_g: 450, length_mm: 250, width_mm: 80, height_mm: 80, version: 2 });
    const [pa] = await audits(v.productId);
    expect(pa).toMatchObject({ actor_id: null, entity_type: 'product.products', after: { originCountry: 'VN', source } });
    const [va] = await audits(v.variantId);
    expect(va).toMatchObject({ actor_id: null, entity_type: 'product.product_variants', before: { weightG: null }, after: { weightG: 450, source } });
  });

  it('trường đã có giữ nguyên; không gì để ghi thì không tăng version, không nhật ký', async () => {
    const v = await createVariant(companyId);
    await testPool().query("update product.products set origin_country = 'CN', brand = 'Có sẵn', description = 'Mô tả cũ' where id = $1", [v.productId]);
    await testPool().query('update product.product_variants set weight_g = 100, length_mm = 1, width_mm = 1, height_mm = 1 where id = $1', [v.variantId]);
    const p0 = await product(v.productId);
    const res = await fill(v.productId, {
      originCountry: 'VN',
      brand: 'Khác',
      description: 'Mới',
      variants: [{ variantId: v.variantId, weightG: 450, lengthMm: 250, widthMm: 80, heightMm: 80 }],
    });
    expect(res.filled).toEqual([]);
    expect(await product(v.productId)).toMatchObject({ origin_country: 'CN', brand: 'Có sẵn', description: 'Mô tả cũ', version: p0.version });
    expect(await variant(v.variantId)).toMatchObject({ weight_g: 100, version: 1 });
    expect(await audits(v.productId)).toEqual([]);
  });

  it('chỉ SKU được điền: version sản phẩm giữ, updated_at đổi; giá trị không hợp luật bỏ; SKU sản phẩm khác bỏ', async () => {
    const v = await createVariant(companyId);
    const other = await createVariant(companyId);
    const p0 = await product(v.productId);
    const res = await fill(v.productId, {
      originCountry: 'Việt Nam',
      brand: 'x'.repeat(101),
      variants: [
        { variantId: v.variantId, weightG: 450, lengthMm: 0, widthMm: 1.5, heightMm: null },
        { variantId: other.variantId, weightG: 999, lengthMm: 1, widthMm: 1, heightMm: 1 },
      ],
    });
    expect(res.filled).toEqual([`variants.${v.variantId}.weightG`]);
    const p1 = await product(v.productId);
    expect(p1).toMatchObject({ origin_country: null, brand: null, version: p0.version });
    expect(p1.updated_at.getTime()).toBeGreaterThan(p0.updated_at.getTime());
    expect(await variant(other.variantId)).toMatchObject({ weight_g: null, version: 1 });
  });

  it('sản phẩm công ty khác hoặc id sai dạng: không ghi gì', async () => {
    const v = await createVariant((await createCompany({ optionalModules: [] })).companyId);
    expect(await fill(v.productId, { brand: 'A', variants: [{ variantId: v.variantId, weightG: 1, lengthMm: 1, widthMm: 1, heightMm: 1 }] })).toEqual({ filled: [] });
    expect(await product(v.productId)).toMatchObject({ brand: null });
    expect(await fill('khong-phai-uuid', { brand: 'A' })).toEqual({ filled: [] });
  });
});
