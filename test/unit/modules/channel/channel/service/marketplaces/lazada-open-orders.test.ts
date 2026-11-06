import { describe, expect, it } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const base = Date.parse('2026-11-01T00:00:00Z');
const lazadaTime = (ms: number) => `${new Date(ms + 7 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} +0700`;

// Sàn giả theo `/orders/get` có `status` (open.lazada.com, tra 06/11/2026): lọc theo trạng thái và `update_after`,
// xếp `updated_at` tăng dần, lật `offset`, trang tối đa 100.
function fakeLazada(orders: Map<string, { status: string; t: number }>, afterCall?: (q: URLSearchParams) => void) {
  return async (url: string | URL | Request) => {
    const q = new URL(String(url)).searchParams;
    const after = Date.parse(q.get('update_after')!);
    const offset = Number(q.get('offset'));
    const limit = Number(q.get('limit'));
    const all = [...orders]
      .filter(([, o]) => o.status === q.get('status') && o.t >= after)
      .sort((a, b) => a[1].t - b[1].t || a[0].localeCompare(b[0]));
    const page = all.slice(offset, offset + limit).map(([id, o]) => ({ order_id: id, created_at: lazadaTime(base - 86_400_000 * 30), updated_at: lazadaTime(o.t) }));
    afterCall?.(q);
    return new Response(JSON.stringify({ code: '0', data: { countTotal: all.length, orders: page } }), { status: 200 });
  };
}

async function drain(orders: Map<string, { status: string; t: number }>, afterCall?: (q: URLSearchParams) => void) {
  const calls: string[] = [];
  const adapter = createLazadaAdapter(
    config,
    fakeLazada(orders, (q) => {
      calls.push(q.get('status')!);
      afterCall?.(q);
    }),
  );
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await adapter.listOpenOrders!('t', cursor);
    seen.push(...page.orders.map((o) => o.externalOrderId));
    cursor = page.nextCursor;
    if (++pages > 100) throw new Error('không dừng');
  } while (cursor);
  return { seen, calls };
}

const OPEN = ['unpaid', 'pending', 'topack', 'packed', 'toship', 'ready_to_ship', 'shipped', 'shipping'];

describe('Lazada: lượt kéo đơn còn mở (#198 AC-14)', () => {
  it('đi lần lượt các trạng thái mở theo vòng đời, bỏ đơn đã xong, lật trang 100, hết thì nextCursor null', async () => {
    const orders = new Map<string, { status: string; t: number }>();
    for (let i = 0; i < 150; i++) orders.set(`P${i}`, { status: 'pending', t: base + i * 1000 });
    orders.set('D1', { status: 'delivered', t: base });
    orders.set('C1', { status: 'canceled', t: base });
    orders.set('S1', { status: 'shipped', t: base });
    const { seen, calls } = await drain(orders);
    expect(new Set(seen)).toEqual(new Set([...Array.from({ length: 150 }, (_, i) => `P${i}`), 'S1']));
    expect([...new Set(calls)]).toEqual(OPEN);
    expect(calls.filter((s) => s === 'pending')).toHaveLength(2);
  });

  it('đơn đổi trạng thái tiến giữa lượt (pending → packed khi đang đọc pending) vẫn được đọc', async () => {
    const orders = new Map<string, { status: string; t: number }>();
    for (let i = 0; i < 120; i++) orders.set(`P${i}`, { status: 'pending', t: base + i * 1000 });
    let moved = false;
    const { seen } = await drain(orders, (q) => {
      if (!moved && q.get('status') === 'pending') {
        moved = true;
        orders.set('P110', { status: 'packed', t: base + 3600_000 });
      }
    });
    expect(seen).toContain('P110');
    expect(new Set(seen).size).toBe(120);
  });
});
