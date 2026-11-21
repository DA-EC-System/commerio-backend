// Cổng `fillProductFacts` (#497, Documents/21 §11.3): ghép SKU sàn điền trường dùng chung **đang trống** của sản phẩm (xuất xứ,
// thương hiệu, mô tả; cân nặng, kích thước của SKU). Trường đã có giá trị giữ nguyên; có ghi thì tăng `version` bản ghi được
// ghi, nhật ký người làm hệ thống kèm gian hàng nguồn; SKU ghi mà sản phẩm không đổi thì chỉ đổi `updated_at` sản phẩm (P7).
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { fillProductFacts, productMediaGaps } from '#src/modules/product/catalog/index.ts';
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

  it('số đo sàn vượt trần (#434) thì bỏ, không lỗi; đúng trần thì ghi', async () => {
    const v = await createVariant(companyId);
    const res = await fill(v.productId, { variants: [{ variantId: v.variantId, weightG: 50_001, lengthMm: 2_000, widthMm: 2_001, heightMm: 2_000 }] });
    expect(res.filled.sort()).toEqual([`variants.${v.variantId}.heightMm`, `variants.${v.variantId}.lengthMm`]);
    expect(await variant(v.variantId)).toMatchObject({ weight_g: null, length_mm: 2_000, width_mm: null, height_mm: 2_000 });
  });

  it('sản phẩm công ty khác hoặc id sai dạng: không ghi gì', async () => {
    const v = await createVariant((await createCompany({ optionalModules: [] })).companyId);
    expect(await fill(v.productId, { brand: 'A', variants: [{ variantId: v.variantId, weightG: 1, lengthMm: 1, widthMm: 1, heightMm: 1 }] })).toEqual({ filled: [] });
    expect(await product(v.productId)).toMatchObject({ brand: null });
    expect(await fill('khong-phai-uuid', { brand: 'A' })).toEqual({ filled: [] });
  });

  describe('ảnh từ sàn (#498)', () => {
    /** Tệp ảnh sản phẩm đã có trên kho; `uploaded` false là vé chưa PUT, `purpose` khác để thử tệp không dùng được. */
    const file = async (opts: { uploaded?: boolean; purpose?: string; company?: string } = {}) => {
      const id = randomUUID();
      await testPool().query(
        "insert into core.files (id, company_id, storage_key, file_name, content_type, size_bytes, purpose, uploaded_at) values ($1, $2, $3, 'anh.jpg', 'image/jpeg', 100, $4, $5)",
        [id, opts.company ?? companyId, `test/${id}.jpg`, opts.purpose ?? 'product_image', opts.uploaded === false ? null : new Date()],
      );
      return id;
    };
    const images = async (productId: string) =>
      (await testPool().query('select file_id from product.product_images where product_id = $1 order by position', [productId])).rows.map((r) => r.file_id);
    const chart = async (productId: string) => (await testPool().query('select size_chart_file_id from product.products where id = $1', [productId])).rows[0].size_chart_file_id;

    it('sản phẩm chưa có ảnh, bảng size: gắn theo thứ tự, bỏ trùng và tệp không dùng được, tăng version, nhật ký', async () => {
      const v = await createVariant(companyId);
      const [a, b, c] = [await file(), await file(), await file()];
      const notUploaded = await file({ uploaded: false });
      const attachment = await file({ purpose: 'attachment' });
      const foreign = await file({ company: (await createCompany({ optionalModules: [] })).companyId });
      const p0 = await product(v.productId);
      const res = await fill(v.productId, { imageFileIds: [a, notUploaded, b, a, attachment, foreign], sizeChartFileId: c });
      expect(res.filled.sort()).toEqual(['images', 'sizeChartFileId']);
      expect(await images(v.productId)).toEqual([a, b]);
      expect(await chart(v.productId)).toBe(c);
      expect((await product(v.productId)).version).toBe(p0.version + 1);
      const [log] = await audits(v.productId);
      expect(log).toMatchObject({ actor_id: null, before: { images: [], sizeChartFileId: null }, after: { images: [a, b], sizeChartFileId: c, source } });
    });

    it('sản phẩm đã có ảnh, bảng size: giữ nguyên, không tăng version', async () => {
      const v = await createVariant(companyId);
      const [own, ownChart] = [await file(), await file()];
      await fill(v.productId, { imageFileIds: [own], sizeChartFileId: ownChart });
      const p0 = await product(v.productId);
      expect(await fill(v.productId, { imageFileIds: [await file()], sizeChartFileId: await file() })).toEqual({ filled: [] });
      expect(await images(v.productId)).toEqual([own]);
      expect(await chart(v.productId)).toBe(ownChart);
      expect((await product(v.productId)).version).toBe(p0.version);
    });

    it('tối đa 9 ảnh; mọi tệp hỏng thì không gắn gì', async () => {
      const v = await createVariant(companyId);
      const ids = await Promise.all(Array.from({ length: 11 }, () => file()));
      await fill(v.productId, { imageFileIds: ids });
      expect(await images(v.productId)).toEqual(ids.slice(0, 9));
      const w = await createVariant(companyId);
      expect(await fill(w.productId, { imageFileIds: [await file({ uploaded: false }), 'khong-phai-uuid'] })).toEqual({ filled: [] });
      expect(await images(w.productId)).toEqual([]);
    });

    it('productMediaGaps báo sản phẩm thiếu ảnh, thiếu bảng size', async () => {
      const full = await createVariant(companyId);
      await fill(full.productId, { imageFileIds: [await file()], sizeChartFileId: await file() });
      const empty = await createVariant(companyId);
      const gaps = await withCompany(companyId, () => productMediaGaps([full.productId, empty.productId]));
      expect(gaps.get(full.productId)).toEqual({ images: false, sizeChart: false });
      expect(gaps.get(empty.productId)).toEqual({ images: true, sizeChart: true });
    });
  });
});
