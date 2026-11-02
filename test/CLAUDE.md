# test/

Mọi test của repo nằm ở đây. CI chạy `npm test` (`vitest run`), Vitest chỉ quét `test/**/*.test.ts`. Có hai project: `unit` (`unit/`, `api/`) và `integration`; chạy riêng bằng `npx vitest run --project unit`. File đặt sai chỗ hoặc sai tên thì **bị bỏ qua mà không báo lỗi**.

## Đặt file ở đâu

| Thư mục | Loại | Cần gì |
|---|---|---|
| `unit/` | Một hàm, một lớp, không I/O thật | Không DB, không mạng |
| `api/` | Gọi HTTP vào `createApp()` bằng Supertest, không mở cổng thật | Không DB |
| `integration/` | Repository, transaction, migration, RLS trên PostgreSQL thật | Docker đang chạy. `global-setup.ts` dựng một container `pgvector/pgvector:pg18` cho cả lượt, chạy mọi migration trong `db/migrations`; `setup.ts` đặt `DATABASE_URL` trước khi file test import code. Dữ liệu dùng chung giữa các file: mỗi test tự tạo công ty, email riêng (vd `randomUUID()`), không giả định bảng trống |
| `blackbox/` | Gọi HTTP vào **server đang chạy** (máy dev, CI, staging), không dựng app trong tiến trình test | Không chạy trong `npm test`. Xem mục Hộp đen |

Integration chạy migration và test bằng role `commerio_migrator` (`NOSUPERUSER CREATEROLE`, chủ các bảng) giống user `postgres` của Supabase, riêng extension `vector` (cần superuser) do `global-setup.ts` bật trước; `TEST_PG_IMAGE=pgvector/pgvector:pg17` để chạy trên PostgreSQL 17 như staging.

### Helper dùng chung (`integration/helpers/`)

| File | Hàm |
|---|---|
| `db.ts` | `testPool()`: pool tới DB test bằng role chủ bảng (bỏ qua RLS), `setup.ts` tự đóng |
| `http.ts` | `testApp()`, `login(email)`, `selectCompany(token, companyId)`, `refreshCookie(res)`, `PASSWORD` |
| `company.ts` | `createCompany({ optionalModules? })` → `{ companyId, ceo: { email, token } }` (token đã chọn công ty); `addMember(companyId, 'admin' \| 'sale' \| 'warehouse' \| roleId)`; `createCustomRole(companyId, permissions)`; `registerCompany`, `registerBody`, `uniqueEmail` |
| `rls.ts` | `asCompany(companyId, fn)`: chạy như request trong công ty (role `commerio_app`), rồi rollback |
| `locks.ts` | `raceBehindLock(lock, blocked, start)`: dựng chạy đua tất định. Mở giao dịch chạy `lock(holder)` (vd `select … for update`, chèn chưa commit), gửi các request đua trong `start`, chờ tới khi đúng `blocked` phiên bị chặn sau giao dịch đó (đếm cả phiên xếp hàng sau phiên bị chặn), rồi commit và trả kết quả của `start` |
| `state.ts` | `lockCompany`, `suspendMembership`, `setModuleEnabled`, `revokePermission` (chỉ cho vai trò tuỳ biến) |
| `catalog.ts` | `createVariant(companyId, { sku?, categoryName? })` → `{ variantId, productId, categoryId, sku }` (mỗi lần một danh mục và sản phẩm mới, ghi trong `withCompany`; không truyền `categoryName` trùng trong một công ty) |
| `sales.ts` | `createOrder(companyId, { lines: { variantId, quantity, unitPrice }[], paymentMethod?, source? })` → `{ orderId, code, total }` (ghi bảng sales trong `withCompany`, chép SKU, tên sản phẩm từ biến thể; đơn tay mặc định `prepaid`, đơn sàn không có phương thức; không tạo `payment.order_payments`) |

Helper đóng băng trong lúc các nhánh làm song song; helper riêng của một module đặt ở `integration/<lớn>/<con>/helpers.ts`.

### Hộp đen (`blackbox/`, #120)

`npm run test:blackbox` (`vitest.blackbox.config.ts`) với `BLACKBOX_BASE_URL` (gốc server, vd `http://127.0.0.1:3000`, staging là tên miền) và `BLACKBOX_PASSWORD` (mật khẩu seed của server đó). Server phải đã chạy `npm run db:seed`: test dùng hai công ty QA của seed (`blackboxCompanies` ở `db/seed/demo.ts`), không dùng công ty demo. CI chạy job `blackbox` (api dựng trong runner) ở mọi PR, và chạy vào staging sau mỗi lần deploy (`deploy/staging/README.md`).

- `global-setup.ts` đăng nhập mỗi tài khoản một lần cho cả lượt (server giới hạn đăng nhập theo IP) và gắn vai trò tuỳ biến "QA Lập và duyệt" cho `qa-truong-mua` (ca người thứ hai không phải CEO). File test lấy token bằng `inject('tokens')`.
- Chỉ gọi API công khai; dữ liệu tạo mới mỗi lần chạy, tên có mã ngẫu nhiên (`lib/fixtures.ts`). Không giả định bảng trống, không xoá gì.
- Kiểm lỗi bằng `expectProblem(res, status, code)`; kiểm hình dạng bằng `expectContract(SchemaZod, body)` (đủ trường, không thừa, luật R2, R3, R5 của `Documents/21` §1.1). Schema lấy từ code của chính commit đang test, nên chạy vào staging phải cùng commit với bản đã deploy.
- Nhóm ca của module chưa merge bọc trong `describe.runIf(await served('GET /<route>'))`: server chưa có route thì bỏ qua, merge xong tự chạy.
- Mã ca (`A1-04q`, `D44-03p`, `ISO-01`) theo `Documents/26` §3; module mới thêm một file theo sơ đồ của nó và một ca vào `co-lap-cong-ty.test.ts`.

`unit/` đi theo đúng cấu trúc của `src/`: test của `src/shared/http/validate.ts` là `test/unit/shared/http/validate.test.ts`; test của `src/modules/product/inventory/domain/stock.ts` là `test/unit/modules/product/inventory/domain/stock.test.ts`.

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
