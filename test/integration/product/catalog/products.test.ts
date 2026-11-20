import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { type AttributeBody, api, auditOf, createAttribute, createGroup, createProduct, type ProductBody, productBody, uniq, valueId, archiveSku, businessStatus } from './helpers.ts';

// Sản phẩm, SKU tự sinh (UC-CP-02; Documents/21 5.1–5.4, mục 9, C3, C5, P5–P8, V24, D9).
let token: string;
let color: AttributeBody;
let size: AttributeBody;
beforeAll(async () => {
  token = (await createCompany()).ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng', 'Xanh navy']);
  size = await createAttribute(token, 'Size', ['M', 'XL', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11']);
});

/** Cài đặt sản phẩm của công ty (#447): mẫu SKU và số `{SEQ}` kế tiếp là của công ty, không theo nhóm. */
const settingsOf = async (t = token) => (await api(t).get('/settings')).body as { skuPattern: string; skuNextSeq: number; version: number };
const body = (name: string, groupId: string, variants: string[][], extra: object = {}) =>
  productBody(name, groupId, variants, { description: 'Mô tả', ...extra });

/** Công ty mới có hai thuộc tính "Màu", "Size" như `beforeAll`, để ca đếm số `{SEQ}` bắt đầu từ 1. */
async function freshCompany() {
  const { ceo, companyId } = await createCompany();
  const own = await createAttribute(ceo.token, 'Màu', ['Đen', 'Trắng', 'Xanh navy']);
  const ownSize = await createAttribute(ceo.token, 'Size', ['M', 'XL', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11']);
  return { token: ceo.token, companyId, color: own, size: ownSize };
}

/** Đặt số `{SEQ}` kế tiếp (cột chỉ đọc qua API) để dựng ca trùng SKU, trùng mã cha như khi người dùng đổi mẫu rồi quay lại. */
const resetSeq = (companyId: string, seq: number) =>
  testPool().query('update product.company_product_settings set sku_next_seq = $2 where company_id = $1', [companyId, seq]);

describe('POST /catalog/products', () => {
  it('SKU theo mẫu của công ty, theo thứ tự biến thể; skuNextSeq tăng, version cài đặt giữ nguyên (AC-8)', async () => {
    const { token, color, size } = await freshCompany();
    const group = await createGroup(token, uniq('Áo'), 'AO-{SEQ:4}-{VAL}');
    // Đưa số thứ tự lên 12 bằng luồng thật: 11 biến thể đầu.
    const sizes = size.values.slice(2).map((v) => [v.id]);
    await createProduct(token, { name: uniq('Lót'), groupId: group.id, variants: sizes });
    const before = await settingsOf(token);
    expect(before.skuNextSeq).toBe(12);

    const name = uniq('Áo thun');
    const res = await api(token).post(
      '/products',
      body(name, group.id, [
        [valueId(color, 'Đen'), valueId(size, 'XL')],
        [valueId(color, 'Trắng'), valueId(size, 'XL')],
      ]),
    );
    expect(res.status).toBe(201);
    expect(res.body.variants.map((v: { sku: string }) => v.sku)).toEqual(['AO-0012-DEN-XL', 'AO-0013-TRANG-XL']);
    expect(await settingsOf(token)).toMatchObject({ skuNextSeq: 14, version: before.version });
    expect(await auditOf(res.body.id)).toEqual([
      {
        action: 'create',
        entity_type: 'product.products',
        before: null,
        after: {
          name,
          code: 'AO-0012',
          group: group.name,
          description: 'Mô tả',
          imageFileIds: [],
          variants: ['AO-0012-DEN-XL', 'AO-0013-TRANG-XL'],
        },
      },
    ]);
  });

  it('chi tiết sản phẩm đủ trường, thuộc tính theo thứ tự của biến thể đầu, giá chuẩn null (S-4, B4, B6)', async () => {
    const { token, color, size } = await freshCompany();
    const group = await createGroup(token, uniq('Áo'), '{VAL}-{SEQ:6}');
    const product = await createProduct(token, {
      name: uniq('Áo'),
      groupId: group.id,
      // Biến thể thứ hai gửi đảo thứ tự: BE sắp lại theo biến thể đầu.
      variants: [
        [valueId(color, 'Xanh navy'), valueId(size, 'M')],
        [valueId(size, 'XL'), valueId(color, 'Đen')],
      ],
    });
    const res = await api(token).get(`/products/${product.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: product.id,
      group: { id: group.id, name: group.name },
      variantCount: 2,
      thumbnailUrl: null,
      status: 'active',
      version: 1,
      description: '',
      images: [],
      imageAttributeId: null,
      attributeValueImages: [],
      originCountry: null,
      brand: null,
    });
    expect(res.body.variants).toEqual([
      {
        id: expect.any(String),
        sku: 'XANHNA-M-000001',
        archivedAt: null,
        businessStatus: 'selling',
        standardPrice: null,
        targetNetPrice: null,
        weightG: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        version: 1,
        archiveBlockers: [],
        image: null,
        readiness: 'incomplete',
        missing: ['image', 'price', 'minQty', 'weight', 'dimensions'],
        minQty: null,
        presence: 'not_listed',
        hasListingError: false,
        listingCount: 0,
        attributes: [
          { attributeId: color.id, attributeName: 'Màu', valueId: valueId(color, 'Xanh navy'), value: 'Xanh navy' },
          { attributeId: size.id, attributeName: 'Size', valueId: valueId(size, 'M'), value: 'M' },
        ],
      },
      expect.objectContaining({ sku: 'DEN-XL-000002' }),
    ]);
  });

  it('sản phẩm không có thuộc tính có một biến thể, {VAL} rỗng bỏ dấu nối (bảng 9.1)', async () => {
    const { token } = await freshCompany();
    const group = await createGroup(token, uniq('Phụ kiện'), 'AO-{SEQ}-{VAL}');
    const product = await createProduct(token, { name: uniq('Thắt lưng'), groupId: group.id, variants: [[]] });
    expect(product.variants.map((v) => v.sku)).toEqual(['AO-0001']);
  });

  it.each([
    ['thiếu tên', { name: '' }, 'name'],
    ['nhóm hàng không tồn tại', { groupId: randomUUID() }, 'groupId'],
    ['nhóm hàng không phải uuid', { groupId: 'abc' }, 'groupId'],
    ['không có biến thể', { variants: [] }, 'variants'],
    ['hơn 100 biến thể', { variants: Array.from({ length: 101 }, () => ({ options: ['Đen'] })) }, 'variants'],
    ['ảnh chưa tải lên (#303)', { imageFileIds: [randomUUID()] }, 'images'],
    ['mô tả quá 5000 ký tự', { description: 'a'.repeat(5001) }, 'description'],
  ])('%s → 422 errors.%s, không tạo, không tiêu số (AC-9)', async (_case, override, field) => {
    const group = await createGroup(token, uniq('Lỗi'), 'L-{SEQ}');
    const seq = (await settingsOf()).skuNextSeq;
    const res = await api(token).post('/products', { ...body(uniq('SP'), group.id, [[valueId(color, 'Đen')]]), ...override });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors[field]).toBeTruthy();
    expect((await settingsOf()).skuNextSeq).toBe(seq);
  });

  // #447: biến thể khai bằng `options` (giá trị theo thứ tự trục), nên "hai giá trị cùng thuộc tính" không còn dựng được;
  // thay bằng hai trục cùng một thuộc tính (`errors.axes`).
  const twoAxes = () => [
    { attributeId: color.id, values: [{ id: valueId(color, 'Đen'), value: 'Đen' }, { id: valueId(color, 'Trắng'), value: 'Trắng' }] },
    { attributeId: size.id, values: [{ id: valueId(size, 'M'), value: 'M' }] },
  ];
  it.each([
    ['khác bộ thuộc tính (số option khác số trục)', () => ({ axes: twoAxes(), variants: [{ options: ['Đen', 'M'] }, { options: ['Trắng'] }] }), 'variants.1'],
    ['tổ hợp trùng', () => ({ axes: twoAxes(), variants: [{ options: ['Đen', 'M'] }, { options: [' đen', 'M'] }] }), 'variants'],
    ['option không thuộc giá trị của trục', () => ({ axes: twoAxes(), variants: [{ options: ['Đen', 'M'] }, { options: ['Đỏ', 'M'] }] }), 'variants.1'],
    [
      'hai trục cùng một thuộc tính',
      () => ({
        axes: [
          { attributeId: color.id, values: [{ id: valueId(color, 'Đen'), value: 'Đen' }] },
          { attributeId: color.id, values: [{ id: valueId(color, 'Trắng'), value: 'Trắng' }] },
        ],
        variants: [{ options: ['Đen', 'Trắng'] }],
      }),
      'axes',
    ],
    ['giá trị của trục không tồn tại', () => ({ axes: [{ attributeId: color.id, values: [{ id: randomUUID(), value: 'Đen' }] }], variants: [{ options: ['Đen'] }] }), 'axes.0.values.0.value'],
  ])('%s → 422, không tạo sản phẩm, không tiêu số (AC-9)', async (_case, override, field) => {
    const group = await createGroup(token, uniq('Lỗi'), 'L-{SEQ}');
    const seq = (await settingsOf()).skuNextSeq;
    const name = uniq('SP');
    const res = await api(token).post('/products', { ...body(name, group.id, [[]]), ...override() });
    expect(res.status).toBe(422);
    expect(res.body.errors[field], JSON.stringify(res.body.errors)).toBeTruthy();
    const list = await api(token).get(`/products?search=${encodeURIComponent(name)}`);
    expect(list.body.total).toBe(0);
    expect((await settingsOf()).skuNextSeq).toBe(seq);
  });

  it('nhóm, thuộc tính của công ty khác → 422, không tạo dòng trỏ sang công ty kia (AC-9, S-6)', async () => {
    const other = await createCompany();
    const theirGroup = await createGroup(other.ceo.token, uniq('Của B'), null);
    const theirColor = await createAttribute(other.ceo.token, uniq('Màu B'), ['Đỏ']);
    const mine = await createGroup(token, uniq('Của A'), 'A-{SEQ}');

    const byGroup = await api(token).post('/products', body(uniq('SP'), theirGroup.id, [[]]));
    expect(byGroup.status).toBe(422);
    expect(byGroup.body.errors.groupId).toBeTruthy();
    const byAttribute = await api(token).post('/products', {
      ...body(uniq('SP'), mine.id, [[]]),
      axes: [{ attributeId: theirColor.id, values: [{ value: 'Đỏ' }] }],
      variants: [{ options: ['Đỏ'] }],
    });
    expect(byAttribute.status).toBe(422);
    expect(byAttribute.body.errors['axes.0.name']).toBeTruthy();
  });

  it('tên trùng sản phẩm đang bán → 409 name_taken (AC-18)', async () => {
    const group = await createGroup(token, uniq('Tên'), 'T-{SEQ}');
    const name = uniq('Giày');
    await createProduct(token, { name, groupId: group.id, variants: [[]] });
    const res = await api(token).post('/products', body(` ${name.toUpperCase()} `, group.id, [[]]));
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/name_taken');
    expect(res.body.errors.name).toBeTruthy();
  });

  it('biến thể 3 thuộc tính → 422 errors.axes, không tạo, không tiêu số (#204, #447)', async () => {
    const material = await createAttribute(token, uniq('Chất'), ['Cotton']);
    const group = await createGroup(token, uniq('Ba trục'), 'BT-{SEQ}-{VAL}');
    const seq = (await settingsOf()).skuNextSeq;
    const name = uniq('SP ba trục');
    const res = await api(token).post('/products', {
      ...body(name, group.id, [[]]),
      axes: [
        ...twoAxes(),
        { attributeId: material.id, values: [{ id: valueId(material, 'Cotton'), value: 'Cotton' }] },
      ],
      variants: [{ options: ['Đen', 'M', 'Cotton'] }],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors.axes).toBeTruthy();
    expect((await api(token).get(`/products?search=${encodeURIComponent(name)}`)).body.total).toBe(0);
    expect((await settingsOf()).skuNextSeq).toBe(seq);
  });

  // D4 (#204, Thành đồng ý 16/11/2026): bỏ lưu trữ cha nên tên không trùng trên mọi sản phẩm, thay B1 của #12.
  it('tên của sản phẩm mọi SKU đã lưu trữ vẫn bị giữ → 409 name_taken (D4)', async () => {
    const group = await createGroup(token, uniq('Tên'), 'T-{SEQ}');
    const name = uniq('Giày chạy bộ');
    const old = await createProduct(token, { name, groupId: group.id, variants: [[]] });
    await archiveSku(token, old.id, old.variants[0]!.id);
    const res = await api(token).post('/products', body(name, group.id, [[]]));
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/name_taken');
  });
});

describe('mã cha (#204 D5)', () => {
  it('SKU đầu bỏ phần giá trị thuộc tính; không thuộc tính thì bằng SKU; có ở chi tiết, danh sách, nhật ký', async () => {
    const { ceo } = await createCompany();
    const own = await createAttribute(ceo.token, 'Màu', ['Đen', 'Trắng']);
    const ownSize = await createAttribute(ceo.token, 'Size', ['XL']);
    const shirts = await createGroup(ceo.token, 'Áo', 'AO-{SEQ:4}-{VAL}');
    const shirt = await createProduct(ceo.token, {
      name: 'Áo thun',
      groupId: shirts.id,
      variants: [
        [valueId(own, 'Đen'), valueId(ownSize, 'XL')],
        [valueId(own, 'Trắng'), valueId(ownSize, 'XL')],
      ],
    });
    expect([shirt.variants[0]!.sku, shirt.code]).toEqual(['AO-0001-DEN-XL', 'AO-0001']);
    // Mẫu SKU là của công ty (#447): đổi mẫu rồi tạo tiếp, số {SEQ} chạy tiếp từ 3 (áo thun đã dùng 1 và 2).
    const belts = await createGroup(ceo.token, 'Dây lưng', 'PK-{SEQ}');
    const belt = await createProduct(ceo.token, { name: 'Thắt lưng', groupId: belts.id, variants: [[]] });
    expect([belt.variants[0]!.sku, belt.code]).toEqual(['PK-0003', 'PK-0003']);
    expect((await api(ceo.token).get(`/products/${shirt.id}`)).body.code).toBe('AO-0001');
    const list = await api(ceo.token).get('/products?search=thun');
    expect(list.body.items.map((p: { code: string }) => p.code)).toEqual(['AO-0001']);
    expect((await auditOf(shirt.id))[0]!.after).toMatchObject({ code: 'AO-0001' });
  });

  it('hai sản phẩm cùng ra một mã cha (đổi mẫu rồi số {SEQ} quay lại): mã sau thêm -2', async () => {
    const { ceo, companyId } = await createCompany();
    const own = await createAttribute(ceo.token, 'Màu', ['Đen']);
    const shirts = await createGroup(ceo.token, 'Áo', 'MC-{SEQ:4}-{VAL}');
    const shirt = await createProduct(ceo.token, { name: 'Áo', groupId: shirts.id, variants: [[valueId(own, 'Đen')]] });
    // Số {SEQ} là của công ty nên hai sản phẩm không tự ra cùng số; đặt lại số kế tiếp về 1 để dựng ca trùng mã cha.
    const hats = await createGroup(ceo.token, 'Mũ', 'MC-{SEQ:4}');
    await resetSeq(companyId, 1);
    const hat = await createProduct(ceo.token, { name: 'Mũ', groupId: hats.id, variants: [[]] });
    expect([shirt.variants[0]!.sku, shirt.code]).toEqual(['MC-0001-DEN', 'MC-0001']);
    expect([hat.variants[0]!.sku, hat.code]).toEqual(['MC-0001', 'MC-0001-2']);
  });
});

describe('SKU duy nhất trong công ty (S-3, D9)', () => {
  it('SKU đã có thì nhảy số kế tiếp, kể cả khi số {SEQ} của công ty bị đặt lại', async () => {
    const { token, companyId } = await freshCompany();
    const a = await createGroup(token, uniq('A'), 'DUP-{SEQ}');
    const pa = await createProduct(token, { name: uniq('SP'), groupId: a.id, variants: [[]] });
    expect(pa.variants[0]!.sku).toBe('DUP-0001');
    // Số {SEQ} chạy chung công ty nên trùng SKU chỉ còn xảy ra khi số quay lại (đổi mẫu rồi trở về); đặt lại về 1 để dựng ca đó.
    await resetSeq(companyId, 1);
    const pb = await createProduct(token, { name: uniq('SP'), groupId: a.id, variants: [[]] });
    expect(pb.variants[0]!.sku).toBe('DUP-0002');
    expect((await settingsOf(token)).skuNextSeq).toBe(3);
  });

  it('hai request song song cùng công ty: SKU không trùng, skuNextSeq tăng đúng tổng số biến thể', async () => {
    const { token, color } = await freshCompany();
    const group = await createGroup(token, uniq('Song song'), 'PAR-{SEQ}-{VAL}');
    const make = (n: number) =>
      api(token).post('/products', body(uniq(`SP${n}`), group.id, [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]]));
    const results = await Promise.all([make(1), make(2), make(3)]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const skus = results.flatMap((r) => (r.body as ProductBody).variants.map((v) => v.sku));
    expect(new Set(skus).size).toBe(6);
    expect((await settingsOf(token)).skuNextSeq).toBe(7);
  });
});

describe('GET /catalog/products', () => {
  it('tìm theo tên hoặc SKU, lọc nhóm hàng và trạng thái, ô rỗng không lọc, dạng trang (AC-14)', async () => {
    const { ceo } = await createCompany();
    const own = await createAttribute(ceo.token, 'Màu', ['Đen']);
    // Mẫu SKU là của công ty (#447): tạo 12 "Lót" với mẫu Q{SEQ:4} (Q0001..Q0012) rồi đổi mẫu cho nhóm "Áo" (số chạy tiếp từ 13).
    const other = await createGroup(ceo.token, 'Quần', 'Q{SEQ:4}');
    for (let i = 0; i < 12; i++) await createProduct(ceo.token, { name: `Lót ${i}`, groupId: other.id, variants: [[]] });
    const group = await createGroup(ceo.token, 'Áo', 'AO-{SEQ:4}-{VAL}');
    const target = await createProduct(ceo.token, { name: 'Áo thun', groupId: group.id, variants: [[valueId(own, 'Đen')]] });
    const archived = await createProduct(ceo.token, { name: 'Áo cũ 0012', groupId: group.id, variants: [[]] });
    await archiveSku(ceo.token, archived.id, archived.variants[0]!.id);

    // SKU Q0012 (sản phẩm Lót 11) và AO-0013-DEN không chứa 0012; "Áo cũ 0012" đã lưu trữ.
    const bySku = await api(ceo.token).get('/products?search=0012&groupId=&status=&page=1&pageSize=20');
    expect(bySku.status).toBe(200);
    expect(bySku.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(bySku.body.items[0]).toMatchObject({ name: 'Lót 11', group: { id: other.id, name: 'Quần' }, variantCount: 1 });

    const byName = await api(ceo.token).get('/products?search=ÁO THUN');
    expect(byName.body.items.map((p: { id: string }) => p.id)).toEqual([target.id]);
    expect(byName.body.items[0]).toEqual({
      id: target.id,
      name: 'Áo thun',
      code: 'AO-0013',
      group: { id: group.id, name: 'Áo' },
      variantCount: 1,
      variantTotal: 1,
      labelCounts: { archived: 0, discontinued: 0, paused: 0, live: 0, error: 0, pending: 0, not_listed: 1 },
      incompleteCount: 1,
      errorCount: 0,
      thumbnailUrl: null,
      status: 'active',
      updatedAt: expect.any(String),
      version: 1,
    });

    const byGroup = await api(ceo.token).get(`/products?groupId=${group.id}`);
    expect(byGroup.body.total).toBe(1);
    const archivedOnly = await api(ceo.token).get('/products?status=archived');
    expect(archivedOnly.body.items.map((p: { id: string; status: string }) => [p.id, p.status])).toEqual([[archived.id, 'archived']]);

    const page2 = await api(ceo.token).get('/products?pageSize=5&page=3');
    expect(page2.body).toMatchObject({ total: 13, page: 3, pageSize: 5 });
    expect(page2.body.items).toHaveLength(3);

    const none = await api(ceo.token).get('/products?search=khongco');
    expect(none.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('SKU của biến thể đã ngừng bán vẫn tìm được', async () => {
    const group = await createGroup(token, uniq('Ngừng'), 'NB-{SEQ}-{VAL}');
    const product = await createProduct(token, {
      name: uniq('SP'),
      groupId: group.id,
      variants: [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]],
    });
    await archiveSku(token, product.id, product.variants[0]!.id);
    const res = await api(token).get(`/products?search=${product.variants[0]!.sku}`);
    expect(res.body.items.map((p: { id: string }) => p.id)).toEqual([product.id]);
    expect(res.body.items[0].variantCount).toBe(1);
  });

  it.each([
    ['pageSize=101', 'pageSize'],
    ['page=0', 'page'],
    ['status=xoa', 'status'],
    ['groupId=abc', 'groupId'],
    ['search=a&search=b', 'search'],
  ])('%s → 422 errors.%s (B7, S-7)', async (query, field) => {
    const res = await api(token).get(`/products?${query}`);
    expect(res.status).toBe(422);
    expect(res.body.errors[field]).toBeTruthy();
  });

  it('id không có hoặc không phải uuid → 404', async () => {
    for (const id of [randomUUID(), 'abc']) {
      expect((await api(token).get(`/products/${id}`)).status).toBe(404);
    }
  });
});

describe('PUT, DELETE /catalog/products/:id', () => {
  const simple = async () => {
    const group = await createGroup(token, uniq('Sửa'), 'S-{SEQ}-{VAL}');
    return createProduct(token, { name: uniq('SP'), groupId: group.id, variants: [[valueId(color, 'Đen')]] });
  };
  const update = (id: string, version: number, extra: object = {}) =>
    api(token).put(`/products/${id}`, { name: uniq('Tên mới'), description: 'mới', imageFileIds: [], version, ...extra });

  it('sửa với version đúng → 200, version tăng; nhật ký update (AC-20, S-2)', async () => {
    const product = await simple();
    const res = await update(product.id, 1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2, description: 'mới' });
    expect((await auditOf(product.id)).map((l) => l.action)).toEqual(['create', 'update']);
  });

  // Đổi nhóm qua `groupId` trong PUT đã có ca riêng ở axes.test.ts (#447); ở đây chỉ còn `variants` bị bỏ qua.
  it('gửi kèm variants thì bỏ qua: biến thể không đổi (AC-13)', async () => {
    const product = await simple();
    const res = await update(product.id, 1, { variants: [{ options: [] }] });
    expect(res.status).toBe(200);
    const detail = await api(token).get(`/products/${product.id}`);
    expect(detail.body.variants.map((v: { sku: string }) => v.sku)).toEqual(product.variants.map((v) => v.sku));
  });

  it('version cũ → 409 version_conflict kèm current là chi tiết sản phẩm (AC-12)', async () => {
    const product = await simple();
    await update(product.id, 1);
    const res = await update(product.id, 1);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(res.body.current).toMatchObject({ id: product.id, version: 2, variants: [expect.objectContaining({ sku: product.variants[0]!.sku })] });
  });

  it('đổi sang tên sản phẩm khác đang bán → 409 name_taken; tên dài quá → 422 (AC-18)', async () => {
    const a = await simple();
    const b = await simple();
    const res = await update(b.id, 1, { name: a.name.toUpperCase() });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/name_taken');
    const long = await update(b.id, 1, { name: 'A'.repeat(201) });
    expect(long.status).toBe(422);
    expect(long.body.errors.name).toBeTruthy();
  });

  // #204: cha không còn trạng thái lưu riêng (bỏ `product_archived`); `status` suy từ SKU.
  it('mọi SKU lưu trữ: status archived; vẫn sửa, thêm biến thể, đổi trạng thái được; SKU mới làm cha active lại', async () => {
    const product = await simple();
    await archiveSku(token, product.id, product.variants[0]!.id);
    expect((await api(token).get(`/products/${product.id}`)).body).toMatchObject({ status: 'archived', variantCount: 0, version: 1 });
    expect((await update(product.id, 1)).status).toBe(200);
    const added = await api(token).post(`/products/${product.id}/variants`, { attributeValueIds: [valueId(color, 'Trắng')] });
    expect(added.status).toBe(201);
    expect((await businessStatus(token, product.id, 'pause', [added.body.id])).status).toBe(200);
    expect((await api(token).get(`/products/${product.id}`)).body).toMatchObject({ status: 'active', variantCount: 1 });
  });

  // #340: xuất xứ, thương hiệu dùng chung mọi sàn (Documents/21 §17.2).
  it('xuất xứ, thương hiệu: lưu, đọc lại; bỏ trường giữ; null xoá; rỗng → null; vn → VN; nhật ký có khi có giá trị (AC-15, AC-S6)', async () => {
    const product = await simple();
    const set = await update(product.id, 1, { originCountry: 'VN', brand: 'Coolmate' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ originCountry: 'VN', brand: 'Coolmate' });
    expect((await api(token).get(`/products/${product.id}`)).body).toMatchObject({ originCountry: 'VN', brand: 'Coolmate' });
    expect((await auditOf(product.id)).at(-1)!.after).toMatchObject({ originCountry: 'VN', brand: 'Coolmate' });

    expect((await update(product.id, 2)).body).toMatchObject({ originCountry: 'VN', brand: 'Coolmate' });
    expect((await update(product.id, 3, { originCountry: null, brand: null })).body).toMatchObject({ originCountry: null, brand: null });
    expect((await auditOf(product.id)).at(-1)!.after).not.toHaveProperty('brand');
    expect((await update(product.id, 4, { originCountry: ' vn ', brand: '  ' })).body).toMatchObject({ originCountry: 'VN', brand: null });
    expect((await update(product.id, 5, { originCountry: '', brand: '' })).body).toMatchObject({ originCountry: null, brand: null });
    expect((await update(product.id, 6, { originCountry: '  ' })).body).toMatchObject({ originCountry: null, version: 7 });
  });

  it('mã nước sai dạng, thương hiệu quá 100 ký tự → 422 theo ô, không đổi (AC-16)', async () => {
    const product = await simple();
    for (const bad of ['VNM', 'V1', 'V']) {
      const res = await update(product.id, 1, { originCountry: bad });
      expect(res.status, bad).toBe(422);
      expect(res.body.errors.originCountry).toBe('Mã nước không hợp lệ (2 chữ cái, vd VN)');
    }
    const long = await update(product.id, 1, { brand: ` ${'x'.repeat(101)} ` });
    expect(long.status).toBe(422);
    expect(long.body.errors.brand).toBeTruthy();
    expect((await update(product.id, 1, { brand: ` ${'x'.repeat(100)} ` })).status).toBe(200);
    expect((await api(token).get(`/products/${product.id}`)).body).toMatchObject({ originCountry: null, version: 2 });
  });

  it('DELETE thiếu ?version= → 422 errors.version (AC-20)', async () => {
    const product = await simple();
    const missing = await api(token).delete(`/products/${product.id}`);
    expect(missing.status).toBe(422);
    expect(missing.body.errors.version).toBeTruthy();
  });
});
