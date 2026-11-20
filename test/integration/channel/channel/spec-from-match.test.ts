// Ghép SKU dựng spec từ category trên sàn (#400 lát 12, Documents/19 mục 3.3): việc nền `channel.spec_from_match` đọc
// category và attribute của sản phẩm trên sàn (ngoài giao dịch), luôn ghi `listings.external_category_id` (không tăng
// `version`), sản phẩm chưa có spec của sàn thì tạo spec `source = 'match'`, `version = 1`, trục `__custom`, attribute đổi sang
// mã lựa chọn của leaf; spec có sẵn giữ nguyên. Việc xếp cùng giao dịch ghép (ghép tay có hiệu lực, CEO duyệt, thiết lập).
// #497: điền trường dùng chung đang trống qua cổng `fillProductFacts` (cả khi spec đã có) và ghi bản sàn đang ghi
// (`remote_facts`), bản đọc sau thắng.
import { randomInt, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Decimal } from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { replaceLeaf } from '#src/modules/channel/channel/repository/platform-categories.ts';
import { MarketplaceError, type RemoteProductCategory, type RemoteProductFacts } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, type ProductPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { runSpecFromMatch, sendSpecFromMatch } from '#src/modules/channel/channel/service/spec-from-match.ts';
import { setRemoteImageOptions } from '#src/modules/core/files/service/remote-images.ts';
import { setPutObject } from '#src/modules/core/files/service/storage.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { withCompany } from '#src/shared/db/client.ts';
import request from 'supertest';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const variants: ListingVariant[] = [];
const port: ProductPort = {
  variants: async (ids, opts) => variants.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  productImageUrls: async () => new Map(),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 5])),
  fillProductFacts: vi.fn(async () => ({ filled: [] })),
};
setProductPort(port);

const leaf = String(randomInt(800_000_000, 900_000_000));
const attr = (code: string, input: PlatformAttribute['input'], options: { id: string; label: string }[], extra: Partial<PlatformAttribute> = {}): PlatformAttribute => ({
  code,
  label: code,
  kind: 'property',
  input,
  options,
  allowCustom: false,
  required: false,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw: {},
  ...extra,
});
const NO_FACTS: RemoteProductFacts = { brand: null, description: null, imageUrls: [], sizeChartUrl: null, skus: [] };
const remote = new Map<string, Omit<RemoteProductCategory, 'facts'> & { facts?: RemoteProductFacts }>();
const productCategory = vi.fn(async (_t: string, externalProductId: string): Promise<RemoteProductCategory | null> => {
  const r = remote.get(externalProductId);
  return r ? { facts: NO_FACTS, ...r } : null;
});
registerAdapter(
  'lazada',
  fakeAdapter({
    getSeller: async (accessToken) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' }),
    categoriesNeedToken: false,
    productCategory,
    productFields: { brand: 'brand', country_origin_hb: 'originCountry' },
    defaultBrand: 'No Brand',
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

let companyId: string;
let shopId: string;

function variant(attributes: ListingVariant['attributes'] = []) {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Bình giữ nhiệt',
    sku: `SM-${randomUUID().slice(0, 8)}`,
    attributesLabel: '',
    productCode: 'SP-TEST',
    groupId: 'GROUP-TEST',
    attributes,
    archived: false,
    businessStatus: 'selling',
    description: null,
    weightG: 200,
    lengthMm: 100,
    widthMm: 100,
    heightMm: 100,
  };
  variants.push(v);
  return v;
}
async function listing(variantId: string | null, externalProductId: string | null, externalSkuId?: string) {
  const id = randomUUID().slice(0, 8);
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, mode, external_sku_id, external_product_id, seller_sku, status, content_source, approved_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'live', 'platform', $8) returning id`,
    [companyId, shopId, variantId, variantId ? 'mapped' : 'unmanaged', externalSkuId ?? `sku-${id}`, externalProductId, `LZ-${id}`, variantId ? null : randomUUID()],
  );
  return rows[0]!.id;
}
const run = (listingIds: string[]) => runSpecFromMatch(port, { companyId, shopId, listingIds });
const specOf = async (productId: string) =>
  (await testPool().query('select * from channel.product_specs where product_id = $1 and platform = $2', [productId, 'lazada'])).rows[0];
const listingRow = async (id: string) => (await testPool().query('select external_category_id, version from channel.listings where id = $1', [id])).rows[0];

beforeAll(async () => {
  await testPool().query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at)
     values ('lazada', $1, 'Bình', true, 'Nhà cửa > Bình', 'nha cua > binh', now())`,
    [leaf],
  );
  await replaceLeaf('lazada', leaf, {
    attributes: [
      attr('material', 'select', [{ id: '11', label: 'Thép không gỉ' }], { raw: { options: [{ id: 11, name: 'Thép không gỉ', en_name: 'Stainless Steel' }] } }),
      attr('features', 'multiselect', [
        { id: '21', label: 'Giữ nhiệt' },
        { id: '22', label: 'Chống tràn' },
      ]),
      attr('capacity', 'text', []),
      attr('brand', 'select', [{ id: '1', label: 'No Brand' }], { tier: 'product' }),
      attr('color_family', 'select', [{ id: '31', label: 'Trắng' }], { kind: 'sales' }),
    ],
    sizeChartRule: null,
    fetchedAt: new Date(),
  });
  const c = await createCompany({ optionalModules: [] });
  companyId = c.companyId;
  const shop = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${c.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = shop.body.shop.id;
  await activateShop(shopId);
});

beforeEach(() => {
  productCategory.mockClear();
  vi.mocked(port.fillProductFacts!).mockClear();
});

describe('runSpecFromMatch', () => {
  it('chưa có spec: tạo spec match version 1, attribute category đổi sang mã lựa chọn, trục __custom; ghi external_category_id không tăng version', async () => {
    const v = variant([{ attributeId: 'A-COLOR', attributeName: 'Màu', platformKind: null, valueId: 'V1', value: 'Trắng' }]);
    remote.set('item-1', {
      externalCategoryId: leaf,
      attributes: [
        { code: 'material', values: [{ id: null, name: 'Stainless Steel' }] },
        { code: 'features', values: [{ id: null, name: 'Giữ nhiệt' }, { id: null, name: 'Chống tràn' }] },
        { code: 'capacity', values: [{ id: null, name: '750ml' }] },
        { code: 'brand', values: [{ id: null, name: 'No Brand' }] },
        { code: 'color_family', values: [{ id: null, name: 'Trắng' }] },
        { code: 'khong_co', values: [{ id: null, name: 'x' }] },
      ],
    });
    const id = await listing(v.id, 'item-1');
    const before = (await listingRow(id)).version;
    await run([id]);
    const spec = await specOf(v.productId);
    expect(spec).toMatchObject({
      external_category_id: leaf,
      source: 'match',
      version: 1,
      attributes: { material: '11', features: ['21', '22'], capacity: '750ml' },
      axis_map: { 'A-COLOR': '__custom' },
      value_map: {},
      category_status: 'ok',
    });
    expect(await listingRow(id)).toEqual({ external_category_id: leaf, version: before });
  });

  it('spec có sẵn: giữ nguyên, vẫn ghi external_category_id', async () => {
    const v = variant();
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, attributes, source, version)
       values ($1, $2, 'lazada', 'OTHER', '{"a":"b"}', 'push', 3)`,
      [companyId, v.productId],
    );
    remote.set('item-2', { externalCategoryId: leaf, attributes: [{ code: 'material', values: [{ id: null, name: 'Stainless Steel' }] }] });
    const id = await listing(v.id, 'item-2');
    await run([id]);
    expect(await specOf(v.productId)).toMatchObject({ external_category_id: 'OTHER', version: 3, attributes: { a: 'b' }, source: 'push' });
    expect((await listingRow(id)).external_category_id).toBe(leaf);
  });

  it('nhiều listing cùng sản phẩm sàn: gọi sàn một lần; listing "không quản tồn" chỉ ghi cột; listing chưa có mã sàn bỏ qua', async () => {
    const v = variant();
    remote.set('item-3', { externalCategoryId: leaf, attributes: [] });
    const a = await listing(v.id, 'item-3');
    const b = await listing(null, 'item-3');
    const c = await listing(variant().id, null);
    await run([a, b, c]);
    expect(productCategory).toHaveBeenCalledTimes(1);
    expect((await listingRow(b)).external_category_id).toBe(leaf);
    expect((await listingRow(c)).external_category_id).toBeNull();
    expect(await specOf(v.productId)).toMatchObject({ source: 'match', attributes: {} });
  });

  it('sàn không trả category: không ghi gì; sàn lỗi tạm: ném để thử lại', async () => {
    const v = variant();
    const id = await listing(v.id, 'item-none');
    await run([id]);
    expect(await specOf(v.productId)).toBeUndefined();
    productCategory.mockRejectedValueOnce(new MarketplaceError('unavailable'));
    await expect(run([id])).rejects.toBeInstanceOf(MarketplaceError);
  });

  it('sàn từ chối (vd sản phẩm đã xoá): bỏ qua listing đó, không ném', async () => {
    const v = variant();
    const id = await listing(v.id, 'item-gone');
    productCategory.mockRejectedValueOnce(new MarketplaceError('rejected', '207'));
    await expect(run([id])).resolves.toBeUndefined();
  });
});

describe('runSpecFromMatch: tự điền và bản sàn đang ghi (#497)', () => {
  const facts = (skuId: string): RemoteProductFacts => ({
    brand: 'Lock&Lock',
    description: 'Bình giữ nhiệt 500ml',
    imageUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
    sizeChartUrl: null,
    skus: [{ externalSkuId: skuId, weightG: 450, lengthMm: 250, widthMm: 80, heightMm: 80 }],
  });

  it('chưa có spec: gọi fillProductFacts với xuất xứ ISO, cân nặng theo SKU đã ghép; spec lưu remote và nguồn match', async () => {
    const v = variant();
    const skuId = `sku-${randomUUID().slice(0, 8)}`;
    remote.set('item-f1', {
      externalCategoryId: leaf,
      attributes: [
        { code: 'material', values: [{ id: null, name: 'Stainless Steel' }] },
        { code: 'country_origin_hb', values: [{ id: null, name: 'Việt Nam' }] },
      ],
      facts: facts(skuId),
    });
    const id = await listing(v.id, 'item-f1', skuId);
    await run([id]);
    const expected = {
      originCountry: 'VN',
      brand: 'Lock&Lock',
      description: 'Bình giữ nhiệt 500ml',
      sizeChartUrl: null,
      imageUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
      variants: [{ variantId: v.id, weightG: 450, lengthMm: 250, widthMm: 80, heightMm: 80 }],
    };
    // Cổng giả không có `productMediaGaps`: không tải ảnh (#498), id tệp rỗng.
    expect(port.fillProductFacts).toHaveBeenCalledWith(v.productId, { ...expected, imageFileIds: [], sizeChartFileId: null }, { shopId, shopName: 'Shop thử' });
    const spec = await specOf(v.productId);
    expect(spec).toMatchObject({
      attributes: { material: '11' },
      field_sources: { material: 'match' },
      remote_facts: { shopName: 'Shop thử', ...expected },
      remote_shop_id: shopId,
    });
    expect(spec.remote_read_at).toBeInstanceOf(Date);
  });

  it('spec có sẵn: attribute người dùng giữ nguyên, vẫn điền catalog và thêm remote; "No Brand" là không thương hiệu', async () => {
    const v = variant();
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, attributes, field_sources, source, version)
       values ($1, $2, 'lazada', $3, '{"material":"11"}', '{"material":"user"}', 'push', 4)`,
      [companyId, v.productId, leaf],
    );
    remote.set('item-f2', { externalCategoryId: leaf, attributes: [], facts: { ...facts('x'), brand: 'No Brand' } });
    const id = await listing(v.id, 'item-f2');
    await run([id]);
    expect(port.fillProductFacts).toHaveBeenCalledWith(v.productId, expect.objectContaining({ brand: null, variants: [] }), expect.anything());
    expect(await specOf(v.productId)).toMatchObject({
      version: 4,
      attributes: { material: '11' },
      field_sources: { material: 'user' },
      remote_facts: { brand: null, description: 'Bình giữ nhiệt 500ml' },
    });
  });

  it('bản đã lưu đọc sau lần đọc này (gian hàng khác ghép cùng lúc): không đè remote', async () => {
    const v = variant();
    remote.set('item-f3', { externalCategoryId: leaf, attributes: [], facts: facts('y') });
    const id = await listing(v.id, 'item-f3');
    await run([id]);
    const later = new Date(Date.now() + 60_000);
    await testPool().query(
      `update channel.product_specs set remote_read_at = $2, remote_facts = remote_facts || '{"brand":"Bản mới hơn"}' where product_id = $1`,
      [v.productId, later],
    );
    await run([id]);
    const spec = await specOf(v.productId);
    expect(spec.remote_facts.brand).toBe('Bản mới hơn');
    expect(spec.remote_read_at).toEqual(later);
  });

  it('hai lượt ghép chạy song song: không lỗi, remote là bản đọc sau', async () => {
    const v = variant();
    remote.set('item-f4', { externalCategoryId: leaf, attributes: [], facts: facts('z') });
    const id = await listing(v.id, 'item-f4');
    await Promise.all([run([id]), run([id])]);
    const { rows } = await testPool().query('select count(*)::int n, max(remote_read_at) at from channel.product_specs where product_id = $1', [v.productId]);
    expect(rows[0].n).toBe(1);
    expect(rows[0].at).toBeInstanceOf(Date);
  });
});

describe('sendSpecFromMatch', () => {
  it('xếp việc mang danh sách listing, đi chung giao dịch: rollback thì không có việc', async () => {
    const id = randomUUID();
    await withCompany(companyId, () => sendSpecFromMatch(companyId, shopId, [id]));
    await withCompany(companyId, async () => {
      await sendSpecFromMatch(companyId, shopId, [randomUUID()]);
      throw new Error('rollback');
    }).catch(() => {});
    const { rows } = await testPool().query<{ data: { listingIds: string[] } }>(
      "select data from pgboss.job where name = 'channel.spec_from_match' and data->>'shopId' = $1",
      [shopId],
    );
    expect(rows.map((r) => r.data.listingIds)).toEqual([[id]]);
  });
});

describe('ảnh, ảnh bảng size từ sàn (#498)', () => {
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  let server: http.Server;
  let base: string;
  let hits: string[];
  let puts: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url?.startsWith('/ok')) res.writeHead(200, { 'content-type': 'image/jpg' }).end(JPG);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setRemoteImageOptions({ allowAddress: () => true });
    setPutObject(async () => {
      puts++;
    });
  });
  afterAll(async () => {
    delete port.productMediaGaps;
    setRemoteImageOptions(null);
    setPutObject(null);
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    hits = [];
    puts = 0;
  });

  const gaps = (images: boolean, sizeChart: boolean) => {
    port.productMediaGaps = vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, { images, sizeChart }])));
  };
  const withMedia = (item: string) =>
    remote.set(item, {
      externalCategoryId: leaf,
      attributes: [],
      facts: { ...NO_FACTS, imageUrls: [`${base}/ok/1.jpg`, `${base}/mat.jpg`, `${base}/ok/2.jpg`], sizeChartUrl: `${base}/ok/size.jpg` },
    });
  const lastFacts = () => vi.mocked(port.fillProductFacts!).mock.calls.at(-1)![1];

  it('sản phẩm thiếu ảnh, bảng size: tải ảnh sàn về kho, ảnh lỗi bỏ qua, truyền id tệp vào fillProductFacts', async () => {
    gaps(true, true);
    const v = variant();
    withMedia('item-m1');
    await run([await listing(v.id, 'item-m1')]);
    const facts = lastFacts();
    expect(facts.imageFileIds).toHaveLength(2);
    expect(facts.sizeChartFileId).toEqual(expect.any(String));
    expect(puts).toBe(3);
    const { rows } = await testPool().query('select id, content_type from core.files where id = any($1) order by created_at', [[...facts.imageFileIds!, facts.sizeChartFileId]]);
    expect(rows.map((r) => r.content_type)).toEqual(['image/jpeg', 'image/jpeg', 'image/jpeg']);
    expect(await specOf(v.productId)).toBeDefined();
  });

  it('sản phẩm đã có ảnh, bảng size: không tải gì', async () => {
    gaps(false, false);
    const v = variant();
    withMedia('item-m2');
    await run([await listing(v.id, 'item-m2')]);
    expect(lastFacts()).toMatchObject({ imageFileIds: [], sizeChartFileId: null });
    expect(hits).toEqual([]);
  });

  it('hai sản phẩm Commerio ghép cùng sản phẩm sàn: mỗi ảnh tải một lần, dùng chung id tệp', async () => {
    gaps(true, false);
    const [a, b] = [variant(), variant()];
    withMedia('item-m3');
    await run([await listing(a.id, 'item-m3'), await listing(b.id, 'item-m3')]);
    const calls = vi.mocked(port.fillProductFacts!).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1].imageFileIds).toEqual(calls[1]![1].imageFileIds);
    expect(hits.sort()).toEqual(['/mat.jpg', '/ok/1.jpg', '/ok/2.jpg']);
  });
});
