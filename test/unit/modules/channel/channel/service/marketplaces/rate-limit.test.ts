import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '#src/modules/channel/channel/service/marketplaces/rate-limit.ts';
import { createTiktokClient, packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';

/** Đồng hồ giả: `sleep` tiến đồng hồ, ghi lại các lần chờ. */
function fakeClock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

describe('giãn lời gọi theo khoá (#215 phần TikTok)', () => {
  it('lượt sau của cùng khoá chờ đủ khoảng cách, khoá khác không chờ', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter(clock.now, clock.sleep);
    await limiter.acquire('shop-a:read', 200);
    await limiter.acquire('shop-b:read', 200);
    expect(clock.waits).toEqual([]);
    await limiter.acquire('shop-a:read', 200);
    expect(clock.waits).toEqual([200]);
  });

  it('backoff lùi lượt kế tiếp của khoá', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter(clock.now, clock.sleep);
    await limiter.acquire('k', 100);
    limiter.backoff('k', 1000);
    await limiter.acquire('k', 100);
    expect(clock.waits).toEqual([1000]);
  });
});

describe('client TikTok có rateLimit', () => {
  const token = packTiktokToken({ token: 'raw', cipher: 'cph', shopId: 'shop-1' });
  const ok = () => new Response(JSON.stringify({ code: 0, data: { ok: true } }), { status: 200 });
  const limited = () => new Response(JSON.stringify({ code: 36009002, message: 'Too many requests' }), { status: 200 });
  const client = (fetchFn: typeof fetch) =>
    createTiktokClient(
      {
        appKey: 'k',
        appSecret: 's',
        serviceId: undefined,
        apiUrl: 'http://tiktok.invalid',
        authUrl: 'http://tiktok.invalid',
        rateLimit: { readPerSecond: 1000, writePerSecond: 1000, backoffMs: 1 },
      },
      fetchFn,
    );

  it('bị 36009002 thì lùi rồi gọi lại một lần', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok());
    await expect(client(fetchFn).call('GET', '/x/202309/y', { token })).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('gọi lại vẫn bị giới hạn (HTTP 429) thì ném unavailable, không gọi lần ba', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('', { status: 429 }));
    await expect(client(fetchFn).call('POST', '/x/202309/y', { token, body: {} })).rejects.toMatchObject({
      kind: 'unavailable',
      platformCode: 'http_429',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('lỗi khác không gọi lại', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: 106001, message: 'sign' }), { status: 200 }));
    await expect(client(fetchFn).call('GET', '/x', { token })).rejects.toMatchObject({ kind: 'rejected' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
