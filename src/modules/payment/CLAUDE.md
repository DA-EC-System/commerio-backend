# Module `payment`

Cấu hình khoá cổng (UC-PF-11), mã QR/link thanh toán (UC-PF-01), trạng thái tiền của đơn. Hợp đồng API: `Documents/21` mục 12 (12.3 API, 12.8 kiểu dữ liệu, 12.9 mã lỗi, T1–T15), mục 11 (hàm cho module khác), mục 10.8 (D14–D17). Bốn cổng `vnpay`, `momo`, `zalopay`, `vietqr`, **chỉ sandbox**.

## Bảng

| Bảng | Ghi chú |
|---|---|
| `payment.gateway_configs` | Một dòng mỗi (công ty, cổng). Có dòng = đã cấu hình; chưa có dòng thì API trả `version: 0`. `webhook_receiver_key` (chỉ `vietqr`) unique toàn hệ thống, sinh một lần |
| `payment.order_payments` | Trạng thái tiền của đơn tay/hộp thư (đơn sàn không có dòng) |
| `payment.payment_links` | Mã thanh toán; `payment_code` unique toàn hệ thống; mỗi đơn tối đa một mã `active` (unique một phần) |
| `payment.payment_transactions` | Giao dịch cổng báo về, ghi một lần; unique `(gateway, gateway_txn_id)` toàn hệ thống |
| `payment.webhook_events` | Webhook (và kết quả tra cứu) đã kiểm chữ ký; chống trùng theo `(company_id, gateway, event_key)` |

## API (gắn tại `/api/v1/payment`)

| API | Quyền | Việc |
|---|---|---|
| `GET /gateways` | `payment.gateway.manage` hoặc `payment.link.create` | 4 cổng theo thứ tự `GATEWAYS`. Có `manage`: `GatewayConfig` đã che; chỉ có `link.create`: `{ gateway, configured }` |
| `PUT /gateways/:gateway` | `payment.gateway.manage` | Lưu đủ các ô của cổng theo `version` (0 = tạo); nhật ký `create`/`update` không có giá trị khoá |
| `POST /orders/:orderId/links` | `payment.link.create` | Tạo mã (201) hoặc trả mã còn hạn (200); nhật ký `create` |
| `GET /transactions`, `GET /transactions/:id` | `payment.transaction.view` | Giao dịch cổng; `receipt`, `unmatchedReceiptId` lấy qua `ctx.financeRefsOf` (finance, tiêm ở `src/wiring.ts`) |
| `POST /dev/simulate/:paymentCode` | `payment.link.create` | Mô phỏng trả đủ tiền (demo, E2E), đi đúng đường webhook; **không gắn ở production** |
| `GET /webhooks/vnpay`, `POST /webhooks/{momo,zalopay}`, `POST /webhooks/sepay/:receiverKey` | không token | Webhook của cổng (mục Webhook dưới) |
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
| `markPaid(orderId, by)` | chỉ finance (webhook, gán khoản thu) | `unpaid` → `paid`, mã `active`/`expired` → `paid`; lệch → 409 |
| `recordGatewayTransaction(payment, status)` | chỉ finance (handler webhook) | Ghi `webhook_events` rồi `payment_transactions`; trùng → `duplicate` |
| `markCodCollected(orderIds)` | chỉ finance (xác nhận COD) | Cả lô `cod_pending` đã giao → `cod_collected`; lệch → 409 kèm `orders: [{ orderId, status }]` (finance gắn mã đơn); khoá theo thứ tự `order_id` |
| `markRefunded(orderId)` | chỉ finance (ghi sổ phiếu chi hoàn tiền) | `pending_refund` → `refunded`; lệch → 409 kèm `current` |
| `listOrderPayments(filter)`, `getPaymentTransactions(ids)`, `getOrderPaymentView(companyId, orderId)` | chỉ finance (danh sách COD, hoàn tiền; cổng của phiếu thu; `current` của 409) | Đọc, trong `withCompany` |
| `getDailyPaymentFees({ from, to })` | report (#29) | Phí cổng theo ngày giờ VN và đơn, từ giao dịch `succeeded` có `fee` |
| `revertPaid`, `revertRefunded` | — | Khung 501, chờ UC-PF-09 |

`markRefundPending`, `markCodNotCollected` trả 404 cho đơn sàn (không có trạng thái tiền) và đơn công ty khác: #25 không gọi cho đơn sàn; `markDelivered` với đơn không có dòng thì bỏ qua. **Thứ tự khoá cho mọi hàm trên:** bên gọi đổi `sales.orders` trước (giữ khoá dòng đơn), rồi mới gọi hàm payment (khoá `order_payments`), cùng giao dịch; ngược lại thì deadlock với tạo mã, webhook, COD (đơn trước, `order_payments` sau). Mọi hàm phải gọi trong `withCompany` (ngoài đó là role chủ bảng, RLS không có hiệu lực).

Payment gọi `sales.getOrderForPayment(orderId, { lock?: 'share' })` để đọc đơn.

## Bất biến

- **Khoá cổng là bí mật (T4):** API chỉ trả `{ last4 }` mỗi ô, kể cả trong `current` của 409. Không ghi giá trị khoá vào nhật ký thao tác, log, Problem Details. Không đưa khoá thô làm tham số SQL (`DrizzleQueryError` chép tham số vào `message`, lỗi lạ bị log).
- `credentials_enc` = AES-256-GCM bằng `PAYMENT_CREDENTIALS_KEY` (`service/credentials-cipher.ts`), AAD `"<companyId>:<gateway>"`: bản mã chép sang công ty hay cổng khác không giải mã được. Máy thiếu biến → 500 `payment_credentials_key_missing`.
- Ô khoá theo cổng: `CredentialsByGateway` (`api/schemas.ts`), cũng là schema Swagger; ô bí mật tối thiểu 8 ký tự. Danh sách cổng và kiểu `Gateway`: `domain/gateways.ts` (`GATEWAYS`, trùng enum `payment.gateway`).
- URL webhook SePay = `<PUBLIC_API_URL>/api/v1/payment/webhooks/sepay/<webhook_receiver_key>`; chưa đặt `PUBLIC_API_URL` thì `null`.
- **Mã thanh toán** (`service/payment-links.ts`): mỗi đơn tối đa một mã `active` còn hạn (15 phút); `payment_code` `CM` + 10 ký tự, unique toàn hệ thống. Tạo mã ba bước: đọc và kiểm luật trong giao dịch → gọi cổng **ngoài** giao dịch (10 giây) → ghi trong giao dịch có khoá. Thứ tự khoá: dòng `sales.orders` (`FOR SHARE`) trước, `order_payments` (`FOR UPDATE`) sau, cùng chiều với huỷ đơn; ngược chiều thì deadlock. Hai yêu cầu song song: unique một phần chặn, bên thua trả 200 mã của bên thắng.
- Luật được tạo mã: `domain/link-rules.ts` (luật theo đơn kiểm trước khi trả mã còn hạn; luật theo cổng, hạn mức MoMo 1.000–50.000.000 đ, kiểm sau). Mã `active` quá hạn hiện `expired` khi đọc, chỉ đổi DB khi tạo mã mới (#27 tra cứu quá hạn).
- Cổng (Strategy + Factory, docs/16 #9): `service/gateways/` — `PaymentGateway` có `createPayment`, `codeOf` (mã trong callback, trước khi biết công ty), `readCallback` (kiểm chữ ký bằng khoá công ty, bỏ trường chữ ký khỏi payload), `respond` (định dạng phản hồi riêng của cổng), `queryPayment` (tra cứu). VNPay, VietQR không gọi mạng khi tạo mã; MoMo, ZaloPay gọi sandbox. Không chép `message` của cổng vào lỗi (MoMo lặp lại chuỗi ký).
- Payment gọi `sales`, `staff`, `audit`; **không** gọi `finance` (webhook giao cho finance qua `ctx.onVerifiedPayment`, A11 của PR chuẩn bị).

## Webhook (#27, Documents/21 §12.4, D16)

`service/webhooks.ts`: (1) lấy mã thanh toán (`codeOf`), SePay lấy công ty từ `receiverKey`; (2) tìm mã/công ty **mọi công ty** bằng role chủ bảng (`findLinkByCodeAnyCompany`, `findCompanyByReceiverKey`; cùng `findOverdueLinksAnyCompany` của tra cứu quá hạn là ba chỗ duy nhất đọc chéo công ty, đều ném lỗi nếu gọi trong `withCompany` trừ `findCompanyByReceiverKey`); (3) `withCompany`: lấy khoá, `readCallback` — sai chữ ký thì `warn` và dừng, không ghi gì; mã thuộc cổng khác hoặc công ty chưa cấu hình cổng = không thấy mã; (4) giao cho finance qua `ctx.onVerifiedPayment` trong cùng giao dịch. Mọi nguồn dùng `eventKey = gatewayTxnId` (webhook, tra cứu, `sim:<mã>`). Phản hồi theo cổng (route tự đặt `res.status`, ngoại lệ có chủ đích). Lỗi lạ → mã "lỗi" của cổng để cổng gửi lại.

Tra cứu quá hạn (`service/overdue-query.ts`, `startBackground` của module, chạy trong worker): mỗi 60 giây, tối đa 20 mã `active` quá hạn ≤ 24 giờ; gọi cổng ngoài giao dịch; đã trả → như webhook `source=query` (không ghi được phiếu thu thì mã cũng `expired`), chưa trả → `expired`; cổng lỗi thì mã xuống cuối hàng chờ. Mã giao dịch cổng trùng với dòng của công ty khác (unique toàn hệ thống) → lỗi, không báo "đã xử lý". Không giữ advisory lock (chống trùng ở DB).

Giới hạn: access log `pinoHttp` ghi URL webhook (chữ ký VNPay, `receiverKey` SePay); che ở PR dọn dẹp sau đợt (`src/shared/logger.ts`). Webhook thật trên máy dev cần URL HTTPS công khai: `cloudflared tunnel --url http://localhost:<API_PORT>`, đặt `PUBLIC_API_URL` bằng URL đó rồi khởi động lại api.

## Test

Test không gọi mạng: `vi.spyOn(globalThis, 'fetch')` cho MoMo, ZaloPay. Helper riêng: `test/integration/payment/helpers.ts` (`shop`, `order`). Env đọc một lần lúc import: file test cần khoá đặt `PAYMENT_CREDENTIALS_KEY` (và `PUBLIC_API_URL` nếu kiểm URL) trong `vi.hoisted` trước import, không dùng import trong khối đó (`test/integration/payment/gateway-configs.test.ts`).
