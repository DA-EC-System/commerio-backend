import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setHeadObject } from '#src/modules/core/files/service/storage.ts';
import { productImageUrls } from '#src/modules/product/catalog/index.ts';
import { env } from '#src/shared/config/env.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { api, auditOf, createCategory, productBody, uniq } from './helpers.ts';

// Ảnh sản phẩm ở catalog (#303; Documents/21 §5.2–5.4 P8, P10, V26). Kho tệp là bản giả: `setHeadObject` trả cỡ của
// tệp đã "PUT"; ký URL tính trong máy. Link công khai theo `S3_PUBLIC_URL` của vitest.config.ts.

/** storage_key → cỡ của tệp đang có trên kho giả. */
const stored = new Map<string, number>();
let heads = 0;
let storeDown = false;

beforeAll(() => {
  setHeadObject(async (_config, target) => {
    heads++;
    if (storeDown) throw new Error('kho không trả lời');
    const size = stored.get(target.key);
    return size === undefined ? null : { sizeBytes: size };
  });
});
afterAll(() => setHeadObject(null));
afterEach(() => {
  storeDown = false;
});

const url = (key: string) => `https://files.commerio.test/${key}`;

/** Xin vé ảnh như FE (2048 byte); `put` thì tệp có trên kho giả (như FE đã PUT xong). */
async function image(
  token: string,
  opts: { put?: boolean; purpose?: 'product_image' | 'attachment' } = {},
): Promise<{ id: string; key: string }> {
  const body = { fileName: 'anh.jpg', contentType: 'image/jpeg', sizeBytes: 2048, purpose: opts.purpose ?? 'product_image' };
  const res = await request(testApp()).post('/api/v1/files/uploads').set('Authorization', `Bearer ${token}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const { rows } = await testPool().query<{ storage_key: string }>('select storage_key from core.files where id = $1', [res.body.fileId]);
  const key = rows[0]!.storage_key;
  if (opts.put ?? true) stored.set(key, body.sizeBytes);
  return { id: res.body.fileId as string, key };
}

let token: string;
let companyId: string;
let other: string;
beforeAll(async () => {
  const company = await createCompany();
  token = company.ceo.token;
  companyId = company.companyId;
  other = (await createCompany()).ceo.token;
});

type Image = { id: string; fileId: string; url: string; position: number };
const fileIdsOf = (images: Image[]) => images.map((i) => i.fileId);

async function newProduct(imageFileIds: string[]) {
  const category = await createCategory(token, uniq('Ảnh'), 'A-{SEQ}');
  const res = await api(token).post('/products', productBody(uniq('SP ảnh'), category.id, [[]], { imageFileIds }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; name: string; version: number; images: Image[]; thumbnailUrl: string | null };
}

const put = (p: { id: string; name: string }, version: number, extra: object = {}) =>
  api(token).put(`/products/${p.id}`, { name: p.name, description: '', version, ...extra });

describe('tạo, sửa sản phẩm có ảnh', () => {
  it('tạo sản phẩm 3 ảnh: images theo thứ tự gửi, url công khai, thumbnailUrl là ảnh đầu, nhật ký imageFileIds', async () => {
    const [a, b, c] = [await image(token), await image(token), await image(token)];
    const p = await newProduct([a.id, b.id, c.id]);
    expect(p.images.map((i) => [i.fileId, i.position])).toEqual([
      [a.id, 0],
      [b.id, 1],
      [c.id, 2],
    ]);
    expect(p.images.map((i) => i.url)).toEqual([url(a.key), url(b.key), url(c.key)]);
    expect(p.thumbnailUrl).toBe(url(a.key));
    const [created] = await auditOf(p.id);
    expect(created!.after).toMatchObject({ imageFileIds: [a.id, b.id, c.id] });
    expect((await api(token).get(`/products/${p.id}`)).body.images).toEqual(p.images);
  });

  it('PUT không gửi imageFileIds thì giữ ảnh, version tăng', async () => {
    const [a, b] = [await image(token), await image(token)];
    const p = await newProduct([a.id, b.id]);
    const res = await put(p, p.version);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(fileIdsOf(res.body.images)).toEqual([a.id, b.id]);
    expect(res.body.version).toBe(p.version + 1);
  });

  it('PUT gửi lại đúng ảnh đang có thì thành công, không hỏi lại kho', async () => {
    const [a, b] = [await image(token), await image(token)];
    const p = await newProduct([a.id, b.id]);
    const before = heads;
    const res = await put(p, p.version, { imageFileIds: [a.id, b.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(fileIdsOf(res.body.images)).toEqual([a.id, b.id]);
    expect(heads).toBe(before);
  });

  it('PUT đổi thứ tự thì images theo thứ tự mới, thumbnailUrl là ảnh mới đứng đầu', async () => {
    const [a, b] = [await image(token), await image(token)];
    const p = await newProduct([a.id, b.id]);
    const res = await put(p, p.version, { imageFileIds: [b.id, a.id] });
    expect(res.body.images.map((i: Image) => [i.fileId, i.position])).toEqual([
      [b.id, 0],
      [a.id, 1],
    ]);
    expect(res.body.thumbnailUrl).toBe(url(b.key));
  });

  it('PUT [] gỡ hết: images [], thumbnailUrl null; nhật ký before, after imageFileIds', async () => {
    const [a] = [await image(token)];
    const p = await newProduct([a.id]);
    const res = await put(p, p.version, { imageFileIds: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ images: [], thumbnailUrl: null });
    const updated = (await auditOf(p.id)).find((r) => r.action === 'update');
    expect(updated).toMatchObject({ before: { imageFileIds: [a.id] }, after: { imageFileIds: [] } });
  });

  it('lưu trữ ghi imageFileIds đang có vào nhật ký', async () => {
    const [a] = [await image(token)];
    const p = await newProduct([a.id]);
    expect((await api(token).delete(`/products/${p.id}?version=${p.version}`)).status).toBe(204);
    const deleted = (await auditOf(p.id)).find((r) => r.action === 'delete');
    expect(deleted).toMatchObject({ before: { imageFileIds: [a.id] } });
  });
});

describe('từ chối ảnh: không ghi gì', () => {
  const categoryOf = async (id: string) =>
    (await api(token).get('/categories')).body.find((c: { id: string }) => c.id === id) as { skuNextSeq: number };

  it.each([
    ['10 ảnh', async () => Promise.all(Array.from({ length: 10 }, () => image(token))).then((l) => l.map((f) => f.id)), 'Tối đa 9 ảnh'],
    ['ảnh lặp', async () => image(token).then((f) => [f.id, f.id]), 'Ảnh bị trùng'],
    ['ảnh chưa PUT', async () => [(await image(token, { put: false })).id], 'Có ảnh chưa tải xong hoặc không thuộc công ty'],
    ['ảnh công ty khác', async () => [(await image(other)).id], 'Có ảnh chưa tải xong hoặc không thuộc công ty'],
    ['tệp đính kèm', async () => [(await image(token, { purpose: 'attachment' })).id], 'Có ảnh chưa tải xong hoặc không thuộc công ty'],
    ['id không phải uuid', async () => ['abc'], 'Có ảnh chưa tải xong hoặc không thuộc công ty'],
  ])('tạo với %s → 422 errors.images, không tạo sản phẩm, không tiêu số SKU', async (_case, ids, message) => {
    const imageFileIds = await ids();
    const category = await createCategory(token, uniq('Ảnh lỗi'), 'L-{SEQ}');
    const name = uniq('SP lỗi');
    const before = heads;
    const res = await api(token).post('/products', productBody(name, category.id, [[]], { imageFileIds }));
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(res.body.errors.images).toBe(message);
    expect((await categoryOf(category.id)).skuNextSeq).toBe(1);
    expect((await api(token).get(`/products?search=${encodeURIComponent(name)}`)).body.total).toBe(0);
    // Số ảnh, ảnh lặp kiểm ở Zod: không hỏi kho.
    if (message === 'Tối đa 9 ảnh' || message === 'Ảnh bị trùng') expect(heads).toBe(before);
  });

  it('PUT bị từ chối thì ảnh và version giữ nguyên', async () => {
    const [a] = [await image(token)];
    const p = await newProduct([a.id]);
    const pending = await image(token, { put: false });
    const res = await put(p, p.version, { imageFileIds: [pending.id] });
    expect(res.status).toBe(422);
    expect(res.body.errors.images).toBe('Có ảnh chưa tải xong hoặc không thuộc công ty');
    const now = (await api(token).get(`/products/${p.id}`)).body;
    expect(fileIdsOf(now.images)).toEqual([a.id]);
    expect(now.version).toBe(p.version);
  });

  it('PUT kèm ảnh với version cũ: 409 version_conflict, ảnh giữ nguyên', async () => {
    const [a, b] = [await image(token), await image(token)];
    const p = await newProduct([a.id]);
    expect((await put(p, p.version)).status).toBe(200);
    const res = await put(p, p.version, { imageFileIds: [b.id] });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(fileIdsOf((await api(token).get(`/products/${p.id}`)).body.images)).toEqual([a.id]);
  });

  it('kho không trả lời: 503 storage_unavailable, không tạo sản phẩm', async () => {
    const pending = await image(token, { put: false });
    const category = await createCategory(token, uniq('Ảnh kho'), 'K-{SEQ}');
    const name = uniq('SP kho');
    storeDown = true;
    const res = await api(token).post('/products', productBody(name, category.id, [[]], { imageFileIds: [pending.id] }));
    expect(res.status).toBe(503);
    expect(res.body.type).toBe('/problems/storage_unavailable');
    expect((await api(token).get(`/products?search=${encodeURIComponent(name)}`)).body.total).toBe(0);
  });

  it('sản phẩm đã lưu trữ: PUT kèm ảnh → 409 product_archived', async () => {
    const [a, b] = [await image(token), await image(token)];
    const p = await newProduct([a.id]);
    expect((await api(token).delete(`/products/${p.id}?version=${p.version}`)).status).toBe(204);
    const res = await put(p, p.version + 1, { imageFileIds: [b.id] });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/product_archived');
  });
});

describe('ảnh đại diện ở danh sách, ảnh cho module khác', () => {
  const savedUrl = env.S3_PUBLIC_URL;
  afterEach(() => {
    env.S3_PUBLIC_URL = savedUrl;
  });

  /** Hai sản phẩm cùng tiền tố tên: một có hai ảnh, một không ảnh. */
  async function pair() {
    const [a, b] = [await image(token), await image(token)];
    const category = await createCategory(token, uniq('Ảnh DS'), 'D-{SEQ}');
    const prefix = uniq('DS');
    const withImages = await api(token).post('/products', productBody(`${prefix} có ảnh`, category.id, [[]], { imageFileIds: [a.id, b.id] }));
    const without = await api(token).post('/products', productBody(`${prefix} không ảnh`, category.id, [[]]));
    expect([withImages.status, without.status]).toEqual([201, 201]);
    return { prefix, a, b, withImages: withImages.body.id as string, without: without.body.id as string };
  }
  const listed = async (prefix: string) => {
    const res = await api(token).get(`/products?search=${encodeURIComponent(prefix)}`);
    expect(res.status).toBe(200);
    return new Map((res.body.items as { id: string; thumbnailUrl: string | null }[]).map((i) => [i.id, i.thumbnailUrl]));
  };

  it('danh sách: thumbnailUrl là ảnh position 0, sản phẩm không ảnh là null', async () => {
    const p = await pair();
    const rows = await listed(p.prefix);
    expect(rows.get(p.withImages)).toBe(url(p.a.key));
    expect(rows.get(p.without)).toBeNull();
  });

  it('productImageUrls lấy tối đa max ảnh theo thứ tự, bỏ sản phẩm không ảnh', async () => {
    const p = await pair();
    const two = await withCompany(companyId, () => productImageUrls([p.withImages, p.without], 2));
    expect(two.get(p.withImages)).toEqual([url(p.a.key), url(p.b.key)]);
    expect(two.has(p.without)).toBe(false);
    const one = await withCompany(companyId, () => productImageUrls([p.withImages], 1));
    expect(one.get(p.withImages)).toEqual([url(p.a.key)]);
  });

  it('thiếu S3_PUBLIC_URL: chi tiết url rỗng, thumbnailUrl null ở chi tiết và danh sách, productImageUrls không có sản phẩm', async () => {
    const p = await pair();
    env.S3_PUBLIC_URL = undefined;
    const detail = await api(token).get(`/products/${p.withImages}`);
    expect(detail.status).toBe(200);
    expect(detail.body.images.map((i: Image) => i.url)).toEqual(['', '']);
    expect(detail.body.thumbnailUrl).toBeNull();
    expect((await listed(p.prefix)).get(p.withImages)).toBeNull();
    expect((await withCompany(companyId, () => productImageUrls([p.withImages], 8))).size).toBe(0);
  });
});
