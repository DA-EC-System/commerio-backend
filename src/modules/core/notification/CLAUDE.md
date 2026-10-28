# src/modules/core/notification/

Thông báo thời gian thực qua SSE (UC-NO-01, #33). **Không có bảng**, không lưu lịch sử (D11). Hợp đồng với FE: `Documents/21` §13.

## Luồng

```
publishEvent (module phát, trong giao dịch) → outbox → relay (worker) → Kafka
  → consumer `notification-sse`, scope `instance` (mỗi tiến trình realtime một group, bản nào cũng nhận đủ)
  → hub.dispatch: lọc công ty của sự kiện + quyền của kết nối → frame SSE → trình duyệt
```

| File | Việc |
|---|---|
| `domain/rules.ts` | Bảng loại sự kiện → quyền và trường được gửi (`toMessage`), tiền đổi sang số nguyên đồng (V29) |
| `service/hub.ts` | Kết nối đang mở theo công ty; `dispatch`, `closeAll` (gỡ hết rồi mới đóng) |
| `service/consumer.ts` | `notificationHandlers(hub)`, `startNotifications(hub)` (đăng ký consumer, gauge `notification_open_streams`); gọi một lần ở realtime |
| `api/routes.ts` | `GET /stream`: token (401, 403 `password_change_required`), `company_not_selected`, truy cập công ty từ DB lúc mở (404, `company_locked`, `account_locked`), header SSE, `retry: 3000`, heartbeat 25 s, đóng đúng lúc token hết hạn |
| `api/app.ts` | `createRealtimeApp`: chỉ stream, trên `REALTIME_PORT`. `/health`, `/metrics` ở cổng vận hành `REALTIME_OPS_PORT` (`src/entrypoints/realtime.ts`) |
| `api/openapi.ts` | Operation trên Swagger của api (stream do realtime phục vụ) |

## Ai nhận gì (D11, Thành duyệt A1 = "hoặc" ngày 18/10/2026)

| Thông báo | Loại sự kiện | Quyền (một trong) | Trường gửi |
|---|---|---|---|
| Đơn mới | `sales.order_created` | `sales.order.view` | `orderId`, `code`, `source`, `total` |
| Đơn đổi trạng thái, đơn thiếu hàng | `fulfillment.order_status_changed` | `sales.order.view` | `orderId`, `from`, `to`, `isShortStock` |
| Thanh toán thành công | `payment.succeeded` | `sales.order.view`, `finance.invoice.view` | `orderId`, `amount` (không gửi mã giao dịch, cổng: T13) |
| Tồn dưới ngưỡng | `inventory.below_threshold` | `inventory.stock.view` | `variantId`, `available`, `minQty` |
| Hàng nhập về | `inventory.receipt_posted` | `inventory.stock.view` | `receiptId`, `number`, `kind` |
| Đề nghị nhập chờ duyệt | `purchasing.request_submitted` | `purchasing.request.approve` | `requestId`, `number` |

Quyền của phân hệ đang tắt không tính. Loại không có trong bảng thì không gửi ai. `data` không có `companyId`, `aggregateId`.

## Bất biến

- Quyền và truy cập công ty kiểm **từ DB lúc mở** (D1), dùng tới khi token hết hạn: khoá, bớt quyền, tắt phân hệ có hiệu lực với thông báo chậm nhất 15 phút (A3, đã duyệt).
- Không ghi vào stream đã đóng: gỡ khỏi hub trước `res.end()`, mọi lần ghi kiểm `writableEnded`/`destroyed` (ghi sau `end` ném bất đồng bộ, sập tiến trình).
- Tắt realtime: `hub.closeAll()` trước `closeServer` (server chờ stream đang mở).
- Thứ tự chỉ giữ trong một đối tượng (key Kafka = `aggregateId`); hai đơn khác nhau có thể tới đảo thứ tự.
- api và realtime phải dùng chung `JWT_PUBLIC_KEY`; thiếu khoá thì mỗi tiến trình tự sinh khoá tạm và stream trả 401.

## Giới hạn đã biết

- Consumer `instance` chưa dừng được khi tắt (platform chưa export hàm dừng): dừng theo tiến trình. Sửa ở PR dọn dẹp sau đợt.
- `/metrics` chung cổng với stream; proxy (Caddy #37, Ingress #36) chỉ đưa `/api/v1/notification/stream*` ra ngoài.
- Không giới hạn số kết nối, không phát lại sự kiện lỡ khi mất mạng hay khi realtime khởi động lại.
- Test: `test/unit/modules/notification/`, `test/integration/notification/stream.test.ts` (app thật, đọc bằng `fetch`), `kafka.test.ts` (Kafka riêng ~15 s).
