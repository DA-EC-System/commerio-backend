import { describe, expect, it } from 'vitest';
import { marketplace } from '#src/modules/channel/channel/repository/schema.ts';
import { getAdapter, registeredPlatforms } from '#src/modules/channel/channel/service/marketplaces/index.ts';

describe('registry adapter sàn', () => {
  it('mọi sàn đăng ký mặc định có trong enum DB channel.marketplace (checklist thêm sàn bước 4)', () => {
    expect(registeredPlatforms().length).toBeGreaterThan(0);
    for (const platform of registeredPlatforms()) expect(marketplace.enumValues).toContain(platform);
  });

  it('khoá của Object không phải adapter', () => {
    for (const key of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) expect(getAdapter(key)).toBeUndefined();
    expect(getAdapter('lazada')).toBeDefined();
    expect(getAdapter('tiktok')).toBeDefined();
  });
});
