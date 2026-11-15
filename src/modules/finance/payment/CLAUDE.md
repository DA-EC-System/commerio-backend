# Module `payment`

Webhook và tra cứu quá hạn của cổng, trạng thái tiền của đơn tay kiểu cũ. **#235 gỡ** route cấu hình khoá cổng, tạo mã thanh toán, trạng thái tiền của đơn, đơn chưa thu, giao dịch cổng, mô phỏng trả tiền (cổng thanh toán ngoài MVP; Documents/21 mục 12 "(bỏ)"), cùng service `gateway-configs` (trừ `loadGatewayCredentials`), `payment-links`, `transactions`, `order-list`, `daily-totals`, `markCodCollected`, `markRefunded`, `listOrderPayments`, `getDailyPaymentFees`. Bảng giữ nguyên. Hợp đồng API: `Documents/21` mục 12 (12.3 API, 12.8 kiểu dữ liệu, 12.9 mã lỗi, T1–T15), mục 11 (hàm cho module khác), mục 10.8 (D14–D17). Bốn cổng `vnpay`, `momo`, `zalopay`, `vietqr`, **chỉ sandbox**.

## Bảng

| Bảng | Ghi chú |
|---|---|
| `payment.gateway_configs` | Một dòng mỗi (công ty, cổng). Có dòng = đã cấu hình; chưa có dòng thì API trả `version: 0`. `webhook_receiver_key` (chỉ `vietqr`) unique toàn hệ thống, sinh một lần |
| `payment.order_payments` | Trạng thái tiền của đơn tay/hộp thư (đơn sàn không có dòng) |
| `payment.payment_links` | Mã thanh toán; `payment_code` unique toàn hệ thống; mỗi đơn tối đa một mã `active` (unique một phần) |
| `payment.payment_transactions` | Giao dịch cổng báo về, ghi một lần; unique `(gateway, gateway_txn_id)` toàn hệ thống |
| `payment.webhook_events` | Webhook (và kết quả tra cứu) đã kiểm chữ ký; chống trùng theo `(company_id, gateway, event_key)` |

## API (gắn tại `/api/v1/payment`)

Chỉ còn `GET /webhooks/vnpay`, `POST /webhooks/{momo,zalopay}`, `POST /webhooks/sepay/:receiverKey` (không token, mục Webhook dưới). `gateways`, `orders`, `transactions`, `dev/simulate` trả 404 (#235).

## Hàm cho module khác (`index.ts`, Documents/21 §11)

| Hàm | Ai gọi | Việc |
|---|---|---|
| `initOrderPayment(orderId, method)` | fulfillment #25 khi xác nhận đơn | Tạo dòng `unpaid`/`cod_pending`, có rồi thì thôi. Trong `withCompany` của bên gọi |
| `cancelActiveLink(orderId)` | fulfillment #25 khi huỷ đơn | Mã `active` → `cancelled`. **Bên gọi đổi `sales.orders` trước rồi mới gọi hàm này, cùng giao dịch** |
| `markRefundPending(orderId)` | fulfillment #25 khi huỷ **mọi** đơn tay/hộp thư | `paid` → hoàn tiền `pending_refund` (`updated_at` = lúc huỷ, tab Cần hoàn tiền); chưa thu, chưa xác nhận, đã chờ hoàn → trả nguyên; `cod_collected` → 409 `payment_state_changed`. Gọi sau `cancelActiveLink` |
| `markCodNotCollected(orderId)` | fulfillment #25 khi giao COD thất bại hoặc huỷ đơn COD chưa giao | `cod_pending` → `not_collected`; đơn trả trước, chưa xác nhận → trả nguyên; `cod_collected` → 409 |
| `markDelivered(orderId, at)` | fulfillment #25 khi giao xong | Ghi `delivered_at` lần đầu (tab COD lọc theo ngày giao, R2) |
| `getOrderPayments(ids)` | chỉ finance | Trạng thái tiền theo lô; đơn chưa có dòng không có trong kết quả |
| `markPaid(orderId, by)` | chỉ finance (webhook, gán khoản thu) | `unpaid` → `paid`, mã `active`/`expired` → `paid`; lệch → 409 |
| `recordGatewayTransaction(payment, status)` | chỉ finance (handler webhook) | Ghi `webhook_events` rồi `payment_transactions`; trùng → `duplicate` |
| `revertPaid`, `revertRefunded` | — | Khung 501, chờ UC-PF-09 |

`markRefundPending`, `markCodNotCollected` trả 404 cho đơn sàn (không có trạng thái tiền) và đơn công ty khác: #25 không gọi cho đơn sàn; `markDelivered` với đơn không có dòng thì bỏ qua. **Thứ tự khoá cho mọi hàm trên:** bên gọi đổi `sales.orders` trước (giữ khoá dòng đơn), rồi mới gọi hàm payment (khoá `order_payments`), cùng giao dịch; ngược lại thì deadlock với tạo mã, webhook, COD (đơn trước, `order_payments` sau). Mọi hàm phải gọi trong `withCompany` (ngoài đó là role chủ bảng, RLS không có hiệu lực).

Payment gọi `sales.getOrderForPayment(orderId, { lock?: 'share' })` để đọc đơn.

## Bất biến

- **Khoá cổng là bí mật (T4):** API chỉ trả `{ last4 }` mỗi ô, kể cả trong `current` của 409. Không ghi giá trị khoá vào nhật ký thao tác, log, Problem Details. Không đưa khoá thô làm tham số SQL (`DrizzleQueryError` chép tham số vào `message`, lỗi lạ bị log).
- `credentials_enc` = AES-256-GCM bằng `PAYMENT_CREDENTIALS_KEY` (`service/credentials-cipher.ts`), AAD `"<companyId>:<gateway>"`: bản mã chép sang công ty hay cổng khác không giải mã được. Máy thiếu biến → 500 `payment_credentials_key_missing`; giải mã lỗi → 500 `payment_credentials_unreadable`: webhook và tra cứu quá hạn ném để cổng gửi lại / lượt sau thử lại.
- Danh sách cổng và kiểu `Gateway`, `Credentials` (ô khoá từng cổng): `domain/gateways.ts`, trùng enum `payment.gateway`.
- URL webhook SePay = `<PUBLIC_API_URL>/api/v1/payment/webhooks/sepay/<webhook_receiver_key>`; chưa đặt `PUBLIC_API_URL` thì `null`.
- Cổng (Strategy + Factory, docs/16 #9): `service/gateways/` — `PaymentGateway` có `createPayment`, `codeOf` (mã trong callback, trước khi biết công ty), `readCallback` (kiểm chữ ký bằng khoá công ty, bỏ trường chữ ký khỏi payload), `respond` (định dạng phản hồi riêng của cổng), `queryPayment` (tra cứu). VNPay, VietQR không gọi mạng khi tạo mã; MoMo, ZaloPay gọi sandbox. Không chép `message` của cổng vào lỗi (MoMo lặp lại chuỗi ký).
- Payment gọi `sales`, `staff`, `audit`; **không** gọi `finance` (webhook giao cho finance qua `ctx.onVerifiedPayment`, A11 của PR chuẩn bị).

## Webhook (#27, Documents/21 §12.4, D16)

`service/webhooks.ts`: (1) lấy mã thanh toán (`codeOf`), SePay lấy công ty từ `receiverKey`; (2) tìm mã/công ty **mọi công ty** bằng role chủ bảng (`findLinkByCodeAnyCompany`, `findCompanyByReceiverKey`; cùng `findOverdueLinksAnyCompany` của tra cứu quá hạn là ba chỗ duy nhất đọc chéo công ty, đều ném lỗi nếu gọi trong `withCompany` trừ `findCompanyByReceiverKey`); (3) `withCompany`: lấy khoá, `readCallback` — sai chữ ký thì `warn` và dừng, không ghi gì; mã thuộc cổng khác hoặc công ty chưa cấu hình cổng = không thấy mã; (4) giao cho finance qua `ctx.onVerifiedPayment` trong cùng giao dịch. Mọi nguồn dùng `eventKey = gatewayTxnId` (webhook, tra cứu, `sim:<mã>`). Phản hồi theo cổng (route tự đặt `res.status`, ngoại lệ có chủ đích). Lỗi lạ → mã "lỗi" của cổng để cổng gửi lại.

Tra cứu quá hạn (`service/overdue-query.ts`, `startBackground` của module, chạy trong worker): mỗi 60 giây, tối đa 20 mã `active` quá hạn ≤ 24 giờ; gọi cổng ngoài giao dịch; đã trả → như webhook `source=query` (không ghi được phiếu thu thì mã cũng `expired`), chưa trả → `expired`; cổng lỗi thì mã xuống cuối hàng chờ. Mã giao dịch cổng trùng với dòng của công ty khác (unique toàn hệ thống) → lỗi, không báo "đã xử lý". Mỗi lúc một lượt trên mọi bản sao worker: khoá phiên `payment.overdue_query` (`withSessionLock`, #63 B20), lượt khác đang chạy thì trả `busy`; phần ghi vẫn chống trùng ở DB.

Access log không ghi query (chữ ký VNPay) và che `receiverKey` SePay (`src/shared/logger.ts`). Trang khách quay về sau khi trả tiền: `<PUBLIC_WEB_URL>/thanh-toan/ket-qua` (chưa đặt thì gốc của API). Webhook thật trên máy dev cần URL HTTPS công khai: `cloudflared tunnel --url http://localhost:<API_PORT>`, đặt `PUBLIC_API_URL` bằng URL đó rồi khởi động lại api.

## Test

Test không gọi mạng: `vi.spyOn(globalThis, 'fetch')` cho MoMo, ZaloPay. Helper riêng: `test/integration/finance/payment/helpers.ts` (`shop` ghi khoá cổng đã mã hoá thẳng vào bảng, `order`, `insertLink` dựng mã bằng adapter thật rồi ghi bảng). Env đọc một lần lúc import: file test cần khoá đặt `PAYMENT_CREDENTIALS_KEY` (và `PUBLIC_API_URL` nếu kiểm URL) trong `vi.hoisted` trước import, không dùng import trong khối đó (`test/integration/payment/gateway-configs.test.ts`).
