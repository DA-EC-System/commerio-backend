# test/

Mọi test của repo nằm ở đây. CI chạy `npm test` (`vitest run`), Vitest chỉ quét `test/**/*.test.ts`. File đặt sai chỗ hoặc sai tên thì **bị bỏ qua mà không báo lỗi**.

## Đặt file ở đâu

| Thư mục | Loại | Cần gì |
|---|---|---|
| `unit/` | Một hàm, một lớp, không I/O thật | Không DB, không mạng |
| `api/` | Gọi HTTP vào `createApp()` bằng Supertest, không mở cổng thật | Không DB |
| `integration/` (chưa có) | Repository, transaction, migration trên PostgreSQL thật | Testcontainers, cần Docker (máy CI của GitHub có sẵn) |

`unit/` đi theo đúng cấu trúc của `src/`: test của `src/shared/http/validate.ts` là `test/unit/shared/http/validate.test.ts`; test của `src/modules/inventory/domain/stock.ts` là `test/unit/modules/inventory/domain/stock.test.ts`.

## Quy tắc để CI chạy được

1. Tên file kết thúc bằng `.test.ts`. Không đặt file test trong `src/`; `unit/repo-layout.test.ts` sẽ báo lỗi.
2. Import code bằng `#src/...` có đuôi `.ts`: `import { validate } from '#src/shared/http/validate.ts'`. Không dùng `../../src/...`.
3. Không gọi mạng ra ngoài (sàn, cổng thanh toán, AI). Thay bằng bản giả truyền vào qua tham số, hoặc `vi.mock`.
4. Không để lại `it.only` hay `describe.only`; Vitest báo lỗi khi chạy trên CI. `it.skip` phải có comment ghi lý do.
5. Chạy bao nhiêu lần cũng ra cùng một kết quả: không phụ thuộc giờ thật (`vi.useFakeTimers()`), thứ tự chạy, dữ liệu test khác để lại hay cổng cố định (mở server thì dùng cổng `0`).
6. Mở server, pool, timer thì đóng trong `afterAll`/`afterEach`.
7. Không dùng dữ liệu khách hàng thật; tên, số điện thoại, địa chỉ đều là dữ liệu giả.
8. Biến môi trường test đặt trong `vitest.config.ts` (`NODE_ENV=test`, `LOG_LEVEL=silent`), không đọc `.env`.

## Viết test

- Tên `describe`/`it` bằng tiếng Việt, mô tả hành vi: `it('trả 409 khi giữ hàng vượt số tồn khả dụng')`, không viết `it('test reserve')`.
- Mỗi `it` kiểm một hành vi. Kiểm cả trường hợp lỗi, không chỉ trường hợp chạy đúng.
- Lỗi API kiểm `status` và `type` của Problem Details (`/problems/<code>`), không so nguyên câu `detail`.
- Test luật nghiệp vụ (State Machine duyệt đơn, tồn không âm, webhook lặp) thì viết ở `unit/` cho lớp `domain`, rồi thêm một test `api/` hoặc `integration/` cho luồng đầy đủ.

Trước khi push: `npm run check`.
