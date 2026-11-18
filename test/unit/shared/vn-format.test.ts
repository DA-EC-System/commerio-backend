import { describe, expect, it } from 'vitest';
import { vnDateText, vnShortDateTime } from '#src/shared/vn-format.ts';

describe('vnShortDateTime', () => {
  it('in dd/MM HH:mm theo giờ Việt Nam, kể cả khi qua ngày so với UTC', () => {
    expect(vnShortDateTime(new Date('2026-11-16T18:46:00Z'))).toBe('17/11 01:46');
    expect(vnShortDateTime(new Date('2026-01-05T03:07:00Z'))).toBe('05/01 10:07');
  });
});

describe('vnDateText', () => {
  it('đổi ngày yyyy-mm-dd sang dd/MM/yyyy, không qua múi giờ', () => {
    expect(vnDateText('2026-11-01')).toBe('01/11/2026');
  });
});
