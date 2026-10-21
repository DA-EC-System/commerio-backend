import { defineConfig } from 'vitest/config';

// Test gọi đăng nhập nhiều lần từ cùng một IP, nên nới giới hạn. Không đặt SMTP_URL: test gửi thư qua transport giả.
const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  AUTH_RATE_LIMIT: '10000',
  MAIL_FROM: 'Commerio <no-reply@commerio.test>',
  // ID token Google trong test ký bằng khoá tự sinh (setGoogleKeySource), aud là client id này.
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  // Gốc FE của link mời (#7 [C]).
  PUBLIC_WEB_URL: 'https://commerio.test',
};

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
