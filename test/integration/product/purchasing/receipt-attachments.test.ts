import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setHeadObject } from '#src/modules/core/files/service/storage.ts';
import { GoodsReceipt } from '#src/modules/product/purchasing/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { type Count, countBody, createReceipt, createSupplier, orderedRequest, pur, type Receipt } from './helpers.ts';

// Tệp đính kèm phiếu nhận và bằng chứng trước khi ghi sổ (#212; Documents/21 §14.3, §16.3). Kho tệp là bản giả:
// `setHeadObject` trả cỡ của tệp đã "PUT"; ký URL tính trong máy, không gọi mạng.

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
beforeEach(() => {
  storeDown = false;
});

let A: { companyId: string; ceo: string; requester: string; kho: string; supplierId: string; variantId: string };
let B: { ceo: string };

beforeAll(async () => {
  const a = await createCompany();
  A = {
    companyId: a.companyId,
    ceo: a.ceo.token,
    requester: (await addMember(a.companyId, 'warehouse')).token,
    kho: (await addMember(a.companyId, 'warehouse')).token,
    supplierId: '',
    variantId: (await createVariant(a.companyId)).variantId,
  };
  A.supplierId = (await createSupplier(A.ceo)).id;
  B = { ceo: (await createCompany()).ceo.token };
});

/** Xin vé như FE; `put` thì tệp có trên kho giả (như FE đã PUT xong). */
async function upload(
  token: string,
  opts: { name?: string; contentType?: string; purpose?: 'attachment' | 'product_image'; put?: boolean } = {},
): Promise<string> {
  const body = {
    fileName: opts.name ?? 'mo-thung.jpg',
    contentType: opts.contentType ?? 'image/jpeg',
    sizeBytes: 2048,
    purpose: opts.purpose ?? 'attachment',
  };
  const res = await request(testApp()).post('/api/v1/files/uploads').set('Authorization', `Bearer ${token}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (opts.put ?? true) {
    const { rows } = await testPool().query<{ storage_key: string }>('select storage_key from core.files where id = $1', [res.body.fileId]);
    stored.set(rows[0]!.storage_key, body.sizeBytes);
  }
  return res.body.fileId as string;
}

async function receipt(mode: 'waiting' | 'left' = 'waiting'): Promise<Receipt> {
  const req = await orderedRequest(A, A.supplierId, [{ variantId: A.variantId, quantity: 10, unitCost: 100000 }]);
  return createReceipt(A.kho, req.id, mode);
}

async function save(r: Receipt, attachmentIds: string[] | undefined, counts: Partial<Count>[] = [{ announced: 10, accepted: 10 }]) {
  const body: Record<string, unknown> = { ...countBody(r, counts) };
  if (attachmentIds === undefined) delete body.attachmentIds;
  else body.attachmentIds = attachmentIds;
  return pur(A.kho).put(`/goods-receipts/${r.id}`, body);
}

describe('gắn tệp vào phiếu nhận', () => {
  it('gắn ảnh và PDF: chi tiết trả attachments theo thứ tự, link ký sẵn 15 phút ở bucket riêng', async () => {
    const r = await receipt();
    const photo = await upload(A.kho, { name: 'mo-thung.jpg' });
    const pdf = await upload(A.kho, { name: 'biên bản.pdf', contentType: 'application/pdf' });
    const res = await save(r, [pdf, photo]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const saved = GoodsReceipt.parse(res.body);
    expect(saved.attachments.map((a) => [a.fileId, a.name, a.contentType])).toEqual([
      [pdf, 'biên bản.pdf', 'application/pdf'],
      [photo, 'mo-thung.jpg', 'image/jpeg'],
    ]);
    const pdfUrl = new URL(saved.attachments[0]!.url);
    expect(pdfUrl.href).toContain('commerio-test-private');
    expect(pdfUrl.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(pdfUrl.searchParams.get('response-content-disposition')).toBe("attachment; filename*=UTF-8''bi%C3%AAn%20b%E1%BA%A3n.pdf");
    expect(pdfUrl.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(new URL(saved.attachments[1]!.url).searchParams.get('response-content-disposition')).toMatch(/^inline;/);

    const detail = GoodsReceipt.parse((await pur(A.kho).get(`/goods-receipts/${r.id}`)).body);
    expect(detail.attachments.map((a) => a.fileId)).toEqual([pdf, photo]);
  });

  it('không gửi attachmentIds thì giữ nguyên; gửi [] thì gỡ hết (tệp vẫn còn)', async () => {
    const r = await receipt();
    const file = await upload(A.kho);
    const first = GoodsReceipt.parse((await save(r, [file])).body);
    const kept = await save(first, undefined);
    expect(kept.status).toBe(200);
    expect(GoodsReceipt.parse(kept.body).attachments.map((a) => a.fileId)).toEqual([file]);
    const cleared = await save(GoodsReceipt.parse(kept.body), []);
    expect(GoodsReceipt.parse(cleared.body).attachments).toEqual([]);
    const { rowCount } = await testPool().query('select 1 from core.files where id = $1', [file]);
    expect(rowCount).toBe(1);
  });

  it('chỉ hỏi kho một lần cho mỗi tệp: lần sau dùng uploaded_at', async () => {
    const r = await receipt();
    const file = await upload(A.kho);
    const before = heads;
    const first = GoodsReceipt.parse((await save(r, [file])).body);
    await save(first, [file]);
    expect(heads - before).toBe(1);
  });

  it('nhật ký thao tác ghi danh sách tệp trước và sau', async () => {
    const r = await receipt();
    const file = await upload(A.kho);
    await save(r, [file]);
    const { rows } = await testPool().query<{ before: { attachmentIds: string[] }; after: { attachmentIds: string[] } }>(
      `select before, after from core.audit_logs where entity_id = $1 and action = 'update' order by created_at desc limit 1`,
      [r.id],
    );
    expect(rows[0]).toMatchObject({ before: { attachmentIds: [] }, after: { attachmentIds: [file] } });
  });
});

describe('từ chối tệp: 422 errors.attachments, phiếu không đổi', () => {
  const message = 'Có tệp chưa tải xong hoặc không thuộc công ty';

  async function expectRejected(r: Receipt, ids: string[], text = message) {
    const res = await save(r, ids);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.errors).toEqual({ attachments: text });
    const after = GoodsReceipt.parse((await pur(A.kho).get(`/goods-receipts/${r.id}`)).body);
    expect(after.version).toBe(r.version);
    expect(after.attachments).toEqual([]);
  }

  it('xin vé mà chưa PUT lên kho', async () => {
    await expectRejected(await receipt(), [await upload(A.kho, { put: false })]);
  });

  it('tệp của công ty khác', async () => {
    await expectRejected(await receipt(), [await upload(B.ceo)]);
  });

  it('tệp xin vé là ảnh sản phẩm', async () => {
    await expectRejected(await receipt(), [await upload(A.ceo, { purpose: 'product_image', contentType: 'image/png' })]);
  });

  it('id không phải uuid', async () => {
    await expectRejected(await receipt(), ['khong-phai-uuid']);
  });

  it('tệp bị lặp', async () => {
    const file = await upload(A.kho);
    await expectRejected(await receipt(), [file, file], 'Có tệp bị lặp');
  });

  it('kho không trả lời khi xác nhận tệp → 503 storage_unavailable', async () => {
    const r = await receipt();
    const file = await upload(A.kho);
    storeDown = true;
    const res = await save(r, [file]);
    expect(res.status).toBe(503);
    expect(res.body.type).toBe('/problems/storage_unavailable');
  });
});

describe('bằng chứng trước khi ghi sổ (evidence_required)', () => {
  const withDefect = [{ announced: 10, accepted: 9, defectKept: 1, reason: 'Móp hộp' }];

  it('người giao đã đi, có lỗi giữ, chưa đính tệp → 422 evidence_required; đính ảnh rồi ghi sổ được', async () => {
    const r = await receipt('left');
    const counted = GoodsReceipt.parse((await save(r, [], withDefect)).body);
    const refused = await pur(A.kho).post(`/goods-receipts/${r.id}/post`, { version: counted.version });
    expect(refused.status).toBe(422);
    expect(refused.body.type).toBe('/problems/evidence_required');

    const withPhoto = GoodsReceipt.parse((await save(counted, [await upload(A.kho)], withDefect)).body);
    const posted = await pur(A.kho).post(`/goods-receipts/${r.id}/post`, { version: withPhoto.version });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.status).toBe('matched');
  });

  it('người giao đã đi, thiếu hàng, chưa đính tệp → 422 evidence_required khi post_short', async () => {
    const r = await receipt('left');
    const counted = GoodsReceipt.parse((await save(r, [], [{ announced: 10, accepted: 8, reason: 'Thiếu 2' }])).body);
    const res = await pur(A.kho).post(`/goods-receipts/${r.id}/post_short`, { version: counted.version });
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/evidence_required');
  });

  it('người giao đã đi, đủ và không lỗi → ghi sổ không cần tệp', async () => {
    const r = await receipt('left');
    const counted = GoodsReceipt.parse((await save(r, [])).body);
    const res = await pur(A.kho).post(`/goods-receipts/${r.id}/post`, { version: counted.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('người giao còn chờ, có lỗi giữ → ghi sổ không cần tệp', async () => {
    const r = await receipt('waiting');
    const counted = GoodsReceipt.parse((await save(r, [], withDefect)).body);
    const res = await pur(A.kho).post(`/goods-receipts/${r.id}/post`, { version: counted.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
