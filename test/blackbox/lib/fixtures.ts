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
