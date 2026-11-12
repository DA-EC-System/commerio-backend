import { describe, expect, it } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };

const BASE = Date.parse('2025-01-01T00:00:00Z');
// Sàn giả theo GetProducts (open.lazada.com, tra 06/11 và 12/11/2026): `filter`, `limit` tối đa 50, `offset` tối đa 10000,
// `create_after`, `create_before` lấy cả mốc, `total_products` theo bộ lọc. Sản phẩm i tạo lúc BASE + i × `gapMs`.
// `shuffle`: mỗi lời gọi trả thứ tự khác (tài liệu không có tham số sắp xếp; review #309 vòng 3 R1).
function fakeLazada(total: number, calls: URLSearchParams[], opts: { gapMs?: number; shuffle?: boolean } = {}) {
  const gap = opts.gapMs ?? 3600_000;
  let n = 0;
  return async (url: string | URL | Request) => {
    const q = new URL(String(url)).searchParams;
    calls.push(q);
    const after = q.get('create_after') ? Date.parse(q.get('create_after')!) : -Infinity;
    const before = q.get('create_before') ? Date.parse(q.get('create_before')!) : Infinity;
    const offset = Number(q.get('offset'));
    const limit = Number(q.get('limit'));
    let ids = Array.from({ length: total }, (_, i) => i).filter((i) => BASE + i * gap >= after && BASE + i * gap <= before);
    if (opts.shuffle) {
      n += 1;
      ids = ids.map((i) => [i, (i * 7919 + n * 104729) % 1000003] as const).sort((a, b) => a[1] - b[1]).map(([i]) => i);
    }
    const products = ids.slice(offset, offset + limit).map((i) => ({
      item_id: 1000 + i,
      status: i === 0 ? 'Deleted' : 'Active',
      attributes: { name: `Sản phẩm ${i}` },
      skus: [{ SkuId: 5000 + i, SellerSku: `S-${i}`, quantity: i, Status: i === 0 ? 'deleted' : 'active' }],
    }));
    return new Response(JSON.stringify({ code: '0', data: { total_products: ids.length, products } }), { status: 200 });
  };
}

describe('Lazada: đọc hết SKU của gian hàng (#198 §18.7.5)', () => {
  it('gian hàng không quá 50 sản phẩm: một lời gọi `filter=all`, bỏ sản phẩm đã xoá', async () => {
    const calls: URLSearchParams[] = [];
    const skus = await createLazadaAdapter(config, fakeLazada(40, calls)).listSkus!('t');
    expect(calls.map((q) => [q.get('filter'), q.get('limit'), q.get('offset')])).toEqual([['all', '50', '0']]);
    expect(skus).toHaveLength(39);
  });

  it('review vòng 3 R1: chia theo khoảng ngày tạo tới khi mỗi khoảng không quá 50, không lật `offset`; sàn đổi thứ tự mỗi lần vẫn đủ', async () => {
    const calls: URLSearchParams[] = [];
    const adapter = createLazadaAdapter(config, fakeLazada(120, calls, { shuffle: true }));
    const skus = await adapter.listSkus!('t');
    expect(calls.every((q) => q.get('offset') === '0' && q.get('create_after') && q.get('create_before'))).toBe(true);
    expect(new Set(skus.map((s) => s.externalSkuId)).size).toBe(119);
    expect(calls.length).toBeLessThan(40);
    expect(skus.find((s) => s.externalSkuId === '5001')).toMatchObject({ externalProductId: '1001', externalSkuId: '5001', sellerSku: 'S-1', title: 'Sản phẩm 1', quantity: 1 });
    expect(skus.some((s) => s.sellerSku === 'S-0')).toBe(false);
  });

  it('imageUrl (#282): ảnh đầu của `images` (mảng như gọi thật 09/11/2026, hoặc chuỗi JSON như ví dụ tài liệu), không có thì ảnh SKU, rồi null', async () => {
    const products = [
      { item_id: 1, status: 'Active', attributes: { name: 'A' }, images: ['', 'https://vn-live.slatic.net/p/a.png'], skus: [{ SkuId: 11, SellerSku: 'A', Images: [] }] },
      { item_id: 2, status: 'Active', attributes: { name: 'B' }, images: '["https://vn-live.slatic.net/p/b.png"]', skus: [{ SkuId: 21, SellerSku: 'B' }] },
      { item_id: 3, status: 'Pending QC', attributes: { name: 'C' }, images: [], skus: [{ SkuId: 31, SellerSku: 'C', Images: ['https://vn-live.slatic.net/p/c.jpg', ''] }] },
      { item_id: 4, status: 'InActive', attributes: { name: 'D' }, skus: [{ SkuId: 41, SellerSku: 'D', Images: ['', ''] }] },
    ];
    const fetchFn = async () => new Response(JSON.stringify({ code: '0', data: { total_products: 4, products } }), { status: 200 });
    const skus = await createLazadaAdapter(config, fetchFn).listSkus!('t');
    expect(skus.map((s) => [s.externalSkuId, s.imageUrl, s.state])).toEqual([
      ['11', 'https://vn-live.slatic.net/p/a.png', 'live'],
      ['21', 'https://vn-live.slatic.net/p/b.png', 'live'],
      ['31', 'https://vn-live.slatic.net/p/c.jpg', 'review'],
      ['41', null, 'inactive'],
    ]);
  });

  it('review vòng 2 N1: sàn trả thành công mà `data` vắng thì rejected `unexpected_response`, không coi là gian hàng rỗng', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ code: '0' }), { status: 200 });
    await expect(createLazadaAdapter(config, fetchFn).listSkus!('t')).rejects.toMatchObject({ kind: 'rejected', platformCode: 'unexpected_response' });
  });

  it('review vòng 3 R1: hơn 50 sản phẩm tạo cùng một giây thì lật `offset` trong khoảng đó', async () => {
    const calls: URLSearchParams[] = [];
    const skus = await createLazadaAdapter(config, fakeLazada(60, calls, { gapMs: 0 })).listSkus!('t');
    expect(new Set(skus.map((s) => s.externalSkuId)).size).toBe(59);
    expect(calls.some((q) => q.get('offset') === '50')).toBe(true);
  });

  it('review vòng 2 N1: sàn trả ít sản phẩm hơn `total_products` của khoảng thì rejected `incomplete_list`, không trả thiếu', async () => {
    const real = fakeLazada(40, []);
    const fetchFn = async (url: string | URL | Request) => {
      const res = await real(url);
      const body = (await res.json()) as { code: string; data: { total_products: number; products: unknown[] } };
      // Sàn báo 40 nhưng chỉ trả 10.
      body.data.products = body.data.products.slice(0, 10);
      return new Response(JSON.stringify(body), { status: 200 });
    };
    await expect(createLazadaAdapter(config, fetchFn).listSkus!('t')).rejects.toMatchObject({ kind: 'rejected', platformCode: 'incomplete_list' });
  });

  it('gian hàng không có sản phẩm nào (sàn bỏ trường `products`, `total_products`) thì trả rỗng', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ code: '0', data: {} }), { status: 200 });
    await expect(createLazadaAdapter(config, fetchFn).listSkus!('t')).resolves.toEqual([]);
  });

  it('gian hàng quá 10000 sản phẩm thì báo lỗi thay vì trả thiếu', async () => {
    const adapter = createLazadaAdapter(config, fakeLazada(10_100, []));
    await expect(adapter.listSkus!('t')).rejects.toMatchObject({ kind: 'rejected', platformCode: 'too_many_products' });
  });
});

// GetProducts (open.lazada.com, tra 12/11/2026): "update_after … Limits the returned products to those updated after or on
// the specified date, given in ISO 8601 date format."; `filter=all` không gồm sản phẩm đã xoá nên gọi thêm `filter=deleted`.
// Review vòng 2 N2: chỉ gọi `filter=all`; sản phẩm đã xoá do lần đọc trọn mỗi ngày dọn (tiết kiệm hạn mức chung của app).
describe('Lazada: SKU của sản phẩm sửa từ một mốc (#220 đợt 2, bản sao SKU sàn)', () => {
  it('gửi `update_after` ISO 8601 giờ VN, chỉ `filter=all` (một lời gọi khi ít sản phẩm sửa)', async () => {
    const calls: URLSearchParams[] = [];
    const fetchFn = async (url: string | URL | Request) => {
      const q = new URL(String(url)).searchParams;
      calls.push(q);
      const deleted = q.get('filter') === 'deleted';
      const products = Number(q.get('offset')) > 0 ? [] : [
        {
          item_id: deleted ? 2 : 1,
          status: deleted ? 'Deleted' : 'Active',
          attributes: { name: deleted ? 'Đã xoá' : 'Còn' },
          skus: [{ SkuId: deleted ? 21 : 11, SellerSku: deleted ? 'X' : 'A', quantity: 2, Status: deleted ? 'deleted' : 'active' }],
        },
      ];
      return new Response(JSON.stringify({ code: '0', data: { total_products: products.length, products } }), { status: 200 });
    };
    const skus = await createLazadaAdapter(config, fetchFn).listSkusChanged!('t', new Date('2026-11-12T01:00:00Z'));
    expect(calls.map((q) => [q.get('filter'), q.get('update_after'), q.get('offset')])).toEqual([
      ['all', '2026-11-12T08:00:00+07:00', '0'],
    ]);
    expect(skus.map((s) => [s.externalSkuId, s.state])).toEqual([['11', 'live']]);
  });
});
