# test/

Test xuyên nhiều lớp. Unit test không đặt ở đây mà đặt cạnh file code (`*.test.ts` trong `src/`).

| Thư mục | Loại | Cách chạy |
|---|---|---|
| `api/` | Gọi HTTP vào `createApp()` bằng Supertest, không mở cổng thật | `npm test` |
| `integration/` (sẽ thêm) | Repository và transaction trên PostgreSQL thật bằng Testcontainers | Cần Docker |

- Vitest đặt sẵn `NODE_ENV=test`, `LOG_LEVEL=silent` (`vitest.config.ts`).
- Test hiện tại không cần DB; `getDb()` chỉ nối DB khi được gọi.
- E2E trên trình duyệt (Cypress) thuộc repo frontend.
- Tên `describe`/`it` viết tiếng Việt, mô tả hành vi mong đợi.
