import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setHeadObject } from '#src/modules/core/files/service/storage.ts';
import { ProductDraft, ProductDraftPage, PurchaseRequest } from '#src/modules/product/purchasing/api/schemas.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { api, uniq } from '../catalog/helpers.ts';
import { act, type Count, countBody, createReceipt, createRequest, createSupplier, pur, runActions } from './helpers.ts';

// Bản soạn trước nội dung sản phẩm mới trên đề nghị nhập (Documents/21 mục 16.2, 16.3 "Bản soạn trước", 19
// `purchase_product_drafts`, 29 bước 1): tạo, xoá theo dòng; quyền xem, sửa; kiểm ô; ghi sổ phiếu nhập kho thì chép sang
// sản phẩm và SKU vừa tạo.

const stored = new Map<string, number>();
beforeAll(() => {
  setHeadObject(async (_config, target) => {
    const size = stored.get(target.key);
    return size === undefined ? null : { sizeBytes: size };
  });
});
afterAll(() => setHeadObject(null));

/** Xin vé ảnh như FE rồi giả như đã PUT xong lên kho. */
async function image(token: string) {
  const body = { fileName: 'anh.png', contentType: 'image/png', sizeBytes: 2048, purpose: 'product_image' };
  const res = await request(testApp()).post('/api/v1/files/uploads').set('Authorization', `Bearer ${token}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const { rows } = await testPool().query<{ storage_key: string }>('select storage_key from core.files where id = $1', [res.body.fileId]);
  stored.set(rows[0]!.storage_key, body.sizeBytes);
  return res.body.fileId as string;
}

interface Ctx {
  companyId: string;
  ceo: string;
  kho: string;
  admin: string;
  sale: string;
  supplierId: string;
  groupId: string;
}
let A: Ctx;
let otherCeo: string;

beforeAll(async () => {
  const c = await createCompany();
  const group = (await api(c.ceo.token).get('/groups')).body.items[0] as { id: string };
  A = {
    companyId: c.companyId,
    ceo: c.ceo.token,
    kho: (await addMember(c.companyId, 'warehouse')).token,
    admin: (await addMember(c.companyId, 'admin')).token,
    sale: (await addMember(c.companyId, 'sale')).token,
    supplierId: (await createSupplier(c.ceo.token)).id,
    groupId: group.id,
  };
  otherCeo = (await createCompany()).ceo.token;
});

const fresh = (parentName: string, optionValues: Record<string, string>, quantity = 2) => ({
  newProduct: { parentId: null, parentName, groupId: A.groupId, optionValues },
  quantity,
  unitCost: 100000,
});

async function ordered(lines: object[]) {
  const r = await createRequest(A.kho, A.supplierId, lines as never);
  return runActions([[A.kho, 'submit'], [A.ceo, 'approve'], [A.kho, 'order', { expectedDeliveryDate: '2026-12-01' }]], r.id, r.version);
}

async function receive(requestId: string, counts: Partial<Count>[]) {
  const draft = await createReceipt(A.kho, requestId);
  const saved = await pur(A.kho).put(`/goods-receipts/${draft.id}`, countBody(draft, counts));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const res = await pur(A.ceo).post(`/goods-receipts/${draft.id}/post`, { version: saved.body.version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const getDraft = async (token: string, id: string) => {
  const res = await pur(token).get(`/product-drafts/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ProductDraft.parse(res.body);
};
const putDraft = (token: string, id: string, body: object) => pur(token).put(`/product-drafts/${id}`, body);

describe('tạo, xoá bản soạn theo dòng đề nghị', () => {
  it('mỗi tên cha mới một bản (dòng cùng tên gộp); chi tiết đề nghị có productDrafts, newProduct.draftId; đổi tên ở nháp thì bản tên cũ bị xoá', async () => {
    const shirt = uniq('Áo thun');
    const cap = uniq('Mũ');
    const r = await createRequest(A.kho, A.supplierId, [
      fresh(shirt, { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' }),
      fresh(shirt.toUpperCase(), { 'Màu sắc': 'Trắng', 'Kích cỡ': 'L' }),
      fresh(cap, { 'Màu sắc': 'Đỏ' }),
    ] as never);
    const detail = PurchaseRequest.parse((await pur(A.kho).get(`/requests/${r.id}`)).body);
    expect(detail.productDrafts.map((d) => d.parentName).sort()).toEqual([shirt, cap].sort());
    const shirtDraft = detail.productDrafts.find((d) => d.parentName === shirt)!;
    expect(detail.lines.map((l) => l.newProduct?.draftId)).toEqual([shirtDraft.id, shirtDraft.id, expect.any(String)]);

    const full = await getDraft(A.kho, shirtDraft.id);
    expect(full).toMatchObject({ requestId: r.id, requestStatus: 'draft', productId: null, imageAxis: null, images: [], sizeChart: null });
    expect(full.variants.map((v) => v.optionValues)).toEqual([
      { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' },
      { 'Màu sắc': 'Trắng', 'Kích cỡ': 'L' },
    ]);
    expect(full.readiness.missing).toEqual(expect.arrayContaining(['image', 'price', 'weight', 'dimensions']));

    const renamed = uniq('Áo phông');
    const put = await pur(A.kho).put(`/requests/${r.id}`, {
      supplierId: A.supplierId,
      note: '',
      version: detail.version,
      lines: [fresh(renamed, { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' }), fresh(cap, { 'Màu sắc': 'Đỏ' })],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = PurchaseRequest.parse(put.body);
    expect(after.productDrafts.map((d) => d.parentName).sort()).toEqual([renamed, cap].sort());
    expect((await pur(A.kho).get(`/product-drafts/${shirtDraft.id}`)).status).toBe(404);
  });
});

describe('quyền (21 mục 16.2)', () => {
  let draftId: string;
  beforeAll(async () => {
    const r = await createRequest(A.kho, A.supplierId, [fresh(uniq('Son'), { 'Màu sắc': 'Hồng' })] as never);
    draftId = PurchaseRequest.parse((await pur(A.kho).get(`/requests/${r.id}`)).body).productDrafts[0]!.id;
  });

  it('Admin (catalog.product.manage, không quyền nhập hàng) xem danh sách, chi tiết và sửa được; danh sách không có giá nhập', async () => {
    const list = await pur(A.admin).get('/product-drafts');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const page = ProductDraftPage.parse(list.body);
    expect(page.items.some((d) => d.id === draftId)).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/unitCost|unitPrice|quantity/);
    const draft = await getDraft(A.admin, draftId);
    const res = await putDraft(A.admin, draftId, { brand: 'Hoa Sen', version: draft.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ brand: 'Hoa Sen', version: draft.version + 1 });
  });

  it('Sale (không quyền nào trong hai nhóm) bị 403 ở danh sách, chi tiết, sửa', async () => {
    expect((await pur(A.sale).get('/product-drafts')).status).toBe(403);
    expect((await pur(A.sale).get(`/product-drafts/${draftId}`)).status).toBe(403);
    const res = await putDraft(A.sale, draftId, { brand: 'X', version: 1 });
    expect(res.status).toBe(403);
  });

  it('công ty khác: 404; id sai dạng: 404', async () => {
    expect((await pur(otherCeo).get(`/product-drafts/${draftId}`)).status).toBe(404);
    expect((await putDraft(otherCeo, draftId, { brand: 'X', version: 1 })).status).toBe(404);
    expect((await pur(A.kho).get('/product-drafts/khong-phai-uuid')).status).toBe(404);
  });

  it('Kho thiếu inventory.reorder.manage: gửi minQty thì 422 theo ô', async () => {
    const draft = await getDraft(A.kho, draftId);
    const res = await putDraft(A.kho, draftId, {
      variantDefaults: { minQty: 5 },
      variants: [{ optionValues: { 'Màu sắc': 'Hồng' }, minQty: 3 }],
      version: draft.version,
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toMatchObject({ 'variantDefaults.minQty': expect.any(String), 'variants.0.minQty': expect.any(String) });
  });
});

describe('kiểm ô khi sửa', () => {
  it('tổ hợp không có trên dòng, trục gắn ảnh không phải trục của sản phẩm, ảnh theo giá trị sai trục, sai version', async () => {
    const r = await createRequest(A.kho, A.supplierId, [fresh(uniq('Áo'), { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' })] as never);
    const id = PurchaseRequest.parse((await pur(A.kho).get(`/requests/${r.id}`)).body).productDrafts[0]!.id;
    const draft = await getDraft(A.kho, id);
    const fileId = await image(A.admin);

    const bad = await putDraft(A.kho, id, { variants: [{ optionValues: { 'Màu sắc': 'Xanh', 'Kích cỡ': 'M' }, weightG: 200 }], version: draft.version });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty(['variants.0.optionValues']);

    const axis = await putDraft(A.kho, id, { imageAxis: 'Chất liệu', version: draft.version });
    expect(axis.status).toBe(422);
    expect(axis.body.errors).toHaveProperty('imageAxis');

    const wrongAxis = await putDraft(A.kho, id, { imageAxis: 'màu  SẮC', optionImages: [{ axis: 'Kích cỡ', value: 'M', fileId }], version: draft.version });
    expect(wrongAxis.status).toBe(422);
    expect(wrongAxis.body.errors).toHaveProperty(['optionImages.0']);

    const stale = await putDraft(A.kho, id, { brand: 'A', version: draft.version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('gộp theo ô: specs theo fieldId (gửi rỗng là xoá), variants theo tổ hợp; lỗi theo chỉ số trong mảng đã gửi', async () => {
    const nameM = uniq('Áo');
    const r = await createRequest(A.kho, A.supplierId, [fresh(nameM, { 'Kích cỡ': 'M' }), fresh(uniq('Áo'), { 'Kích cỡ': 'L' })] as never);
    const drafts = PurchaseRequest.parse((await pur(A.kho).get(`/requests/${r.id}`)).body).productDrafts;
    // Hai bản soạn tạo cùng giao dịch, cùng `created_at`: thứ tự trả về không cố định, chọn theo tên (bản của dòng "M").
    const id = drafts.find((d) => d.parentName === nameM)!.id;
    const field = async () => {
      const res = await api(A.ceo).post('/spec-fields', { name: uniq('Ghi chú'), input: 'text', allowCustom: false });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as string;
    };
    const [f1, f2] = [await field(), await field()];
    let d = await getDraft(A.kho, id);
    let res = await putDraft(A.kho, id, { specs: [{ fieldId: f1, value: 'Một' }, { fieldId: f2, value: 'Hai' }], version: d.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    d = ProductDraft.parse(res.body);
    res = await putDraft(A.kho, id, { specs: [{ fieldId: f2, value: 'Hai sửa' }], version: d.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    d = ProductDraft.parse(res.body);
    expect(Object.fromEntries(d.specs.map((s) => [s.fieldId, s.value]))).toEqual({ [f1]: 'Một', [f2]: 'Hai sửa' });
    res = await putDraft(A.kho, id, { specs: [{ fieldId: f1, value: '' }], version: d.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ProductDraft.parse(res.body).specs.map((s) => s.fieldId)).toEqual([f2]);

    // Lỗi theo chỉ số trong mảng `variants` đã gửi (FE chỉ gửi tổ hợp có ô đổi).
    d = ProductDraft.parse(res.body);
    const bad = await putDraft(A.kho, id, {
      variants: [{ optionValues: { 'Kích cỡ': 'M' }, weightG: 100 }, { optionValues: { 'Kích cỡ': 'XL' }, weightG: 100 }],
      version: d.version,
    });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors)).toEqual(['variants.1.optionValues']);
  });
});

describe('ghi sổ phiếu nhập kho chép bản soạn sang sản phẩm', () => {
  it('phiếu đầu: cha nhận mô tả, thương hiệu, xuất xứ, ảnh, ảnh theo màu; SKU nhận số chung, số riêng ghi đè, ngưỡng tồn; phần sản phẩm khoá, tổ hợp chưa về vẫn sửa; phiếu sau SKU mới nhận số', async () => {
    const name = uniq('Áo thun soạn trước');
    const req = await ordered([fresh(name, { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' }), fresh(name, { 'Màu sắc': 'Trắng', 'Kích cỡ': 'L' })]);
    const id = PurchaseRequest.parse((await pur(A.kho).get(`/requests/${req.id}`)).body).productDrafts[0]!.id;
    const [cover, black, white] = [await image(A.admin), await image(A.admin), await image(A.admin)];
    const draft = await getDraft(A.admin, id);
    const saved = await putDraft(A.admin, id, {
      description: 'Áo cotton 100%',
      brand: 'Hoa Sen',
      originCountry: 'vn',
      imageFileIds: [cover],
      imageAxis: 'Màu sắc',
      optionImages: [
        { axis: 'Màu sắc', value: 'Đen', fileId: black },
        { axis: 'Màu sắc', value: 'Trắng', fileId: white },
      ],
      variantDefaults: { standardPrice: 150000, targetNetPrice: 120000, weightG: 250, lengthMm: 300, widthMm: 200, heightMm: 30, minQty: 4 },
      variants: [{ optionValues: { 'Kích cỡ': 'L', 'Màu sắc': 'Trắng' }, targetNetPrice: 130000, minQty: 6 }],
      version: draft.version,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(ProductDraft.parse(saved.body).readiness.missing).not.toContain('price');

    // Chỉ về dòng Đen M.
    await receive(req.id, [{ announced: 2, accepted: 2 }]);
    const afterFirst = await getDraft(A.kho, id);
    expect(afterFirst.productId).not.toBeNull();
    expect(afterFirst.variants.find((v) => v.optionValues['Màu sắc'] === 'Đen')!.variantId).not.toBeNull();
    expect(afterFirst.variants.find((v) => v.optionValues['Màu sắc'] === 'Trắng')!.variantId).toBeNull();

    const product = (await api(A.ceo).get(`/products/${afterFirst.productId}`)).body as {
      description: string;
      brand: string;
      originCountry: string;
      images: { fileId: string }[];
      variants: { sku: string; standardPrice: number; targetNetPrice: number; weightG: number; minQty: number; image: { fileId: string } | null }[];
    };
    expect(product).toMatchObject({ description: 'Áo cotton 100%', brand: 'Hoa Sen', originCountry: 'VN' });
    expect(product.images.map((i) => i.fileId)).toEqual([cover]);
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]).toMatchObject({ standardPrice: 150000, targetNetPrice: 120000, weightG: 250, minQty: 4, image: { fileId: black } });

    // Phần sản phẩm đã khoá; tổ hợp đã có SKU không sửa; tổ hợp chưa về vẫn sửa.
    const closed = await putDraft(A.kho, id, { brand: 'Khác', version: afterFirst.version });
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ code: 'draft_closed', productId: afterFirst.productId });
    const created = await putDraft(A.kho, id, { variants: [{ optionValues: { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' }, weightG: 1 }], version: afterFirst.version });
    expect(created.status).toBe(422);
    expect(created.body.code).toBe('variant_created');
    const pending = await putDraft(A.kho, id, { variants: [{ optionValues: { 'Màu sắc': 'Trắng', 'Kích cỡ': 'L' }, weightG: 400 }], version: afterFirst.version });
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);

    // Phiếu sau về dòng Trắng L: SKU thứ hai thêm vào cùng cha, nhận số riêng (giá muốn bán, cân nặng mới gửi, ngưỡng tồn).
    await receive(req.id, [{ announced: 2, accepted: 2 }]);
    const again = (await api(A.ceo).get(`/products/${afterFirst.productId}`)).body as typeof product;
    expect(again.variants).toHaveLength(2);
    const second = again.variants.find((v) => v.image?.fileId === white)!;
    expect(second).toMatchObject({ standardPrice: 150000, targetNetPrice: 130000, weightG: 400, minQty: 6 });
  });

  it('đề nghị đã kết thúc (huỷ): sửa bản soạn 409 draft_closed', async () => {
    const req = await ordered([fresh(uniq('Quần'), { 'Kích cỡ': 'M' })]);
    const id = PurchaseRequest.parse((await pur(A.kho).get(`/requests/${req.id}`)).body).productDrafts[0]!.id;
    const cancelled = await act(A.ceo, req.id, 'cancel', { version: req.version, reason: 'NCC hết hàng' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const draft = await getDraft(A.kho, id);
    const res = await putDraft(A.kho, id, { brand: 'X', version: draft.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('draft_closed');
    // Danh sách mặc định (pending) bỏ bản của đề nghị đã kết thúc.
    const list = ProductDraftPage.parse((await pur(A.kho).get('/product-drafts?pageSize=100')).body);
    expect(list.items.some((d) => d.id === id)).toBe(false);
  });
});
