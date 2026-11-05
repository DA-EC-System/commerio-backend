import { describe, expect, it } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const base = Date.parse('2026-11-01T00:00:00Z');
const lazadaTime = (ms: number) => `${new Date(ms + 7 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} +0700`;

// Sàn giả theo `/orders/get`: lọc theo `update_after`, xếp `updated_at` tăng dần, lật `offset`, trang tối đa 100.
// `inclusive` thử cả hai cách hiểu `update_after` (lấy cả mốc hay chỉ sau mốc), tài liệu Lazada không nói rõ.
function fakeLazada(updated: Map<string, number>, inclusive: boolean, afterCall?: (n: number) => void) {
  let calls = 0;
  return async (url: string | URL | Request) => {
    const q = new URL(String(url)).searchParams;
    const after = Date.parse(q.get('update_after')!);
    const offset = Number(q.get('offset'));
    const limit = Number(q.get('limit'));
    const all = [...updated]
      .filter(([, t]) => (inclusive ? t >= after : t > after))
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    const orders = all
      .slice(offset, offset + limit)
      .map(([id, t]) => ({ order_id: id, created_at: lazadaTime(base), updated_at: lazadaTime(t) }));
    afterCall?.(++calls);
    return new Response(JSON.stringify({ code: '0', data: { countTotal: all.length, orders } }), { status: 200 });
  };
}

async function drain(updated: Map<string, number>, inclusive: boolean, afterCall?: (n: number) => void) {
  const adapter = createLazadaAdapter(config, fakeLazada(updated, inclusive, afterCall));
  const seen: string[] = [];
  let last: Date | undefined;
  let cursor: string | null = null;
  let pages = 0;
  let safeUntil: Date | null = null;
  do {
    const page = await adapter.listOrders!('t', new Date(base - 120_000), cursor);
    seen.push(...page.orders.map((o) => o.externalOrderId));
    if (page.safeUntil && (!safeUntil || page.safeUntil < safeUntil)) safeUntil = page.safeUntil;
    // Hợp đồng: đơn trả về không giảm theo `updatedAt` qua các trang.
    for (const o of page.orders) if (last && o.updatedAt < last) throw new Error('đơn trả về giảm theo updatedAt');
    last = page.orders.at(-1)?.updatedAt ?? last;
    cursor = page.nextCursor;
    if (++pages > 50) throw new Error('không dừng');
  } while (cursor);
  return { seen, pages, safeUntil };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `O${String(i + 1).padStart(3, '0')}`);

describe('Lazada: lật trang kéo đơn theo con trỏ (#218)', () => {
  it.each([true, false])('cửa sổ 150 đơn, đơn thứ 50 đổi giữa hai trang: không sót đơn nào (update_after lấy cả mốc: %s)', async (inclusive) => {
    const updated = new Map(ids(150).map((id, i) => [id, base + i * 1000]));
    const { seen } = await drain(updated, inclusive, (n) => {
      if (n === 1) updated.set('O050', base + 3600_000);
    });
    expect(new Set(seen)).toEqual(new Set(ids(150)));
    // Đơn đổi được trả hai lần (bản cũ ở trang 1, bản mới ở cuối); đơn không đổi chỉ một lần.
    expect(seen.filter((id) => id === 'O101')).toHaveLength(1);
    expect(seen.filter((id) => id === 'O050')).toHaveLength(2);
  });

  it.each([true, false])('danh sách không đổi: mỗi đơn đúng một lần, kể cả đơn cùng giây ở ranh giới trang (lấy cả mốc: %s)', async (inclusive) => {
    // Đơn 99–103 cùng một giây, vắt qua ranh giới trang 1 và 2.
    const updated = new Map(ids(180).map((id, i) => [id, base + (i < 98 ? i : i <= 102 ? 98 : i - 4) * 1000]));
    const { seen } = await drain(updated, inclusive);
    expect(seen).toEqual(ids(180));
  });

  it('hơn 100 đơn cùng một giây: vẫn lật hết và dừng', async () => {
    const updated = new Map(ids(250).map((id, i) => [id, i < 230 ? base : base + (i - 229) * 1000]));
    const { seen, safeUntil } = await drain(updated, true);
    expect(seen).toEqual(ids(250));
    expect(safeUntil).toBeNull();
  });

  // Review PR #257: lật offset trong nhóm cùng giây mà một đơn của nhóm đổi thì đơn sau dồn lên, sót một đơn. Adapter
  // không tránh được trong lượt này, nhưng phải báo `safeUntil` <= giây của nhóm để bên gọi giữ mốc, lượt sau đọc lại.
  // Lật offset gối một đơn nên một đơn đổi không sót; hai đơn đổi thì sót. Cả hai ca đều phải báo `safeUntil`.
  it.each([
    [true, ['O010']],
    [false, ['O010']],
    [true, ['O010', 'O020']],
    [false, ['O010', 'O020']],
  ])('nhóm hơn 100 đơn cùng giây, đơn trong nhóm đổi giữa chừng: báo mốc an toàn tại giây của nhóm (lấy cả mốc: %s, đổi %j)', async (inclusive, changed) => {
    const updated = new Map(ids(250).map((id, i) => [id, i < 230 ? base : base + (i - 229) * 1000]));
    const { seen, safeUntil } = await drain(updated, inclusive, (n) => {
      if (n === 2) for (const id of changed) updated.set(id, base + 3600_000);
    });
    expect(safeUntil!.getTime()).toBeLessThanOrEqual(base);
    if (changed.length === 1) expect(new Set(seen)).toEqual(new Set(ids(250)));
    expect(seen).toContain('O250');
  });

  it('cửa sổ rỗng: một lần gọi, không có con trỏ', async () => {
    const { seen, pages } = await drain(new Map(), true);
    expect(seen).toEqual([]);
    expect(pages).toBe(1);
  });
});
