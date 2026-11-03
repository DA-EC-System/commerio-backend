// Dựng dữ liệu qua API công khai như người dùng thật. Mỗi lần chạy tạo bản ghi mới, tên có mã ngẫu nhiên.
import { expect } from 'vitest';
import { api, type Res, uniq } from './client.ts';

/** Danh mục và sản phẩm một biến thể mới; trả id biến thể. */
export async function newVariant(ceo: string): Promise<string> {
  const code = uniq();
  const category = await api(ceo).post('/catalog/categories', { name: `QA ${code}`, skuPattern: `QA${code}-{SEQ:3}` });
  expect(category.status, JSON.stringify(category.body)).toBe(201);
  const product = await api(ceo).post('/catalog/products', {
    name: `Áo thun QA ${code}`,
    categoryId: category.body.id,
    variants: [{ attributeValueIds: [] }],
  });
  expect(product.status, JSON.stringify(product.body)).toBe(201);
  return product.body.variants[0].id as string;
}

export async function newSupplier(token: string): Promise<string> {
  const res = await api(token).post('/purchasing/suppliers', { name: `NCC QA ${uniq()}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** Đề nghị nhập nháp một dòng; trả bản chi tiết. */
export async function newRequest(token: string, supplierId: string, variantId: string) {
  const res = await api(token).post('/purchasing/requests', { supplierId, note: '', lines: [{ variantId, quantity: 10, unitCost: 60000 }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; version: number; status: string };
}

export const act = (token: string, id: string, action: string, body: Record<string, unknown>): Promise<Res> =>
  api(token).post(`/purchasing/requests/${id}/${action}`, body);

/** Đề nghị đã đặt NCC: Kho lập và gửi, CEO duyệt, Kho đặt. Trả id và `version` hiện tại. */
export async function orderedRequest(kho: string, ceo: string, supplierId: string, variantId: string) {
  const request = await newRequest(kho, supplierId, variantId);
  let version = request.version;
  for (const [token, action] of [[kho, 'submit'], [ceo, 'approve'], [kho, 'order']] as const) {
    const res = await act(token, request.id, action, { version });
    expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(200);
    version = res.body.version;
  }
  return { id: request.id, version };
}

/** Phiếu nhận của đề nghị đã đặt, đã nhập số đếm đạt toàn bộ (10 báo giao, 10 đạt); trả bản phiếu đang kiểm. */
export async function countedReceipt(token: string, requestId: string) {
  const created = await api(token).post('/purchasing/goods-receipts', { requestId, deliveryMode: 'waiting', note: '' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const receipt = created.body as { id: string; deliveryMode: string; note: string; version: number; lines: { lineId: string }[] };
  const res = await api(token).put(`/purchasing/goods-receipts/${receipt.id}`, {
    deliveryMode: receipt.deliveryMode,
    note: receipt.note,
    attachmentIds: [],
    version: receipt.version,
    lines: receipt.lines.map((l) => ({ lineId: l.lineId, announced: 10, accepted: 10, defectKept: 0, returnedOnSpot: 0, reason: '' })),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; version: number };
}
