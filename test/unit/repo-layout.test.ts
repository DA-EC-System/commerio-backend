import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('bố cục repo', () => {
  // Vitest chỉ quét test/, nên file test đặt trong src/ sẽ bị bỏ qua mà không báo.
  it('không có file test nào nằm trong src/', () => {
    expect(globSync('src/**/*.test.ts')).toEqual([]);
  });
});
