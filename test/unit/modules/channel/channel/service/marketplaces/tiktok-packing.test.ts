import { describe, expect, it, vi } from 'vitest';
import { packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const config = { appKey: 'k', appSecret: 's', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
const token = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '749' });
function fake(handler: (path: string) => Promise<unknown> | unknown) {
  const calls: { method: string | undefined; url: URL }[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: u, method: init?.method });
    return Response.json(await handler(u.pathname));
  });
  const download = vi.fn(async (url: string) => Buffer.from(url));
  return { adapter: createTiktokAdapter(config, fetchFn, { download }), calls, download };
}

describe('RTS và vận đơn TikTok', () => {
  it('giao từng kiện, coi mã đã giao 11006021 là thành công', async () => {
    const { adapter, calls } = fake((path) => ({ code: path.includes('/A/') ? 11006021 : 0, data: {} }));
    await adapter.readyToShip!(token, ['A', 'B']);
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['POST', '/fulfillment/202309/packages/A/ship'], ['POST', '/fulfillment/202309/packages/B/ship'],
    ]);
  });

  it('lấy nhãn PDF A6 của từng kiện, giữ thứ tự với tối đa năm lời gọi cùng lúc', async () => {
    let active = 0;
    let maxActive = 0;
    const ids = Array.from({ length: 12 }, (_, i) => String(i));
    const { adapter, calls } = fake(async (path) => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active--;
      return { code: 0, data: { doc_url: `https://files.test/${path.split('/')[4]}` } };
    });
    const documents = await adapter.shippingDocuments!(token, ids);
    expect(documents.map((pdf) => Buffer.from(pdf).toString())).toEqual(ids.map((id) => `https://files.test/${id}`));
    expect(calls).toHaveLength(ids.length);
    for (const { method, url } of calls) {
      expect(method).toBe('GET');
      expect(url.pathname).toMatch(/\/shipping_documents$/);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        document_type: 'SHIPPING_LABEL', document_size: 'A6', document_format: 'PDF',
      });
    }
    expect(maxActive).toBeGreaterThan(0);
    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it('kiện chưa báo giao: giữ mã lỗi và ghi mã kiện vào câu báo', async () => {
    const { adapter, download } = fake(() => ({ code: 21042104, message: 'Chưa giao kiện' }));
    await expect(adapter.shippingDocuments!(token, ['A'])).rejects.toMatchObject({
      kind: 'rejected', platformCode: '21042104', platformMessage: expect.stringContaining('A'),
    });
    expect(download).not.toHaveBeenCalled();
  });
});
