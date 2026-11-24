// Tồn Lazada (#223): đọc số bán được để đối chiếu, đẩy tồn bằng UpdateSellableQuantity, mã khoá do chiến dịch.
// Số liệu rút từ GetProducts `options=1` gọi thật trên shop thử ngày 12/11/2026 (request_id d742e42a17944720668581466).
// #430: app chỉ quản kho bán mặc định của người bán; đọc và đẩy tồn theo đúng kho đó.
import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter, lazadaWarehouses } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function fakeFetch(...bodies: unknown[]) {
  const fn = vi.fn<typeof fetch>();
  for (const b of bodies) fn.mockResolvedValueOnce(json(b));
  return fn;
}
function sent(fn: ReturnType<typeof fakeFetch>, i = 0) {
  const [url, init] = fn.mock.calls[i] ?? [];
  const u = new URL(String(url));
  const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  return { path: u.pathname, query: Object.fromEntries(u.searchParams), body };
}

/** SKU thật: tồn tổng 99, bị đơn chiếm 2, bán được 97 (`quantity` = `Available` = `sellableStock`). */
const realSku = {
  Status: 'active',
  SellerSku: 'SKU_NGHIATESTNE_0032',
  SkuId: 12345,
  quantity: 97,
  Available: 97,
  sellableStock: 97,
  occupiedStock: 2,
  withholdingStock: 0,
  multiWarehouseInventories: [
    { warehouseCode: 'dropshipping', totalQuantity: 99, occupyQuantity: 2, withholdQuantity: 0, sellableQuantity: 97, quantity: 97 },
    { warehouseCode: 'VN33WH4M4S-WH-10002', totalQuantity: 0, occupyQuantity: 0, withholdQuantity: 0, sellableQuantity: 0, quantity: 0 },
  ],
};

/**
 * Kho của người bán (GetWarehouseBySellerId `/rc/warehouse/get`): kho bán mặc định `dropshipping`, một kho bán thêm, kho
 * nhận hàng trả `customerreturn` (sàn cũng đánh `defaultAddress`), một kho đã ngừng.
 */
const warehouses = {
  code: '0',
  result: {
    module: [
      { code: 'dropshipping', name: 'Kho mặc định', detailAddress: 'Q1', defaultAddress: true, status: 'ACTIVE' },
      { code: 'VN33WH4M4S-WH-10002', name: 'Kho 2', detailAddress: 'Q7', defaultAddress: false, status: 'ACTIVE' },
      { code: 'customerreturn', name: 'Kho trả', defaultAddress: true, status: 'ACTIVE' },
      { code: 'OLD', name: 'Kho cũ', defaultAddress: false, status: 'INACTIVE' },
    ],
  },
};
const timeout = { code: 'ServiceTimeout', type: 'ISP', message: 'x' };
const product = (sku: unknown) => ({ code: '0', data: { products: [{ item_id: 1, status: 'Active', attributes: { name: 'Bình' }, skus: [sku] }] } });

describe('Lazada: kho app quản (#430)', () => {
  it('kho bán mặc định là kho app quản; kho trả không quản, kho ngừng không hiện', () => {
    expect(lazadaWarehouses(warehouses.result.module)).toEqual([
      { code: 'dropshipping', name: 'Kho mặc định', address: 'Q1', kind: 'sales', isDefault: true, managed: true },
      { code: 'VN33WH4M4S-WH-10002', name: 'Kho 2', address: 'Q7', kind: 'sales', isDefault: false, managed: false },
      { code: 'customerreturn', name: 'Kho trả', address: null, kind: 'return', isDefault: true, managed: false },
    ]);
  });

  it('không kho bán nào mặc định thì quản dropshipping', () => {
    const rows = [
      { code: 'A', name: 'A', defaultAddress: false, status: 'ACTIVE' },
      { code: 'dropshipping', name: 'D', defaultAddress: false, status: 'ACTIVE' },
    ];
    expect(lazadaWarehouses(rows).filter((w) => w.managed).map((w) => w.code)).toEqual(['dropshipping']);
  });

  it('listWarehouses trả mọi kho đang dùng, đánh dấu kho app quản', async () => {
    const fn = fakeFetch(warehouses);
    const list = await createLazadaAdapter(config, fn).listWarehouses!('t');
    expect(sent(fn).path).toBe('/rest/rc/warehouse/get');
    expect(list.map((w) => [w.code, w.managed])).toEqual([
      ['dropshipping', true],
      ['VN33WH4M4S-WH-10002', false],
      ['customerreturn', false],
    ]);
  });
});

describe('Lazada: số bán được để đối chiếu tồn (#223)', () => {
  it('getSkus gửi options=1, sellableQuantity là số của kho app quản (tồn 99, chiếm 2 → 97)', async () => {
    const fn = fakeFetch(product(realSku), warehouses);
    const [sku] = await createLazadaAdapter(config, fn).getSkus('t', ['SKU_NGHIATESTNE_0032']);
    expect(sent(fn).query.options).toBe('1');
    expect(sent(fn, 1).path).toBe('/rest/rc/warehouse/get');
    expect(sku).toMatchObject({ quantity: 97, sellableQuantity: 97 });
  });

  it('#430 KB-LZ-B01: kho mặc định 46, kho khác 90 → 46, không lấy tổng 136', async () => {
    const sku = {
      ...realSku,
      sellableStock: 136,
      multiWarehouseInventories: [
        { warehouseCode: 'dropshipping', sellableQuantity: 46 },
        { warehouseCode: 'VN33WH4M4S-WH-10002', sellableQuantity: 90 },
      ],
    };
    const fn = fakeFetch(product(sku), warehouses);
    const [got] = await createLazadaAdapter(config, fn).getSkus('t', ['SKU_NGHIATESTNE_0032']);
    expect(got!.sellableQuantity).toBe(46);
  });

  it('#430: SKU chỉ có hàng ở kho khác thì kho app quản là 0', async () => {
    const sku = { ...realSku, sellableStock: 7, multiWarehouseInventories: [{ warehouseCode: 'VN33WH4M4S-WH-10002', sellableQuantity: 7 }] };
    const fn = fakeFetch(product(sku), warehouses);
    const [got] = await createLazadaAdapter(config, fn).getSkus('t', ['SKU_NGHIATESTNE_0032']);
    expect(got!.sellableQuantity).toBe(0);
  });

  it('#430: không đọc được danh sách kho thì không trả sellableQuantity (không so với tổng mọi kho)', async () => {
    const fn = fakeFetch(product(realSku), timeout);
    const [got] = await createLazadaAdapter(config, fn).getSkus('t', ['SKU_NGHIATESTNE_0032']);
    expect(got!.sellableQuantity).toBeUndefined();
  });

  it('#430: SKU không có mảng kho thì không gọi danh sách kho, lấy sellableStock', async () => {
    const fn = fakeFetch(product({ SkuId: 1, SellerSku: 'A', quantity: 3, sellableStock: 3 }));
    const [got] = await createLazadaAdapter(config, fn).getSkus('t', ['A']);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(got!.sellableQuantity).toBe(3);
  });

  it('sàn không trả sellableStock thì không có sellableQuantity (không đối chiếu SKU đó)', async () => {
    const fn = fakeFetch({ code: '0', data: { products: [{ item_id: 1, status: 'Active', skus: [{ SkuId: 1, SellerSku: 'A', quantity: 3 }] }] } });
    const [sku] = await createLazadaAdapter(config, fn).getSkus('t', ['A']);
    expect(sku!.sellableQuantity).toBeUndefined();
  });
});

describe('Lazada: món xuất từ kho app không quản (#430)', () => {
  const order = { order_id: 9, created_at: '2026-11-18 10:00:00 +0700', updated_at: '2026-11-18 10:00:00 +0700', statuses: ['pending'] };
  const item = (id: number, warehouse?: string) => ({
    order_item_id: id,
    order_id: 9,
    sku: `SKU-${id}`,
    shop_sku: `1_${id}`,
    status: 'pending',
    item_price: 1000,
    paid_price: 1000,
    ...(warehouse !== undefined && { warehouse_code: warehouse }),
  });

  it('getOrder bỏ món của kho khác, giữ món kho app quản', async () => {
    const fn = fakeFetch({ code: '0', data: order }, { code: '0', data: [item(1, 'dropshipping'), item(2, 'VN33WH4M4S-WH-10002')] }, warehouses);
    const got = await createLazadaAdapter(config, fn).getOrder!('t', '9');
    expect(got.lines.map((l) => l.sellerSku)).toEqual(['SKU-1']);
  });

  it('món không ghi kho thì giữ, không gọi danh sách kho', async () => {
    const fn = fakeFetch({ code: '0', data: order }, { code: '0', data: [item(1), item(2)] });
    const got = await createLazadaAdapter(config, fn).getOrder!('t', '9');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(got.lines).toHaveLength(2);
  });

  it('không đọc được danh sách kho thì giữ mọi món (không bỏ đơn vì lỗi sàn)', async () => {
    const fn = fakeFetch({ code: '0', data: order }, { code: '0', data: [item(1, 'dropshipping'), item(2, 'VN33WH4M4S-WH-10002')] }, timeout);
    const got = await createLazadaAdapter(config, fn).getOrder!('t', '9');
    expect(got.lines).toHaveLength(2);
  });
});

describe('Lazada: đẩy tồn bằng UpdateSellableQuantity, giá bằng UpdatePriceQuantity (#223)', () => {
  it('tồn ghi vào kho app quản; giá đi /product/price_quantity/update chỉ có Price', async () => {
    const fn = fakeFetch(warehouses, { code: '0', data: {} }, { code: '0', data: {} });
    const results = await createLazadaAdapter(config, fn).updatePriceQuantity('t', [
      { externalProductId: 'I1', externalSkuId: 'S1', price: '1000', quantity: 4 },
      { externalProductId: 'I2', externalSkuId: 'S2', price: '2000' },
    ]);
    expect(results).toEqual([
      { externalSkuId: 'S1', ok: true, stock: { ok: true }, price: { ok: true } },
      { externalSkuId: 'S2', ok: true, price: { ok: true } },
    ]);
    // #430: mẫu "multi warehouse demo" của UpdateSellableQuantity; kho khác không liệt kê nên sàn giữ nguyên.
    expect(sent(fn, 0).path).toBe('/rest/rc/warehouse/get');
    expect(sent(fn, 1)).toMatchObject({ path: '/rest/product/stock/sellable/update' });
    expect(sent(fn, 1).body.payload).toBe(
      '<Request><Product><Skus><Sku><ItemId>I1</ItemId><SkuId>S1</SkuId><MultiWarehouseInventories><MultiWarehouseInventory><WarehouseCode>dropshipping</WarehouseCode><SellableQuantity>4</SellableQuantity></MultiWarehouseInventory></MultiWarehouseInventories></Sku></Skus></Product></Request>',
    );
    expect(sent(fn, 2)).toMatchObject({ path: '/rest/product/price_quantity/update' });
    expect(sent(fn, 2).body.payload).toBe(
      '<Request><Product><Skus><Sku><ItemId>I1</ItemId><SkuId>S1</SkuId><Price>1000</Price></Sku><Sku><ItemId>I2</ItemId><SkuId>S2</SkuId><Price>2000</Price></Sku></Skus></Product></Request>',
    );
  });

  it('#430: không đọc được danh sách kho thì tồn gửi SellableQuantity trơn', async () => {
    const fn = fakeFetch(timeout, { code: '0', data: {} });
    await createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', quantity: 4 }]);
    expect(sent(fn, 1).body.payload).toBe(
      '<Request><Product><Skus><Sku><ItemId>I1</ItemId><SkuId>S1</SkuId><SellableQuantity>4</SellableQuantity></Sku></Skus></Product></Request>',
    );
  });

  it('#430: danh sách kho giữ trong tiến trình, lần đẩy sau không gọi lại', async () => {
    const ok = { code: '0', data: {} };
    const fn = fakeFetch(warehouses, ok, ok);
    const adapter = createLazadaAdapter(config, fn);
    await adapter.updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', quantity: 1 }]);
    await adapter.updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', quantity: 2 }]);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sent(fn, 2).path).toBe('/rest/product/stock/sellable/update');
  });

  it('SKU có cả giá và tồn: tồn lỗi, giá lên sàn → kết quả riêng từng phần (giá không thành lỗi)', async () => {
    const fn = fakeFetch(
      warehouses,
      { code: '501', type: 'ISP', message: 'E501: Update product failed', detail: [{ code: 'E0501', message: 'lỗi tồn' }] },
      { code: '0', data: {} },
    );
    const [r] = await createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', price: '1000', quantity: 4 }]);
    expect(r).toEqual({
      externalSkuId: 'S1',
      ok: false,
      code: 'E0501',
      message: 'lỗi tồn',
      // Phản hồi giả không có `request_id`: null (#571).
      requestId: null,
      stock: { ok: false, code: 'E0501', message: 'lỗi tồn', requestId: null },
      price: { ok: true },
    });
  });

  it('giá lỗi, tồn lên sàn → `stock` ok, `price` mang lỗi của giá', async () => {
    const fn = fakeFetch(
      warehouses,
      { code: '0', data: {} },
      { code: '501', type: 'ISP', message: 'E501: Update product failed', detail: [{ code: 'E0502', message: 'giá sai' }] },
    );
    const [r] = await createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', price: '1000', quantity: 4 }]);
    expect(r).toMatchObject({ stock: { ok: true }, price: { ok: false, code: 'E0502', message: 'giá sai' } });
  });

  it('chỉ có tồn thì không gọi UpdatePriceQuantity', async () => {
    const fn = fakeFetch(warehouses, { code: '0', data: {} });
    await createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', quantity: 0 }]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sent(fn, 1).path).toBe('/rest/product/stock/sellable/update');
  });
});

describe('Lazada: tồn bị khoá do chiến dịch (#223, 25 §6.5 bước 3)', () => {
  it('mã 4170 (chiến dịch cấm giảm tồn) trả nguyên mã, câu, request_id của sàn; dịch ở errorMap (#571)', async () => {
    const message =
      'During the Bday Mega campaign, there are restrictions for stock adjustments in effect between 2026-11-10 00:00:00 - 2026-11-12 23:59:59. Sellers can increase stocks, but may not decrease stocks.';
    const fn = fakeFetch(warehouses, { code: '501', type: 'ISP', message: 'E501: Update product failed', request_id: 'rq-4170', detail: [{ code: '4170', message }] });
    const [r] = await createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', quantity: 1 }]);
    const part = { ok: false, code: '4170', message, requestId: 'rq-4170' };
    expect(r).toEqual({ externalSkuId: 'S1', ...part, stock: part });
  });
});
