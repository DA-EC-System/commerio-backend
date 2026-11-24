// Kiểm trước khi đăng hàng loạt (be#566, Documents/21 §18.11): cùng luật với readiness (18.10) và `push`.
// Biến thể có thật trong DB (giá muốn bán, giá vốn đọc qua cổng product thật), cổng sản phẩm của channel giả phần còn lại.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ListingList, PriceQuoteList, PushPreview } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { firstBlock } from '#src/modules/channel/channel/service/push-block.ts';
import { checkVariant, loadPushContext } from '#src/modules/channel/channel/service/push-check.ts';
import { ownShop } from '#src/modules/channel/channel/service/shops.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter, seedSpecs } from './helpers.ts';

const variants: ListingVariant[] = [];
const port = {
  variants: async (ids?: readonly string[], opts?: { productIds?: readonly string[] }) =>
    variants.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(150000)])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
  productImageUrls: async (ids: readonly string[]) => new Map(ids.map((id) => [id, ['https://files.commerio.test/a.jpg']])),
};
setProductPort(port);
// Route xem trước không gọi sàn: mọi hàm ghi, đọc sản phẩm của adapter giả đều ném (chỉ `getSeller` cho bước nối).
let marketplaceCalls = 0;
const forbidden = async () => {
  marketplaceCalls += 1;
  throw new Error('push-preview không được gọi sàn');
};
registerAdapter(
  'lazada',
  fakeAdapter({
    getSeller: async (accessToken) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' }),
    getSkus: forbidden,
    createProduct: forbidden,
    updateProduct: forbidden,
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

const app = () => request(testApp());
const db = () => testPool();
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId = '';
let noFeeShopId = '';
let noCostToken = '';
let viewOnlyToken = '';
const as = (token: string) => (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
/** Phí 14% + 3.000 mỗi món, làm tròn lên bậc 10.000 đuôi 9.000; lãi tối thiểu 10%. Giá muốn bán 200.000 → 239.000, thực nhận 202.540. */
const FEE = { fixedPct: 4, transactionPct: 5, servicePct: 3, optionalPct: 2, returnFee: 0, perItemFee: 3000, roundStep: 10000, roundEnding: 9000 };

const color = (value: string) => ({ attributeId: 'attr-color', attributeName: 'Màu', platformKind: null, value, valueId: `color-${value}` });
const size = (value: string) => ({ attributeId: 'attr-size', attributeName: 'Cỡ', platformKind: null, value, valueId: `size-${value}` });

async function variant(target: number | null, cost: number, extra: Partial<ListingVariant> = {}, opts: { spec?: boolean } = {}) {
  const { variantId, productId, sku } = await createVariant(company.companyId);
  await db().query('update product.product_variants set target_net_price = $2 where id = $1', [variantId, target]);
  await db().query('insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, 2, $3)', [company.companyId, variantId, cost]);
  const v: ListingVariant = {
    id: variantId,
    productId,
    productName: 'Áo thun',
    sku,
    attributesLabel: 'Đen / M',
    productCode: 'SP-TEST',
    groupId: 'GROUP-TEST',
    attributes: [],
    archived: false,
    businessStatus: 'selling',
    description: 'Áo cotton',
    weightG: 250,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 15,
    ...extra,
  };
  variants.push(v);
  if (opts.spec !== false) await seedSpecs(company.companyId, 'lazada', '1', [v]);
  return v;
}
async function connect() {
  const res = await as(company.ceo.token)(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  await activateShop(res.body.shop.id);
  return res.body.shop.id as string;
}
const preview = (body: object, token = company.ceo.token, shop = shopId) =>
  as(token)(app().post(`/api/v1/channel/shops/${shop}/listings/push-preview`)).send(body);
const push = (body: object, token = company.ceo.token) => as(token)(app().post(`/api/v1/channel/shops/${shopId}/listings/push`)).send(body);
const codes = (row: { blockers: { code: string }[] }) => row.blockers.map((b) => b.code);
const counts = async () =>
  (
    await db().query(
      `select (select count(*) from channel.listings where company_id = $1)::int as listings,
              (select count(*) from channel.price_calculations where company_id = $1)::int as calcs,
              (select count(*) from pgboss.job where data->>'companyId' = $1::text)::int as jobs`,
      [company.companyId],
    )
  ).rows[0];

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  shopId = await connect();
  noFeeShopId = await connect();
  await db().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, 'fee', $2, 'active', $3, '2026-10-01', $4, $5, now()), ($1, 'min_margin', null, 'active', '{"pct":10}', '2026-10-01', $4, $5, now())`,
    [company.companyId, shopId, JSON.stringify(FEE), randomUUID(), randomUUID()],
  );
  noCostToken = (await addMember(company.companyId, await createCustomRole(company.companyId, ['channel.shop.view', 'channel.listing.manage']))).token;
  viewOnlyToken = (await addMember(company.companyId, await createCustomRole(company.companyId, ['channel.shop.view']))).token;
});

describe('POST /channel/shops/:id/listings/push-preview: dòng đăng được', () => {
  it('giá bộ lọc đã làm tròn kèm quy tắc, thực nhận, phí, tồn sẽ đẩy; đúng hợp đồng', async () => {
    const v = await variant(200000, 150000);
    const res = await preview({ variantIds: [v.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = PushPreview.parse(res.body);
    expect(body.summary).toEqual({ ready: 1, blocked: 0 });
    expect(body.rows[0]).toMatchObject({
      variantId: v.id,
      productId: v.productId,
      productName: 'Áo thun',
      attributesLabel: 'Đen / M',
      sku: v.sku,
      status: 'ready',
      blockers: [],
      listPrice: 239000,
      rounding: { step: 10000, ending: 9000, before: 236047, after: 239000 },
      netReceived: 202540,
      feePct: 0.1526,
      stockToPush: 7,
      stockHeldReason: null,
      feeConfigId: expect.any(String),
    });
    expect(marketplaceCalls).toBe(0);
  });

  it('giá gõ tay: dùng đúng giá đó, không làm tròn (rounding null)', async () => {
    const v = await variant(200000, 150000);
    const [row] = PushPreview.parse((await preview({ variantIds: [v.id], listPrices: { [v.id]: 245000 } })).body).rows;
    expect(row).toMatchObject({ status: 'ready', listPrice: 245000, rounding: null });
  });

  it('không ghi gì: listing, lần tính giá, việc nền giữ nguyên', async () => {
    const v = await variant(200000, 150000);
    const before = await counts();
    expect((await preview({ variantIds: [v.id] })).status).toBe(200);
    expect(await counts()).toEqual(before);
  });
});

describe('push-preview: dòng bị chặn, mỗi mục một Blocker kèm scope và chỗ sửa', () => {
  it('thiếu cân nặng: dimensions_missing, common, chỉ ô cân nặng', async () => {
    const v = await variant(200000, 150000, { weightG: null });
    const [row] = PushPreview.parse((await preview({ variantIds: [v.id] })).body).rows;
    expect(row!.status).toBe('blocked');
    expect(row!.blockers).toContainEqual(
      expect.objectContaining({ code: 'dimensions_missing', scope: 'common', target: { kind: 'variant_field', field: 'weight' }, variantIds: [v.id] }),
    );
  });

  it('chưa chọn category: category_unmapped, platform, mở hộp chọn category', async () => {
    const v = await variant(200000, 150000, {}, { spec: false });
    const [row] = PushPreview.parse((await preview({ variantIds: [v.id] })).body).rows;
    expect(row!.blockers).toContainEqual(expect.objectContaining({ code: 'category_unmapped', scope: 'platform', target: { kind: 'category' } }));
  });

  it('nhiều mục cùng lúc: trả đủ, không dừng ở mục đầu', async () => {
    const v = await variant(200000, 150000, { weightG: null }, { spec: false });
    const [row] = PushPreview.parse((await preview({ variantIds: [v.id] })).body).rows;
    expect(codes(row!)).toEqual(expect.arrayContaining(['category_unmapped', 'dimensions_missing']));
  });

  it('gian hàng chưa có phí: fee_not_configured, shop, chỉ tới cấu hình phí; số tiền null', async () => {
    const v = await variant(200000, 150000);
    const res = await preview({ variantIds: [v.id] }, company.ceo.token, noFeeShopId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = PushPreview.parse(res.body).rows;
    expect(row!.blockers).toContainEqual(expect.objectContaining({ code: 'fee_not_configured', scope: 'shop', target: { kind: 'shop', field: 'fee_config' } }));
    expect(row).toMatchObject({ netReceived: null, feePct: null, rounding: null, feeConfigId: null });
  });

  it('mục chặn xếp theo phạm vi như readiness: sàn, SKU, rồi gian hàng (21 §18.10); `code` của push vẫn theo thứ tự kiểm', async () => {
    const v = await variant(200000, 150000, { weightG: null }, { spec: false });
    const [row] = PushPreview.parse((await preview({ variantIds: [v.id] }, company.ceo.token, noFeeShopId)).body).rows;
    // Thứ tự kiểm là fee_not_configured → dimensions_missing → category_unmapped; hiển thị thì mục sàn trước, gian hàng sau.
    expect(row!.blockers.map((b) => [b.scope, b.code])).toEqual([
      ['platform', 'category_unmapped'],
      ['common', 'dimensions_missing'],
      ['shop', 'fee_not_configured'],
    ]);
  });

  it('biến thể đã lưu trữ: not_found chỉ tới listing (21 §18.11)', async () => {
    const v = await variant(200000, 150000, { archived: true });
    const [row] = PushPreview.parse((await preview({ variantIds: [v.id] })).body).rows;
    expect(row!.blockers).toEqual([expect.objectContaining({ code: 'not_found', scope: 'shop', target: { kind: 'listing', listingId: null } })]);
  });

  it('các SKU mới của một cha khác bộ thuộc tính: axis_shape (trước đây chỉ việc nền mới biết)', async () => {
    const a = await variant(200000, 150000, { attributes: [color('Đỏ')], attributesLabel: 'Đỏ' }, { spec: false });
    const b = await variant(200000, 150000, { productId: a.productId, attributes: [color('Xanh'), size('M')], attributesLabel: 'Xanh / M' }, { spec: false });
    await seedSpecs(company.companyId, 'lazada', '1', [a, b]);
    const body = PushPreview.parse((await preview({ variantIds: [a.id, b.id] })).body);
    for (const row of body.rows) {
      expect(row.blockers).toContainEqual(expect.objectContaining({ code: 'axis_shape', scope: 'platform', target: { kind: 'axis' } }));
    }
    expect(body.summary).toEqual({ ready: 0, blocked: 2 });
  });

  it('dưới giá thấp nhất: CEO thấy below_floor; người không xem giá vốn thì không (R4, Thành chốt qua acn-9a 24/11/2026)', async () => {
    const v = await variant(200000, 200000);
    const [ceo] = PushPreview.parse((await preview({ variantIds: [v.id] })).body).rows;
    expect(codes(ceo!)).toContain('below_floor');
    const [other] = PushPreview.parse((await preview({ variantIds: [v.id] }, noCostToken)).body).rows;
    expect(codes(other!)).not.toContain('below_floor');
    expect(other!.status).toBe('ready');
  });
});

describe('push-preview và push cho cùng một kết quả', () => {
  it('cùng dữ liệu: mã chặn từng dòng của xem trước bằng `blockers` của push', async () => {
    const vs = [
      await variant(200000, 150000, { weightG: null }),
      await variant(200000, 150000, {}, { spec: false }),
      await variant(200000, 200000),
    ];
    const ids = vs.map((v) => v.id);
    const rows = PushPreview.parse((await preview({ variantIds: ids })).body).rows;
    const pushed = await push({ variantIds: ids });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    // Mục chặn đầu theo thứ tự kiểm của #564 (`firstBlock`), không theo `blockers[0]`: xem trước được xếp lại theo phạm vi 18.10
    // để hiển thị (Documents#248 phương án a).
    const first = await withCompany(company.companyId, async () => {
      const ctx = await loadPushContext(port, await ownShop(shopId), ids);
      return new Map(ids.map((id) => [id, firstBlock(checkVariant(ctx, id).items)?.code ?? null]));
    });
    for (const row of rows) {
      const result = pushed.body.results.find((r: { variantId: string }) => r.variantId === row.variantId);
      expect(result.blockers.map((b: { code: string }) => b.code).sort(), row.variantId).toEqual(codes(row).sort());
      expect(result.code ?? null, row.variantId).toBe(first.get(row.variantId));
    }
  });

  it('dữ liệu đổi sau khi xem trước: push kiểm lại từng dòng, dòng hỏng bị chặn, dòng khác vẫn xếp việc', async () => {
    const good = await variant(200000, 150000);
    const broken = await variant(200000, 150000);
    const before = PushPreview.parse((await preview({ variantIds: [good.id, broken.id] })).body);
    expect(before.summary).toEqual({ ready: 2, blocked: 0 });
    variants.find((v) => v.id === broken.id)!.weightG = null;
    const pushed = await push({ variantIds: [good.id, broken.id] });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantId: good.id, status: 'pushing', code: null }),
        expect.objectContaining({ variantId: broken.id, code: 'dimensions_missing' }),
      ]),
    );
  });
});

describe('push-preview: lỗi cả request', () => {
  it('401 không token; 403 thiếu listing.manage', async () => {
    const v = await variant(200000, 150000);
    expect((await app().post(`/api/v1/channel/shops/${shopId}/listings/push-preview`).send({ variantIds: [v.id] })).status).toBe(401);
    expect((await preview({ variantIds: [v.id] }, viewOnlyToken)).status).toBe(403);
  });

  it('404 gian hàng không thuộc công ty', async () => {
    const v = await variant(200000, 150000);
    expect((await preview({ variantIds: [v.id] }, company.ceo.token, randomUUID())).status).toBe(404);
  });

  it('409 gian hàng chưa active, như push', async () => {
    const v = await variant(200000, 150000);
    const pending = await as(company.ceo.token)(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    const res = await preview({ variantIds: [v.id] }, company.ceo.token, pending.body.shop.id);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/shop_not_active$/);
  });

  it('422: rỗng, quá 200, biến thể không có hay của công ty khác (theo chỉ số)', async () => {
    const v = await variant(200000, 150000);
    const empty = await preview({ variantIds: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.errors).toHaveProperty('variantIds');
    const tooMany = await preview({ variantIds: Array.from({ length: 201 }, () => randomUUID()) });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.errors).toHaveProperty('variantIds');
    const foreign = await preview({ variantIds: [v.id, randomUUID()] });
    expect(foreign.status).toBe(422);
    expect(foreign.body.errors).toEqual({ 'variantIds.1': expect.any(String) });
  });
});

describe('rounding ở price-quote và trang listing (21 §18.11)', () => {
  it('price-quote: thiếu giá gõ thì có rounding; giá gõ thử thì null', async () => {
    const v = await variant(200000, 150000);
    const res = await as(company.ceo.token)(app().post(`/api/v1/channel/products/${v.productId}/price-quote`)).send({
      items: [{ shopId, variantId: v.id }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PriceQuoteList.parse(res.body).items[0]!.rounding).toEqual({ step: 10000, ending: 9000, before: 236047, after: 239000 });
    const typed = await as(company.ceo.token)(app().post(`/api/v1/channel/products/${v.productId}/price-quote`)).send({
      items: [{ shopId, variantId: v.id, listPrice: 239000 }],
    });
    expect(typed.body.items[0].rounding).toBeNull();
  });

  it('GET listings: biến thể chưa lên sàn có rounding của giá lần đăng tới', async () => {
    const v = await variant(200000, 150000);
    const res = await as(company.ceo.token)(app().get(`/api/v1/channel/shops/${shopId}/listings`));
    expect(res.status).toBe(200);
    const row = ListingList.parse(res.body).items.find((r) => r.variantId === v.id);
    expect(row?.rounding).toEqual({ step: 10000, ending: 9000, before: 236047, after: 239000 });
  });
});
