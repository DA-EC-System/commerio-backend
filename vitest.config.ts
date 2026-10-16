import { defineConfig } from 'vitest/config';

const env = { NODE_ENV: 'test', LOG_LEVEL: 'silent' };

export default defineConfig({
  test: {
    // Mọi test nằm trong test/ (xem test/CLAUDE.md).
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/api/**/*.test.ts'],
          env,
        },
      },
      {
        // PostgreSQL thật trong container (cần Docker): chạy migration một lần cho cả lượt test.
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          setupFiles: ['test/integration/setup.ts'],
          env,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
