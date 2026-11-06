import { describe, expect, it } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };

// Sàn giả theo GetProducts (open.lazada.com, tra 06/11/2026): `filter`, `limit` tối đa 50, `offset` tối đa 10000.
function fakeLazada(total: number, calls: URLSearchParams[]) {
  return async (url: string | URL | Request) => {
    const q = new URL(String(url)).searchParams;
    calls.push(q);
    const offset = Number(q.get('offset'));
    const limit = Number(q.get('limit'));
    const products = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, k) => {
      const i = offset + k;
      return {
        item_id: 1000 + i,
        status: i === 0 ? 'Deleted' : 'Active',
        attributes: { name: `Sản phẩm ${i}` },
        skus: [{ SkuId: 5000 + i, SellerSku: `S-${i}`, quantity: i, Status: i === 0 ? 'deleted' : 'active' }],
      };
    });
    return new Response(JSON.stringify({ code: '0', data: { total_products: total, products } }), { status: 200 });
  };
}

describe('Lazada: đọc hết SKU của gian hàng (#198 §18.7.5)', () => {
  it('lật `offset` 50 một trang với `filter=all` tới khi trang thiếu, bỏ sản phẩm đã xoá', async () => {
    const calls: URLSearchParams[] = [];
    const adapter = createLazadaAdapter(config, fakeLazada(120, calls));
    const skus = await adapter.listSkus!('t');
    expect(calls.map((q) => [q.get('filter'), q.get('limit'), q.get('offset')])).toEqual([
      ['all', '50', '0'],
      ['all', '50', '50'],
      ['all', '50', '100'],
    ]);
    expect(skus).toHaveLength(119);
    expect(skus[0]).toMatchObject({ externalProductId: '1001', externalSkuId: '5001', sellerSku: 'S-1', title: 'Sản phẩm 1', quantity: 1 });
    expect(skus.some((s) => s.sellerSku === 'S-0')).toBe(false);
  });

  it('gian hàng quá 10000 sản phẩm thì báo lỗi thay vì trả thiếu', async () => {
    const adapter = createLazadaAdapter(config, fakeLazada(10_100, []));
    await expect(adapter.listSkus!('t')).rejects.toMatchObject({ kind: 'rejected', platformCode: 'too_many_products' });
  });
});
