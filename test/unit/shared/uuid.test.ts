import { describe, expect, it } from 'vitest';
import { isUuid } from '#src/shared/uuid.ts';

// Id không phải uuid thì PostgreSQL ném 22P02: mọi module kiểm bằng hàm này trước khi truy vấn (V6: coi như không có).
describe('isUuid', () => {
  it.each([
    ['7d1b6c1e-0000-4000-8000-000000000001', true],
    ['khong-phai-uuid', false],
    ['', false],
    ['7d1b6c1e00004000800000000000001', false],
  ])('%s → %s', (id, expected) => {
    expect(isUuid(id)).toBe(expected);
  });
});
