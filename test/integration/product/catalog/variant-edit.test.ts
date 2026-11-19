import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductDetail } from '#src/modules/product/catalog/api/schemas.ts';
import { getVariants } from '#src/modules/product/catalog/index.ts';
import { findVariants } from '#src/modules/product/catalog/repository/variants.ts';
import { applyVariantUpdate } from '#src/modules/product/catalog/service/variants.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { type AttributeBody, api, auditOf, createAttribute, createCategory, createProduct, uniq, valueId, archiveSku } from './helpers.ts';

// Sửa một SKU: giá chuẩn, giá muốn bán, cân nặng, kích thước gói (#204, Documents/21 §17.1, §17.2).
let companyId: string;
let token: string;
let color: AttributeBody;
beforeAll(async () => {
  const company = await createCompany();
  companyId = company.companyId;
  token = company.ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng']);
});

/** Sản phẩm một SKU không thuộc tính, danh mục riêng. */
const wallet = async () => {
  const category = await createCategory(token, uniq('Ví'), 'VI-{SEQ}');
  return createProduct(token, { name: uniq('Ví'), categoryId: category.id, variants: [[]] });
};

describe('chi tiết sản phẩm: trường của SKU (#204, Documents/21 §17.1)', () => {
  it('SKU mới có version 1, selling, chưa có giá và số đo; body khớp đúng schema ProductDetail', async () => {
    const product = await wallet();
    const res = await api(token).get(`/products/${product.id}`);
    expect(res.status).toBe(200);
    expect(res.body.variants[0]).toMatchObject({
      version: 1,
      businessStatus: 'selling',
      standardPrice: null,
      targetNetPrice: null,
      weightG: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
    // parse bỏ khoá thừa: bằng nhau là không thừa, không thiếu.
    expect(ProductDetail.parse(res.body)).toEqual(res.body);
  });
});

const patch = (productId: string, variantId: string, body: object) =>
  api(token).patch(`/products/${productId}/variants/${variantId}`, body);
const variantOf = async (productId: string) => (await api(token).get(`/products/${productId}`)).body.variants[0];
const FULL = { weightG: 250, lengthMm: 200, widthMm: 100, heightMm: 30, standardPrice: 180000, targetNetPrice: 150000 };

describe('PATCH /catalog/products/:id/variants/:variantId (#204, Documents/21 §17.2)', () => {
  it('đặt 4 số đo và hai giá → 200 ProductDetail; version SKU tăng, version cha giữ; getVariants thấy số đo', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    const res = await patch(product.id, variantId, { version: 1, ...FULL });
    expect(res.status).toBe(200);
    expect(res.body.variants[0]).toMatchObject({ ...FULL, version: 2 });
    expect(res.body.version).toBe(1);
    expect(ProductDetail.parse(res.body)).toEqual(res.body);
    const [v] = await withCompany(companyId, () => getVariants([variantId]));
    expect(v).toMatchObject({ weightG: 250, lengthMm: 200, widthMm: 100, heightMm: 30 });
  });

  it('bỏ trường là giữ nguyên, null là xoá', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, ...FULL });
    const res = await patch(product.id, variantId, { version: 2, weightG: null });
    expect(res.status).toBe(200);
    expect(res.body.variants[0]).toMatchObject({ ...FULL, weightG: null, version: 3 });
  });

  it('nhật ký update chỉ ghi trường đổi, theo dạng API', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, weightG: 250, targetNetPrice: 150000 });
    expect(await auditOf(variantId)).toEqual([
      {
        action: 'update',
        entity_type: 'product.product_variants',
        before: { weightG: null, targetNetPrice: null },
        after: { weightG: 250, targetNetPrice: 150000 },
      },
    ]);
  });

  it.each([
    ['cân nặng 0', { weightG: 0 }, 'weightG'],
    ['cân nặng âm', { weightG: -1 }, 'weightG'],
    ['chiều dài số lẻ', { lengthMm: 2.5 }, 'lengthMm'],
    ['chiều rộng là chuỗi', { widthMm: '250' }, 'widthMm'],
    ['chiều cao vượt integer của PostgreSQL', { heightMm: 2147483648 }, 'heightMm'],
    ['giá muốn bán số lẻ', { targetNetPrice: 150000.5 }, 'targetNetPrice'],
    ['giá chuẩn bằng 0', { standardPrice: 0 }, 'standardPrice'],
  ])('%s → 422 errors.<ô>', async (_case, body, field) => {
    const product = await wallet();
    const res = await patch(product.id, product.variants[0]!.id, { version: 1, ...body });
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(res.body.errors[field]).toBeTruthy();
    expect(await variantOf(product.id)).toMatchObject({ version: 1, weightG: null });
  });

  it('version vượt integer của PostgreSQL → 409 version_conflict, không lỗi 500 từ DB', async () => {
    const product = await wallet();
    const res = await patch(product.id, product.variants[0]!.id, { version: 2147483648, weightG: 250 });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(await variantOf(product.id)).toMatchObject({ version: 1, weightG: null });
  });

  it('thiếu version → 422 errors.version', async () => {
    const product = await wallet();
    const res = await patch(product.id, product.variants[0]!.id, { weightG: 250 });
    expect(res.status).toBe(422);
    expect(res.body.errors.version).toBeTruthy();
  });

  it('trường lạ (imageFileId: ảnh phân loại theo giá trị, không theo SKU, #340) → 422, không ghi gì', async () => {
    const product = await wallet();
    const res = await patch(product.id, product.variants[0]!.id, { version: 1, weightG: 250, imageFileId: randomUUID() });
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(await variantOf(product.id)).toMatchObject({ version: 1, weightG: null });
  });

  it('sai version → 409 version_conflict kèm current mới nhất, không ghi gì', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, weightG: 250 });
    const res = await patch(product.id, variantId, { version: 1, weightG: 300 });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(res.body.current.variants[0]).toMatchObject({ weightG: 250, version: 2 });
    expect(await variantOf(product.id)).toMatchObject({ weightG: 250, version: 2 });
  });

  it('gửi lại PATCH đã thành công (version cũ, cùng giá trị) → 200, không ghi thêm', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    const body = { version: 1, ...FULL };
    expect((await patch(product.id, variantId, body)).status).toBe(200);
    const again = await patch(product.id, variantId, body);
    expect(again.status).toBe(200);
    expect(again.body.variants[0]).toMatchObject({ ...FULL, version: 2 });
    expect(await auditOf(variantId)).toHaveLength(1);
  });

  it('chỉ gửi version → 200, không đổi version', async () => {
    const product = await wallet();
    const res = await patch(product.id, product.variants[0]!.id, { version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.variants[0].version).toBe(1);
  });

  it('SKU đã ngừng bán vẫn sửa được để điền cho đủ', async () => {
    const category = await createCategory(token, uniq('Áo'), 'AO-{SEQ}-{VAL}');
    const product = await createProduct(token, {
      name: uniq('Áo'),
      categoryId: category.id,
      variants: [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]],
    });
    const stopped = product.variants[0]!;
    await archiveSku(token, product.id, stopped.id);
    const res = await patch(product.id, stopped.id, { version: 3, weightG: 250 });
    expect(res.status).toBe(200);
    expect(res.body.variants.find((v: { id: string }) => v.id === stopped.id)).toMatchObject({ weightG: 250, version: 4 });
  });

  it.each([
    ['SKU của sản phẩm khác', async () => ({ productId: (await wallet()).id, variantId: (await wallet()).variants[0]!.id })],
    ['variantId không phải uuid', async () => ({ productId: (await wallet()).id, variantId: 'abc' })],
    ['sản phẩm không tồn tại', async () => ({ productId: randomUUID(), variantId: randomUUID() })],
  ])('%s → 404 not_found', async (_case, ids) => {
    const { productId, variantId } = await ids();
    const res = await patch(productId, variantId, { version: 1, weightG: 250 });
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
  });
});

/** Payload `catalog.variant_price_changed` của một SKU trong outbox, cũ trước. */
const priceEvents = async (variantId: string) =>
  (
    await testPool().query<{ payload: Record<string, unknown> }>(
      "select payload from core.outbox_messages where type = 'catalog.variant_price_changed' and key = $1 order by id",
      [variantId],
    )
  ).rows.map((r) => r.payload);

describe('PATCH SKU phát catalog.variant_price_changed (#204, Documents/21 §11.2)', () => {
  it('đặt giá muốn bán lần đầu → một sự kiện from null, to là chuỗi thập phân', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, targetNetPrice: 150000 });
    expect(await priceEvents(variantId)).toEqual([
      { variantId, productId: product.id, from: null, to: '150000.00', changedAt: expect.any(String) },
    ]);
  });

  it('đổi giá rồi xoá giá → mỗi lần một sự kiện, xoá thì to null', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, targetNetPrice: 150000 });
    await patch(product.id, variantId, { version: 2, targetNetPrice: 170000 });
    await patch(product.id, variantId, { version: 3, targetNetPrice: null });
    expect((await priceEvents(variantId)).map((e) => [e.from, e.to])).toEqual([
      [null, '150000.00'],
      ['150000.00', '170000.00'],
      ['170000.00', null],
    ]);
  });

  it('gửi lại cùng giá (150000 khi đang lưu "150000.00") → không thêm sự kiện, không tăng version', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, targetNetPrice: 150000 });
    const res = await patch(product.id, variantId, { version: 2, targetNetPrice: 150000 });
    expect(res.body.variants[0].version).toBe(2);
    expect(await priceEvents(variantId)).toHaveLength(1);
  });

  it('chỉ đổi giá chuẩn hoặc số đo → không có sự kiện', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    await patch(product.id, variantId, { version: 1, standardPrice: 180000, weightG: 250 });
    expect(await priceEvents(variantId)).toEqual([]);
  });

  it('sai version mà có đổi giá → 409 và không có sự kiện', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    const res = await patch(product.id, variantId, { version: 5, targetNetPrice: 150000 });
    expect(res.status).toBe(409);
    expect(await priceEvents(variantId)).toEqual([]);
  });

  it('hai PATCH cùng version chạy song song → đúng một 200, một 409, một sự kiện', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    const results = await Promise.all([
      patch(product.id, variantId, { version: 1, targetNetPrice: 150000 }),
      patch(product.id, variantId, { version: 1, targetNetPrice: 160000 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await priceEvents(variantId)).toHaveLength(1);
  });
});

describe('applyVariantUpdate cho sửa hàng loạt (#242)', () => {
  it('không khoá dòng sản phẩm cha: nhiều SKU một giao dịch không deadlock với PATCH đơn lẻ', async () => {
    const product = await wallet();
    const variantId = product.variants[0]!.id;
    const holder = await testPool().connect();
    try {
      // Giao dịch khác giữ dòng sản phẩm cha (như một PATCH đơn lẻ đang đổi updated_at của cha).
      await holder.query('begin');
      await holder.query('select 1 from product.products where id = $1 for update', [product.id]);
      const outcome = await withCompany(companyId, async () => {
        await getDb().execute(sql`set local lock_timeout = '1s'`);
        const [current] = await findVariants({ ids: [variantId] });
        return applyVariantUpdate({ companyId, accountId: randomUUID() }, current!, { version: 1, weightG: 250 });
      });
      expect(outcome).toBe('updated');
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });
});
