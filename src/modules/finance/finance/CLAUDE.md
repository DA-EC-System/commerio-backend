# Module `finance`

Hoá đơn bán, phiếu thu, phiếu chi, khoản thu chưa khớp, đối soát (#30). Hợp đồng API: `Documents/21` mục 12 (12.5 API, 12.8 kiểu, 12.9 mã lỗi, T1–T30), mục 11 (hàm cho module khác). Chứng từ đã ghi sổ không sửa, chỉ lập chứng từ đảo (UC-PF-09, **chưa có issue**: `reversalOf`, `reversedBy` luôn `null`).

## Bảng

| Bảng | Ghi chú |
|---|---|
| `sales_invoices`, `sales_invoice_lines` | Hoá đơn tự sinh khi xuất kho (`issueInvoiceForOrder`). Dòng = dòng hàng của đơn; `total` = tổng đơn, gồm phí vận chuyển (`shippingFee` = tổng − dòng). Mỗi đơn tối đa một hoá đơn `posted` chưa đảo (unique một phần). Đơn không có dòng → 409 `order_has_no_lines` (#63 B16) |
| `receipts` | Phiếu thu, không có nháp. `source`: `gateway` (webhook, tra cứu), `cod`, `settlement` (#30), `unmatched_assignment`. Unique `payment_transaction_id` |
| `payment_vouchers` | Phiếu chi nháp → ghi sổ. Đúng một chứng từ gốc theo `purpose`; số tiền = số phải chi (T19). `supplier_payment` chưa làm (422) |
| `unmatched_receipts` | Tiền về không gán được: `no_payment_code`, `amount_mismatch`, `order_cancelled`. Luôn có `payment_transaction_id` |
| `doc_counters` | Số chứng từ `HD-`/`PT-`/`PC-` + 6 chữ số mỗi công ty; `next_number` là số kế tiếp sẽ cấp (cùng nghĩa `inventory.doc_counters`) |

## Luồng tiền (finance điều phối, payment giữ trạng thái; plan chuẩn bị A11)

- **Webhook, tra cứu, mô phỏng:** payment kiểm chữ ký rồi gọi `handleVerifiedPayment` (tiêm qua `ctx.onVerifiedPayment` ở `src/modules/finance/index.ts`). Quyết định ở `domain/payment-outcome.ts` (thuần): thất bại → giao dịch `failed`; không đơn / đơn huỷ / lệch tiền / đơn không `unpaid` → khoản thu chưa khớp; còn lại → `payment.markPaid` + phiếu thu + sự kiện `payment.succeeded`, `finance.receipt_posted`. Hai khoản khác nhau cùng trả một đơn song song: bên thua bị `markPaid` ném 409 → lùi savepoint, xử lý lại thành khoản thu chưa khớp `amount_mismatch`, cổng nhận "đã nhận" (#63 B21; giống khi tới tuần tự).
- **COD (T18):** `POST /cod-confirmations` tất cả hoặc không gì; mỗi đơn một phiếu thu `cod` = tổng đơn. `recordCodCollected` là cùng đường cho một đơn (#25 không gọi).
- **Hoàn tiền (T20):** `POST /refunds` (một bước) hoặc phiếu chi nháp → `/post`; ghi sổ gọi `payment.markRefunded`. Bên ghi sổ sau → 409 `already_processed` nêu số phiếu đã có.

**Thứ tự khoá (A4):** dòng `sales.orders` (`getOrderForPayment(id, { lock: 'share' })`, nhiều đơn thì theo id tăng dần) **trước**, rồi hàm payment khoá `order_payments`. Không khoá dòng đơn sau khi đã khoá `order_payments` (deadlock với tạo mã, huỷ đơn).

## Đối soát tiền sàn (#30, UC-PF-10)

- **Bảng:** `settlement_statements` (một bảng kê của sàn, unique mã bảng kê), `settlement_lines` (một giao dịch, unique `external_transaction_id` theo công ty, `raw` là bản gốc).
- **Ánh xạ** (`domain/tiktok-settlement.ts`, khuôn OAS TikTok, sàn giả lập dùng chung): số của sàn là số có dấu cộng lại ra tiền về. Lưu theo dấu kế toán: ô phí (7 ô `commission`…`other`, chuỗi `toFixed(2)`) và `shipping_cost` **dương = chi phí**, âm = sàn hoàn phí; `adjustment` dương = sàn trả thêm. Dấu của sàn thật chưa đo được (OAS mâu thuẫn): đổi một hằng `DEDUCTION_SIGN`. Báo cáo (#29) cộng thẳng `fees` như chi phí.
- **Khớp** (`domain/settlement-match.ts`, Documents/21 T23–T25, lệch T23 đã duyệt): dòng đơn — không thấy đơn (theo gian hàng + mã đơn sàn, `sales.findMarketplaceOrders`) → công thức `doanh thu − phí − vận chuyển + điều chỉnh = tiền về` → có hoàn (`refund_tagged`, không so doanh thu) → doanh thu = `orders.total` → `matched`. Dòng điều chỉnh, giữ lại chỉ kiểm công thức.
- **Phiếu thu** (D19, lệch T24 đã duyệt): dòng không lệch, tiền về dương, bảng kê `PAID` → một phiếu `settlement`; dòng âm không phiếu.
- **Nhận bảng kê** (`service/settlement-ingest.ts`, trong `withCompany`): khoá advisory theo công ty → upsert bảng kê (khác gian hàng → 422) → chèn dòng mới (trùng bỏ qua) → khớp lại mọi `order_not_found` của công ty → sinh phiếu còn thiếu. Một giao dịch.
- **API** (`api/settlement-*.ts`): cần thêm phân hệ Kênh bán (`module_disabled`); tên gian hàng qua `ctx.shopsOf` (`channel.getShops`, tiêm ở `src/wiring.ts`). `POST /settlements/dev/import` chỉ ngoài production. Kéo từ sàn (vòng lặp, `POST /settlements/run`) chờ sàn giả lập (#17, #19).

## Gọi module khác

finance → payment (trạng thái tiền, giao dịch cổng), sales (`getOrdersForFinance`, `getOrderLines`, `getOrderForPayment`, `findMarketplaceOrders`), catalog (`getVariants` cho nhãn thuộc tính), staff (tên người), audit, platform (sự kiện). Không ai ở lớp dưới import finance: payment nhận hàm của finance qua `ctx`.

## API (gắn tại `/api/v1/finance`)

Xem: `finance.invoice.view`; ghi tiền: `finance.voucher.create` (T7; mặc định chỉ CEO có). Danh sách có `search` thì lọc trong bộ nhớ trên tập đã lọc theo DB (mã đơn, tên khách ở sales; A16). Chi tiết ở `api/openapi.ts`.

## Test

`test/integration/finance/` (helper riêng `helpers.ts`: `linkedOrder`, `paidOrder`, `refundPendingOrder`, `codOrder` dựng trạng thái theo đường thật). File dùng chúng đặt `PAYMENT_CREDENTIALS_KEY` trong `vi.hoisted`.
