import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';
import { createSupplier, orderedRequest, pur } from '../purchasing/helpers.ts';
import { api, archiveSku, createAttribute, createGroup, createProduct, uniq, valueId } from './helpers.ts';

// Sửa hàng loạt có gợi ý (#242, Documents/21 §17.5, 27 US-SP-04).
let companyId: string;
let ceo: string;
let kho: string;
let admin: string;
beforeAll(async () => {
  const company = await createCompany({ optionalModules: ['purchasing'] });
  companyId = company.companyId;
  ceo = company.ceo.token;
  kho = (await addMember(companyId, 'warehouse')).token;
  admin = (await addMember(companyId, 'admin')).token;
});

const SUGGEST = { marginCoefficient: 1.4, priceRounding: 1000, reorderLeadDays: 7, reorderSafetyQty: 2, reorderDefaultQty: 5 };
const NO_SUGGEST = { marginCoefficient: null, priceRounding: null, reorderLeadDays: null, reorderSafetyQty: null, reorderDefaultQty: null };

/** Nhóm hàng có cấu hình gợi ý (hoặc không), một sản phẩm một SKU không thuộc tính. Công ty chưa đặt gợi ý mặc định. */
async function setup(suggest: object | null = SUGGEST) {
  const group = await api(ceo).post('/groups', { name: uniq('Áo'), ...(suggest && { suggest }) });
  expect(group.status, JSON.stringify(group.body)).toBe(201);
  const product = await createProduct(ceo, { name: uniq('Áo'), groupId: group.body.id, variants: [[]] });
  return { group: group.body, product, variantId: product.variants[0]!.id };
}

const bulk = (token: string) => ({
  list: (query = '') => api(token).get(`/variants/bulk-edit${query}`),
  save: (rows: unknown[]) => api(token).patch('/variants/bulk', { rows }),
});
interface BulkRowView {
  variantId: string;
  sku: string;
  productName: string;
  attributesLabel: string;
  version: number;
  reorderVersion: number | null;
  current: Record<string, number | null>;
  source: { purchaseRequestNumber: string; supplierName: string | null; lastCost: number | null } | null;
  suggestions: Record<string, { value: number; basis: string }>;
}
const rowOf = (res: { body: { items: BulkRowView[] } }, variantId: string) => res.body.items.find((i) => i.variantId === variantId)!;
const search = (name: string) => `?search=${encodeURIComponent(name)}`;
const eventsOf = (variantId: string) =>
  testPool().query("select payload from core.outbox_messages where type = 'catalog.variant_price_changed' and key = $1 order by id", [variantId]);
const variantRow = async (id: string) => (await testPool().query('select * from product.product_variants where id = $1', [id])).rows[0];

describe('cấu hình gợi ý của nhóm hàng', () => {
  it('tạo kèm cấu hình, trả lại; sửa không gửi `suggest` thì giữ; gửi thì thay cả năm giá trị', async () => {
    const { group } = await setup();
    expect(group.suggest).toEqual(SUGGEST);
    const keep = await api(ceo).put(`/groups/${group.id}`, { name: group.name, version: group.version });
    expect(keep.status).toBe(200);
    expect(keep.body.suggest).toEqual(SUGGEST);
    const clear = await api(ceo).put(`/groups/${group.id}`, {
      name: group.name,
      version: keep.body.version,
      suggest: NO_SUGGEST,
    });
    expect(clear.body.suggest).toEqual(NO_SUGGEST);
  });

  it('tạo không kèm cấu hình thì năm giá trị là null; hệ số dưới 1 hoặc quá hai chữ số thập phân bị từ chối', async () => {
    const { group } = await setup(null);
    expect(group.suggest).toEqual(NO_SUGGEST);
    for (const marginCoefficient of [0.9, 1.234]) {
      const bad = await api(ceo).post('/groups', { name: uniq('Xấu'), suggest: { ...SUGGEST, marginCoefficient } });
      expect(bad.status).toBe(422);
    }
  });
});

describe('GET /variants/bulk-edit', () => {
  it('AC1, AC2: giá nhập 100.000, hệ số 1,4, làm tròn 1.000 → gợi ý 140.000; nguồn là đề nghị nhập; chưa lưu gì (AC5)', async () => {
    const { product, variantId } = await setup();
    const supplier = await createSupplier(ceo, { name: uniq('NCC') });
    const ordered = await orderedRequest({ requester: kho, ceo }, supplier.id, [{ variantId, quantity: 10, unitCost: 100_000 }]);
    const res = await bulk(ceo).list(search(product.name));
    expect(res.status).toBe(200);
    const row = rowOf(res, variantId);
    expect(row).toMatchObject({
      sku: product.variants[0]!.sku,
      productName: product.name,
      attributesLabel: '',
      version: 1,
      reorderVersion: null,
      current: { standardPrice: null, targetNetPrice: null, minQty: null, weightG: null },
      source: { purchaseRequestNumber: ordered.number, supplierName: supplier.name, lastCost: 100_000 },
    });
    expect(row.suggestions.targetNetPrice!.value).toBe(140_000);
    expect(row.suggestions.targetNetPrice!.basis).toContain('100.000');
    const after = await variantRow(variantId);
    expect(after).toMatchObject({ target_net_price: null, version: 1 });
  });

  it('thiếu `inventory.cost.view` (Admin): vẫn có gợi ý giá nhưng không lộ giá nhập, câu giải thích cũng không nêu', async () => {
    const { product, variantId } = await setup();
    const supplier = await createSupplier(ceo, { name: uniq('NCC') });
    await orderedRequest({ requester: kho, ceo }, supplier.id, [{ variantId, quantity: 10, unitCost: 100_000 }]);
    const row = rowOf(await bulk(admin).list(search(product.name)), variantId);
    expect(row.source!.lastCost).toBeNull();
    expect(row.suggestions.targetNetPrice!.value).toBe(140_000);
    expect(row.suggestions.targetNetPrice!.basis).not.toContain('100.000');
  });

  it('chỉ đề nghị đã duyệt mới là nguồn giá nhập: đề nghị nháp không tính', async () => {
    const { product, variantId } = await setup();
    const supplier = await createSupplier(ceo, { name: uniq('NCC') });
    const draft = await pur(kho).post('/requests', { supplierId: supplier.id, note: '', lines: [{ variantId, quantity: 5, unitCost: 90_000 }] });
    expect(draft.status).toBe(201);
    const row = rowOf(await bulk(ceo).list(search(product.name)), variantId);
    expect(row.source).toBeNull();
    expect(row.suggestions.targetNetPrice).toBeUndefined();
  });

  it('AC3: ngưỡng tồn = bán/ngày × ngày chờ + tồn an toàn; chưa bán thì mặc định của nhóm; đơn huỷ không tính', async () => {
    const sold = await setup();
    const fresh = await setup();
    await createOrder(companyId, { lines: [{ variantId: sold.variantId, quantity: 30, unitPrice: 100_000 }] });
    const cancelled = await createOrder(companyId, { lines: [{ variantId: sold.variantId, quantity: 60, unitPrice: 100_000 }] });
    await testPool().query('update "order".orders set status = \'cancelled\' where id = $1', [cancelled.orderId]);
    const a = rowOf(await bulk(ceo).list(search(sold.product.name)), sold.variantId);
    expect(a.suggestions.minQty).toMatchObject({ value: 9 }); // 30/30 × 7 + 2
    const b = rowOf(await bulk(ceo).list(search(fresh.product.name)), fresh.variantId);
    expect(b.suggestions.minQty).toMatchObject({ value: 5 });
  });

  it('nhóm và công ty đều chưa đặt cấu hình thì không gợi ý giá, ngưỡng tồn dù đã có giá nhập', async () => {
    const { product, variantId } = await setup(null);
    const supplier = await createSupplier(ceo, { name: uniq('NCC') });
    await orderedRequest({ requester: kho, ceo }, supplier.id, [{ variantId, quantity: 10, unitCost: 100_000 }]);
    const row = rowOf(await bulk(ceo).list(search(product.name)), variantId);
    expect(row.suggestions).toEqual({});
    expect(row.source!.lastCost).toBe(100_000);
  });

  // AC-6 (#447): hệ số lãi, bước làm tròn, số ngày chờ... lấy ở nhóm hàng, nhóm để trống thì lấy ở cài đặt công ty. Dùng công ty
  // riêng vì đặt gợi ý mặc định của công ty sẽ đổi kết quả của các ca "chưa đặt cấu hình" ở trên.
  it('AC-6: SKU của nhóm có hệ số 1,2 gợi ý theo 1,2 "theo nhóm <tên>"; nhóm để trống gợi ý theo hệ số 2 của công ty "theo công ty"', async () => {
    const own = await createCompany({ optionalModules: ['purchasing'] });
    const owner = own.ceo.token;
    const warehouse = (await addMember(own.companyId, 'warehouse')).token;
    const settings = (await api(owner).get('/settings')).body as { skuPattern: string; version: number };
    const company = await api(owner).put('/settings', { skuPattern: settings.skuPattern, suggest: { ...NO_SUGGEST, marginCoefficient: 2 }, version: settings.version });
    expect(company.status, JSON.stringify(company.body)).toBe(200);

    const groups = (await api(owner).get('/groups')).body.items as { id: string; name: string; version: number }[];
    const electronics = groups.find((g) => g.name === 'Âm thanh, TV & máy ảnh')!;
    const blank = groups.find((g) => g.name === 'Khác')!;
    const set = await api(owner).put(`/groups/${electronics.id}`, { suggest: { ...NO_SUGGEST, marginCoefficient: 1.2 }, version: electronics.version });
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    const inGroup = await createProduct(owner, { name: uniq('Tai nghe'), groupId: electronics.id, variants: [[]] });
    const inBlank = await createProduct(owner, { name: uniq('Đồ lặt vặt'), groupId: blank.id, variants: [[]] });
    const supplier = await createSupplier(owner, { name: uniq('NCC') });
    await orderedRequest({ requester: warehouse, ceo: owner }, supplier.id, [
      { variantId: inGroup.variants[0]!.id, quantity: 10, unitCost: 100_000 },
      { variantId: inBlank.variants[0]!.id, quantity: 10, unitCost: 100_000 },
    ]);

    const list = await bulk(owner).list();
    expect(list.status).toBe(200);
    const byGroup = rowOf(list, inGroup.variants[0]!.id).suggestions.targetNetPrice!;
    expect(byGroup.value).toBe(120_000);
    expect(byGroup.basis).toMatch(new RegExp(`theo nhóm ${electronics.name}$`));
    const byCompany = rowOf(list, inBlank.variants[0]!.id).suggestions.targetNetPrice!;
    expect(byCompany.value).toBe(200_000);
    expect(byCompany.basis).toMatch(/theo công ty$/);
  });

  it('AC4: SKU còn trống chép cân nặng, kích thước, giá từ SKU anh em đã có số; ô đã đủ thì không gợi ý', async () => {
    const color = await createAttribute(ceo, uniq('Màu'), ['Đen', 'Trắng']);
    const group = await createGroup(ceo, uniq('Quần'), 'Q-{SEQ:4}-{VAL}');
    const pants = await createProduct(ceo, {
      name: uniq('Quần'),
      groupId: group.id,
      variants: [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]],
    });
    const [first, second] = pants.variants;
    const patch = await api(ceo).patch(`/products/${pants.id}/variants/${first!.id}`, {
      version: 1,
      standardPrice: 150_000,
      targetNetPrice: 200_000,
      weightG: 300,
      lengthMm: 400,
      widthMm: 250,
      heightMm: 30,
    });
    expect(patch.status).toBe(200);
    const res = await bulk(ceo).list(search(pants.name));
    const row = rowOf(res, second!.id);
    expect(row.attributesLabel).toBe('Trắng');
    expect(row.suggestions).toMatchObject({
      standardPrice: { value: 150_000 },
      targetNetPrice: { value: 200_000 },
      weightG: { value: 300 },
      lengthMm: { value: 400 },
      widthMm: { value: 250 },
      heightMm: { value: 30 },
    });
    expect(row.suggestions.weightG!.basis).toContain(first!.sku);
    expect(rowOf(res, first!.id).suggestions).toEqual({});
  });

  it('lọc incomplete, nhóm hàng, từ khoá có ký tự LIKE; SKU của sản phẩm đã lưu trữ không có; phân trang; công ty khác không thấy', async () => {
    const full = await setup(null);
    const empty = await setup(null);
    await api(ceo).patch(`/products/${full.product.id}/variants/${full.variantId}`, {
      version: 1,
      targetNetPrice: 100_000,
      weightG: 100,
      lengthMm: 100,
      widthMm: 100,
      heightMm: 100,
    });
    const onlyEmpty = await bulk(ceo).list(`?groupId=${empty.group.id}&incomplete=true`);
    expect(onlyEmpty.body.items.map((i: { variantId: string }) => i.variantId)).toEqual([empty.variantId]);
    expect((await bulk(ceo).list(`?groupId=${full.group.id}&incomplete=true`)).body.items).toEqual([]);
    expect((await bulk(ceo).list(`?groupId=${full.group.id}`)).body.total).toBe(1);
    expect((await bulk(ceo).list('?search=%25')).body.total).toBe(0); // `%` là chữ, không phải mẫu LIKE
    await archiveSku(ceo, empty.product.id, empty.variantId);
    expect((await bulk(ceo).list(`?groupId=${empty.group.id}`)).body.items).toEqual([]);
    expect((await bulk(ceo).list('?page=1&pageSize=1')).body).toMatchObject({ page: 1, pageSize: 1 });
    expect((await bulk(ceo).list('?pageSize=201')).status).toBe(422);
    const other = await createCompany();
    expect((await bulk(other.ceo.token).list(`?groupId=${full.group.id}`)).body.items).toEqual([]);
  });

  it('cần `catalog.product.manage`: Kho nhận 403, không đăng nhập 401', async () => {
    expect((await bulk(kho).list()).status).toBe(403);
    expect((await request(testApp()).get('/api/v1/catalog/variants/bulk-edit')).status).toBe(401);
  });
});

describe('PATCH /variants/bulk', () => {
  it('lưu giá muốn bán, cân nặng, ngưỡng tồn; phát variant_price_changed một lần; trả version mới; GET sau đó khớp', async () => {
    const { product, variantId } = await setup();
    const res = await bulk(ceo).save([
      { variantId, version: 1, reorderVersion: null, targetNetPrice: 140_000, weightG: 250, lengthMm: 300, widthMm: 200, heightMm: 20, minQty: 9 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ saved: [{ variantId, version: 2 }], failed: [] });
    expect(await variantRow(variantId)).toMatchObject({ target_net_price: '140000.00', weight_g: 250, version: 2 });
    const stock = (await testPool().query('select min_qty from product.stock_levels where variant_id = $1', [variantId])).rows[0];
    expect(stock).toEqual({ min_qty: 9 });
    const events = await eventsOf(variantId);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload).toMatchObject({ variantId, to: '140000.00' });
    const row = rowOf(await bulk(ceo).list(search(product.name)), variantId);
    expect(row).toMatchObject({ version: 2, current: { targetNetPrice: 140_000, minQty: 9 } });
    expect(row.reorderVersion).toBeGreaterThan(0);
  });

  it('lỗi theo dòng, dòng đúng vẫn lưu: sai version, số không hợp lệ, SKU không có, SKU lặp, trường lạ', async () => {
    const good = await setup();
    const stale = await setup();
    const invalid = await setup();
    const ghost = randomUUID();
    const res = await bulk(ceo).save([
      { variantId: good.variantId, version: 1, weightG: 100 },
      { variantId: stale.variantId, version: 7, weightG: 100 },
      { variantId: invalid.variantId, version: 1, weightG: 0, heightMm: 99_999, targetNetPrice: -5 },
      { variantId: ghost, version: 1, weightG: 100 },
      { variantId: good.variantId, version: 2, weightG: 200 },
      { variantId: invalid.variantId, version: 1, imageFileId: 'x' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.saved).toEqual([{ variantId: good.variantId, version: 2 }]);
    expect(res.body.failed).toEqual([
      { variantId: stale.variantId, code: 'version_conflict', message: expect.stringContaining('vừa được người khác sửa') },
      {
        variantId: invalid.variantId,
        code: 'validation_failed',
        message: 'Dữ liệu dòng không hợp lệ',
        errors: { weightG: expect.any(String), heightMm: expect.any(String), targetNetPrice: expect.any(String) },
      },
      { variantId: ghost, code: 'not_found', message: 'Không tìm thấy SKU' },
      { variantId: good.variantId, code: 'validation_failed', message: expect.any(String), errors: { variantId: 'SKU bị lặp' } },
      { variantId: invalid.variantId, code: 'validation_failed', message: expect.any(String), errors: { row: expect.any(String) } },
    ]);
    expect((await variantRow(good.variantId)).weight_g).toBe(100);
    expect((await variantRow(stale.variantId)).weight_g).toBeNull();
    expect((await variantRow(invalid.variantId)).weight_g).toBeNull();
  });

  it('dòng cân nặng 50001 hoặc cạnh 2001 lỗi theo ô, dòng khác vẫn lưu (#434)', async () => {
    const good = await setup();
    const bad = await setup();
    const res = await bulk(ceo).save([
      { variantId: good.variantId, version: 1, weightG: 50_000, lengthMm: 2_000 },
      { variantId: bad.variantId, version: 1, weightG: 50_001, widthMm: 2_001 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.saved).toEqual([{ variantId: good.variantId, version: 2 }]);
    expect(res.body.failed).toMatchObject([
      {
        variantId: bad.variantId,
        code: 'validation_failed',
        errors: { weightG: 'Cân nặng tối đa 50 kg', widthMm: 'Chiều rộng tối đa 2.000 mm' },
      },
    ]);
    expect((await variantRow(good.variantId)).weight_g).toBe(50_000);
    expect((await variantRow(bad.variantId)).weight_g).toBeNull();
  });

  it('dòng lỗi huỷ cả những gì đã ghi cho dòng đó: sai reorderVersion thì giá của dòng cũng không đổi, không có sự kiện', async () => {
    const { variantId } = await setup();
    const res = await bulk(ceo).save([{ variantId, version: 1, reorderVersion: 5, targetNetPrice: 120_000, minQty: 4 }]);
    expect(res.body.saved).toEqual([]);
    expect(res.body.failed).toEqual([
      { variantId, code: 'version_conflict', message: expect.any(String), errors: { minQty: expect.any(String) } },
    ]);
    expect(await variantRow(variantId)).toMatchObject({ target_net_price: null, version: 1 });
    expect((await eventsOf(variantId)).rowCount).toBe(0);
  });

  it('gửi lại đúng giá trị đã lưu: không ghi, không đổi version, không phát thêm sự kiện', async () => {
    const { variantId } = await setup();
    await bulk(ceo).save([{ variantId, version: 1, targetNetPrice: 120_000 }]);
    const again = await bulk(ceo).save([{ variantId, version: 2, targetNetPrice: 120_000 }]);
    expect(again.body).toEqual({ saved: [{ variantId, version: 2 }], failed: [] });
    expect((await eventsOf(variantId)).rowCount).toBe(1);
  });

  it('null xoá giá trị; minQty null bỏ ngưỡng', async () => {
    const { variantId } = await setup();
    await bulk(ceo).save([{ variantId, version: 1, weightG: 100, minQty: 3 }]);
    const level = (await testPool().query('select version from product.stock_levels where variant_id = $1', [variantId])).rows[0];
    const res = await bulk(ceo).save([{ variantId, version: 2, reorderVersion: level.version, weightG: null, minQty: null }]);
    expect(res.body.failed).toEqual([]);
    expect((await variantRow(variantId)).weight_g).toBeNull();
    expect((await testPool().query('select min_qty from product.stock_levels where variant_id = $1', [variantId])).rows[0].min_qty).toBeNull();
  });

  it('SKU công ty khác: not_found', async () => {
    const { variantId } = await setup();
    const other = await createCompany();
    const cross = await bulk(other.ceo.token).save([{ variantId, version: 1, weightG: 1 }]);
    expect(cross.body.failed[0].code).toBe('not_found');
  });

  it('thiếu `inventory.reorder.manage`: dòng có minQty bị từ chối theo ô, dòng không có minQty vẫn lưu', async () => {
    const roleId = await createCustomRole(companyId, ['catalog.product.view', 'catalog.product.manage']);
    const user = (await addMember(companyId, roleId)).token;
    const a = await setup();
    const b = await setup();
    const res = await bulk(user).save([
      { variantId: a.variantId, version: 1, weightG: 10, minQty: 3 },
      { variantId: b.variantId, version: 1, weightG: 10 },
    ]);
    expect(res.body.saved).toEqual([{ variantId: b.variantId, version: 2 }]);
    expect(res.body.failed).toEqual([
      { variantId: a.variantId, code: 'validation_failed', message: expect.any(String), errors: { minQty: expect.any(String) } },
    ]);
    expect((await variantRow(a.variantId)).weight_g).toBeNull();
  });

  it('201 dòng: 400 too_many_rows, không ghi gì; rows rỗng: 422; Kho: 403', async () => {
    const { variantId } = await setup();
    const rows = Array.from({ length: 201 }, () => ({ variantId, version: 1, weightG: 5 }));
    const res = await bulk(ceo).save(rows);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('too_many_rows');
    expect((await variantRow(variantId)).weight_g).toBeNull();
    expect((await bulk(ceo).save([])).status).toBe(422);
    expect((await bulk(kho).save([{ variantId, version: 1, weightG: 5 }])).status).toBe(403);
  });

  it('ghi nhật ký thao tác cho SKU đổi, chỉ gồm trường đổi theo dạng API', async () => {
    const { variantId } = await setup();
    await bulk(ceo).save([{ variantId, version: 1, weightG: 123 }]);
    const logs = await testPool().query(
      "select action, before, after from core.audit_logs where entity_type = 'product.product_variants' and entity_id = $1 order by created_at",
      [variantId],
    );
    expect(logs.rows.at(-1)).toMatchObject({ action: 'update', before: { weightG: null }, after: { weightG: 123 } });
  });
});
