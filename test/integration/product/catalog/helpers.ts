import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

// Helper riêng của test catalog: gọi API thật như FE, mỗi test tự đặt tên khác nhau (dữ liệu dùng chung giữa file).

const BASE = '/api/v1/catalog';

/** Gọi API catalog bằng token (đã chọn công ty). */
export function api(token: string) {
  const app = testApp();
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  return {
    get: (path: string) => auth(request(app).get(BASE + path)),
    post: (path: string, body: object) => auth(request(app).post(BASE + path).send(body)),
    put: (path: string, body: object) => auth(request(app).put(BASE + path).send(body)),
    delete: (path: string) => auth(request(app).delete(BASE + path)),
  };
}

export async function createCategory(token: string, name: string, skuPattern = 'AO-{SEQ:4}-{VAL}') {
  const res = await api(token).post('/categories', { name, skuPattern });
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string; skuPattern: string; skuNextSeq: number; version: number };
}

export interface AttributeBody {
  id: string;
  name: string;
  version: number;
  productCount: number;
  values: { id: string; value: string; code: string; inUse: boolean }[];
}

export async function createAttribute(token: string, name: string, values: string[]) {
  const res = await api(token).post('/attributes', { name, values: values.map((value) => ({ value })) });
  expect(res.status).toBe(201);
  return res.body as AttributeBody;
}

/** Id giá trị theo chữ, vd `valueId(color, 'Đen')`. */
export function valueId(attribute: AttributeBody, value: string): string {
  const found = attribute.values.find((v) => v.value === value);
  if (!found) throw new Error(`Không có giá trị ${value}`);
  return found.id;
}

export interface ProductBody {
  id: string;
  name: string;
  version: number;
  status: 'active' | 'archived';
  variants: { id: string; sku: string; archivedAt: string | null; attributes: { valueId: string; value: string }[] }[];
}

/** Tên không trùng giữa các test (dữ liệu dùng chung giữa file). */
export const uniq = (prefix: string) => `${prefix} ${randomUUID().slice(0, 8)}`;

/** Thân `POST /catalog/products` như FE gửi; `extra` ghi đè để thử ca lỗi. */
export function productBody(name: string, categoryId: string, variants: string[][], extra: object = {}) {
  return {
    name,
    categoryId,
    description: '',
    imageFileIds: [],
    variants: variants.map((attributeValueIds) => ({ attributeValueIds })),
    ...extra,
  };
}

export async function createProduct(token: string, body: { name: string; categoryId: string; variants: string[][] }) {
  const res = await api(token).post('/products', productBody(body.name, body.categoryId, body.variants));
  expect(res.status).toBe(201);
  return res.body as ProductBody;
}

/** Dòng nhật ký của một đối tượng, cũ trước. */
export async function auditOf(entityId: string) {
  const res = await testPool().query<{ action: string; entity_type: string; before: unknown; after: unknown }>(
    'select action, entity_type, before, after from core.audit_logs where entity_id = $1 order by created_at, id',
    [entityId],
  );
  return res.rows;
}
