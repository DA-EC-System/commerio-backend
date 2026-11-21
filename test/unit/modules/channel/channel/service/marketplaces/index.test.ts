import { describe, expect, it } from 'vitest';
import { getAdapter, marketplaceMismatches, registeredPlatforms } from '#src/modules/channel/channel/service/marketplaces/index.ts';

describe('registry adapter sàn', () => {
  it('đối chiếu danh mục sàn: adapter thiếu dòng, dòng bật không có adapter là lệch; dòng tắt không adapter thì được', () => {
    expect(registeredPlatforms().length).toBeGreaterThan(0);
    const all = registeredPlatforms().map((code) => ({ code, enabled: true }));
    expect(marketplaceMismatches([...all, { code: 'shopee', enabled: false }, { code: 'mock', enabled: false }])).toEqual([]);
    expect(marketplaceMismatches(all.slice(1))).toEqual([`adapter ${all[0]!.code} chưa có dòng trong channel.marketplaces`]);
    expect(marketplaceMismatches([...all, { code: 'shopee', enabled: true }])).toEqual(['channel.marketplaces shopee đang bật mà không có adapter']);
  });

  it('khoá của Object không phải adapter', () => {
    for (const key of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) expect(getAdapter(key)).toBeUndefined();
    expect(getAdapter('lazada')).toBeDefined();
    expect(getAdapter('tiktok')).toBeDefined();
  });
});
