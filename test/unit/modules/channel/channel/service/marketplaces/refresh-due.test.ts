import { describe, expect, it } from 'vitest';
import { DEFAULT_REFRESH_LEAD_MS, refreshBefore } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const HOUR = 3_600_000;
const noNetwork = async (): Promise<Response> => {
  throw new Error('không gọi mạng');
};
const lazada = createLazadaAdapter(
  { appKey: 'k', appSecret: 's', redirectUrl: undefined, apiUrl: 'http://lazada.invalid', authUrl: 'http://lazada.invalid' },
  noNetwork,
);
const tiktok = createTiktokAdapter(
  { appKey: 'k', appSecret: 's', serviceId: undefined, apiUrl: 'http://tiktok.invalid', authUrl: 'http://tiktok.invalid' },
  noNetwork,
);

describe('ngưỡng làm mới token theo adapter (#201)', () => {
  const access = new Date('2026-11-10T00:00:00Z');
  const tokens = { accessExpiresAt: access, refreshExpiresAt: new Date('2026-12-20T00:00:00Z') };

  it('mặc định 48 giờ trước hạn access; không biết hạn access thì không tự làm mới', () => {
    expect(DEFAULT_REFRESH_LEAD_MS).toBe(48 * HOUR);
    expect(refreshBefore(tokens, 2 * HOUR)).toEqual(new Date(access.getTime() - 2 * HOUR));
    expect(refreshBefore({ accessExpiresAt: null, refreshExpiresAt: null }, HOUR)).toBeNull();
  });

  it('Lazada và TikTok (access 7 ngày) làm mới khi access còn dưới 48 giờ', () => {
    for (const adapter of [lazada, tiktok]) {
      expect(adapter.refreshDueAt!(tokens)).toEqual(new Date(access.getTime() - 48 * HOUR));
      expect(adapter.refreshDueAt!({ accessExpiresAt: null, refreshExpiresAt: null })).toBeNull();
    }
  });
});
