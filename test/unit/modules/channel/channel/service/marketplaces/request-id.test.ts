// `request_id` của sàn vào log khi gọi API ghi và vào lỗi sàn (#504): đối chiếu ticket TikTok, Lazada chỉ cần tra log.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as LoggerModule from '#src/shared/logger.ts';

const info = vi.hoisted(() => vi.fn());
vi.mock('#src/shared/logger.ts', async (original) => {
  const mod = await original<typeof LoggerModule>();
  return { ...mod, logger: new Proxy(mod.logger, { get: (t, k) => (k === 'info' ? info : Reflect.get(t, k)) }) };
});

const { MarketplaceError } = await import('#src/modules/channel/channel/service/marketplaces/common.ts');
const { createLazadaAdapter, lazadaError } = await import('#src/modules/channel/channel/service/marketplaces/lazada.ts');
const { createTiktokClient, packTiktokToken, tiktokError } = await import('#src/modules/channel/channel/service/marketplaces/tiktok-client.ts');

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const writes = () => info.mock.calls.filter(([, msg]) => msg === 'gọi ghi lên sàn').map(([obj]) => obj);

afterEach(() => info.mockReset());

describe('TikTok: request_id', () => {
  const config = { appKey: 'appk', appSecret: 'apps', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
  const token = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '749' });

  it('lời gọi ghi thành công: một dòng log có platform, path, requestId, code', async () => {
    const client = createTiktokClient(config, vi.fn<typeof fetch>().mockResolvedValue(json({ code: 0, request_id: 'REQ-OK', data: {} })));
    await client.call('POST', '/return_refund/202309/returns/1/approve', { token, body: { decision: 'APPROVE_RETURN' } });
    expect(writes()).toEqual([{ platform: 'tiktok', path: '/return_refund/202309/returns/1/approve', requestId: 'REQ-OK', code: '0' }]);
  });

  it('lời gọi ghi bị sàn từ chối: vẫn log, và MarketplaceError mang requestId', async () => {
    const client = createTiktokClient(config, vi.fn<typeof fetch>().mockResolvedValue(json({ code: 12052556, message: 'bad', request_id: 'REQ-ERR' })));
    const err = await client.call('POST', '/product/202309/products/1/inventory/update', { token, body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceError);
    expect(err).toMatchObject({ kind: 'rejected', platformCode: '12052556', requestId: 'REQ-ERR' });
    expect(writes()).toEqual([{ platform: 'tiktok', path: '/product/202309/products/1/inventory/update', requestId: 'REQ-ERR', code: '12052556' }]);
  });

  it('lời gọi đọc (GET, POST …/search) không log; lỗi đọc vẫn mang requestId', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ code: 0, request_id: 'R1', data: {} }))
      .mockResolvedValueOnce(json({ code: 0, request_id: 'R2', data: {} }))
      .mockResolvedValueOnce(json({ code: 105002, message: 'expired', request_id: 'R3' }));
    const client = createTiktokClient(config, fetchFn);
    await client.call('GET', '/product/202309/products/1', { token });
    await client.call('POST', '/product/202502/products/search', { token, body: {} });
    const err = await client.call('GET', '/product/202309/products/2', { token }).catch((e: unknown) => e);
    expect(writes()).toEqual([]);
    expect(err).toMatchObject({ kind: 'unauthorized', requestId: 'R3' });
  });

  it('tiktokError không có request_id thì requestId null', () => {
    expect(tiktokError(1, 'x').requestId).toBeNull();
  });
});

describe('Lazada: request_id', () => {
  const config = { appKey: '143465', appSecret: 'secret', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };

  it('lời gọi ghi (POST) log requestId kể cả khi sàn trả lỗi; lỗi mang requestId', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ code: '4155', message: 'locked', type: 'ISP', request_id: 'LZ-ERR' }));
    const adapter = createLazadaAdapter(config, fetchFn);
    const err = await adapter.deactivate!('tok', '100', '200').catch((e: unknown) => e);
    expect(err).toMatchObject({ platformCode: '4155', requestId: 'LZ-ERR' });
    expect(writes()[0]).toMatchObject({ platform: 'lazada', requestId: 'LZ-ERR', code: '4155' });
    expect(Object.keys(writes()[0]).sort()).toEqual(['code', 'path', 'platform', 'requestId']);
  });

  it('lazadaError đọc request_id', () => {
    expect(lazadaError({ code: 'E1', message: 'x', request_id: 'abc' }).requestId).toBe('abc');
    expect(lazadaError({ code: 'E1' }).requestId).toBeNull();
  });
});
