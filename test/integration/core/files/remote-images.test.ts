// `ingestRemoteImage` (#498): ảnh từ URL ngoài vào kho tệp như tệp tải lên. Server HTTP cục bộ thay ảnh sàn (cho phép địa
// chỉ loopback qua `setRemoteImageOptions`), kho thay bằng bản giả `setPutObject`, không gọi mạng ra ngoài.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestRemoteImage } from '#src/modules/core/index.ts';
import { setRemoteImageOptions } from '#src/modules/core/files/service/remote-images.ts';
import { type PutObject, setPutObject } from '#src/modules/core/files/service/storage.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([137, 80, 78, 71, 4, 5, 6]);
let server: http.Server;
let base: string;
let companyId: string;
let puts: Parameters<PutObject>[1][];
let putFails = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '';
    if (path.startsWith('/lazada/anh.jpg')) res.writeHead(200, { 'content-type': 'image/jpg' }).end(JPG);
    else if (path === '/tiktok/anh~tplv-origin-jpeg.jpeg') res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPG);
    else if (path === '/size.png') res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    else if (path === '/webp') res.writeHead(200, { 'content-type': 'image/webp' }).end(PNG);
    else if (path === '/html') res.writeHead(200, { 'content-type': 'text/html' }).end('<p>x</p>');
    else if (path === '/big') res.writeHead(200, { 'content-type': 'image/jpeg' }).end(Buffer.alloc(1024 * 1024 + 1, 1));
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  companyId = (await createCompany({ optionalModules: [] })).companyId;
  setRemoteImageOptions({ allowAddress: () => true });
  setPutObject(async (_config, target) => {
    if (putFails) throw new Error('kho lỗi');
    puts.push(target);
  });
});

afterAll(async () => {
  setRemoteImageOptions(null);
  setPutObject(null);
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  puts = [];
  putFails = false;
});

const fileRow = async (id: string) =>
  (await testPool().query('select company_id, file_name, content_type, size_bytes, purpose, uploaded_by, uploaded_at, storage_key from core.files where id = $1', [id]))
    .rows[0];
const fileCount = async () => Number((await testPool().query('select count(*) from core.files where company_id = $1', [companyId])).rows[0].count);

describe('ingestRemoteImage', () => {
  it('ảnh Lazada `image/jpg` lưu thành `image/jpeg` ở bucket công khai, đã tải lên, người tải là hệ thống', async () => {
    const id = await ingestRemoteImage(companyId, `${base}/lazada/anh.jpg?x=1`, 'product_image');
    expect(id).toEqual(expect.any(String));
    const row = await fileRow(id!);
    expect(row).toMatchObject({ company_id: companyId, file_name: 'anh.jpg', content_type: 'image/jpeg', size_bytes: String(JPG.length), purpose: 'product_image', uploaded_by: null });
    expect(row.uploaded_at).not.toBeNull();
    expect(row.storage_key).toBe(`test/${id}.jpg`);
    expect(puts).toEqual([{ bucket: 'commerio-test-public', key: `test/${id}.jpg`, contentType: 'image/jpeg', body: JPG }]);
  });

  it('tên tệp TikTok bỏ phần `~tplv…`, PNG giữ kiểu', async () => {
    const jpg = await ingestRemoteImage(companyId, `${base}/tiktok/anh~tplv-origin-jpeg.jpeg`, 'product_image');
    expect((await fileRow(jpg!)).file_name).toBe('anh.jpg');
    const png = await ingestRemoteImage(companyId, `${base}/size.png`, 'product_image');
    expect(await fileRow(png!)).toMatchObject({ file_name: 'size.png', content_type: 'image/png' });
  });

  it.each([
    ['sai kiểu theo luật ảnh sản phẩm (WebP)', '/webp'],
    ['không phải ảnh', '/html'],
    ['quá 1 MB', '/big'],
    ['sàn trả 404', '/khong-co'],
  ])('%s: trả null, không ghi dòng, không PUT', async (_why, path) => {
    const before = await fileCount();
    expect(await ingestRemoteImage(companyId, `${base}${path}`, 'product_image')).toBeNull();
    expect(await fileCount()).toBe(before);
    expect(puts).toEqual([]);
  });

  it('URL hỏng, địa chỉ riêng khi không cho phép: null', async () => {
    expect(await ingestRemoteImage(companyId, 'không phải url', 'product_image')).toBeNull();
    setRemoteImageOptions(null);
    try {
      expect(await ingestRemoteImage(companyId, `${base}/size.png`, 'product_image')).toBeNull();
    } finally {
      setRemoteImageOptions({ allowAddress: () => true });
    }
    expect(puts).toEqual([]);
  });

  it('kho lỗi khi PUT: null, dòng nằm lại chưa có uploaded_at (như vé chưa dùng)', async () => {
    putFails = true;
    const before = await fileCount();
    expect(await ingestRemoteImage(companyId, `${base}/size.png`, 'product_image')).toBeNull();
    expect(await fileCount()).toBe(before + 1);
    const { rows } = await testPool().query('select uploaded_at from core.files where company_id = $1 order by created_at desc limit 1', [companyId]);
    expect(rows[0].uploaded_at).toBeNull();
  });
});
