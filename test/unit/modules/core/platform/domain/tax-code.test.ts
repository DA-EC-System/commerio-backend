import { describe, expect, it } from 'vitest';
import { normalizeTaxCode } from '#src/modules/core/platform/domain/tax-code.ts';

describe('normalizeTaxCode (#459, Documents/21 mục 2.1)', () => {
  it.each([
    ['0312345678', '0312345678'],
    [' 0312 345 678 ', '0312345678'],
    ['031.234.5678', '0312345678'],
    ['001099012345', '001099012345'],
    ['0312345678-001', '0312345678-001'],
    ['0312345678001', '0312345678-001'],
    ['0312.345.678 - 001', '0312345678-001'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeTaxCode(input)).toBe(expected);
  });

  it.each(['', '123', '03123456789', '03123456780012', '03123456a8', '0312345678/001'])('%j không hợp lệ', (input) => {
    expect(normalizeTaxCode(input)).toBeNull();
  });
});
