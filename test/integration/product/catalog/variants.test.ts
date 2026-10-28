import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { type AttributeBody, api, auditOf, createAttribute, createCategory, createProduct, valueId, uniq } from './helpers.ts';

// Thêm, ngừng bán biến thể (UC-CP-02; Documents/21 5.2, 5.3, P5, P7, V23; plan #12 B3, B5, B8, B11).
let token: string;
let color: AttributeBody;
let size: AttributeBody;
beforeAll(async () => {
  token = (await createCompany()).ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng', 'Xám']);
  size = await createAttribute(token, 'Size', ['M', 'XL']);
});

const shirt = async () => {
  const category = await createCategory(token, uniq('Áo'), 'AO-{SEQ:4}-{VAL}');
  return createProduct(token, {
    name: uniq('Áo'),
    categoryId: category.id,
    variants: [
      [valueId(color, 'Đen'), valueId(size, 'XL')],
      [valueId(color, 'Trắng'), valueId(size, 'XL')],
    ],
  });
};
const add = (productId: string, ids: string[]) => api(token).post(`/products/${productId}/variants`, { attributeValueIds: ids });
const stop = (productId: string, variantId: string) => api(token).delete(`/products/${productId}/variants/${variantId}`);
const detailOf = async (id: string) => (await api(token).get(`/products/${id}`)).body;

describe('POST /catalog/products/:id/variants', () => {
  it('tổ hợp mới → 201 SKU mới, thứ tự thuộc tính theo sản phẩm dù gửi đảo; version sản phẩm giữ nguyên (AC-10)', async () => {
    const product = await shirt();
    const res = await add(product.id, [valueId(size, 'M'), valueId(color, 'Xám')]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sku: 'AO-0003-XAM-M', archivedAt: null });
    expect(res.body.attributes.map((a: { value: string }) => a.value)).toEqual(['Xám', 'M']);
    expect(await detailOf(product.id)).toMatchObject({ version: 1, variantCount: 3 });
    expect(await auditOf(res.body.id)).toEqual([
      { action: 'create', entity_type: 'product.product_variants', before: null, after: { product: product.name, sku: 'AO-0003-XAM-M', attributes: ['Xám', 'M'] } },
    ]);
  });

  it('tổ hợp đang bán → 409 variant_exists (AC-10)', async () => {
    const product = await shirt();
    const res = await add(product.id, [valueId(size, 'XL'), valueId(color, 'Đen')]);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/variant_exists');
  });

  it('tổ hợp từng ngừng bán → 200, bán lại đúng biến thể và SKU cũ, nhật ký update (AC-10, B8)', async () => {
    const product = await shirt();
    const old = product.variants[0]!;
    expect((await stop(product.id, old.id)).status).toBe(204);
    const res = await add(product.id, [valueId(color, 'Đen'), valueId(size, 'XL')]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: old.id, sku: old.sku, archivedAt: null });
    expect(await detailOf(product.id)).toMatchObject({ version: 1, variantCount: 2 });
    expect((await auditOf(old.id)).map((l) => l.action)).toEqual(['delete', 'update']);
  });

  it.each([
    ['thiếu thuộc tính', () => [valueId(color, 'Xám')]],
    ['thừa thuộc tính', () => [valueId(color, 'Xám'), valueId(size, 'M'), randomUUID()]],
    ['hai giá trị cùng thuộc tính', () => [valueId(color, 'Xám'), valueId(color, 'Đen')]],
    ['giá trị không phải uuid', () => ['abc', valueId(size, 'M')]],
  ])('%s → 422 errors.attributeValueIds (AC-17)', async (_case, ids) => {
    const product = await shirt();
    const res = await add(product.id, ids());
    expect(res.status).toBe(422);
    expect(res.body.errors.attributeValueIds).toBeTruthy();
  });

  it('giá trị của công ty khác → 422, không thêm biến thể (S-6)', async () => {
    const other = await createCompany();
    const theirs = await createAttribute(other.ceo.token, uniq('Màu'), ['Đỏ']);
    const product = await shirt();
    const res = await add(product.id, [valueId(theirs, 'Đỏ'), valueId(size, 'M')]);
    expect(res.status).toBe(422);
    expect((await detailOf(product.id)).variants).toHaveLength(2);
  });

  it('sản phẩm không có thuộc tính → 422 errors.attributeValueIds (B11)', async () => {
    const category = await createCategory(token, uniq('Phụ kiện'), 'PK-{SEQ}');
    const product = await createProduct(token, { name: uniq('Ví'), categoryId: category.id, variants: [[]] });
    const res = await add(product.id, []);
    expect(res.status).toBe(422);
    expect(res.body.errors.attributeValueIds).toBe('Sản phẩm tạo không có thuộc tính nên chỉ có một biến thể');
  });
});

describe('DELETE /catalog/products/:id/variants/:variantId', () => {
  it('còn nhiều biến thể → 204, biến thể có archivedAt, vẫn trong chi tiết, SKU không cấp lại (AC-11)', async () => {
    const product = await shirt();
    const target = product.variants[1]!;
    expect((await stop(product.id, target.id)).status).toBe(204);
    const detail = await detailOf(product.id);
    expect(detail.variants.find((v: { id: string }) => v.id === target.id).archivedAt).toEqual(expect.any(String));
    expect(detail).toMatchObject({ variantCount: 1, version: 1 });
    // Danh mục khác cùng quy tắc tới đúng số đó thì nhảy qua SKU đã ngừng bán.
    const category = await createCategory(token, uniq('Cùng quy tắc'), 'AO-{SEQ:4}-{VAL}');
    const again = await createProduct(token, {
      name: uniq('Áo'),
      categoryId: category.id,
      variants: [[valueId(color, 'Đen'), valueId(size, 'XL')], [valueId(color, 'Trắng'), valueId(size, 'XL')]],
    });
    expect(again.variants.map((v) => v.sku)).not.toContain(target.sku);
  });

  it('biến thể cuối còn bán → 409 last_variant (AC-11)', async () => {
    const product = await shirt();
    await stop(product.id, product.variants[0]!.id);
    const res = await stop(product.id, product.variants[1]!.id);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/last_variant');
  });

  it('biến thể đã ngừng, không có, hoặc của sản phẩm khác → 404', async () => {
    const product = await shirt();
    const other = await shirt();
    await stop(product.id, product.variants[0]!.id);
    for (const variantId of [product.variants[0]!.id, randomUUID(), 'abc', other.variants[0]!.id]) {
      expect((await stop(product.id, variantId)).status).toBe(404);
    }
  });
});

describe('chạy đua (S-3 c, d; plan B5)', () => {
  it('hai lần ngừng bán song song trên sản phẩm còn 2 biến thể: một 204, một 409, còn đúng 1 biến thể đang bán', async () => {
    const product = await shirt();
    // Giữ khoá dòng sản phẩm: cả hai request phải chờ (thiếu khoá công ty thì cả hai đã đếm "còn 2" trước khi chờ).
    const results = await raceBehindLock(
      (holder) => holder.query('select 1 from product.products where id = $1 for update', [product.id]),
      2,
      () => Promise.all(product.variants.map((v) => stop(product.id, v.id))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect((await detailOf(product.id)).variantCount).toBe(1);
  });

  it('hai lần thêm cùng tổ hợp mới song song: một 201, một 409, chỉ một biến thể mang tổ hợp đó', async () => {
    const product = await shirt();
    const ids = [valueId(color, 'Xám'), valueId(size, 'M')];
    const results = await Promise.all([add(product.id, ids), add(product.id, ids)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await detailOf(product.id)).variants).toHaveLength(3);
  });
});
