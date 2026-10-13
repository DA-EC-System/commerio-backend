# src/shared/

Nền kỹ thuật chung cho mọi module và tiến trình. **Không chứa nghiệp vụ, không import gì từ `modules/`, `entrypoints/`, `app.ts`.** Thứ gì chỉ một module dùng thì để trong module đó.

| Đường dẫn | Nội dung |
|---|---|
| `config/env.ts` | Đọc và kiểm biến môi trường bằng Zod một lần lúc khởi động. Thêm biến mới thì thêm vào đây và `.env.example` |
| `db/client.ts` | Pool PostgreSQL + Drizzle. `getDb()` trả transaction đang mở nếu có; `inTransaction(fn)` mở transaction hoặc dùng lại transaction của bên gọi (`AsyncLocalStorage`) |
| `errors/` | `AppError` và middleware lỗi tập trung, trả Problem Details (RFC 9457): `type` = `/problems/<code>`, `status`, `detail`, `instance` |
| `http/validate.ts` | Middleware Zod kiểm `body`/`query`/`params`, gom mọi lỗi vào một phản hồi 400 |
| `observability/` | prom-client (`/metrics`, histogram thời gian request), cổng vận hành cho `worker`/`realtime` |
| `logger.ts` | pino, log dạng JSON |
| `lifecycle.ts` | Dừng êm khi nhận SIGTERM/SIGINT |
| `module.ts` | Kiểu `ModuleDefinition` mà mỗi module export |

## Chưa có, sẽ thêm vào đây

- Ngữ cảnh công ty đi theo request và Row-Level Security (đặt `app.company_id` trong transaction), xem `docs/17` mục 3.
- Middleware `authenticate` (JWT bằng `jose`) và `authorize`. Phần kiểm quyền gọi sang module `access`, nên `authorize` nhận hàm kiểm quyền qua tham số thay vì import module.
- Outbox và client Kafka (`events/`), Redis (`cache/`), OpenTelemetry, `decimal.js` cho tiền, sinh OpenAPI từ schema Zod.
