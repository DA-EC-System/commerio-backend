import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { type AttributeBody, api, auditOf, createAttribute, createCategory, createProduct, type ProductBody, productBody, uniq, valueId, archiveSku, businessStatus } from './helpers.ts';

// Sản phẩm, SKU tự sinh (UC-CP-02; Documents/21 5.1–5.4, mục 9, C3, C5, P5–P8, V24, D9).
let token: string;
let color: AttributeBody;
let size: AttributeBody;
beforeAll(async () => {
  token = (await createCompany()).ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng', 'Xanh navy']);
  size = await createAttribute(token, 'Size', ['M', 'XL', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11']);
});

const categoryOf = async (id: string) =>
  (await api(token).get('/categories')).body.find((c: { id: string }) => c.id === id) as { skuNextSeq: number; version: number };
const body = (name: string, categoryId: string, variants: string[][], extra: object = {}) =>
  productBody(name, categoryId, variants, { description: 'Mô tả', ...extra });

describe('POST /catalog/products', () => {
  it('SKU theo quy tắc, theo thứ tự biến thể; skuNextSeq tăng, version danh mục giữ nguyên (AC-8)', async () => {
    const category = await createCategory(token, uniq('Áo'), 'AO-{SEQ:4}-{VAL}');
    // Đưa số thứ tự lên 12 bằng luồng thật: 11 biến thể đầu.
    const sizes = size.values.slice(2).map((v) => [v.id]);
    await createProduct(token, { name: uniq('Lót'), categoryId: category.id, variants: sizes });
    expect((await categoryOf(category.id)).skuNextSeq).toBe(12);

    const name = uniq('Áo thun');
    const res = await api(token).post(
      '/products',
      body(name, category.id, [
        [valueId(color, 'Đen'), valueId(size, 'XL')],
        [valueId(color, 'Trắng'), valueId(size, 'XL')],
      ]),
    );
    expect(res.status).toBe(201);
    expect(res.body.variants.map((v: { sku: string }) => v.sku)).toEqual(['AO-0012-DEN-XL', 'AO-0013-TRANG-XL']);
    expect(await categoryOf(category.id)).toMatchObject({ skuNextSeq: 14, version: 1 });
    expect(await auditOf(res.body.id)).toEqual([
      {
        action: 'create',
        entity_type: 'product.products',
        before: null,
        after: {
          name,
          code: 'AO-0012',
          category: category.name,
          description: 'Mô tả',
          imageFileIds: [],
          variants: ['AO-0012-DEN-XL', 'AO-0013-TRANG-XL'],
        },
      },
    ]);
  });

  it('chi tiết sản phẩm đủ trường, thuộc tính theo thứ tự của biến thể đầu, giá chuẩn null (S-4, B4, B6)', async () => {
    const category = await createCategory(token, uniq('Áo'), '{VAL}-{SEQ:6}');
    const product = await createProduct(token, {
      name: uniq('Áo'),
      categoryId: category.id,
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
      category: { id: category.id, name: category.name },
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
    const category = await createCategory(token, uniq('Phụ kiện'), 'AO-{SEQ}-{VAL}');
    const product = await createProduct(token, { name: uniq('Thắt lưng'), categoryId: category.id, variants: [[]] });
    expect(product.variants.map((v) => v.sku)).toEqual(['AO-0001']);
  });

  it.each([
    ['thiếu tên', { name: '' }, 'name'],
    ['danh mục không tồn tại', { categoryId: randomUUID() }, 'categoryId'],
    ['danh mục không phải uuid', { categoryId: 'abc' }, 'categoryId'],
    ['không có biến thể', { variants: [] }, 'variants'],
    ['hơn 100 biến thể', { variants: Array.from({ length: 101 }, () => ({ attributeValueIds: [] })) }, 'variants'],
    ['ảnh chưa tải lên (#303)', { imageFileIds: [randomUUID()] }, 'images'],
    ['mô tả quá 5000 ký tự', { description: 'a'.repeat(5001) }, 'description'],
  ])('%s → 422 errors.%s, không tạo, không tiêu số (AC-9)', async (_case, override, field) => {
    const category = await createCategory(token, uniq('Lỗi'), 'L-{SEQ}');
    const res = await api(token).post('/products', { ...body(uniq('SP'), category.id, [[valueId(color, 'Đen')]]), ...override });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors[field]).toBeTruthy();
    expect((await categoryOf(category.id)).skuNextSeq).toBe(1);
  });

  it.each([
    ['khác bộ thuộc tính', () => [[valueId(color, 'Đen')], [valueId(color, 'Trắng'), valueId(size, 'M')]]],
    ['tổ hợp trùng', () => [[valueId(color, 'Đen'), valueId(size, 'M')], [valueId(size, 'M'), valueId(color, 'Đen')]]],
    ['hai giá trị cùng thuộc tính', () => [[valueId(color, 'Đen'), valueId(color, 'Trắng')]]],
    ['giá trị không tồn tại', () => [[randomUUID()]]],
  ])('%s → 422 errors.variants, không tạo sản phẩm (AC-9)', async (_case, variants) => {
    const category = await createCategory(token, uniq('Lỗi'), 'L-{SEQ}');
    const name = uniq('SP');
    const res = await api(token).post('/products', body(name, category.id, variants()));
    expect(res.status).toBe(422);
    expect(res.body.errors.variants).toBeTruthy();
    const list = await api(token).get(`/products?search=${encodeURIComponent(name)}`);
    expect(list.body.total).toBe(0);
    expect((await categoryOf(category.id)).skuNextSeq).toBe(1);
  });

  it('danh mục, giá trị của công ty khác → 422, không tạo dòng trỏ sang công ty kia (AC-9, S-6)', async () => {
    const other = await createCompany();
    const theirCategory = await createCategory(other.ceo.token, uniq('Của B'), 'B-{SEQ}');
    const theirColor = await createAttribute(other.ceo.token, uniq('Màu B'), ['Đỏ']);
    const mine = await createCategory(token, uniq('Của A'), 'A-{SEQ}');

    const byCategory = await api(token).post('/products', body(uniq('SP'), theirCategory.id, [[]]));
    expect(byCategory.status).toBe(422);
    expect(byCategory.body.errors.categoryId).toBeTruthy();
    const byValue = await api(token).post('/products', body(uniq('SP'), mine.id, [[valueId(theirColor, 'Đỏ')]]));
    expect(byValue.status).toBe(422);
    expect(byValue.body.errors.variants).toBeTruthy();
  });

  it('tên trùng sản phẩm đang bán → 409 name_taken (AC-18)', async () => {
    const category = await createCategory(token, uniq('Tên'), 'T-{SEQ}');
    const name = uniq('Giày');
    await createProduct(token, { name, categoryId: category.id, variants: [[]] });
    const res = await api(token).post('/products', body(` ${name.toUpperCase()} `, category.id, [[]]));
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/name_taken');
    expect(res.body.errors.name).toBeTruthy();
  });

  it('biến thể 3 thuộc tính → 422 too_many_axes, không tạo, không tiêu số (#204)', async () => {
    const material = await createAttribute(token, uniq('Chất liệu'), ['Cotton']);
    const category = await createCategory(token, uniq('Ba trục'), 'BT-{SEQ}-{VAL}');
    const name = uniq('SP ba trục');
    const res = await api(token).post(
      '/products',
      body(name, category.id, [[valueId(color, 'Đen'), valueId(size, 'M'), valueId(material, 'Cotton')]]),
    );
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/too_many_axes');
    expect(res.body.errors.variants).toBeTruthy();
    expect((await api(token).get(`/products?search=${encodeURIComponent(name)}`)).body.total).toBe(0);
    expect((await categoryOf(category.id)).skuNextSeq).toBe(1);
  });

  // D4 (#204, Thành đồng ý 16/11/2026): bỏ lưu trữ cha nên tên không trùng trên mọi sản phẩm, thay B1 của #12.
  it('tên của sản phẩm mọi SKU đã lưu trữ vẫn bị giữ → 409 name_taken (D4)', async () => {
    const category = await createCategory(token, uniq('Tên'), 'T-{SEQ}');
    const name = uniq('Giày chạy bộ');
    const old = await createProduct(token, { name, categoryId: category.id, variants: [[]] });
    await archiveSku(token, old.id, old.variants[0]!.id);
    const res = await api(token).post('/products', body(name, category.id, [[]]));
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/name_taken');
  });
});

describe('mã cha (#204 D5)', () => {
  it('SKU đầu bỏ phần giá trị thuộc tính; không thuộc tính thì bằng SKU; có ở chi tiết, danh sách, nhật ký', async () => {
    const { ceo } = await createCompany();
    const own = await createAttribute(ceo.token, 'Màu', ['Đen', 'Trắng']);
    const ownSize = await createAttribute(ceo.token, 'Size', ['XL']);
    const shirts = await createCategory(ceo.token, 'Áo', 'AO-{SEQ:4}-{VAL}');
    const belts = await createCategory(ceo.token, 'Phụ kiện', 'PK-{SEQ}');
    const shirt = await createProduct(ceo.token, {
      name: 'Áo thun',
      categoryId: shirts.id,
      variants: [
        [valueId(own, 'Đen'), valueId(ownSize, 'XL')],
        [valueId(own, 'Trắng'), valueId(ownSize, 'XL')],
      ],
    });
    expect([shirt.variants[0]!.sku, shirt.code]).toEqual(['AO-0001-DEN-XL', 'AO-0001']);
    const belt = await createProduct(ceo.token, { name: 'Thắt lưng', categoryId: belts.id, variants: [[]] });
    expect([belt.variants[0]!.sku, belt.code]).toEqual(['PK-0001', 'PK-0001']);
    expect((await api(ceo.token).get(`/products/${shirt.id}`)).body.code).toBe('AO-0001');
    const list = await api(ceo.token).get('/products?search=thun');
    expect(list.body.items.map((p: { code: string }) => p.code)).toEqual(['AO-0001']);
    expect((await auditOf(shirt.id))[0]!.after).toMatchObject({ code: 'AO-0001' });
  });

  it('hai danh mục cùng ra một mã cha: mã sau thêm -2', async () => {
    const { ceo } = await createCompany();
    const own = await createAttribute(ceo.token, 'Màu', ['Đen']);
    const shirts = await createCategory(ceo.token, 'Áo', 'MC-{SEQ:4}-{VAL}');
    const hats = await createCategory(ceo.token, 'Mũ', 'MC-{SEQ:4}');
    const shirt = await createProduct(ceo.token, { name: 'Áo', categoryId: shirts.id, variants: [[valueId(own, 'Đen')]] });
    const hat = await createProduct(ceo.token, { name: 'Mũ', categoryId: hats.id, variants: [[]] });
    expect([shirt.variants[0]!.sku, shirt.code]).toEqual(['MC-0001-DEN', 'MC-0001']);
    expect([hat.variants[0]!.sku, hat.code]).toEqual(['MC-0001', 'MC-0001-2']);
  });
});

describe('SKU duy nhất trong công ty (S-3, D9)', () => {
  it('hai danh mục cùng quy tắc: SKU đã có thì nhảy số kế tiếp', async () => {
    const a = await createCategory(token, uniq('A'), 'DUP-{SEQ}');
    const b = await createCategory(token, uniq('B'), 'DUP-{SEQ}');
    // Mỗi lượt test một công ty mới nên tiền tố DUP chỉ của test này.
    const pa = await createProduct(token, { name: uniq('SP'), categoryId: a.id, variants: [[]] });
    expect(pa.variants[0]!.sku).toBe('DUP-0001');
    const pb = await createProduct(token, { name: uniq('SP'), categoryId: b.id, variants: [[]] });
    expect(pb.variants[0]!.sku).toBe('DUP-0002');
    expect((await categoryOf(b.id)).skuNextSeq).toBe(3);
  });

  it('hai request song song cùng danh mục: SKU không trùng, skuNextSeq tăng đúng tổng số biến thể', async () => {
    const category = await createCategory(token, uniq('Song song'), 'PAR-{SEQ}-{VAL}');
    const make = (n: number) =>
      api(token).post('/products', body(uniq(`SP${n}`), category.id, [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]]));
    const results = await Promise.all([make(1), make(2), make(3)]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const skus = results.flatMap((r) => (r.body as ProductBody).variants.map((v) => v.sku));
    expect(new Set(skus).size).toBe(6);
    expect((await categoryOf(category.id)).skuNextSeq).toBe(7);
  });
});

describe('GET /catalog/products', () => {
  it('tìm theo tên hoặc SKU, lọc danh mục và trạng thái, ô rỗng không lọc, dạng trang (AC-14)', async () => {
    const { ceo } = await createCompany();
    const own = await createAttribute(ceo.token, 'Màu', ['Đen']);
    const category = await createCategory(ceo.token, 'Áo', 'AO-{SEQ:4}-{VAL}');
    const other = await createCategory(ceo.token, 'Quần', 'Q{SEQ:4}');
    for (let i = 0; i < 12; i++) await createProduct(ceo.token, { name: `Lót ${i}`, categoryId: other.id, variants: [[]] });
    const target = await createProduct(ceo.token, { name: 'Áo thun', categoryId: category.id, variants: [[valueId(own, 'Đen')]] });
    const archived = await createProduct(ceo.token, { name: 'Áo cũ 0012', categoryId: category.id, variants: [[]] });
    await archiveSku(ceo.token, archived.id, archived.variants[0]!.id);

    // SKU Q0012 (sản phẩm Lót 11) và AO-0001-DEN không chứa 0012; "Áo cũ 0012" đã lưu trữ.
    const bySku = await api(ceo.token).get('/products?search=0012&categoryId=&status=&page=1&pageSize=20');
    expect(bySku.status).toBe(200);
    expect(bySku.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(bySku.body.items[0]).toMatchObject({ name: 'Lót 11', category: { id: other.id, name: 'Quần' }, variantCount: 1 });

    const byName = await api(ceo.token).get('/products?search=ÁO THUN');
    expect(byName.body.items.map((p: { id: string }) => p.id)).toEqual([target.id]);
    expect(byName.body.items[0]).toEqual({
      id: target.id,
      name: 'Áo thun',
      code: 'AO-0001',
      category: { id: category.id, name: 'Áo' },
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

    const byCategory = await api(ceo.token).get(`/products?categoryId=${category.id}`);
    expect(byCategory.body.total).toBe(1);
    const archivedOnly = await api(ceo.token).get('/products?status=archived');
    expect(archivedOnly.body.items.map((p: { id: string; status: string }) => [p.id, p.status])).toEqual([[archived.id, 'archived']]);

    const page2 = await api(ceo.token).get('/products?pageSize=5&page=3');
    expect(page2.body).toMatchObject({ total: 13, page: 3, pageSize: 5 });
    expect(page2.body.items).toHaveLength(3);

    const none = await api(ceo.token).get('/products?search=khongco');
    expect(none.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('SKU của biến thể đã ngừng bán vẫn tìm được', async () => {
    const category = await createCategory(token, uniq('Ngừng'), 'NB-{SEQ}-{VAL}');
    const product = await createProduct(token, {
      name: uniq('SP'),
      categoryId: category.id,
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
    ['categoryId=abc', 'categoryId'],
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
    const category = await createCategory(token, uniq('Sửa'), 'S-{SEQ}-{VAL}');
    return createProduct(token, { name: uniq('SP'), categoryId: category.id, variants: [[valueId(color, 'Đen')]] });
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

  it('gửi kèm categoryId và variants thì bỏ qua: danh mục, biến thể không đổi (AC-13)', async () => {
    const product = await simple();
    const other = await createCategory(token, uniq('Khác'), 'K-{SEQ}');
    const res = await update(product.id, 1, { categoryId: other.id, variants: [{ attributeValueIds: [] }] });
    expect(res.status).toBe(200);
    const detail = await api(token).get(`/products/${product.id}`);
    expect(detail.body.category.id).not.toBe(other.id);
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
