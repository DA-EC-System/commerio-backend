import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import type { z } from 'zod';
import { GoodsReceipt } from '#src/modules/product/purchasing/api/schemas.ts';
import { testApp } from '../../helpers/http.ts';

/** Vai trò có sẵn "Mua hàng" (`purchasing.request.manage`, `purchasing.return.manage`). */
export const BUYER_ROLE = '00000000-0000-4000-8000-000000000005';

export function pur(token: string) {
  const app = testApp();
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const base = '/api/v1/purchasing';
  return {
    get: (path: string) => auth(request(app).get(base + path)),
    post: (path: string, body: object) => auth(request(app).post(base + path).send(body)),
    put: (path: string, body: object) => auth(request(app).put(base + path).send(body)),
  };
}

export async function createSupplier(token: string, overrides: Record<string, unknown> = {}) {
  const res = await pur(token).post('/suppliers', { name: `NCC ${randomUUID().slice(0, 8)}`, ...overrides });
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string; version: number };
}

export interface LineInput {
  variantId?: string;
  newProduct?: { name: string; categoryId: string };
  quantity: number;
  unitCost: number;
}

/** Lập đề nghị nháp qua API; trả bản chi tiết. */
export async function createRequest(token: string, supplierId: string, lines: LineInput[], note = '') {
  const res = await pur(token).post('/requests', { supplierId, note, lines });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: string; status: string; version: number; lines: { id: string; variantId: string | null }[] };
}

/** Một thao tác máy trạng thái; trả response để test kiểm mã lỗi. */
export function act(token: string, id: string, action: string, body: Record<string, unknown>) {
  return pur(token).post(`/requests/${id}/${action}`, body);
}

/** Chạy lần lượt các thao tác, mỗi bước dùng `version` mới nhất; bước nào lỗi thì test đỏ. */
export async function runActions(steps: [token: string, action: string, extra?: Record<string, unknown>][], id: string, version: number) {
  let v = version;
  let body: Record<string, unknown> = {};
  for (const [token, action, extra] of steps) {
    const res = await act(token, id, action, { version: v, ...extra });
    expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(200);
    body = res.body;
    v = res.body.version;
  }
  return body as { id: string; number: string; version: number; status: string; lines: { id: string; variantId: string | null; sku: string | null }[] };
}

/** Đề nghị đã đặt NCC: mua hàng lập và gửi, CEO duyệt, mua hàng đặt. */
export async function orderedRequest(t: { buyer: string; ceo: string }, supplierId: string, lines: LineInput[]) {
  const draft = await createRequest(t.buyer, supplierId, lines);
  return runActions([[t.buyer, 'submit'], [t.ceo, 'approve'], [t.buyer, 'order']], draft.id, draft.version);
}

export type Receipt = z.infer<typeof GoodsReceipt>;

/** Lập phiếu nhận qua API, kỳ vọng 201; body parse bằng schema OpenAPI. */
export async function createReceipt(token: string, requestId: string, deliveryMode: 'waiting' | 'left' = 'waiting') {
  const res = await pur(token).post('/goods-receipts', { requestId, deliveryMode, note: '' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return GoodsReceipt.parse(res.body);
}

export interface Count {
  announced: number;
  accepted: number;
  defectKept: number;
  returnedOnSpot: number;
  reason: string;
}

/** Body `PUT /goods-receipts/:id` theo thứ tự dòng của phiếu; trường không nêu lấy 0 và lý do rỗng. */
export function countBody(receipt: Receipt, counts: Partial<Count>[]) {
  return {
    deliveryMode: receipt.deliveryMode,
    note: receipt.note,
    attachmentIds: [] as string[],
    version: receipt.version,
    lines: receipt.lines.map((l, i) => ({ lineId: l.lineId, announced: 0, accepted: 0, defectKept: 0, returnedOnSpot: 0, reason: '', ...counts[i] })),
  };
}
