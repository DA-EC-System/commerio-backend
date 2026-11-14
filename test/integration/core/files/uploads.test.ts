import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UploadTicketSchema } from '#src/modules/core/files/api/schemas.ts';
import { env } from '#src/shared/config/env.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { lockCompany } from '../../helpers/state.ts';

// POST /files/uploads (#212; Documents/21 §5.2, §5.3, §14.3). Kho trong test là cấu hình giả ở vitest.config.ts:
// ký URL chỉ tính trong máy, không có lời gọi nào tới kho.

const image = { fileName: 'ao-thun.png', contentType: 'image/png', sizeBytes: 2048, purpose: 'product_image' };
const pdf = { fileName: 'bien-ban.pdf', contentType: 'application/pdf', sizeBytes: 4096, purpose: 'attachment' };

function upload(token: string | null, body: object) {
  const req = request(testApp()).post('/api/v1/files/uploads').send(body);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
}

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.body.type).toBe(`/problems/${code}`);
}

async function fileRow(fileId: string) {
  const { rows } = await testPool().query<{
    company_id: string;
    storage_key: string;
    file_name: string;
    content_type: string;
    size_bytes: string;
    purpose: string;
    uploaded_by: string;
  }>('select * from core.files where id = $1', [fileId]);
  return rows[0];
}

async function fileCount(companyId: string): Promise<number> {
  const { rows } = await testPool().query<{ n: string }>('select count(*) as n from core.files where company_id = $1', [
    companyId,
  ]);
  return Number(rows[0]!.n);
}

let companyId: string;
let ceo: string;
/** Thành viên không có quyền catalog nào: chỉ xin được vé đính kèm. */
let viewer: { accountId: string; token: string };
beforeAll(async () => {
  const company = await createCompany();
  companyId = company.companyId;
  ceo = company.ceo.token;
  viewer = await addMember(companyId, await createCustomRole(companyId, ['sales.order.view']));
});

describe('cấp vé', () => {
  it('ảnh sản phẩm: 201, ghi dòng tệp, URL trỏ bucket công khai', async () => {
    const res = await upload(ceo, image);
    expect(res.status).toBe(201);
    const ticket = UploadTicketSchema.parse(res.body);
    expect(ticket.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '2048' });
    expect(ticket.uploadUrl).toContain('commerio-test-public');
    expect(new URL(ticket.uploadUrl).searchParams.get('X-Amz-Expires')).toBe('900');

    const row = await fileRow(ticket.fileId);
    expect(row).toMatchObject({
      company_id: companyId,
      storage_key: `test/${ticket.fileId}.png`,
      file_name: 'ao-thun.png',
      content_type: 'image/png',
      size_bytes: '2048',
      purpose: 'product_image',
    });
  });

  it('đính kèm: thành viên không có quyền catalog vẫn xin được, tệp vào bucket riêng', async () => {
    const res = await upload(viewer.token, pdf);
    expect(res.status).toBe(201);
    const ticket = UploadTicketSchema.parse(res.body);
    expect(ticket.uploadUrl).toContain('commerio-test-private');
    expect(await fileRow(ticket.fileId)).toMatchObject({
      storage_key: `test/${ticket.fileId}.pdf`,
      purpose: 'attachment',
      uploaded_by: viewer.accountId,
    });
  });

  it('kiểu viết hoa được đưa về chữ thường, header ký theo kiểu đã chuẩn hoá', async () => {
    const res = await upload(ceo, { ...image, contentType: 'IMAGE/PNG' });
    expect(res.status).toBe(201);
    expect(res.body.headers['Content-Type']).toBe('image/png');
  });

  it('mỗi lần xin là một tệp mới', async () => {
    const [a, b] = await Promise.all([upload(ceo, image), upload(ceo, image)]);
    expect(a.body.fileId).not.toBe(b.body.fileId);
  });
});

describe('quyền', () => {
  it('chưa đăng nhập: 401', async () => {
    expectProblem(await upload(null, pdf), 401, 'unauthorized');
  });

  it('ảnh sản phẩm thiếu catalog.product.manage: 403 forbidden', async () => {
    expectProblem(await upload(viewer.token, image), 403, 'forbidden');
  });

  it('Sale (chỉ xem sản phẩm) không xin được vé ảnh sản phẩm', async () => {
    const sale = await addMember(companyId, 'sale');
    expectProblem(await upload(sale.token, image), 403, 'forbidden');
  });

  it('công ty bị khoá: 403 company_locked, kể cả vé đính kèm', async () => {
    const locked = await createCompany();
    await lockCompany(locked.companyId);
    expectProblem(await upload(locked.ceo.token, pdf), 403, 'company_locked');
  });
});

describe('từ chối tệp, không ghi dòng nào', () => {
  it('ảnh sản phẩm là PDF: 422 file_type_not_allowed', async () => {
    const before = await fileCount(companyId);
    expectProblem(await upload(ceo, { ...image, contentType: 'application/pdf' }), 422, 'file_type_not_allowed');
    expect(await fileCount(companyId)).toBe(before);
  });

  it('video: 422 file_type_not_allowed (MVP không nhận video)', async () => {
    expectProblem(await upload(viewer.token, { ...pdf, contentType: 'video/mp4' }), 422, 'file_type_not_allowed');
  });

  it('ảnh sản phẩm WebP: 422 file_type_not_allowed (sàn chỉ nhận JPG, PNG)', async () => {
    expectProblem(await upload(ceo, { ...image, contentType: 'image/webp' }), 422, 'file_type_not_allowed');
  });

  it('ảnh hơn 1 MB: 422 file_too_large', async () => {
    expectProblem(await upload(ceo, { ...image, sizeBytes: 1024 * 1024 + 1 }), 422, 'file_too_large');
  });

  it('đính kèm hơn 10 MB: 422 file_too_large', async () => {
    expectProblem(await upload(viewer.token, { ...pdf, sizeBytes: 10 * 1024 * 1024 + 1 }), 422, 'file_too_large');
  });

  it('thiếu trường, purpose lạ: 422 validation_failed theo ô', async () => {
    const res = await upload(ceo, { purpose: 'avatar', sizeBytes: 0 });
    expectProblem(res, 422, 'validation_failed');
    expect(Object.keys(res.body.errors)).toEqual(expect.arrayContaining(['fileName', 'contentType', 'sizeBytes', 'purpose']));
  });
});

describe('kho', () => {
  const saved = { endpoint: env.S3_ENDPOINT, quota: env.STORAGE_QUOTA_BYTES };
  afterEach(() => {
    env.S3_ENDPOINT = saved.endpoint;
    env.STORAGE_QUOTA_BYTES = saved.quota;
  });

  it('chưa cấu hình kho: 503 storage_unavailable, không ghi dòng', async () => {
    env.S3_ENDPOINT = undefined;
    const before = await fileCount(companyId);
    expectProblem(await upload(ceo, image), 503, 'storage_unavailable');
    expect(await fileCount(companyId)).toBe(before);
  });

  it('vượt trần tổng dung lượng: 507 storage_quota_exceeded, không ghi dòng', async () => {
    // Trần nhỏ hơn tệp: luôn vượt, bất kể các test khác đã ghi bao nhiêu.
    env.STORAGE_QUOTA_BYTES = 1;
    const before = await fileCount(companyId);
    expectProblem(await upload(ceo, image), 507, 'storage_quota_exceeded');
    expect(await fileCount(companyId)).toBe(before);
  });

  it('trần tính cả tệp của công ty khác', async () => {
    const other = await createCompany();
    const { rows } = await testPool().query<{ total: string }>(
      'select coalesce(sum(size_bytes), 0) as total from core.files',
    );
    // Vừa đủ chỗ cho tổng hiện tại cộng một ảnh 2048 byte, chưa tính phần công ty khác ghi thêm.
    env.STORAGE_QUOTA_BYTES = Number(rows[0]!.total) + 2048;
    await testPool().query(
      `insert into core.files (company_id, storage_key, file_name, content_type, size_bytes, purpose)
       values ($1, $2, 'lon.pdf', 'application/pdf', 4096, 'attachment')`,
      [other.companyId, `test/${randomUUID()}.pdf`],
    );
    expectProblem(await upload(ceo, image), 507, 'storage_quota_exceeded');
  });
});
