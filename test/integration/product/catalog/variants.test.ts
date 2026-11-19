import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import {
  type AttributeBody,
  api,
  archiveSku,
  auditOf,
  businessStatus,
  createAttribute,
  createGroup,
  createProduct,
  valueId,
  uniq,
} from './helpers.ts';

// Thêm, ngừng bán biến thể (UC-CP-02; Documents/21 5.2, 5.3, P5, P7, V23; plan #12 B3, B5, B8, B11).
let companyId: string;
let token: string;
let color: AttributeBody;
let size: AttributeBody;
beforeAll(async () => {
  const company = await createCompany();
  companyId = company.companyId;
  token = company.ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng', 'Xám']);
  size = await createAttribute(token, 'Size', ['M', 'XL']);
});

const shirt = async () => {
  const group = await createGroup(token, uniq('Áo'), 'AO-{SEQ:4}-{VAL}');
  return createProduct(token, {
    name: uniq('Áo'),
    groupId: group.id,
    variants: [
      [valueId(color, 'Đen'), valueId(size, 'XL')],
      [valueId(color, 'Trắng'), valueId(size, 'XL')],
    ],
  });
};
const add = (productId: string, ids: string[]) => api(token).post(`/products/${productId}/variants`, { attributeValueIds: ids });
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

  it('tổ hợp của SKU đã lưu trữ → 409 variant_archived kèm variantId, không cấp SKU mới (Documents/21 §17.2)', async () => {
    const product = await shirt();
    const old = product.variants[0]!;
    await archiveSku(token, product.id, old.id);
    const res = await add(product.id, [valueId(color, 'Đen'), valueId(size, 'XL')]);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/variant_archived');
    expect(res.body.variantId).toBe(old.id);
    expect((await detailOf(product.id)).variants).toHaveLength(2);
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
    const group = await createGroup(token, uniq('Phụ kiện'), 'PK-{SEQ}');
    const product = await createProduct(token, { name: uniq('Ví'), groupId: group.id, variants: [[]] });
    const res = await add(product.id, []);
    expect(res.status).toBe(422);
    expect(res.body.errors.attributeValueIds).toBe('Sản phẩm tạo không có thuộc tính nên chỉ có một biến thể');
  });
});

describe('lưu trữ SKU (thay ngừng bán kiểu cũ, #204)', () => {
  it('route ngừng bán cũ DELETE …/variants/:variantId đã bỏ → 404', async () => {
    const product = await shirt();
    expect((await api(token).delete(`/products/${product.id}/variants/${product.variants[1]!.id}`)).status).toBe(404);
  });

  it('SKU lưu trữ có archivedAt, vẫn trong chi tiết, SKU không cấp lại', async () => {
    const product = await shirt();
    const target = product.variants[1]!;
    await archiveSku(token, product.id, target.id);
    const detail = await detailOf(product.id);
    expect(detail.variants.find((v: { id: string }) => v.id === target.id).archivedAt).toEqual(expect.any(String));
    expect(detail).toMatchObject({ variantCount: 1, version: 1 });
    // Số {SEQ} chạy chung công ty nên không tự quay lại số cũ; đặt lại về đúng số của SKU đã lưu trữ (như khi đổi mẫu rồi trở
    // lại) để SKU mới đầu tiên trùng nó và phải nhảy qua.
    const seq = Number(/-(\d{4})-/.exec(target.sku)![1]);
    await testPool().query('update product.company_product_settings set sku_next_seq = $2 where company_id = $1', [companyId, seq]);
    const group = await createGroup(token, uniq('Cùng mẫu'), 'AO-{SEQ:4}-{VAL}');
    const again = await createProduct(token, {
      name: uniq('Áo'),
      groupId: group.id,
      variants: [[valueId(color, 'Trắng'), valueId(size, 'XL')], [valueId(color, 'Đen'), valueId(size, 'XL')]],
    });
    expect(again.variants.map((v) => v.sku)).not.toContain(target.sku);
  });

  it('lưu trữ được cả SKU cuối (bỏ last_variant)', async () => {
    const product = await shirt();
    await archiveSku(token, product.id, product.variants[0]!.id);
    await archiveSku(token, product.id, product.variants[1]!.id);
    expect((await detailOf(product.id)).variantCount).toBe(0);
  });
});

describe('chạy đua (S-3 c, d; plan B5)', () => {
  it('hai lần Ngừng nhập song song cùng SKU: một 200, một 409 invalid_transition (khoá công ty)', async () => {
    const product = await shirt();
    const variantId = product.variants[0]!.id;
    // Giữ khoá công ty của catalog: cả hai request phải chờ (thiếu khoá thì cả hai đã đọc "selling" trước khi chờ).
    const results = await raceBehindLock(
      (holder) => holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`catalog.sku:${companyId}`]),
      2,
      () => Promise.all([0, 1].map(() => businessStatus(token, product.id, 'discontinue', [variantId]))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.type).toBe('/problems/invalid_transition');
  });

  it('hai lần thêm cùng tổ hợp mới song song: một 201, một 409, chỉ một biến thể mang tổ hợp đó', async () => {
    const product = await shirt();
    const ids = [valueId(color, 'Xám'), valueId(size, 'M')];
    const results = await Promise.all([add(product.id, ids), add(product.id, ids)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await detailOf(product.id)).variants).toHaveLength(3);
  });
});

// Khoá trục (#340, Documents/21 §17.2, §17.4 `axis_locked`): chưa route nào thêm, bớt trục hay chuyển SKU sang cha khác;
// thêm biến thể chỉ nhận đúng bộ trục của sản phẩm, kể cả khi SKU đang có listing chưa gỡ.
describe('không đổi được trục phân loại (#340, AC-13)', () => {
  it('thêm biến thể mang thêm trục hoặc thiếu trục → 422 errors.attributeValueIds, kể cả khi SKU có listing live', async () => {
    const material = await createAttribute(token, uniq('Chất'), ['Cotton']);
    const product = await shirt();
    const shop = await testPool().query<{ id: string }>(
      `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop Thử') returning id`,
      [companyId, randomUUID()],
    );
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku) values ($1, $2, $3, 'live', $4)`,
      [companyId, shop.rows[0]!.id, product.variants[0]!.id, `CMR-${randomUUID().slice(0, 8)}`],
    );
    for (const ids of [[valueId(color, 'Xám'), valueId(size, 'M'), valueId(material, 'Cotton')], [valueId(color, 'Xám')]]) {
      const res = await add(product.id, ids);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.errors.attributeValueIds).toBe('Chọn đủ mỗi thuộc tính một giá trị');
    }
    const after = (await detailOf(product.id)).variants as { attributes: { attributeId: string }[] }[];
    expect(after).toHaveLength(2);
    expect(after.map((v) => v.attributes.map((a) => a.attributeId))).toEqual(Array(2).fill([color.id, size.id]));
  });
});
