# test/

Mọi test của repo nằm ở đây. CI chạy `npm test` (`vitest run`), Vitest chỉ quét `test/**/*.test.ts`. Có hai project: `unit` (`unit/`, `api/`) và `integration`; chạy riêng bằng `npx vitest run --project unit`. File đặt sai chỗ hoặc sai tên thì **bị bỏ qua mà không báo lỗi**.

## Đặt file ở đâu

| Thư mục | Loại | Cần gì |
|---|---|---|
| `unit/` | Một hàm, một lớp, không I/O thật | Không DB, không mạng |
| `api/` | Gọi HTTP vào `createApp()` bằng Supertest, không mở cổng thật | Không DB |
| `integration/` | Repository, transaction, migration, RLS trên PostgreSQL thật | Docker đang chạy. `global-setup.ts` dựng một container `pgvector/pgvector:pg18` cho cả lượt, chạy mọi migration trong `db/migrations`; `setup.ts` đặt `DATABASE_URL` trước khi file test import code. Dữ liệu dùng chung giữa các file: mỗi test tự tạo công ty, email riêng (vd `randomUUID()`), không giả định bảng trống |

Integration chạy migration và test bằng role `commerio_migrator` (`NOSUPERUSER CREATEROLE`, chủ các bảng) giống user `postgres` của Supabase; `TEST_PG_IMAGE=pgvector/pgvector:pg17` để chạy trên PostgreSQL 17 như staging.

### Helper dùng chung (`integration/helpers/`)

| File | Hàm |
|---|---|
| `db.ts` | `testPool()`: pool tới DB test bằng role chủ bảng (bỏ qua RLS), `setup.ts` tự đóng |
| `http.ts` | `testApp()`, `login(email)`, `selectCompany(token, companyId)`, `refreshCookie(res)`, `PASSWORD` |
| `company.ts` | `createCompany({ optionalModules? })` → `{ companyId, ceo: { email, token } }` (token đã chọn công ty); `addMember(companyId, 'admin' \| 'sale' \| 'warehouse' \| roleId)`; `createCustomRole(companyId, permissions)`; `registerCompany`, `registerBody`, `uniqueEmail` |
| `rls.ts` | `asCompany(companyId, fn)`: chạy như request trong công ty (role `commerio_app`), rồi rollback |
| `state.ts` | `lockCompany`, `suspendMembership`, `setModuleEnabled`, `revokePermission` (chỉ cho vai trò tuỳ biến) |
| `catalog.ts` | `createVariant(companyId, { sku?, categoryName? })` → `{ variantId, productId, categoryId, sku }` (mỗi lần một danh mục và sản phẩm mới, ghi trong `withCompany`; không truyền `categoryName` trùng trong một công ty) |
| `sales.ts` | `createOrder(companyId, { lines: { variantId, quantity, unitPrice }[], paymentMethod?, source? })` → `{ orderId, code, total }` (ghi bảng sales trong `withCompany`, chép SKU, tên sản phẩm từ biến thể; đơn tay mặc định `prepaid`, đơn sàn không có phương thức; không tạo `payment.order_payments`) |

Helper đóng băng trong lúc các nhánh làm song song; helper riêng của một module đặt ở `integration/<module>/helpers.ts`.

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
