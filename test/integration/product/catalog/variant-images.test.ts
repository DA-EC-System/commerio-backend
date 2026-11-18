import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { type AttributeBody, api, auditOf, createAttribute, createCategory, createProduct, uniq, valueId } from './helpers.ts';

// Ảnh phân loại theo giá trị của thuộc tính gắn ảnh (#340, Documents/21 §17.2): chọn thuộc tính gắn ảnh ở PUT sản phẩm.
let token: string;
let companyId: string;
let color: AttributeBody;
let size: AttributeBody;
let material: AttributeBody;
let otherColor: AttributeBody;
beforeAll(async () => {
  const company = await createCompany();
  token = company.ceo.token;
  companyId = company.companyId;
  color = await createAttribute(token, 'Màu', ['Trắng', 'Đen', 'Xanh']);
  size = await createAttribute(token, 'Size', ['M', 'L']);
  material = await createAttribute(token, 'Chất liệu', ['Cotton']);
  otherColor = await createAttribute((await createCompany()).ceo.token, 'Màu', ['Trắng']);
});

interface Detail {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
  imageAttributeId: string | null;
  attributeValueImages: { attributeValueId: string; fileId: string; url: string }[];
}

/** Áo trục Màu (Trắng, Đen) × Size (M, L), 4 SKU. */
async function shirt(): Promise<Detail> {
  const category = await createCategory(token, uniq('Áo'), 'AO-{SEQ}-{VAL}');
  const combos = ['Trắng', 'Đen'].flatMap((c) => ['M', 'L'].map((s) => [valueId(color, c), valueId(size, s)]));
  const created = await createProduct(token, { name: uniq('Áo'), categoryId: category.id, variants: combos });
  return (await api(token).get(`/products/${created.id}`)).body as Detail;
}

const put = (p: Detail, extra: object, t = token) =>
  api(t).put(`/products/${p.id}`, { name: p.name, description: '', version: p.version, ...extra });
const read = async (p: { id: string }) => (await api(token).get(`/products/${p.id}`)).body as Detail;

/** Ảnh phân loại chèn thẳng (route đặt ảnh ở lát sau có test riêng). */
async function insertImage(p: { id: string }, attributeId: string, attributeValueId: string) {
  await testPool().query(
    `insert into product.product_attribute_value_images (company_id, product_id, attribute_id, attribute_value_id, file_id)
     values ($1, $2, $3, $4, $5)`,
    [companyId, p.id, attributeId, attributeValueId, randomUUID()],
  );
}
const imageCount = async (p: { id: string }) =>
  (await testPool().query('select 1 from product.product_attribute_value_images where product_id = $1', [p.id])).rowCount;

describe('PUT /catalog/products/:id: thuộc tính gắn ảnh (#340)', () => {
  it('chọn Màu → 200, imageAttributeId là Màu, version tăng; đọc lại khớp; bỏ trường thì giữ nguyên (AC-1)', async () => {
    const p = await shirt();
    expect(p).toMatchObject({ imageAttributeId: null, attributeValueImages: [] });
    const res = await put(p, { imageAttributeId: color.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ imageAttributeId: color.id, version: p.version + 1 });
    expect(await read(p)).toMatchObject({ imageAttributeId: color.id, version: p.version + 1 });

    const kept = await put(res.body as Detail, {});
    expect(kept.status).toBe(200);
    expect(kept.body.imageAttributeId).toBe(color.id);
  });

  it('thuộc tính không phải trục, của công ty khác, không phải uuid → 422 errors.imageAttributeId; không đổi (AC-2)', async () => {
    const p = await shirt();
    for (const id of [material.id, otherColor.id, 'khong-phai-uuid']) {
      const res = await put(p, { imageAttributeId: id });
      expect(res.status, id).toBe(422);
      expect(res.body.errors.imageAttributeId).toBe('Thuộc tính không phải trục phân loại của sản phẩm');
    }
    expect(await read(p)).toMatchObject({ imageAttributeId: null, version: p.version });
  });

  it('đổi sang Size hoặc null khi đang có ảnh → 200, xoá mọi ảnh phân loại; gửi lại đúng thuộc tính đang chọn thì giữ ảnh (AC-3)', async () => {
    const p = (await put(await shirt(), { imageAttributeId: color.id })).body as Detail;
    await insertImage(p, color.id, valueId(color, 'Trắng'));
    await insertImage(p, color.id, valueId(color, 'Đen'));

    const same = (await put(p, { imageAttributeId: color.id })).body as Detail;
    expect(same.attributeValueImages.map((i) => i.attributeValueId)).toEqual([valueId(color, 'Trắng'), valueId(color, 'Đen')]);
    expect(await imageCount(p)).toBe(2);

    const toSize = await put(same, { imageAttributeId: size.id });
    expect(toSize.status, JSON.stringify(toSize.body)).toBe(200);
    expect(toSize.body).toMatchObject({ imageAttributeId: size.id, attributeValueImages: [] });
    expect(await imageCount(p)).toBe(0);

    await insertImage(p, size.id, valueId(size, 'M'));
    const cleared = await put(toSize.body as Detail, { imageAttributeId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ imageAttributeId: null, attributeValueImages: [] });
    expect(await imageCount(p)).toBe(0);
  });

  it('version cũ khi có ảnh và đổi thuộc tính → 409, ảnh còn nguyên', async () => {
    const p = (await put(await shirt(), { imageAttributeId: color.id })).body as Detail;
    await insertImage(p, color.id, valueId(color, 'Trắng'));
    const res = await put({ ...p, version: p.version - 1 }, { imageAttributeId: size.id });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(await imageCount(p)).toBe(1);
    expect((await read(p)).imageAttributeId).toBe(color.id);
  });

  it('chỉ có quyền xem → 403 trước khi kiểm body (AC-S2)', async () => {
    const p = await shirt();
    const viewer = await addMember(companyId, await createCustomRole(companyId, ['catalog.product.view']));
    expect((await put(p, { imageAttributeId: color.id }, viewer.token)).status).toBe(403);
    expect((await api(viewer.token).put(`/products/${p.id}`, { imageAttributeId: 5 })).status).toBe(403);
  });

  it('nhật ký update ghi imageAttributeId trước và sau (AC-S6)', async () => {
    const p = await shirt();
    const first = (await put(p, { imageAttributeId: color.id })).body as Detail;
    await put(first, { imageAttributeId: size.id });
    const updates = (await auditOf(p.id)).filter((l) => l.action === 'update');
    expect(updates[0]!.before).not.toHaveProperty('imageAttributeId');
    expect(updates[0]!.after).toMatchObject({ imageAttributeId: color.id });
    expect(updates[1]).toMatchObject({ before: { imageAttributeId: color.id }, after: { imageAttributeId: size.id } });
  });
});
