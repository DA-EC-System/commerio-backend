# CLAUDE.md: commerio-backend

Backend của **Commerio**, hệ thống thương mại điện tử doanh nghiệp (đồ án chuyên ngành, nhóm Nguyễn Công Thành, Nguyễn Chí Duy Khang). Ba vai trò: Admin, Sale, Khách hàng.

Quyết định kiến trúc nằm ở repo tài liệu của đồ án: `docs/17-modular-monolith.md` (kiến trúc, 19 module, thư viện), `docs/16-design-pattern.md` (pattern theo bài toán), `docs/19-mo-hinh-du-lieu.md` (mô hình dữ liệu). Code lệch tài liệu thì hỏi trước, đừng tự chọn bên nào đúng.

## Kiến trúc

Modular monolith: một mã nguồn, 19 module, mỗi module bốn lớp và một schema PostgreSQL riêng. Một Docker image chạy ba tiến trình:

| Tiến trình | File | Việc |
|---|---|---|
| `api` | `src/entrypoints/api.ts` | Phục vụ REST |
| `worker` | `src/entrypoints/worker.ts` | Việc nền: outbox → Kafka, đẩy tồn lên sàn, email, dựng số liệu |
| `realtime` | `src/entrypoints/realtime.ts` | Giữ kết nối SSE, đẩy sự kiện xuống trình duyệt |

Stack: Node.js 24 (chạy thẳng `.ts`, không build), Express 5, TypeScript 6, Zod 4, Drizzle ORM + PostgreSQL 18, Redis, Kafka (`@confluentinc/kafka-javascript`, chỉ dùng trong `src/modules/platform/service/outbox/`), `decimal.js`, pino, prom-client, Vitest.

## Lệnh

```bash
npm run dev            # api, có watch. dev:worker, dev:realtime cho hai tiến trình kia
npm run check          # lint + typecheck + depcruise + test, chạy trước khi mở PR
npm run infra:up       # PostgreSQL, Redis, Kafka (deploy/compose.yaml)
npm run db:generate    # sinh migration từ schema Drizzle
npm run db:migrate
```

Dùng **npm**, không dùng pnpm/yarn (client Kafka chưa hỗ trợ ổn định).

## Luật ranh giới (dependency-cruiser kiểm trong CI)

1. Module khác chỉ import từ `src/modules/<tên>/index.ts`.
2. Repository chỉ truy vấn schema của chính module. Không join chéo schema; cần dữ liệu module khác thì gọi hàm trong `index.ts` của module đó.
3. Nghiệp vụ nhiều module trong một giao dịch: bọc bằng `inTransaction()` (`src/shared/db/client.ts`). Module được gọi tự đi chung transaction qua `AsyncLocalStorage`.
4. `shared` không biết module nào tồn tại.
5. Module chỉ gọi module cùng lớp hoặc lớp thấp hơn (bảng lớp ở `src/modules/CLAUDE.md`). Cần hàm của module lớp trên thì nhận qua `ModuleContext` do `src/wiring.ts` dựng.
6. Route kiểm quyền bằng `ctx.authorize('<mã quyền>')` đặt trước `validate()`; truy vấn dữ liệu công ty chạy trong `withCompany(companyId, fn)` (`src/shared/db/client.ts`).

## Quy ước code

- Định danh bằng tiếng Anh (`Order`, `ProductVariant`, `stockThreshold`); comment, tài liệu, thông báo lỗi cho người đọc bằng tiếng Việt.
- Import tương đối phải có đuôi `.ts`. Chỉ viết cú pháp TypeScript xoá được: không `enum`, `namespace`, parameter property. Dùng union literal hoặc object `as const` thay `enum`.
- Lỗi nghiệp vụ ném `AppError(status, code, message)`; middleware trả về dạng Problem Details (RFC 9457). Không tự `res.status(4xx)` trong controller.
- Đầu vào HTTP luôn qua `validate({ body, query, params })`; controller đọc `res.locals.validated`.
- Tiền dùng `numeric` trong DB và `decimal.js` trong code, không dùng `number`.

## Test: đặt file ở đâu

**Mọi file test nằm trong `test/`, tên kết thúc bằng `.test.ts`. Không bao giờ đặt test trong `src/`.** CI chỉ quét `test/**/*.test.ts`, file đặt chỗ khác bị bỏ qua mà không báo.

| Test cái gì | Đặt ở |
|---|---|
| Một hàm/lớp trong `src/<đường dẫn>/<file>.ts`, không DB, không mạng | `test/unit/<đường dẫn>/<file>.test.ts` (đi theo đúng cấu trúc `src/`) |
| Endpoint HTTP qua `createApp()` | `test/api/<module>.test.ts` |
| Cần PostgreSQL thật | `test/integration/<module>/<tên>.test.ts` |

Import code bằng `#src/...ts`. **Đọc `test/CLAUDE.md` trước khi viết hoặc sửa test** (quy tắc để CI chạy được).

## Git

Git Flow: `main` (phát hành) ← `develop` (tích hợp) ← `feature/<tên>`. PR vào `develop`, CI phải xanh. Không commit `.env`, khoá cổng thanh toán, JWT secret; cấu hình mẫu đặt trong `.env.example`. Cổng thanh toán chỉ chạy sandbox, dữ liệu demo là dữ liệu giả.

## CLAUDE.md của thư mục con

`src/`, `src/entrypoints/`, `src/modules/`, `src/shared/`, `db/`, `test/`, `deploy/` mỗi thư mục có một file riêng ghi context của nó. Module nào bắt đầu có nghiệp vụ thì thêm `src/modules/<tên>/CLAUDE.md`.
