import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PurchaseRequest } from '#src/modules/product/purchasing/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { api, setSkuPattern, uniq } from '../catalog/helpers.ts';
import { act, createRequest, createSupplier, pur, runActions } from './helpers.ts';

// Dòng sản phẩm mới theo sản phẩm cha và trục phân loại (#243; Documents/21 mục 16.3, 25 §3.2, §5.4).

interface Ctx {
  companyId: string;
  ceo: string;
  kho: string;
  supplierId: string;
  groupId: string;
}

interface ProductVariant {
  id: string;
  sku: string;
  attributes: { attributeName: string; value: string }[];
}

let A: Ctx;
let otherCompanyProductId: string;

async function company(): Promise<Ctx> {
  const c = await createCompany();
  const group = (await api(c.ceo.token).get('/groups')).body.items[0] as { id: string };
  return {
    companyId: c.companyId,
    ceo: c.ceo.token,
    kho: (await addMember(c.companyId, 'warehouse')).token,
    supplierId: (await createSupplier(c.ceo.token)).id,
    groupId: group.id,
  };
}

beforeAll(async () => {
  A = await company();
  otherCompanyProductId = (await createVariant((await createCompany()).companyId)).productId;
});

const fresh = (parentName: string, optionValues: Record<string, string>, groupId = A.groupId) => ({
  newProduct: { parentId: null, parentName, groupId, optionValues },
  quantity: 2,
  unitCost: 100000,
});
const under = (parentId: string, optionValues: Record<string, string>) => ({
  newProduct: { parentId, parentName: null, groupId: null, optionValues },
  quantity: 1,
  unitCost: 100000,
});

const post = (ctx: Ctx, lines: object[]) => pur(ctx.kho).post('/requests', { supplierId: ctx.supplierId, note: '', lines });

async function approved(ctx: Ctx, lines: object[]) {
  const r = await createRequest(ctx.kho, ctx.supplierId, lines as never);
  return runActions([[ctx.kho, 'submit'], [ctx.ceo, 'approve']], r.id, r.version);
}

async function productOf(token: string, variantId: string) {
  const [row] = (await testPool().query<{ product_id: string }>('select product_id from product.product_variants where id = $1', [variantId])).rows;
  const res = await api(token).get(`/products/${row!.product_id}`);
  expect(res.status).toBe(200);
  return res.body as { id: string; name: string; code: string; groupId: string; variants: ProductVariant[] };
}

/** Sản phẩm cha có sẵn hai trục (Màu sắc, Kích cỡ) qua API catalog. */
async function parentWithAxes(ctx: Ctx, combos: [string, string][]) {
  const colors = [...new Set(combos.map((c) => c[0]))];
  const sizes = [...new Set(combos.map((c) => c[1]))];
  const res = await api(ctx.ceo).post('/products', {
    name: uniq('Áo có sẵn'),
    groupId: ctx.groupId,
    description: '',
    imageFileIds: [],
    axes: [
      { name: 'Màu sắc', values: colors.map((value) => ({ value })) },
      { name: 'Kích cỡ', values: sizes.map((value) => ({ value })) },
    ],
    variants: combos.map((options) => ({ options })),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; name: string; variants: ProductVariant[] };
}

const label = (v: ProductVariant) => v.attributes.map((a) => `${a.attributeName}=${a.value}`).join(',');

describe('cha mới', () => {
  it('hai dòng cùng tên cha (khác hoa thường, khoảng trắng) → duyệt sinh một cha, hai SKU, trục theo dòng đầu', async () => {
    const name = uniq('Áo polo');
    const res = await post(A, [
      fresh(name, { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' }),
      fresh(`  ${name.toUpperCase().replace(' ', '   ')} `, { 'Kích cỡ': 'L', 'Màu sắc': 'Trắng' }),
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const draft = PurchaseRequest.parse(res.body);
    expect(draft.lines[0]!.newProduct).toEqual({
      parentId: null,
      parentName: name,
      groupId: A.groupId,
      optionValues: { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' },
      name,
      groupName: expect.any(String),
    });
    expect(draft.lines[0]).toMatchObject({ productName: name, attributesLabel: 'Đen / M' });

    const body = await runActions([[A.kho, 'submit'], [A.ceo, 'approve']], draft.id, draft.version);
    const [l0, l1] = body.lines;
    expect(l0!.variantId).not.toBeNull();
    const product = await productOf(A.ceo, l0!.variantId!);
    expect(product.name).toBe(name);
    expect(product.variants.map(label).sort()).toEqual(['Màu sắc=Trắng,Kích cỡ=L', 'Màu sắc=Đen,Kích cỡ=M']);
    expect(new Set(product.variants.map((v) => v.id))).toEqual(new Set([l0!.variantId, l1!.variantId]));
    // M2: SKU sinh ra trỏ dòng đề nghị; cha mới có mã riêng.
    const src = await testPool().query<{ id: string; source_request_line_id: string }>(
      'select id, source_request_line_id from product.product_variants where product_id = $1',
      [product.id],
    );
    expect(Object.fromEntries(src.rows.map((r) => [r.id, r.source_request_line_id]))).toEqual({ [l0!.variantId!]: l0!.id, [l1!.variantId!]: l1!.id });
    expect(product.code).toBeTruthy();
    // Nit: sau duyệt, dòng cha mới trả id cha vừa tạo.
    const detail = PurchaseRequest.parse((await pur(A.ceo).get(`/requests/${draft.id}`)).body);
    expect(detail.lines.map((l) => l.newProduct?.parentId)).toEqual([product.id, product.id]);
  });

  it('optionValues {} là mặt hàng không biến thể: một SKU không thuộc tính, mã cha bằng SKU', async () => {
    const name = uniq('Bình giữ nhiệt');
    const body = await approved(A, [fresh(name, {})]);
    const product = await productOf(A.ceo, body.lines[0]!.variantId!);
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]!.attributes).toEqual([]);
    expect(product.code).toBe(body.lines[0]!.sku);
  });

  it('câu trùng phân loại đánh số theo dòng của đề nghị (có dòng SKU có sẵn đứng trước)', async () => {
    const name = uniq('Áo');
    const { variantId } = await createVariant(A.companyId);
    const res = await post(A, [{ variantId, quantity: 1, unitCost: 1000 }, fresh(name, { 'Màu sắc': 'Đỏ' }), fresh(name, { 'Màu sắc': 'đỏ' })]);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ 'lines.2.newProduct.optionValues': 'Trùng phân loại với dòng 2' });
  });

  it('tên cha trùng sản phẩm đã có và gộp quá 2 trục: lỗi tên, mã vẫn validation_failed', async () => {
    const existing = await parentWithAxes(A, [['Đen', 'M']]);
    const res = await post(A, [fresh(existing.name, { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' }), fresh(existing.name, { 'Chất liệu': 'Len' })]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(Object.values(res.body.errors)).toEqual(['Đã có sản phẩm cùng tên', 'Đã có sản phẩm cùng tên']);
  });

  it('gộp quá 2 trục → 422 too_many_axes ở mọi dòng của cha', async () => {
    const name = uniq('Áo');
    const res = await post(A, [fresh(name, { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' }), fresh(name, { 'Chất liệu': 'Cotton' })]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('too_many_axes');
    expect(Object.keys(res.body.errors).sort()).toEqual(['lines.0.newProduct.optionValues', 'lines.1.newProduct.optionValues']);
  });

  it('dòng thiếu trục, trùng tổ hợp (không phân biệt hoa thường), hai dòng {} cùng cha → 422 validation_failed theo dòng', async () => {
    const a = uniq('Áo');
    const b = uniq('Ly');
    const res = await post(A, [
      fresh(a, { 'Màu sắc': 'Đen', 'Kích cỡ': 'M' }),
      fresh(a, { 'Màu sắc': 'Trắng' }),
      fresh(a, { 'màu sắc': 'đen', 'kích cỡ': 'm' }),
      fresh(b, {}),
      fresh(b, {}),
    ]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors).toEqual({
      'lines.1.newProduct.optionValues': 'Thiếu giá trị cho trục Kích cỡ',
      'lines.2.newProduct.optionValues': 'Trùng phân loại với dòng 1',
      'lines.4.newProduct.optionValues': 'Trùng phân loại với dòng 4',
    });
  });

  it('tên cha trùng sản phẩm đã có, nhóm hàng sai, hai dòng cùng cha khác nhóm → 422 đúng ô', async () => {
    const existing = await parentWithAxes(A, [['Đen', 'M']]);
    const other = (await api(A.ceo).get('/groups')).body.items[1] as { id: string };
    const c = uniq('Áo');
    const res = await post(A, [
      fresh(existing.name.toLowerCase(), {}),
      fresh(uniq('Áo'), {}, randomUUID()),
      fresh(c, { 'Màu sắc': 'Đen' }),
      fresh(c, { 'Màu sắc': 'Trắng' }, other.id),
    ]);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({
      'lines.0.newProduct.parentName': 'Đã có sản phẩm cùng tên',
      'lines.1.newProduct.groupId': 'Chọn nhóm hàng',
      'lines.3.newProduct.groupId': 'Các dòng cùng sản phẩm cha phải cùng nhóm hàng',
    });
  });

  it('SKU sinh ra quá 50 ký tự khi duyệt → 422 lines.i, đề nghị giữ chờ duyệt, không sót sản phẩm, thuộc tính', async () => {
    const c = await company();
    const name = uniq('Áo');
    const r = await createRequest(c.kho, c.supplierId, [fresh(name, { 'Hoạ tiết': 'Kẻ caro', 'Màu nền': 'Xanh rêu' }, c.groupId)] as never);
    const submitted = await act(c.kho, r.id, 'submit', { version: r.version });
    // Như axes.test.ts: mẫu 28 chữ + {SEQ:1}{VAL}, số kế tiếp 1e9, hai mã giá trị 6 ký tự → 51.
    await setSkuPattern(c.ceo, `${'A'.repeat(28)}{SEQ:1}{VAL}`);
    await testPool().query('update product.company_product_settings set sku_next_seq = 1000000000 where company_id = $1', [c.companyId]);
    const res = await act(c.ceo, r.id, 'approve', { version: submitted.body.version });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)).toEqual(['lines.0']);
    expect((await pur(c.ceo).get(`/requests/${r.id}`)).body.status).toBe('pending_approval');
    const left = await testPool().query('select 1 from product.products where company_id = $1 and name = $2', [c.companyId, name]);
    expect(left.rowCount).toBe(0);
    const attr = await testPool().query("select 1 from product.attributes where company_id = $1 and name in ('Hoạ tiết', 'Màu nền')", [c.companyId]);
    expect(attr.rowCount).toBe(0);
  });
});

describe('cha có sẵn', () => {
  it('thêm SKU vào cha có sẵn theo thứ tự trục của cha, tạo giá trị mới trong thuộc tính', async () => {
    const parent = await parentWithAxes(A, [['Đen', 'M']]);
    const body = await approved(A, [under(parent.id, { 'kích cỡ': 'XXL', 'Màu sắc': 'Đen' })]);
    const line = body.lines[0]!;
    const product = await productOf(A.ceo, line.variantId!);
    expect(product.id).toBe(parent.id);
    expect(product.variants.find((v) => v.id === line.variantId)!.attributes.map((a) => a.attributeName)).toEqual(['Màu sắc', 'Kích cỡ']);
    expect(product.variants.map(label).sort()).toEqual(['Màu sắc=Đen,Kích cỡ=M', 'Màu sắc=Đen,Kích cỡ=XXL']);
    const [src] = (await testPool().query('select source_request_line_id from product.product_variants where id = $1', [line.variantId])).rows;
    expect(src.source_request_line_id).toBe(line.id);
    const detail = PurchaseRequest.parse((await pur(A.ceo).get(`/requests/${body.id}`)).body);
    expect(detail.lines[0]!.newProduct).toMatchObject({ parentId: parent.id, parentName: null, name: parent.name, groupId: A.groupId });
  });

  it('khoá trục lệch cha, tổ hợp đã là SKU, cha của công ty khác, cha không phân loại → 422 đúng ô', async () => {
    const parent = await parentWithAxes(A, [['Đen', 'M']]);
    const plain = await createVariant(A.companyId);
    const res = await post(A, [
      under(parent.id, { 'Màu sắc': 'Đen' }),
      under(parent.id, { 'Màu sắc': 'Đen', 'Kích cỡ': 'M', 'Chất liệu': 'Len' }),
      under(parent.id, { 'Màu sắc': 'đen', 'Kích cỡ': 'm' }),
      under(otherCompanyProductId, {}),
      under(plain.productId, { 'Màu sắc': 'Đen' }),
      under(plain.productId, {}),
    ]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors).toEqual({
      'lines.0.newProduct.optionValues': 'Sản phẩm cha có trục: Màu sắc, Kích cỡ',
      'lines.1.newProduct.optionValues': 'Sản phẩm cha có trục: Màu sắc, Kích cỡ',
      'lines.2.newProduct.optionValues': `Đã có SKU ${parent.variants[0]!.sku}, chọn SKU có sẵn`,
      'lines.3.newProduct.parentId': 'Không tìm thấy sản phẩm cha',
      'lines.4.newProduct.optionValues': 'Sản phẩm cha không có phân loại, chọn SKU có sẵn',
      'lines.5.newProduct.optionValues': `Đã có SKU ${plain.sku}, chọn SKU có sẵn`,
    });
  });

  it('S1: cha có thêm SKU cùng tổ hợp giữa lúc gửi và lúc duyệt → 422, giữ chờ duyệt, câu bảo trả về', async () => {
    const parent = await parentWithAxes(A, [['Đen', 'M'], ['Đỏ', 'L']]);
    const r = await createRequest(A.kho, A.supplierId, [under(parent.id, { 'Màu sắc': 'Đỏ', 'Kích cỡ': 'M' })] as never);
    const submitted = await act(A.kho, r.id, 'submit', { version: r.version });
    const variants = (await api(A.ceo).get(`/products/${parent.id}`)).body.variants as { attributes: { value: string; valueId: string }[] }[];
    const valueOf = (v: string) => variants.flatMap((x) => x.attributes).find((a) => a.value === v)!.valueId;
    const added = await api(A.ceo).post(`/products/${parent.id}/variants`, { attributeValueIds: [valueOf('Đỏ'), valueOf('M')] });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const res = await act(A.ceo, r.id, 'approve', { version: submitted.body.version });
    expect(res.status).toBe(422);
    expect(res.body.errors['lines.0.newProduct.optionValues']).toBe(`Đã có SKU ${added.body.sku}, chọn SKU có sẵn. Trả về cho người lập sửa dòng này`);
    expect((await pur(A.ceo).get(`/requests/${r.id}`)).body.status).toBe('pending_approval');
  });
});

describe('hình dạng newProduct', () => {
  it('trường lạ (name), cả parentId lẫn parentName, cha mới thiếu nhóm, tên trục, giá trị quá dài, parentId rỗng → 422', async () => {
    const parent = await parentWithAxes(A, [['Đen', 'M']]);
    const res = await post(A, [
      { newProduct: { parentId: null, parentName: uniq('Áo'), groupId: A.groupId, optionValues: {}, name: 'x' }, quantity: 1, unitCost: 1000 },
      { newProduct: { parentId: parent.id, parentName: uniq('Áo'), groupId: null, optionValues: {} }, quantity: 1, unitCost: 1000 },
      { newProduct: { parentId: null, parentName: uniq('Áo'), groupId: null, optionValues: {} }, quantity: 1, unitCost: 1000 },
      fresh(uniq('Áo'), { 'Tên trục rất là dài': 'Đen' }),
      fresh(uniq('Áo'), { 'Màu sắc': 'Đen tuyền pha xanh rêu' }),
      { newProduct: { parentId: '', parentName: uniq('Áo'), groupId: A.groupId, optionValues: {} }, quantity: 1, unitCost: 1000 },
    ]);
    expect(res.status).toBe(422);
    const keys = Object.keys(res.body.errors);
    expect(keys.some((k) => k.startsWith('lines.0.newProduct'))).toBe(true);
    expect(res.body.errors['lines.1.newProduct.parentName']).toBe('Chọn sản phẩm cha có sẵn hoặc nhập tên sản phẩm cha mới');
    expect(res.body.errors['lines.2.newProduct.groupId']).toBe('Chọn nhóm hàng');
    expect(keys.some((k) => k.startsWith('lines.3.newProduct.optionValues'))).toBe(true);
    expect(keys.some((k) => k.startsWith('lines.4.newProduct.optionValues'))).toBe(true);
    expect(res.body.errors['lines.5.newProduct.parentId']).toBe('Chọn sản phẩm cha');
  });

  it('dòng cha mới bị loại khi duyệt thì không tạo sản phẩm', async () => {
    const name = uniq('Áo');
    const c = await company();
    const r = await createRequest(c.kho, c.supplierId, [
      { variantId: (await createVariant(c.companyId)).variantId, quantity: 1, unitCost: 1000 },
      fresh(name, {}, c.groupId),
    ] as never);
    const submitted = await act(c.kho, r.id, 'submit', { version: r.version });
    const line = submitted.body.lines[1];
    const excluded = await pur(c.ceo).post(`/requests/${r.id}/lines/${line.id}/exclude`, { excluded: true, reason: 'Chưa cần', version: submitted.body.version });
    expect(excluded.status).toBe(200);
    const res = await act(c.ceo, r.id, 'approve', { version: excluded.body.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.lines[1].variantId).toBeNull();
    expect((await testPool().query('select 1 from product.products where company_id = $1 and name = $2', [c.companyId, name])).rowCount).toBe(0);
  });
});
