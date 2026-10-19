# Module `finance`

Hoá đơn bán, phiếu thu, phiếu chi, khoản thu chưa khớp, đối soát (#30). Hợp đồng API: `Documents/21` mục 12 (12.5 API, 12.8 kiểu, 12.9 mã lỗi, T1–T30), mục 11 (hàm cho module khác). Chứng từ đã ghi sổ không sửa, chỉ lập chứng từ đảo (UC-PF-09, **chưa có issue**: `reversalOf`, `reversedBy` luôn `null`).

## Bảng

| Bảng | Ghi chú |
|---|---|
| `sales_invoices`, `sales_invoice_lines` | Hoá đơn tự sinh khi xuất kho (`issueInvoiceForOrder`). Dòng = dòng hàng của đơn; `total` = tổng đơn, gồm phí vận chuyển (`shippingFee` = tổng − dòng). Mỗi đơn tối đa một hoá đơn `posted` chưa đảo (unique một phần) |
| `receipts` | Phiếu thu, không có nháp. `source`: `gateway` (webhook, tra cứu), `cod`, `settlement` (#30), `unmatched_assignment`. Unique `payment_transaction_id` |
| `payment_vouchers` | Phiếu chi nháp → ghi sổ. Đúng một chứng từ gốc theo `purpose`; số tiền = số phải chi (T19). `supplier_payment` chưa làm (422) |
| `unmatched_receipts` | Tiền về không gán được: `no_payment_code`, `amount_mismatch`, `order_cancelled`. Luôn có `payment_transaction_id` |
| `doc_counters` | Số chứng từ `HD-`/`PT-`/`PC-` + 6 chữ số mỗi công ty; `next_number` là số kế tiếp sẽ cấp (cùng nghĩa `inventory.doc_counters`) |

## Luồng tiền (finance điều phối, payment giữ trạng thái; plan chuẩn bị A11)

- **Webhook, tra cứu, mô phỏng:** payment kiểm chữ ký rồi gọi `handleVerifiedPayment` (tiêm qua `ctx.onVerifiedPayment` ở `src/wiring.ts`). Quyết định ở `domain/payment-outcome.ts` (thuần): thất bại → giao dịch `failed`; không đơn / đơn huỷ / lệch tiền / đơn không `unpaid` → khoản thu chưa khớp; còn lại → `payment.markPaid` + phiếu thu + sự kiện `payment.succeeded`, `finance.receipt_posted`.
- **COD (T18):** `POST /cod-confirmations` tất cả hoặc không gì; mỗi đơn một phiếu thu `cod` = tổng đơn. `recordCodCollected` là cùng đường cho một đơn (#25 không gọi).
- **Hoàn tiền (T20):** `POST /refunds` (một bước) hoặc phiếu chi nháp → `/post`; ghi sổ gọi `payment.markRefunded`. Bên ghi sổ sau → 409 `already_processed` nêu số phiếu đã có.

**Thứ tự khoá (A4):** dòng `sales.orders` (`getOrderForPayment(id, { lock: 'share' })`, nhiều đơn thì theo id tăng dần) **trước**, rồi hàm payment khoá `order_payments`. Không khoá dòng đơn sau khi đã khoá `order_payments` (deadlock với tạo mã, huỷ đơn).

## Gọi module khác

finance → payment (trạng thái tiền, giao dịch cổng), sales (`getOrdersForFinance`, `getOrderLines`, `getOrderForPayment`), catalog (`getVariants` cho nhãn thuộc tính), staff (tên người), audit, platform (sự kiện). Không ai ở lớp dưới import finance: payment nhận hàm của finance qua `ctx`.

## API (gắn tại `/api/v1/finance`)

Xem: `finance.invoice.view`; ghi tiền: `finance.voucher.create` (T7; mặc định chỉ CEO có). Danh sách có `search` thì lọc trong bộ nhớ trên tập đã lọc theo DB (mã đơn, tên khách ở sales; A16). Chi tiết ở `api/openapi.ts`.

## Test

`test/integration/finance/` (helper riêng `helpers.ts`: `linkedOrder`, `paidOrder`, `refundPendingOrder`, `codOrder` dựng trạng thái theo đường thật). File dùng chúng đặt `PAYMENT_CREDENTIALS_KEY` trong `vi.hoisted`.
