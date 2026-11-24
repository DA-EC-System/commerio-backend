import { describe, expect, it } from 'vitest';
import { confidenceOf } from '#src/modules/channel/channel/domain/match-confidence.ts';

describe('confidenceOf (#565)', () => {
  it('khớp SKU người bán (score null) là high', () => {
    expect(confidenceOf(null)).toBe('high');
  });
  it('khớp tên từ 0,7 là medium, ngay dưới 0,7 là low', () => {
    expect(confidenceOf(0.7)).toBe('medium');
    expect(confidenceOf(0.95)).toBe('medium');
    expect(confidenceOf(0.6999)).toBe('low');
    expect(confidenceOf(0.4)).toBe('low');
  });
});
