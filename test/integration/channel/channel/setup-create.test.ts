// Tạo SKU kho từ SKU sàn ở bước thiết lập (#500; Documents/21 §18.7.5): dòng `create` tạo sản phẩm, biến thể (mã = SKU
// người bán) bằng cổng catalog thật rồi ghép như dòng chọn biến thể. Mỗi ca một công ty riêng.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { ShopSetupPreview, ShopSetupResult } from '#src/modules/channel/channel/api/schemas.ts';
import { priceFilter, targetForPrice } from '#src/modules/channel/channel/domain/price-filter.ts';
import type { RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { setStocktakePort } from '#src/modules/channel/channel/service/stocktake-port.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const sku = (id: string, productId: string, sellerSku: string, title: string, extra: Partial<RemoteSku> = {}): RemoteSku => ({
  externalProductId: productId,
  externalSkuId: id,
  sellerSku,
  title,
  state: 'live',
  rejectReason: null,
  quantity: 4,
  ...extra,
});

/** Bộ SKU sàn của từng ca (SKU người bán phải khác nhau giữa các công ty vì sàn giả dùng chung). */
let remote: RemoteSku[] = [];
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    getSkus: async (_t, sellerSkus) => remote.filter((r) => sellerSkus.includes(r.sellerSku)),
    listSkus: async () => remote,
    updatePriceQuantity: async (_t, items) => items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true as const })),
  }),
);
setProductPort(null);
afterAll(() => resetAdapters());
afterEach(() => setStocktakePort());

const app = () => request(testApp());
type Company = Awaited<ReturnType<typeof createCompany>>;
const tag = () => randomUUID().slice(0, 6).toUpperCase();

/** Gian hàng `connecting` của công ty đã có gian hàng xong thiết lập (được `push`). */
async function connectingShop(c: Company, token = c.ceo.token, withActive = true) {
  if (withActive) {
    await testPool().query(
      "insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at) values ($1, 'lazada', $2, 'Cũ', 'active', now())",
      [c.companyId, randomUUID()],
    );
  }
  const res = await app()
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${c.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status).toBe(201);
  const shopId = res.body.shop.id as string;
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  return {
    shopId,
    preview: () => auth(app().get(`/api/v1/channel/shops/${shopId}/setup`)),
    setup: (body: object) =>
      auth(app().post(`/api/v1/channel/shops/${shopId}/setup`)).send({ openingStock: 'push', returnWindowDays: 7, ...body }),
  };
}

/** Nhóm công ty dùng được: nhóm chuẩn của nền tảng (dùng chung mọi công ty, #521). */
async function groupOf(_companyId: string): Promise<string> {
  const { rows } = await testPool().query('select id from product.product_groups where company_id is null order by name limit 1');
  return rows[0].id as string;
}

/** Nhóm riêng của một công ty (công ty khác không dùng được). */
async function privateGroupOf(companyId: string): Promise<string> {
  const { rows } = await testPool().query("insert into product.product_groups (company_id, name) values ($1, 'Nhóm riêng ' || substr(md5(random()::text), 1, 8)) returning id", [companyId]);
  return rows[0].id as string;
}

async function variantsOf(companyId: string, skus: string[]) {
  const { rows } = await testPool().query(
    `select v.id, v.sku, p.id as product_id, p.name, p.code, p.group_id
       from product.product_variants v join product.products p on p.id = v.product_id
      where v.company_id = $1 and v.sku = any($2) order by v.sku`,
    [companyId, skus],
  );
  return rows;
}

const create = (externalSkuId: string) => ({ externalSkuId, variantId: null, create: true });

describe('canCreate trong gợi ý (AC-1)', () => {
  it('chỉ dòng `none` có SKU người bán hợp lệ, chưa là SKU kho (kể cả lưu trữ) mới tạo được; lý do theo dòng', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    const archived = await createVariant(c.companyId, { sku: `ARC-${t}` });
    await testPool().query("update product.product_variants set business_status = 'archived', archived_at = now() where id = $1", [
      archived.variantId,
    ]);
    remote = [
      sku('n1', `p-${t}`, `NEW-${t}`, 'Áo khoác gió'),
      sku('n2', `q-${t}`, '', 'Không SKU'),
      sku('n3', `r-${t}`, `L${'x'.repeat(50)}`, 'SKU dài'),
      sku('n4', `s-${t}`, `ARC-${t}`, 'Đã lưu trữ'),
    ];
    const { preview } = await connectingShop(c);
    const res = await preview();
    expect(res.status).toBe(200);
    const body = ShopSetupPreview.parse(res.body);
    const by = new Map(body.suggestions.map((i) => [i.externalSkuId, i]));
    expect(by.get('n1')).toMatchObject({ match: 'none', canCreate: true, cannotCreateReason: null });
    expect(by.get('n2')).toMatchObject({ canCreate: false, cannotCreateReason: 'no_seller_sku' });
    expect(by.get('n3')).toMatchObject({ canCreate: false, cannotCreateReason: 'sku_too_long' });
    expect(by.get('n4')).toMatchObject({ canCreate: false, cannotCreateReason: 'sku_taken' });
  });

  it('dòng ghép theo SKU: SKU đã có nên không tạo được (sku_taken)', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    await createVariant(c.companyId, { sku: `HAS-${t}` });
    remote = [sku('m1', `p-${t}`, `HAS-${t}`, 'Có sẵn')];
    const { preview } = await connectingShop(c);
    const item = ShopSetupPreview.parse((await preview()).body).suggestions[0]!;
    expect(item).toMatchObject({ match: 'sku', canCreate: false, cannotCreateReason: 'sku_taken' });
  });
});

describe('POST /setup với dòng create (AC-2, AC-3, AC-7, AC-10, AC-11)', () => {
  it('AC-2: sản phẩm một SKU → một sản phẩm, một biến thể mã = SKU người bán, listing live; created tính trong matched', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [sku('a1', `p-${t}`, `ONE-${t}`, `Bình nước ${t}`)];
    const { shopId, setup } = await connectingShop(c);
    const groupId = await groupOf(c.companyId);
    const res = await setup({ decisions: [create('a1')], createGroupId: groupId });
    expect(res.status).toBe(200);
    expect(ShopSetupResult.parse(res.body)).toMatchObject({ matched: 1, created: 1 });
    const [v] = await variantsOf(c.companyId, [`ONE-${t}`]);
    expect(v).toMatchObject({ name: `Bình nước ${t}`, code: `ONE-${t}`, group_id: groupId });
    const { rows } = await testPool().query('select variant_id, seller_sku, status, content_source from channel.listings where shop_id = $1', [shopId]);
    expect(rows).toEqual([{ variant_id: v.id, seller_sku: `ONE-${t}`, status: 'live', content_source: 'platform' }]);
  });

  it('AC-3: nhiều SKU cùng sản phẩm sàn → một sản phẩm cha, trục "Phân loại" theo nhãn; nhãn trống thì SKU', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [
      sku('b1', `p-${t}`, `CUP-W-${t}`, `Cốc sứ ${t} - Trắng`, { variantLabel: 'Trắng' }),
      sku('b2', `p-${t}`, `CUP-B-${t}`, `Cốc sứ ${t} - Đen`, { variantLabel: 'Đen' }),
      sku('b3', `p-${t}`, `CUP-X-${t}`, `Cốc sứ ${t}`),
    ];
    const { setup } = await connectingShop(c);
    const res = await setup({ decisions: ['b1', 'b2', 'b3'].map(create), createGroupId: await groupOf(c.companyId) });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(3);
    const rows = await variantsOf(c.companyId, [`CUP-W-${t}`, `CUP-B-${t}`, `CUP-X-${t}`]);
    expect(new Set(rows.map((r) => r.product_id)).size).toBe(1);
    expect(rows[0].name).toBe(`Cốc sứ ${t}`);
    const { rows: values } = await testPool().query(
      `select v.sku, av.value, a.name as attr from product.variant_attribute_values vav
         join product.product_variants v on v.id = vav.variant_id
         join product.attribute_values av on av.id = vav.attribute_value_id
         join product.attributes a on a.id = av.attribute_id
        where v.product_id = $1 order by v.sku`,
      [rows[0].product_id],
    );
    expect(values).toEqual([
      { sku: `CUP-B-${t}`, value: 'Đen', attr: 'Phân loại' },
      { sku: `CUP-W-${t}`, value: 'Trắng', attr: 'Phân loại' },
      { sku: `CUP-X-${t}`, value: `CUP-X-${t}`, attr: 'Phân loại' },
    ]);
  });

  it('AC-7: tên trùng sản phẩm đã có (dòng đang có gợi ý theo tên vẫn tạo được) → thêm " (<SKU đầu>)"', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    const existing = await createVariant(c.companyId, { sku: `OLD-${t}` });
    const { rows } = await testPool().query('select name, code from product.products where id = $1', [existing.productId]);
    remote = [sku('c1', `p-${t}`, rows[0].code, rows[0].name)];
    // SKU người bán trùng mã cha có sẵn (không trùng SKU) để thử cả hậu tố mã cha `-2`.
    const { preview, setup } = await connectingShop(c);
    expect(ShopSetupPreview.parse((await preview()).body).suggestions[0]).toMatchObject({ match: 'name', canCreate: true });
    const r7 = await setup({ decisions: [create('c1')], createGroupId: await groupOf(c.companyId) });
    expect(r7.body).toMatchObject({ created: 1 });
    const [v] = await variantsOf(c.companyId, [rows[0].code]);
    expect(v.name).toBe(`${rows[0].name} (${rows[0].code})`);
    expect(v.code).toBe(`${rows[0].code}-2`);
  });

  it('AC-10, AC-11: nhật ký create product.products có gian hàng nguồn; spec_from_match mang listing vừa tạo', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [sku('d1', `p-${t}`, `AUD-${t}`, `Túi vải ${t}`)];
    const { shopId, setup } = await connectingShop(c);
    expect((await setup({ decisions: [create('d1')], createGroupId: await groupOf(c.companyId) })).status).toBe(200);
    const [v] = await variantsOf(c.companyId, [`AUD-${t}`]);
    const audit = await testPool().query(
      "select actor_id, after from core.audit_logs where entity_type = 'product.products' and entity_id = $1 and action = 'create'",
      [v.product_id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).not.toBeNull();
    expect(audit.rows[0].after.fromShop).toEqual({ id: shopId, name: 'Shop thử' });
    const { rows: listing } = await testPool().query('select id from channel.listings where shop_id = $1', [shopId]);
    const jobs = await testPool().query(
      "select data->'listingIds' as ids from pgboss.job where name = 'channel.spec_from_match' and data->>'shopId' = $1",
      [shopId],
    );
    expect(jobs.rows.flatMap((r) => r.ids)).toContain(listing[0].id);
  });
});

const FEE = { fixedPct: 4, transactionPct: '5.2', servicePct: 3, optionalPct: 2, returnFee: 0, perItemFee: 1500, roundStep: 1, roundEnding: 0 };
async function activeFee(companyId: string, shopId: string) {
  await testPool().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, 'fee', $2, 'active', $3, '2026-10-01', $4, $5, now())`,
    [companyId, shopId, JSON.stringify(FEE), randomUUID(), randomUUID()],
  );
}

describe('giá của SKU tạo từ sàn (Thành chốt 20/11/2026)', () => {
  it('giá chuẩn = giá sàn; giá muốn bán tính ngược theo phí, bộ lọc ra đúng giá sàn; không bản chờ, không sự kiện đổi giá', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [sku('k1', `p-${t}`, `PRC-${t}`, `Áo len ${t}`, { price: '61300' })];
    const { shopId, setup } = await connectingShop(c);
    await activeFee(c.companyId, shopId);
    expect((await setup({ decisions: [create('k1')], createGroupId: await groupOf(c.companyId) })).status).toBe(200);
    const [v] = await variantsOf(c.companyId, [`PRC-${t}`]);
    const { rows } = await testPool().query('select standard_price, target_net_price from product.product_variants where id = $1', [v.id]);
    expect(rows[0].standard_price).toBe('61300.00');
    const fee = { feePct: '14.2', perItemFee: 1500, roundStep: 1, roundEnding: 0 };
    expect(rows[0].target_net_price).toBe(new Decimal(targetForPrice('61300', fee, 0)!).toFixed(2));
    const again = priceFilter({ target: rows[0].target_net_price, fee, taxPct: 0, cost: null, minMarginPct: 0 });
    expect(again).toMatchObject({ ok: true, price: '61300' });
    const pending = await testPool().query('select count(*)::int as n from channel.price_calculations where variant_id = $1', [v.id]);
    expect(pending.rows[0].n).toBe(0);
    const events = await testPool().query(
      "select count(*)::int as n from core.outbox_messages where type = 'catalog.variant_price_changed' and payload->>'variantId' = $1",
      [v.id],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it('gian hàng chưa có phí: giá muốn bán null, giá chuẩn vẫn là giá sàn', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [sku('l1', `p-${t}`, `NOF-${t}`, `Áo len ${t}`, { price: '99000' })];
    const { setup } = await connectingShop(c);
    expect((await setup({ decisions: [create('l1')], createGroupId: await groupOf(c.companyId) })).status).toBe(200);
    const { rows } = await testPool().query(
      'select standard_price, target_net_price from product.product_variants where company_id = $1 and sku = $2',
      [c.companyId, `NOF-${t}`],
    );
    expect(rows[0]).toEqual({ standard_price: '99000.00', target_net_price: null });
  });
});

describe('lỗi theo dòng (AC-4, AC-5, AC-6) và quyền', () => {
  it('AC-4, AC-6: không SKU người bán, create kèm variantId, trùng SKU người bán, thiếu nhóm → 422, không ghi gì', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    const other = await createVariant(c.companyId, { sku: `OTH-${t}` });
    remote = [
      sku('e1', `p-${t}`, '', 'Không SKU'),
      sku('e2', `q-${t}`, `DUP-${t}`, 'Một'),
      sku('e3', `r-${t}`, `DUP-${t}`, 'Hai'),
      sku('e4', `s-${t}`, `OK-${t}`, 'Ba'),
    ];
    const { shopId, setup } = await connectingShop(c);
    const res = await setup({
      decisions: [create('e1'), create('e2'), create('e3'), { externalSkuId: 'e4', variantId: other.variantId, create: true }],
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['createGroupId', 'decisions.0', 'decisions.2', 'decisions.3']);
    expect(res.body.errors['decisions.2']).toBe('Hai SKU sàn cùng SKU người bán');
    expect(await variantsOf(c.companyId, [`DUP-${t}`, `OK-${t}`])).toEqual([]);
    const { rows } = await testPool().query('select status from channel.shops where id = $1', [shopId]);
    expect(rows[0].status).toBe('connecting');
  });

  it('AC-6: nhóm hàng của công ty khác → 422 errors.createGroupId', async () => {
    const c = await createCompany({ optionalModules: [] });
    const other = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [sku('f1', `p-${t}`, `GRP-${t}`, 'Áo')];
    const { setup } = await connectingShop(c);
    const res = await setup({ decisions: [create('f1')], createGroupId: await privateGroupOf(other.companyId) });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ createGroupId: 'Danh mục sản phẩm không thuộc công ty' });
    expect(await variantsOf(c.companyId, [`GRP-${t}`])).toEqual([]);
  });

  it('AC-5: gian hàng thứ hai thấy gợi ý `sku` trỏ vào biến thể tạo từ gian hàng thứ nhất; gửi create thì 422', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [sku('g1', `p-${t}`, `TWO-${t}`, 'Nón lá')];
    const first = await connectingShop(c);
    expect((await first.setup({ decisions: [create('g1')], createGroupId: await groupOf(c.companyId) })).status).toBe(200);
    const [v] = await variantsOf(c.companyId, [`TWO-${t}`]);
    const second = await connectingShop(c, c.ceo.token, false);
    const item = ShopSetupPreview.parse((await second.preview()).body).suggestions[0]!;
    expect(item).toMatchObject({ match: 'sku', variantId: v.id, canCreate: false });
    const res = await second.setup({ decisions: [create('g1')], createGroupId: await groupOf(c.companyId) });
    expect(res.status).toBe(422);
    expect(res.body.errors['decisions.0']).toBeDefined();
    expect((await second.setup({ decisions: [{ externalSkuId: 'g1', variantId: v.id }] })).status).toBe(200);
  });

  it('thiếu catalog.product.manage: canCreate false lý do no_permission; POST create 403, không ghi gì', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [sku('h1', `p-${t}`, `PRM-${t}`, 'Khăn')];
    const roleId = await createCustomRole(c.companyId, ['channel.shop.connect', 'channel.shop.view', 'catalog.product.view']);
    const member = await addMember(c.companyId, roleId);
    const { shopId, preview, setup } = await connectingShop(c, member.token);
    const item = ShopSetupPreview.parse((await preview()).body).suggestions[0]!;
    expect(item).toMatchObject({ canCreate: false, cannotCreateReason: 'no_permission' });
    const res = await setup({ decisions: [create('h1')], createGroupId: await groupOf(c.companyId) });
    expect(res.status).toBe(403);
    expect(await variantsOf(c.companyId, [`PRM-${t}`])).toEqual([]);
    const { rows } = await testPool().query('select count(*)::int as n from channel.listings where shop_id = $1', [shopId]);
    expect(rows[0].n).toBe(0);
  });
});

describe('giao dịch và kiểm kê đầu kỳ (AC-8, AC-9)', () => {
  it('AC-8: lập phiếu đầu kỳ ném lỗi → không còn sản phẩm, biến thể, listing; gian hàng vẫn connecting', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [sku('i1', `p-${t}`, `RBK-${t}`, `Dép ${t}`)];
    setStocktakePort({
      createOpeningStocktake: async () => {
        throw new Error('hỏng giữa chừng');
      },
      openingStocktakeStatusOf: async () => new Map(),
    });
    const { shopId, setup } = await connectingShop(c, c.ceo.token, false);
    const res = await setup({ decisions: [create('i1')], createGroupId: await groupOf(c.companyId), openingStock: 'stocktake' });
    expect(res.status).toBe(500);
    expect(await variantsOf(c.companyId, [`RBK-${t}`])).toEqual([]);
    const { rows: products } = await testPool().query('select count(*)::int as n from product.products where company_id = $1 and name = $2', [
      c.companyId,
      `Dép ${t}`,
    ]);
    expect(products[0].n).toBe(0);
    const { rows } = await testPool().query(
      'select s.status, (select count(*)::int from channel.listings l where l.shop_id = s.id) as n from channel.shops s where s.id = $1',
      [shopId],
    );
    expect(rows[0]).toEqual({ status: 'connecting', n: 0 });
  });

  it('AC-9: phiếu kiểm kê đầu kỳ có dòng của biến thể vừa tạo', async () => {
    const c = await createCompany({ optionalModules: [] });
    const t = tag();
    remote = [sku('j1', `p-${t}`, `STK-${t}`, `Ví ${t}`)];
    const { setup } = await connectingShop(c, c.ceo.token, false);
    const res = await setup({ decisions: [create('j1')], createGroupId: await groupOf(c.companyId), openingStock: 'stocktake' });
    expect(res.status).toBe(200);
    expect(res.body.stocktakeNumber).toBeTruthy();
    const [v] = await variantsOf(c.companyId, [`STK-${t}`]);
    const { rows } = await testPool().query(
      `select count(*)::int as n from product.stock_document_lines l join product.stock_documents d on d.id = l.document_id
        where d.company_id = $1 and d.number = $2 and l.variant_id = $3`,
      [c.companyId, res.body.stocktakeNumber, v.id],
    );
    expect(rows[0].n).toBe(1);
  });
});
