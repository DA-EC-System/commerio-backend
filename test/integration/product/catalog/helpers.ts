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
    patch: (path: string, body: object) => auth(request(app).patch(BASE + path).send(body)),
    delete: (path: string) => auth(request(app).delete(BASE + path)),
  };
}

/** Đặt mẫu SKU của công ty (`PUT /catalog/settings`, #447); trả cài đặt sau khi sửa. */
export async function setSkuPattern(token: string, skuPattern: string) {
  const current = await api(token).get('/settings');
  expect(current.status).toBe(200);
  const res = await api(token).put('/settings', { skuPattern, version: current.body.version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { skuPattern: string; skuNextSeq: number; version: number };
}

/**
 * Nhóm hàng mới (#447). Mẫu SKU là của công ty: `skuPattern` (mặc định `AO-{SEQ:4}-{VAL}` như các test cũ) được đặt
 * cho công ty trước khi tạo nhóm; `null` thì giữ mẫu đang có.
 */
export async function createGroup(token: string, name: string, skuPattern: string | null = 'AO-{SEQ:4}-{VAL}') {
  if (skuPattern !== null) await setSkuPattern(token, skuPattern);
  const res = await api(token).post('/groups', { name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; name: string; productCount: number; version: number };
}

export interface AttributeBody {
  id: string;
  name: string;
  version: number;
  productCount: number;
  values: { id: string; value: string; code: string; inUse: boolean }[];
}

/** Giá trị thuộc tính đã biết (id → thuộc tính, chữ), để `productBody` dựng `axes` từ id giá trị như test cũ. */
const knownValues = new Map<string, { attributeId: string; value: string }>();

/** Ghi nhớ giá trị của thuộc tính lấy từ response (`createAttribute` tự gọi; dùng sau `PUT /attributes`). */
export function rememberAttribute(attribute: AttributeBody): AttributeBody {
  for (const v of attribute.values) knownValues.set(v.id, { attributeId: attribute.id, value: v.value });
  return attribute;
}

export async function createAttribute(token: string, name: string, values: string[]) {
  const res = await api(token).post('/attributes', { name, values: values.map((value) => ({ value })) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return rememberAttribute(res.body as AttributeBody);
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
  /** Mã cha (#204 D5). */
  code: string;
  version: number;
  status: 'active' | 'archived';
  variants: { id: string; sku: string; archivedAt: string | null; attributes: { valueId: string; value: string }[] }[];
}

/** Tên không trùng giữa các test (dữ liệu dùng chung giữa file). */
export const uniq = (prefix: string) => `${prefix} ${randomUUID().slice(0, 8)}`;

/**
 * Thân `POST /catalog/products` (#447: `axes` + `variants[].options`) dựng từ id giá trị của thuộc tính có sẵn như test
 * cũ: thứ tự trục theo biến thể đầu, mỗi trục gồm các giá trị được dùng. `extra` ghi đè để thử ca lỗi.
 */
export function productBody(name: string, groupId: string, variants: string[][], extra: object = {}) {
  const rows = variants.map((ids) =>
    ids.map((id) => {
      const known = knownValues.get(id);
      if (!known) throw new Error(`Giá trị ${id} chưa qua createAttribute/rememberAttribute`);
      return { id, ...known };
    }),
  );
  const order = (rows[0] ?? []).map((v) => v.attributeId);
  const axes = order.map((attributeId) => {
    const values = new Map<string, { id: string; value: string }>();
    for (const row of rows) for (const v of row) if (v.attributeId === attributeId) values.set(v.id, { id: v.id, value: v.value });
    return { attributeId, values: [...values.values()] };
  });
  return {
    name,
    groupId,
    description: '',
    imageFileIds: [],
    axes,
    variants: rows.map((row) => ({ options: order.map((a) => row.find((v) => v.attributeId === a)?.value ?? '') })),
    ...extra,
  };
}

export async function createProduct(token: string, body: { name: string; groupId: string; variants: string[][] }) {
  const res = await api(token).post('/products', productBody(body.name, body.groupId, body.variants));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
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

/** Đổi trạng thái kinh doanh SKU (#204), như FE gọi. */
export function businessStatus(token: string, productId: string, action: string, variantIds?: string[]) {
  return api(token).post(`/products/${productId}/business-status`, variantIds ? { action, variantIds } : { action });
}

/** Lưu trữ một SKU như người dùng: Ngừng nhập rồi Lưu trữ (`version` SKU tăng 2). */
export async function archiveSku(token: string, productId: string, variantId: string) {
  for (const action of ['discontinue', 'archive']) {
    const res = await businessStatus(token, productId, action, [variantId]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
}
