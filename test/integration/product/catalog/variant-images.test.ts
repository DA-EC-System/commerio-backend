import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setHeadObject } from '#src/modules/core/files/service/storage.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { type AttributeBody, api, archiveSku, auditOf, createAttribute, createGroup, createProduct, uniq, valueId } from './helpers.ts';

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
  const group = await createGroup(token, uniq('Áo'), 'AO-{SEQ}-{VAL}');
  const combos = ['Trắng', 'Đen'].flatMap((c) => ['M', 'L'].map((s) => [valueId(color, c), valueId(size, s)]));
  const created = await createProduct(token, { name: uniq('Áo'), groupId: group.id, variants: combos });
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
    for (const id of [material.id, otherColor.id, 'khong-phai-uuid', '']) {
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
    expect(toSize.body.variants.map((v: { image: unknown }) => v.image)).toEqual([null, null, null, null]);
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

  it('đổi thuộc tính gắn ảnh khi còn ảnh: nhật ký ghi các ảnh phân loại bị gỡ ở before (AC-S6, review N2)', async () => {
    const p = await shirt();
    const first = (await put(p, { imageAttributeId: color.id })).body as Detail;
    const images = [];
    for (const value of ['Trắng', 'Đen']) {
      const fileId = randomUUID();
      await testPool().query(
        `insert into product.product_attribute_value_images (company_id, product_id, attribute_id, attribute_value_id, file_id)
         values ($1, $2, $3, $4, $5)`,
        [companyId, p.id, color.id, valueId(color, value), fileId],
      );
      images.push({ attributeValueId: valueId(color, value), fileId });
    }
    expect((await put(first, { imageAttributeId: size.id })).status).toBe(200);
    const last = (await auditOf(p.id)).filter((l) => l.action === 'update').at(-1)!;
    expect(last.before).toMatchObject({ imageAttributeId: color.id, attributeValueImages: images });
    expect(last.after).not.toHaveProperty('attributeValueImages');
  });
});

// ---------- Route đặt, gỡ ảnh phân loại (lát 3) ----------

/** Tệp ảnh của công ty chèn thẳng vào `core.files` (như `file-problem.test.ts`); `uploaded: false` là chưa PUT lên kho. */
async function fileRow(
  owner: string,
  f: { purpose?: 'product_image' | 'attachment'; name?: string; contentType?: string; sizeBytes?: number; uploaded?: boolean } = {},
) {
  const id = randomUUID();
  await testPool().query(
    `insert into core.files (id, company_id, storage_key, file_name, content_type, size_bytes, purpose, uploaded_at)
     values ($1, $2, $3, $4, $5, $6, $7, case when $8::boolean then now() end)`,
    [id, owner, `test/${id}.png`, f.name ?? 'anh.png', f.contentType ?? 'image/png', f.sizeBytes ?? 2048, f.purpose ?? 'product_image', f.uploaded ?? true],
  );
  return id;
}
const fileExists = async (id: string) => (await testPool().query('select 1 from core.files where id = $1', [id])).rowCount === 1;

interface DetailWithVariants extends Detail {
  variants: { id: string; attributes: { valueId: string }[]; image: unknown }[];
}

/** Áo đã chọn Màu làm thuộc tính gắn ảnh. */
async function colored(): Promise<DetailWithVariants> {
  return (await put(await shirt(), { imageAttributeId: color.id })).body as DetailWithVariants;
}
const imagePath = (p: { id: string }, valueIdOrRaw: string) => `/products/${p.id}/attribute-value-images/${valueIdOrRaw}`;
const setImage = (p: { id: string }, value: string, fileId: unknown, t = token) => api(t).put(imagePath(p, value), { fileId });
const removeImage = (p: { id: string }, value: string, t = token) => api(t).delete(imagePath(p, value));
const auditCount = async (id: string) =>
  (await testPool().query('select 1 from core.audit_logs where entity_id = $1', [id])).rowCount;

describe('PUT, DELETE /catalog/products/:id/attribute-value-images/:attributeValueId (#340)', () => {
  beforeAll(() => setHeadObject(async () => null));
  afterAll(() => setHeadObject(null));

  it('đặt ảnh Trắng → 200 ProductDetail có ảnh; version giữ, updatedAt đổi; đọc lại khớp (AC-4)', async () => {
    const p = await colored();
    const fileId = await fileRow(companyId);
    const res = await setImage(p, valueId(color, 'Trắng'), fileId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.attributeValueImages).toEqual([
      { attributeValueId: valueId(color, 'Trắng'), fileId, url: expect.stringContaining('https://') },
    ]);
    expect(res.body.version).toBe(p.version);
    expect(res.body.updatedAt).not.toBe(p.updatedAt);
    expect((await read(p)).attributeValueImages).toEqual(res.body.attributeValueImages);
    // Hai SKU Trắng (M, L) cùng ảnh, hai SKU Đen null.
    const white = res.body.attributeValueImages[0];
    const images = ((await read(p)) as DetailWithVariants).variants.map((v) => v.image);
    expect(images).toEqual([white, white, null, null]);
  });

  it('đặt lại bằng tệp khác: vẫn 1 dòng, tệp cũ còn; gửi lại đúng tệp đang có → 200, không thêm nhật ký (AC-5)', async () => {
    const p = await colored();
    const first = await fileRow(companyId);
    const second = await fileRow(companyId);
    await setImage(p, valueId(color, 'Trắng'), first);
    const res = await setImage(p, valueId(color, 'Trắng'), second);
    expect(res.status).toBe(200);
    expect(res.body.attributeValueImages).toEqual([expect.objectContaining({ fileId: second })]);
    expect(await imageCount(p)).toBe(1);
    expect(await fileExists(first)).toBe(true);
    const logs = await auditCount(p.id);
    const again = await setImage(p, valueId(color, 'Trắng'), second);
    expect(again.status).toBe(200);
    expect(await auditCount(p.id)).toBe(logs);
  });

  it('sản phẩm chưa chọn thuộc tính gắn ảnh → 422 errors.attributeValueId (AC-6)', async () => {
    const p = await shirt();
    const res = await setImage(p, valueId(color, 'Trắng'), await fileRow(companyId));
    expect(res.status).toBe(422);
    expect(res.body.errors.attributeValueId).toBe('Sản phẩm chưa chọn thuộc tính gắn ảnh');
    expect(await imageCount(p)).toBe(0);
  });

  it('giá trị của Size, giá trị Màu không SKU nào mang, của công ty khác, không phải uuid → 422; SKU lưu trữ vẫn tính là có mang (AC-7)', async () => {
    const p = await colored();
    const fileId = await fileRow(companyId);
    for (const bad of [valueId(size, 'M'), valueId(color, 'Xanh'), valueId(otherColor, 'Trắng'), 'khong-phai-uuid']) {
      const res = await setImage(p, bad, fileId);
      expect(res.status, bad).toBe(422);
      expect(res.body.errors.attributeValueId).toBe('Giá trị không thuộc thuộc tính gắn ảnh của sản phẩm');
    }
    expect(await imageCount(p)).toBe(0);

    const added = await api(token).post(`/products/${p.id}/variants`, { attributeValueIds: [valueId(color, 'Xanh'), valueId(size, 'M')] });
    expect(added.status).toBe(201);
    await archiveSku(token, p.id, added.body.id);
    expect((await setImage(p, valueId(color, 'Xanh'), fileId)).status).toBe(200);
  });

  it('tệp chưa tải xong, của công ty khác, là tệp đính kèm, id sai dạng; sai kiểu; quá 1 MB → 422 errors.image, không ghi (AC-8)', async () => {
    const p = await colored();
    const white = valueId(color, 'Trắng');
    const otherCompany = (await createCompany()).companyId;
    const unusable = [
      await fileRow(companyId, { uploaded: false }),
      await fileRow(otherCompany),
      await fileRow(companyId, { purpose: 'attachment' }),
      'khong-phai-uuid',
    ];
    for (const fileId of unusable) {
      const res = await setImage(p, white, fileId);
      expect(res.status, fileId).toBe(422);
      expect(res.body.errors.image).toBe('Có ảnh chưa tải xong hoặc không thuộc công ty');
    }
    const gif = await setImage(p, white, await fileRow(companyId, { name: 'dong.gif', contentType: 'image/gif' }));
    expect(gif.body.errors.image).toBe('Ảnh dong.gif không phải JPG hoặc PNG');
    const big = await setImage(p, white, await fileRow(companyId, { name: 'to.png', sizeBytes: 2 * 1024 * 1024 }));
    expect(big.body.errors.image).toBe('Ảnh to.png lớn hơn 1 MB');

    const both = await setImage(p, valueId(size, 'M'), await fileRow(companyId, { uploaded: false }));
    expect(both.status).toBe(422);
    expect(Object.keys(both.body.errors).sort()).toEqual(['attributeValueId', 'image']);
    expect(await imageCount(p)).toBe(0);
  });

  it('DELETE gỡ ảnh, tệp còn; giá trị chưa có ảnh hoặc không phải uuid → 200 bản hiện tại, không nhật ký (AC-9)', async () => {
    const p = await colored();
    const fileId = await fileRow(companyId);
    await setImage(p, valueId(color, 'Trắng'), fileId);
    const res = await removeImage(p, valueId(color, 'Trắng'));
    expect(res.status).toBe(200);
    expect(res.body.attributeValueImages).toEqual([]);
    expect(await fileExists(fileId)).toBe(true);
    const logs = await auditCount(p.id);
    for (const value of [valueId(color, 'Đen'), 'khong-phai-uuid']) {
      const again = await removeImage(p, value);
      expect(again.status, value).toBe(200);
      expect(again.body.id).toBe(p.id);
    }
    expect(await auditCount(p.id)).toBe(logs);
  });

  it('sản phẩm công ty khác, không có, id sai dạng → 404; ảnh của công ty kia không đổi (AC-10)', async () => {
    const p = await colored();
    await setImage(p, valueId(color, 'Trắng'), await fileRow(companyId));
    const outsider = await createCompany();
    const theirFile = await fileRow(outsider.companyId);
    for (const id of [p.id, randomUUID(), 'khong-phai-uuid']) {
      const set = await setImage({ id }, valueId(color, 'Đen'), theirFile, outsider.ceo.token);
      expect(set.status, id).toBe(404);
      expect(set.body.type).toBe('/problems/not_found');
      expect((await removeImage({ id }, valueId(color, 'Trắng'), outsider.ceo.token)).status).toBe(404);
    }
    expect(await imageCount(p)).toBe(1);
  });

  it('đổi thuộc tính khi đã có ảnh thật: ảnh gỡ hết, tệp còn ở core.files (AC-3, phần có ảnh)', async () => {
    const p = await colored();
    const white = await fileRow(companyId);
    const black = await fileRow(companyId);
    await setImage(p, valueId(color, 'Trắng'), white);
    await setImage(p, valueId(color, 'Đen'), black);
    const res = await put(await read(p), { imageAttributeId: size.id });
    expect(res.status).toBe(200);
    expect(res.body.attributeValueImages).toEqual([]);
    expect(await fileExists(white)).toBe(true);
    expect(await fileExists(black)).toBe(true);
  });

  it('nhật ký update product.products ghi attributeValueImage trước và sau khi đặt, thay, gỡ (AC-S6)', async () => {
    const p = await colored();
    const white = valueId(color, 'Trắng');
    const a = await fileRow(companyId);
    const b = await fileRow(companyId);
    await setImage(p, white, a);
    await setImage(p, white, b);
    await removeImage(p, white);
    const logs = (await auditOf(p.id)).filter((l) => JSON.stringify([l.before, l.after]).includes('attributeValueImage'));
    expect(logs.map((l) => [l.action, l.entity_type, l.before, l.after])).toEqual([
      ['update', 'product.products', { attributeValueImage: { attributeValueId: white, fileId: null } }, { attributeValueImage: { attributeValueId: white, fileId: a } }],
      ['update', 'product.products', { attributeValueImage: { attributeValueId: white, fileId: a } }, { attributeValueImage: { attributeValueId: white, fileId: b } }],
      ['update', 'product.products', { attributeValueImage: { attributeValueId: white, fileId: b } }, { attributeValueImage: { attributeValueId: white, fileId: null } }],
    ]);
  });

  it('thiếu token → 401; chỉ có quyền xem → 403 kể cả body sai (AC-S1, AC-S2)', async () => {
    const p = await colored();
    const white = valueId(color, 'Trắng');
    const app = testApp();
    expect((await request(app).put(`/api/v1/catalog${imagePath(p, white)}`).send({ fileId: randomUUID() })).status).toBe(401);
    expect((await request(app).delete(`/api/v1/catalog${imagePath(p, white)}`)).status).toBe(401);
    expect((await request(app).put(`/api/v1/catalog/products/${p.id}`).send({})).status).toBe(401);
    const viewer = await addMember(companyId, await createCustomRole(companyId, ['catalog.product.view']));
    expect((await setImage(p, white, await fileRow(companyId), viewer.token)).status).toBe(403);
    expect((await api(viewer.token).put(imagePath(p, white), { nope: 1 })).status).toBe(403);
    expect((await removeImage(p, white, viewer.token)).status).toBe(403);
  });

  it('SKU có listing live: đặt, gỡ ảnh vẫn 200, listing không đổi trạng thái (AC-18)', async () => {
    const shopOwner = await createCompany({ optionalModules: ['channel'] });
    const t = shopOwner.ceo.token;
    const c = await createAttribute(t, 'Màu', ['Trắng', 'Đen']);
    const group = await createGroup(t, uniq('Áo'), 'AL-{SEQ}-{VAL}');
    const created = await createProduct(t, { name: uniq('Áo'), groupId: group.id, variants: [[valueId(c, 'Trắng')], [valueId(c, 'Đen')]] });
    const chosen = await api(t).put(`/products/${created.id}`, { name: created.name, description: '', version: created.version, imageAttributeId: c.id });
    expect(chosen.status).toBe(200);
    const shop = await testPool().query<{ id: string }>(
      `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop Thử') returning id`,
      [shopOwner.companyId, randomUUID()],
    );
    const listing = await testPool().query<{ id: string }>(
      `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku) values ($1, $2, $3, 'live', $4) returning id`,
      [shopOwner.companyId, shop.rows[0]!.id, created.variants[0]!.id, `CMR-${randomUUID().slice(0, 8)}`],
    );
    const set = await setImage(created, valueId(c, 'Trắng'), await fileRow(shopOwner.companyId), t);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await removeImage(created, valueId(c, 'Trắng'), t)).status).toBe(200);
    const after = await testPool().query('select status from channel.listings where id = $1', [listing.rows[0]!.id]);
    expect(after.rows[0]).toEqual({ status: 'live' });
  });
});

/** Số phiên đang chờ (thẳng hoặc xếp hàng sau phiên chờ) sau phiên `pid`, như `helpers/locks.ts`. */
async function blockedBehind(pid: number): Promise<number> {
  const r = await testPool().query<{ n: number }>(
    `with direct as (select pid from pg_stat_activity where pg_blocking_pids(pid) @> array[$1]::int[])
     select (select count(*) from direct)::int + (select count(*) from pg_stat_activity
       where pid not in (select pid from direct) and pg_blocking_pids(pid) && array(select pid from direct))::int as n`,
    [pid],
  );
  return r.rows[0]!.n;
}
async function waitBlocked(pid: number, n: number) {
  for (let i = 0; i < 100 && (await blockedBehind(pid)) < n; i++) await new Promise((r) => setTimeout(r, 50));
}

/**
 * Hai request xếp hàng đúng thứ tự sau khoá dòng sản phẩm: gửi `first`, chờ nó bị chặn, rồi mới gửi `second` (AC-S8).
 * Khoá dòng nhả theo thứ tự xếp hàng.
 */
async function inOrder(productId: string, first: () => request.Test, second: () => request.Test) {
  let pid = 0;
  return raceBehindLock(
    async (holder) => {
      pid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await holder.query('select 1 from product.products where id = $1 for update', [productId]);
    },
    2,
    async () => {
      const a = Promise.resolve(first());
      await waitBlocked(pid, 1);
      const b = Promise.resolve(second());
      return Promise.all([a, b]);
    },
  );
}

describe('đặt ảnh phân loại đua với đổi thuộc tính gắn ảnh (AC-S8)', () => {
  beforeAll(() => setHeadObject(async () => null));
  afterAll(() => setHeadObject(null));

  it('đặt ảnh trước, đổi sang Size sau: cả hai 200, cuối cùng không còn ảnh, thuộc tính là Size', async () => {
    const p = await colored();
    const fileId = await fileRow(companyId);
    const [img, upd] = await inOrder(
      p.id,
      () => setImage(p, valueId(color, 'Trắng'), fileId),
      () => put(p, { imageAttributeId: size.id }),
    );
    expect(img.status, JSON.stringify(img.body)).toBe(200);
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(await imageCount(p)).toBe(0);
    expect((await read(p)).imageAttributeId).toBe(size.id);
  });

  it('đổi sang Size trước, đặt ảnh Trắng sau: PUT 200, ảnh 422 errors.attributeValueId, không dòng ảnh', async () => {
    const p = await colored();
    const fileId = await fileRow(companyId);
    const [upd, img] = await inOrder(
      p.id,
      () => put(p, { imageAttributeId: size.id }),
      () => setImage(p, valueId(color, 'Trắng'), fileId),
    );
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(img.status, JSON.stringify(img.body)).toBe(422);
    expect(img.body.errors).toEqual({ attributeValueId: 'Giá trị không thuộc thuộc tính gắn ảnh của sản phẩm' });
    expect(await imageCount(p)).toBe(0);
  });
});
