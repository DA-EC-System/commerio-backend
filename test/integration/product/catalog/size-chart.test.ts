import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setHeadObject } from '#src/modules/core/files/service/storage.ts';
import { productSizeChartUrls } from '#src/modules/product/catalog/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { api, auditOf, createGroup, productBody, uniq } from './helpers.ts';

// Ảnh bảng kích cỡ của sản phẩm (#347; Documents/21 §5.2, §18.5): một ảnh JPG/PNG ≤ 1 MB, dùng lại luồng tệp của #303.
const stored = new Map<string, number>();
beforeAll(() => {
  setHeadObject(async (_config, target) => {
    const size = stored.get(target.key);
    return size === undefined ? null : { sizeBytes: size };
  });
});
afterAll(() => setHeadObject(null));

/** Xin vé ảnh như FE; `put` thì tệp có trên kho giả (FE đã PUT xong). */
async function image(token: string, opts: { put?: boolean; contentType?: string } = {}) {
  const body = { fileName: 'bang-size.png', contentType: opts.contentType ?? 'image/png', sizeBytes: 2048, purpose: 'product_image' };
  const res = await request(testApp()).post('/api/v1/files/uploads').set('Authorization', `Bearer ${token}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const { rows } = await testPool().query<{ storage_key: string }>('select storage_key from core.files where id = $1', [res.body.fileId]);
  if (opts.put ?? true) stored.set(rows[0]!.storage_key, body.sizeBytes);
  return res.body.fileId as string;
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

interface Detail {
  id: string;
  name: string;
  version: number;
  sizeChart: { fileId: string; url: string } | null;
}
async function newProduct(extra: object = {}) {
  const group = await createGroup(token, uniq('Áo'), 'A-{SEQ}');
  return api(token).post('/products', productBody(uniq('SP'), group.id, [[]], extra));
}
const put = (p: Detail, extra: object = {}) => api(token).put(`/products/${p.id}`, { name: p.name, description: '', version: p.version, ...extra });

describe('tạo, sửa sản phẩm có ảnh bảng kích cỡ', () => {
  it('sản phẩm tạo không kèm ảnh: sizeChart null; tạo kèm thì trả fileId, url công khai; nhật ký có sizeChartFileId', async () => {
    const plain = await newProduct();
    expect(plain.status).toBe(201);
    expect(plain.body.sizeChart).toBeNull();
    expect((await auditOf(plain.body.id))[0]!.after).not.toHaveProperty('sizeChartFileId');

    const fileId = await image(token);
    const res = await newProduct({ sizeChartFileId: fileId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.sizeChart).toEqual({ fileId, url: expect.stringContaining('/') });
    expect(res.body.sizeChart.url).not.toBe('');
    expect((await auditOf(res.body.id))[0]!.after).toMatchObject({ sizeChartFileId: fileId });
    const get = await api(token).get(`/products/${res.body.id}`);
    expect(get.body.sizeChart.fileId).toBe(fileId);
  });

  it('PUT: bỏ trống giữ nguyên; gửi id thì thay; null thì gỡ (tệp không bị xoá)', async () => {
    const first = await image(token);
    const created = (await newProduct({ sizeChartFileId: first })).body as Detail;

    const kept = (await put(created)).body as Detail;
    expect(kept.sizeChart?.fileId).toBe(first);
    expect(kept.version).toBe(created.version + 1);

    const second = await image(token);
    const swapped = (await put(kept, { sizeChartFileId: second })).body as Detail;
    expect(swapped.sizeChart?.fileId).toBe(second);

    const removed = (await put(swapped, { sizeChartFileId: null })).body as Detail;
    expect(removed.sizeChart).toBeNull();
    const { rows } = await testPool().query('select 1 from core.files where id = $1', [second]);
    expect(rows).toHaveLength(1);
  });

  it('tệp chưa PUT lên kho, tệp công ty khác, tệp không phải ảnh: 422 theo ô sizeChart, sản phẩm không đổi', async () => {
    const notPut = await image(token, { put: false });
    const res = await newProduct({ sizeChartFileId: notPut });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('sizeChart');

    const theirs = await image(other);
    const cross = await newProduct({ sizeChartFileId: theirs });
    expect(cross.status).toBe(422);
    expect(cross.body.errors).toHaveProperty('sizeChart');

    const created = (await newProduct()).body as Detail;
    const bad = await put(created, { sizeChartFileId: await image(token, { put: false }) });
    expect(bad.status).toBe(422);
    expect((await api(token).get(`/products/${created.id}`)).body).toMatchObject({ version: created.version, sizeChart: null });
  });

  it('lỗi ảnh sản phẩm và lỗi bảng kích cỡ báo cùng lúc ở hai ô', async () => {
    const created = (await newProduct()).body as Detail;
    const res = await put(created, { imageFileIds: [await image(token, { put: false })], sizeChartFileId: await image(token, { put: false }) });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['images', 'sizeChart']);
  });
});

describe('productSizeChartUrls (cổng cho channel)', () => {
  it('chỉ có sản phẩm đã có ảnh; sản phẩm công ty khác không thấy', async () => {
    const withChart = (await newProduct({ sizeChartFileId: await image(token) })).body as Detail;
    const without = (await newProduct()).body as Detail;
    const urls = await withCompany(companyId, () => productSizeChartUrls([withChart.id, without.id]));
    expect([...urls.keys()]).toEqual([withChart.id]);
    expect(urls.get(withChart.id)).toBe(withChart.sizeChart!.url);
    const theirs = await withCompany((await createCompany()).companyId, () => productSizeChartUrls([withChart.id]));
    expect(theirs.size).toBe(0);
  });
});
