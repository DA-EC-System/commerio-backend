import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const base = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const empty = { code: '0', data: { count: 0, countTotal: 0, orders: [] } };
const since = new Date('2026-11-01T00:00:00Z');

afterEach(() => vi.useRealTimers());

// Hạn mức gọi Lazada trong ngày (#102 AC-7b): mỗi request xin một lượt trước khi gọi mạng.
describe('hạn mức gọi Lazada', () => {
  it('hết lượt thì ném unavailable daily_call_limit và không gọi mạng', async () => {
    const fetchFn = vi.fn();
    const adapter = createLazadaAdapter({ ...base, reserveCall: async () => false }, fetchFn);
    const err = await adapter.listOrders!('t', since, 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceError);
    expect(err).toMatchObject({ kind: 'unavailable', platformCode: 'daily_call_limit' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('còn lượt thì mỗi request xin đúng một lượt', async () => {
    const reserveCall = vi.fn(async () => true);
    const fetchFn = vi.fn(async () => json(empty));
    await createLazadaAdapter({ ...base, reserveCall }, fetchFn).listOrders!('t', since, 0);
    expect(reserveCall).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('gọi lại sau SellerCallLimit cũng tính một lượt', async () => {
    vi.useFakeTimers();
    const reserveCall = vi.fn(async () => true);
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ code: 'SellerCallLimit', message: 'limit' })).mockResolvedValue(json(empty));
    const done = createLazadaAdapter({ ...base, reserveCall }, fetchFn).listOrders!('t', since, 0);
    await vi.runAllTimersAsync();
    await done;
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(reserveCall).toHaveBeenCalledTimes(2);
  });

  it('không truyền reserveCall thì gọi bình thường (test adapter không cần DB)', async () => {
    const fetchFn = vi.fn(async () => json(empty));
    await createLazadaAdapter(base, fetchFn).listOrders!('t', since, 0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // AC-7a: hạn mức của chính Lazada là lỗi tạm, việc nền thử lại sau.
  it.each([
    ['ApiCallLimit', () => json({ code: 'ApiCallLimit', type: 'ISV', message: 'limit' })],
    ['http_429', () => new Response('', { status: 429 })],
  ])('sàn báo vượt hạn mức (%s) thì là lỗi tạm unavailable', async (platformCode, res) => {
    const err = await createLazadaAdapter(base, vi.fn(async () => res())).listOrders!('t', since, 0).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'unavailable', platformCode });
  });
});
