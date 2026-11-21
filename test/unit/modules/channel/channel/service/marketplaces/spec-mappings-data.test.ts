// Ánh xạ mặc định của adapter (#509): mỗi mã của sàn chỉ thuộc một thông số (unique `(company_id, platform, attribute_code)`),
// không trùng trong một thông số; nếu không, seed bỏ im lặng dòng trùng (`onConflictDoNothing`).
import { describe, expect, it } from 'vitest';
import { LAZADA_ATTRIBUTE_LABELS, LAZADA_SPEC_MAPPINGS } from '#src/modules/channel/channel/service/marketplaces/lazada-spec-mappings.ts';
import { TIKTOK_ATTRIBUTE_LABELS, TIKTOK_SPEC_MAPPINGS } from '#src/modules/channel/channel/service/marketplaces/tiktok-spec-mappings.ts';

describe.each([
  ['Lazada', LAZADA_SPEC_MAPPINGS],
  ['TikTok', TIKTOK_SPEC_MAPPINGS],
])('ánh xạ mặc định %s', (_name, mappings) => {
  it('mỗi mã attribute chỉ xuất hiện một lần trên cả sàn', () => {
    const owner = new Map<string, string>();
    const dup: string[] = [];
    for (const [field, codes] of Object.entries(mappings)) {
      for (const code of codes) {
        if (owner.has(code)) dup.push(`${code}: ${owner.get(code)} và ${field}`);
        owner.set(code, field);
      }
    }
    expect(dup).toEqual([]);
  });

  it('khoá là code thông số (chữ thường, số, gạch dưới)', () => {
    for (const field of Object.keys(mappings)) expect(field).toMatch(/^[a-z0-9_]{1,40}$/);
  });
});

// Trang ánh xạ hiện nhãn và nhận lại ánh xạ mặc định kể cả khi cache chưa có leaf chứa mã (knownAttributes): mọi mã seed phải có
// nhãn lấy từ API thật (có mã mà nhãn của sàn trùng mã, vd Lazada `PA`).
describe.each([
  ['Lazada', LAZADA_SPEC_MAPPINGS, LAZADA_ATTRIBUTE_LABELS],
  ['TikTok', TIKTOK_SPEC_MAPPINGS, TIKTOK_ATTRIBUTE_LABELS],
])('nhãn mã mặc định %s', (_name, mappings, labels) => {
  it('mọi mã seed có nhãn khác rỗng', () => {
    const bad = Object.values(mappings)
      .flat()
      .filter((code) => !labels[code]?.trim());
    expect(bad).toEqual([]);
  });

  it('không khai nhãn cho mã ngoài seed', () => {
    const seeded = new Set(Object.values(mappings).flat());
    expect(Object.keys(labels).filter((code) => !seeded.has(code))).toEqual([]);
  });
});
