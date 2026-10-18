# Module `payment`

Cấu hình khoá cổng (UC-PF-11), mã QR/link thanh toán (UC-PF-01), trạng thái tiền của đơn. Hợp đồng API: `Documents/21` mục 12 (12.3 API, 12.8 kiểu dữ liệu, 12.9 mã lỗi, T1–T15), mục 11 (hàm cho module khác), mục 10.8 (D14–D17). Bốn cổng `vnpay`, `momo`, `zalopay`, `vietqr`, **chỉ sandbox**.

## Bảng

| Bảng | Ghi chú |
|---|---|
| `payment.gateway_configs` | Một dòng mỗi (công ty, cổng). Có dòng = đã cấu hình; chưa có dòng thì API trả `version: 0`. `webhook_receiver_key` (chỉ `vietqr`) unique toàn hệ thống, sinh một lần |
| `payment.order_payments` | Trạng thái tiền của đơn tay/hộp thư (đơn sàn không có dòng) |
| `payment.payment_links` | Mã thanh toán; `payment_code` unique toàn hệ thống; mỗi đơn tối đa một mã `active` (unique một phần) |
| `payment.payment_transactions`, `payment.webhook_events` | Của #27 |

## API (gắn tại `/api/v1/payment`)

| API | Quyền | Việc |
|---|---|---|
| `GET /gateways` | `payment.gateway.manage` hoặc `payment.link.create` | 4 cổng theo thứ tự `GATEWAYS`. Có `manage`: `GatewayConfig` đã che; chỉ có `link.create`: `{ gateway, configured }` |
| `PUT /gateways/:gateway` | `payment.gateway.manage` | Lưu đủ các ô của cổng theo `version` (0 = tạo); nhật ký `create`/`update` không có giá trị khoá |
| `POST /orders/:orderId/links` | `payment.link.create` | Tạo mã (201) hoặc trả mã còn hạn (200); nhật ký `create` |
| `GET /orders/:orderId` | `sales.order.view` | `OrderPayment`; đơn chưa có dòng `order_payments` thì suy từ đơn; đơn sàn 404 |

## Hàm cho module khác (`index.ts`, Documents/21 §11)

| Hàm | Ai gọi | Việc |
|---|---|---|
| `initOrderPayment(orderId, method)` | fulfillment #25 khi xác nhận đơn | Tạo dòng `unpaid`/`cod_pending`, có rồi thì thôi. Trong `withCompany` của bên gọi |
| `cancelActiveLink(orderId)` | fulfillment #25 khi huỷ đơn | Mã `active` → `cancelled`. **Bên gọi đổi `sales.orders` trước rồi mới gọi hàm này, cùng giao dịch** |
| `markRefundPending(orderId)` | fulfillment #25 khi huỷ **mọi** đơn tay/hộp thư | `paid` → hoàn tiền `pending_refund` (`updated_at` = lúc huỷ, tab Cần hoàn tiền); chưa thu, chưa xác nhận, đã chờ hoàn → trả nguyên; `cod_collected` → 409 `payment_state_changed`. Gọi sau `cancelActiveLink` |
| `markCodNotCollected(orderId)` | fulfillment #25 khi giao COD thất bại hoặc huỷ đơn COD chưa giao | `cod_pending` → `not_collected`; đơn trả trước, chưa xác nhận → trả nguyên; `cod_collected` → 409 |
| `markDelivered(orderId, at)` | fulfillment #25 khi giao xong | Ghi `delivered_at` lần đầu (tab COD lọc theo ngày giao, R2) |
| `getOrderPayments(ids)` | chỉ finance | Trạng thái tiền theo lô; đơn chưa có dòng không có trong kết quả |
| `markPaid`, `markCodCollected`, `markRefunded`, … | chỉ finance | Còn là khung 501 (PR sau của #27) |

`markRefundPending`, `markCodNotCollected` trả 404 cho đơn sàn (không có trạng thái tiền) và đơn công ty khác: #25 không gọi cho đơn sàn; `markDelivered` với đơn không có dòng thì bỏ qua. **Thứ tự khoá cho mọi hàm trên:** bên gọi đổi `sales.orders` trước (giữ khoá dòng đơn), rồi mới gọi hàm payment (khoá `order_payments`), cùng giao dịch; ngược lại thì deadlock với tạo mã, webhook, COD (đơn trước, `order_payments` sau). Mọi hàm phải gọi trong `withCompany` (ngoài đó là role chủ bảng, RLS không có hiệu lực).

Payment gọi `sales.getOrderForPayment(orderId, { lock?: 'share' })` để đọc đơn.

## Bất biến

- **Khoá cổng là bí mật (T4):** API chỉ trả `{ last4 }` mỗi ô, kể cả trong `current` của 409. Không ghi giá trị khoá vào nhật ký thao tác, log, Problem Details. Không đưa khoá thô làm tham số SQL (`DrizzleQueryError` chép tham số vào `message`, lỗi lạ bị log).
- `credentials_enc` = AES-256-GCM bằng `PAYMENT_CREDENTIALS_KEY` (`service/credentials-cipher.ts`), AAD `"<companyId>:<gateway>"`: bản mã chép sang công ty hay cổng khác không giải mã được. Máy thiếu biến → 500 `payment_credentials_key_missing`.
- Ô khoá theo cổng: `CredentialsByGateway` (`api/schemas.ts`), cũng là schema Swagger; ô bí mật tối thiểu 8 ký tự. Danh sách cổng và kiểu `Gateway`: `domain/gateways.ts` (`GATEWAYS`, trùng enum `payment.gateway`).
- URL webhook SePay = `<PUBLIC_API_URL>/api/v1/payment/webhooks/sepay/<webhook_receiver_key>`; chưa đặt `PUBLIC_API_URL` thì `null`.
- **Mã thanh toán** (`service/payment-links.ts`): mỗi đơn tối đa một mã `active` còn hạn (15 phút); `payment_code` `CM` + 10 ký tự, unique toàn hệ thống. Tạo mã ba bước: đọc và kiểm luật trong giao dịch → gọi cổng **ngoài** giao dịch (10 giây) → ghi trong giao dịch có khoá. Thứ tự khoá: dòng `sales.orders` (`FOR SHARE`) trước, `order_payments` (`FOR UPDATE`) sau, cùng chiều với huỷ đơn; ngược chiều thì deadlock. Hai yêu cầu song song: unique một phần chặn, bên thua trả 200 mã của bên thắng.
- Luật được tạo mã: `domain/link-rules.ts` (luật theo đơn kiểm trước khi trả mã còn hạn; luật theo cổng, hạn mức MoMo 1.000–50.000.000 đ, kiểm sau). Mã `active` quá hạn hiện `expired` khi đọc, chỉ đổi DB khi tạo mã mới (#27 tra cứu quá hạn).
- Cổng (Strategy + Factory, docs/16 #9): `service/gateways/` — `PaymentGateway` hiện chỉ có `createPayment`; #27 thêm xác minh chữ ký, ánh xạ trạng thái, truy vấn lại. VNPay, VietQR không gọi mạng; MoMo, ZaloPay gọi sandbox. Không chép `message` của cổng vào lỗi (MoMo lặp lại chuỗi ký).
- Payment gọi `sales`, `staff`, `audit`; **không** gọi `finance` (webhook giao cho finance qua `ctx.onVerifiedPayment`, A11 của PR chuẩn bị).

## Test

Test không gọi mạng: `vi.spyOn(globalThis, 'fetch')` cho MoMo, ZaloPay. Helper riêng: `test/integration/payment/helpers.ts` (`shop`, `order`). Env đọc một lần lúc import: file test cần khoá đặt `PAYMENT_CREDENTIALS_KEY` (và `PUBLIC_API_URL` nếu kiểm URL) trong `vi.hoisted` trước import, không dùng import trong khối đó (`test/integration/payment/gateway-configs.test.ts`).
