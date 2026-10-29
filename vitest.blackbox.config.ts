import { defineConfig } from 'vitest/config';

// Bộ test hộp đen (#120): gọi HTTP vào server đang chạy ở BLACKBOX_BASE_URL (máy dev, CI hoặc staging), không dựng app.
// Không nằm trong `npm test`; chạy bằng `npm run test:blackbox` (test/CLAUDE.md, mục Hộp đen).
export default defineConfig({
  test: {
    // Khai bằng project như vitest.config.ts: thư mục gốc có `[...]` thì `include` ở cấp trên cùng không thấy file nào.
    projects: [
      {
        test: {
          name: 'blackbox',
          include: ['test/blackbox/**/*.test.ts'],
          globalSetup: ['test/blackbox/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    // Từng file một: nhẹ cho server dùng chung (staging) và cho máy chạy.
    fileParallelism: false,
  },
});
