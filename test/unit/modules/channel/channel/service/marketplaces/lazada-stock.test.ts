// Tồn Lazada (#223): đọc số bán được để đối chiếu, đẩy tồn bằng UpdateSellableQuantity, mã khoá do chiến dịch.
// Số liệu rút từ GetProducts `options=1` gọi thật trên shop thử ngày 12/11/2026 (request_id d742e42a17944720668581466).
import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

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

describe('Lazada: số bán được để đối chiếu tồn (#223)', () => {
  it('getSkus gửi options=1, sellableQuantity lấy sellableStock (tồn tổng 99, chiếm 2 → 97)', async () => {
    const fn = fakeFetch({ code: '0', data: { products: [{ item_id: 1, status: 'Active', attributes: { name: 'Bình' }, skus: [realSku] }] } });
    const [sku] = await createLazadaAdapter(config, fn).getSkus('t', ['SKU_NGHIATESTNE_0032']);
    expect(sent(fn).query.options).toBe('1');
    expect(sku).toMatchObject({ quantity: 97, sellableQuantity: 97 });
  });

  it('sàn không trả sellableStock thì không có sellableQuantity (không đối chiếu SKU đó)', async () => {
    const fn = fakeFetch({ code: '0', data: { products: [{ item_id: 1, status: 'Active', skus: [{ SkuId: 1, SellerSku: 'A', quantity: 3 }] }] } });
    const [sku] = await createLazadaAdapter(config, fn).getSkus('t', ['A']);
    expect(sku!.sellableQuantity).toBeUndefined();
  });
});

describe('Lazada: đẩy tồn bằng UpdateSellableQuantity, giá bằng UpdatePriceQuantity (#223)', () => {
  it('tồn đi /product/stock/sellable/update với SellableQuantity; giá đi /product/price_quantity/update chỉ có Price', async () => {
    const fn = fakeFetch({ code: '0', data: {} }, { code: '0', data: {} });
    const results = await createLazadaAdapter(config, fn).updatePriceQuantity('t', [
      { externalProductId: 'I1', externalSkuId: 'S1', price: '1000', quantity: 4 },
      { externalProductId: 'I2', externalSkuId: 'S2', price: '2000' },
    ]);
    expect(results).toEqual([
      { externalSkuId: 'S1', ok: true, stock: { ok: true }, price: { ok: true } },
      { externalSkuId: 'S2', ok: true, price: { ok: true } },
    ]);
    expect(sent(fn, 0)).toMatchObject({ path: '/rest/product/stock/sellable/update' });
    expect(sent(fn, 0).body.payload).toBe(
      '<Request><Product><Skus><Sku><ItemId>I1</ItemId><SkuId>S1</SkuId><SellableQuantity>4</SellableQuantity></Sku></Skus></Product></Request>',
    );
    expect(sent(fn, 1)).toMatchObject({ path: '/rest/product/price_quantity/update' });
    expect(sent(fn, 1).body.payload).toBe(
      '<Request><Product><Skus><Sku><ItemId>I1</ItemId><SkuId>S1</SkuId><Price>1000</Price></Sku><Sku><ItemId>I2</ItemId><SkuId>S2</SkuId><Price>2000</Price></Sku></Skus></Product></Request>',
    );
  });

  it('SKU có cả giá và tồn: tồn lỗi, giá lên sàn → kết quả riêng từng phần (giá không thành lỗi)', async () => {
    const fn = fakeFetch(
      { code: '501', type: 'ISP', message: 'E501: Update product failed', detail: [{ code: 'E0501', message: 'lỗi tồn' }] },
      { code: '0', data: {} },
    );
    const [r] = await createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', price: '1000', quantity: 4 }]);
    expect(r).toEqual({
      externalSkuId: 'S1',
      ok: false,
      code: 'E0501',
      message: 'lỗi tồn',
      stock: { ok: false, code: 'E0501', message: 'lỗi tồn' },
      price: { ok: true },
    });
  });

  it('giá lỗi, tồn lên sàn → `stock` ok, `price` mang lỗi của giá', async () => {
    const fn = fakeFetch(
      { code: '0', data: {} },
      { code: '501', type: 'ISP', message: 'E501: Update product failed', detail: [{ code: 'E0502', message: 'giá sai' }] },
    );
    const [r] = await createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', price: '1000', quantity: 4 }]);
    expect(r).toMatchObject({ stock: { ok: true }, price: { ok: false, code: 'E0502', message: 'giá sai' } });
  });

  it('chỉ có tồn thì không gọi UpdatePriceQuantity', async () => {
    const fn = fakeFetch({ code: '0', data: {} });
    await createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', quantity: 0 }]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent(fn).path).toBe('/rest/product/stock/sellable/update');
  });
});

describe('Lazada: tồn bị khoá do chiến dịch (#223, 25 §6.5 bước 3)', () => {
  it('mã 4170 (chiến dịch cấm giảm tồn) → promotion_locked, giữ câu của sàn', async () => {
    const message =
      'During the Bday Mega campaign, there are restrictions for stock adjustments in effect between 2026-11-10 00:00:00 - 2026-11-12 23:59:59. Sellers can increase stocks, but may not decrease stocks.';
    const fn = fakeFetch({ code: '501', type: 'ISP', message: 'E501: Update product failed', detail: [{ code: '4170', message }] });
    const [r] = await createLazadaAdapter(config, fn).updatePriceQuantity('t', [{ externalProductId: 'I1', externalSkuId: 'S1', quantity: 1 }]);
    expect(r).toEqual({ externalSkuId: 'S1', ok: false, code: 'promotion_locked', message, stock: { ok: false, code: 'promotion_locked', message } });
  });
});
