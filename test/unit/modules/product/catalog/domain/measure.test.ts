import { describe, expect, it } from 'vitest';
import { edgeMm, weightG } from '#src/modules/product/catalog/domain/measure.ts';

const messageOf = (result: { error?: { issues: { message: string }[] } | undefined }) => result.error?.issues[0]?.message;

describe('weightG (Documents/21 §17.5, #434)', () => {
  it('nhận 1, 50000, null và bỏ trống', () => {
    for (const v of [1, 50_000, null, undefined]) expect(weightG.safeParse(v).success).toBe(true);
  });

  it.each([
    [50_001, 'Cân nặng tối đa 50 kg'],
    [999_999_999, 'Cân nặng tối đa 50 kg'],
    [0.25, 'Nhập số gam nguyên, vd 250'],
    [0, 'Nhập số nguyên lớn hơn 0'],
  ])('%s → "%s"', (v, msg) => {
    expect(messageOf(weightG.safeParse(v))).toBe(msg);
  });
});

describe('edgeMm (Documents/21 §17.5, #434)', () => {
  it('nhận 1, 2000, null', () => {
    for (const v of [1, 2_000, null]) expect(edgeMm('Chiều dài').safeParse(v).success).toBe(true);
  });

  it('2001 → câu lỗi nêu đúng cạnh', () => {
    expect(messageOf(edgeMm('Chiều cao').safeParse(2_001))).toBe('Chiều cao tối đa 2.000 mm');
  });

  it('30.5 → "Nhập số mm nguyên, vd 300"', () => {
    expect(messageOf(edgeMm('Chiều dài').safeParse(30.5))).toBe('Nhập số mm nguyên, vd 300');
  });
});
