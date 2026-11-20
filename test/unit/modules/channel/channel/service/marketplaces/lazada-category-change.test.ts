import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { lazadaCategoryMismatch, lazadaReactivated, lazadaUnderReview } from '#src/modules/channel/channel/service/marketplaces/lazada-category-change.ts';

const config = { appKey: '1', appSecret: 's', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const sku = (SellerSku: string, extra: Record<string, unknown> = {}) => ({
  SkuId: `id-${SellerSku}`,
  SellerSku,
  price: '100000',
  special_price: '90000',
  Status: 'active',
  ...extra,
});
const item = (skus: unknown[], extra: Record<string, unknown> = {}) => ({
  code: '0',
  data: { item_id: 7, status: 'Active', images: ['a', 'b', 'c'], attributes: { delivery_option_standard: 'Yes', material: 'x' }, skus, ...extra },
});

type Fetch = ReturnType<typeof vi.fn<typeof fetch>>;

function sent(fn: Fetch, i: number) {
  const [url, init] = fn.mock.calls[i] ?? [];
  const u = new URL(String(url));
  const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  return { path: u.pathname, query: Object.fromEntries(u.searchParams), body };
}

function fakeFetch(...bodies: unknown[]): Fetch {
  const fn = vi.fn<typeof fetch>();
  for (const b of bodies) fn.mockResolvedValueOnce(json(b));
  return fn;
}

const OK = { code: '0' };

describe('lazadaCategoryMismatch', () => {
  const before = item([sku('A'), sku('B')]).data;

  it('khớp thì rỗng', () => {
    expect(lazadaCategoryMismatch(before, item([sku('A'), sku('B')]).data)).toEqual([]);
    expect(lazadaCategoryMismatch(before, item([sku('A', { price: '100000.00' }), sku('B')]).data)).toEqual([]);
  });

  it('mất SKU, thêm SKU, đổi giá, đổi giá khuyến mãi, mất ảnh', () => {
    expect(lazadaCategoryMismatch(before, item([sku('A')]).data)).toEqual(['còn 1/2 SKU: thiếu B']);
    expect(lazadaCategoryMismatch(before, item([sku('A'), sku('B'), sku('C')]).data)).toEqual(['còn 3/2 SKU', 'có thêm SKU C']);
    expect(lazadaCategoryMismatch(before, item([sku('A', { price: '1' }), sku('B', { special_price: undefined })]).data)).toEqual([
      'đổi giá SKU A: 100000 → 1',
      'đổi giá khuyến mãi SKU B: 90000 → trống',
    ]);
    expect(lazadaCategoryMismatch(before, item([sku('A'), sku('B')], { images: ['a'] }).data)).toEqual(['còn 1/3 ảnh']);
  });
});

describe('lazadaReactivated, lazadaUnderReview', () => {
  const before = item([sku('A', { Status: 'inactive' }), sku('B')]).data;

  it('chỉ SKU đã tắt mà nay bật', () => {
    const after = item([sku('A'), sku('B')]).data;
    expect(lazadaReactivated(before, after)).toEqual(['id-A']);
    expect(lazadaReactivated(before, after, true)).toEqual(['id-A', 'id-B']);
    expect(lazadaReactivated(before, item([sku('A', { Status: 'inactive' }), sku('B')]).data)).toEqual([]);
  });

  it('chờ duyệt theo status sản phẩm', () => {
    expect(lazadaUnderReview(item([sku('A')], { status: 'Pending QC' }).data)).toBe(true);
    expect(lazadaUnderReview(item([sku('A')]).data)).toBe(false);
    expect(lazadaUnderReview(undefined)).toBe(false);
  });
});

describe('adapter Lazada changeCategory', () => {
  const input = { externalCategoryId: '10100278', attributes: { material: ['Da', 'Vải'] } };
  const run = (fn: Fetch, extra = {}) => createLazadaAdapter(config, fn).changeCategory!('tok', '7', { ...input, ...extra });

  it('chỉ gửi ItemId, PrimaryCategory, Attributes, SkuId; khớp thì không lệch', async () => {
    const skus = [sku('A'), sku('B')];
    // before, deliveryOptions, update, after
    const fn = fakeFetch(item(skus), item(skus), OK, item(skus, { status: 'Pending QC' }));
    expect(await run(fn)).toEqual({ underReview: true, mismatch: [] });
    expect(fn).toHaveBeenCalledTimes(4);
    const update = sent(fn, 2);
    expect(update.path).toBe('/rest/product/update');
    const product = JSON.parse(update.body.payload!).Request.Product;
    expect(Object.keys(product).sort()).toEqual(['Attributes', 'ItemId', 'PrimaryCategory', 'Skus']);
    expect(product.ItemId).toBe('7');
    expect(product.PrimaryCategory).toBe('10100278');
    expect(product.Skus).toEqual({ Sku: [{ SkuId: 'id-A' }, { SkuId: 'id-B' }] });
    expect(product.Attributes).toEqual({ material: 'Da,Vải', delivery_option_standard: 'Yes' });
  });

  it('SKU đã tắt bị bật lại thì tắt lại từng SKU', async () => {
    const was = [sku('A', { Status: 'inactive' }), sku('B')];
    const now = [sku('A'), sku('B')];
    const fn = fakeFetch(item(was), item(was), OK, item(now), OK);
    expect(await run(fn)).toEqual({ underReview: false, mismatch: [] });
    expect(fn).toHaveBeenCalledTimes(5);
    const off = sent(fn, 4);
    expect(off.path).toBe('/rest/product/deactivate');
    expect(off.body.apiRequestBody).toContain('<SkuId>id-A</SkuId>');
  });

  it('`keepDeactivated`: tắt lại mọi SKU đang bật', async () => {
    const skus = [sku('A'), sku('B')];
    const fn = fakeFetch(item(skus), item(skus), OK, item(skus), OK, OK);
    await run(fn, { keepDeactivated: true });
    expect([4, 5].map((i) => sent(fn, i).path)).toEqual(['/rest/product/deactivate', '/rest/product/deactivate']);
  });

  it('tắt lại lỗi thì ghi vào `mismatch`', async () => {
    const fn = fakeFetch(item([sku('A', { Status: 'inactive' })]), item([sku('A', { Status: 'inactive' })]), OK, item([sku('A')]), {
      code: '501',
      type: 'ISP',
      message: 'E501: failed',
    });
    const res = await run(fn);
    expect(res.mismatch).toEqual(['bật lại SKU đang tắt và chưa tắt lại được; tắt trên Seller Center']);
  });

  it('sàn từ chối UpdateProduct thì ném `rejected`', async () => {
    const skus = [sku('A')];
    const fn = fakeFetch(item(skus), item(skus), { code: '4108', type: 'ISP', message: 'E500' });
    await expect(run(fn)).rejects.toMatchObject({ kind: 'rejected', platformCode: '4108' });
  });
});
