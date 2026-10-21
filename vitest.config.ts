import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Mọi test nằm trong test/ (xem test/CLAUDE.md).
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
