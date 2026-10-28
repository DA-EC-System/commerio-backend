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

## Phiên bản cấu hình tiền (#118, D4.4)

- **Bảng** `config_versions`: một dòng mỗi phiên bản của một ô (công ty, `kind`, gian hàng; chỉ `fee` có gian hàng). `payload` kiểm bằng Zod theo `kind` (`domain/config-version.ts`, lỗi trả dưới ô `payload.<trường>`). Hợp đồng: `Documents/21` §21.0, §21.4.
- **Máy trạng thái** `configMachine`: `draft → pending_approval → scheduled → active → expired`, nhánh `rejected`, `cancelled`, trả về `draft`. Gửi duyệt cần đã chạy thử (422 `dry_run_required`); duyệt, trả về, từ chối cần người khác người soạn, chỉ duyệt có ngoại lệ tự duyệt (CEO, công ty một người, ghi `self_approved`); huỷ chỉ trước ngày hiệu lực (409 `config_already_effective`).
- **Dòng thời gian của ô:** ràng buộc `config_versions_no_overlap` (EXCLUDE trên `scheduled`, `active`) cấm hai khoảng ngày chồng nhau, mà `effective_to` null là vô hạn. Nên lúc **duyệt** đã cắt `effective_to` của bản đứng trước về ngày trước bản mới (`placeInTimeline`); huỷ bản `scheduled` thì nới lại sau khi bản đó rời `scheduled`. Trùng ngày hiệu lực mà không phải bản sửa lỗi của chính bản đó: 409 `config_overlap`. Mọi thao tác trên một ô khoá advisory `finance.config:<công ty>:<kind>:<gian hàng>`.
- **Áp dụng:** duyệt bản đã tới ngày (giờ Việt Nam) thì áp ngay; còn lại việc nền `startFinanceBackground` mỗi 5 phút (khoá phiên `finance.config_activation`) chuyển `scheduled → active`, bản `active` đã kết thúc trước ngày đó và bản bị sửa lỗi sang `expired`, phát `finance.fee_config_activated`.
- **Chọn theo ngày:** `getEffectiveConfig(kind, shopId, day)` (export ở `index.ts`, gọi trong `withCompany`) cho sổ tiền #116; bản bị một bản sửa lỗi đã áp dụng thay thế thì bỏ.
- **Chạy thử** không ghi sổ: lãi 30 ngày theo `ledger_entries` (dòng chưa bị thay) và lãi nếu áp bản này (phí, thuế đổi bao nhiêu phần trăm doanh thu). `listingsRepriced`, `belowFloor` null tới khi C2 (#104) có giá theo sàn. Điều chỉnh hồi tố cho bản sửa lỗi cần sổ tiền: làm ở #116.
- **Quyền** (§21.0): xem có ít nhất một quyền `finance.config.*`, `finance.settlement.*`, `finance.invoice.view`; soạn, chạy thử, gửi, huỷ `finance.config.manage`; duyệt, trả về, từ chối `finance.config.approve`.

## Sổ tiền theo đơn (#116, D4.1)

- **Bảng** `ledger_entries`, chỉ thêm (role ứng dụng không UPDATE, DELETE): mỗi khoản một dòng, số có dấu (vào dương, ra âm), `is_estimate`; số thật về thì dòng thực tế trỏ `replaces_entry_id` về dòng ước tính (unique), sai thì thêm dòng `adjustment` có `reason`. Hợp đồng: `Documents/21` §21.1, sự kiện §11.2.
- **Luật ghi** (`domain/ledger.ts`, thuần, `25` §10.1): kiện giao xong → doanh thu theo giá bán, trợ giá sàn, ship, bốn loại phí theo cấu hình phí của gian hàng, thuế sàn khấu trừ (chỉ hộ kinh doanh, cá nhân: GTGT + TNCN của quy tắc thuế), giá vốn; kiện hoàn về → phí khi hoàn; hoàn tiền khách; kiểm hàng về → giảm giá vốn phần bán lại được. Làm tròn tới đồng, dòng 0 đồng không ghi. Chưa có cấu hình thì không ước tính khoản đó. Dòng phí, thuế lưu `config_version_id` (phiên bản theo ngày phát sinh, `getEffectiveConfig`).
- **Ghi theo sự kiện** (`service/ledger.ts`: `recordPackageDelivered`, `recordPackageReturned`, `recordReturnRefunded`, `recordReturnInspected`, export ở `index.ts`): mỗi nguồn (`source_type`, `source_id`) ghi một lần, khoá advisory `finance.ledger:<công ty>:<loại>:<id>`, phát lại không ghi trùng. Loại sự kiện chưa có trong danh mục (#106, #107, #112 thêm): khi có thì đăng ký consumer gọi các hàm này.
- **Đọc:** `GET /ledger` (lọc ước tính, thực tế, đã thay, loại, gian hàng, đơn, ngày; tổng `receivable` là ước tính đang ở sàn, `platformBalance` là thực tế), `GET /orders/:orderId/profit` (`25` §10.2, chỉ phần đã giao), `GET /tax-warnings` (luỹ kế năm so với mốc của quy tắc thuế, từ 90%). Không có `inventory.cost.view` thì bỏ dòng giá vốn, `cogs`, `gross` null (R4). Quyền xem dùng chung `api/access.ts` với cấu hình.
- **Chưa làm (PR sau của #116):** xuất kiểu MISA, dự báo tiền, chia quảng cáo cho lãi đóng góp, chuyển hoá đơn, phiếu thu chi cũ sang sổ, `committedPurchase` của tổng.

## Đối soát quyết toán, trạng thái tiền của đơn (#117, D4.2, D4.3)

Hợp đồng: `Documents/21` §21.2 (OrderPayment), §21.3 (SettlementRun, khớp sao kê). Thay dần đối soát bảng kê #30 (TikTok, còn giữ vì FE `e2e:be` đối soát còn dùng).

- **Kéo quyết toán** (`service/settlement-runs.ts`): `POST /settlement-runs` trả 202 rồi chạy nền; vòng nền 6 giờ (`startFinanceBackground`, khoá phiên `finance.settlement_pull`) kéo mọi gian hàng `active`. Mỗi gian hàng một lần chạy `running` (khoá advisory, 409 `settlement_running`), kỳ từ `period_to` của lần `done` gần nhất (chưa có thì 30 ngày trước) tới lúc bấm; lần lỗi để `failed` kèm `error`, lần sau kéo lại từ mốc cũ. Gọi sàn ngoài giao dịch qua `ctx.settlementSource` (channel), ghi trong `withCompany`. Nhập từ tệp (`fileId`) chưa làm: 422 `file_import_unsupported`.
- **Ghi sổ:** mỗi giao dịch của sàn một dòng thực tế, loại theo `kindOfTransaction` (`domain/settlement.ts`, không nhận ra thì `adjustment` kèm `reason` = tên khoản); thuế khấu trừ tách dòng `withholding_tax` mã `<txnId>:wht`. Trùng mã (`external_transaction_id`, unique theo công ty) thì bỏ, đếm vào `duplicates`. Dòng thực tế nối `replaces_entry_id` về dòng ước tính cùng đơn, cùng loại theo thứ tự; đơn đã có dòng thực tế thì mọi dòng ước tính của đơn coi như đã thay (`isReplaced`). Rút tiền về ngân hàng là `withdrawal`: không gắn đơn, không tính lãi (`NOT_PROFIT`), cộng vào tổng `withdrawn`. `walletDiff` của lần chạy = số dư cuối kỳ của sàn − `platformBalance` của sổ (chưa gắn cờ lệch ví lên gian hàng).
- **Trạng thái tiền** (`order_settlements`, `settlementMachine`): `none → pending` khi kiện đầu giao xong; sau mỗi lần chạy tính lại `estimatedTotal`, `settledTotal`, `diff` (bỏ giá vốn, rút tiền) rồi `nextAfterSettlement`: trong ngưỡng `max(abs, |ước tính| × pct%)` của cấu hình `mismatch_threshold` → `settled`, quá → `mismatch`; `settled` lệch muộn, `resolved` lệch mới (so với `diff` lúc chốt) → `mismatch`; sàn thu tiền đơn chưa giao (`none`) → `mismatch`. Chưa có cấu hình ngưỡng thì lệch một đồng là lệch. Bước hệ thống ghi `state_transitions` nguồn `marketplace`.
- **Chốt lệch:** `POST /payments/:orderId/resolve` (`finance.settlement.resolve`, bắt lý do) người khác người soạn cấu hình phí đang áp dụng; lệch vượt `resolveLimit` (tính từ mốc lúc chốt trước) thì 409 `ceo_approval_required` tới khi `POST /payments/:orderId/ceo-approve` (`finance.settlement.approve`; không cần thì 409 `approval_not_needed`). Người duyệt tự chốt thì bỏ dấu duyệt.
- **Khớp sao kê:** `GET /bank-matching` (dòng thực tế `withdrawal`, `supplier_refund`, `lost_compensation`, lọc `matched`), `POST /ledger/:id/bank-match` ghi `bank_matches` một lần (409 `already_matched`, loại khác 422 `not_bank_matchable`); dòng sổ trả `bankMatch`.

## Gọi module khác

finance → payment (trạng thái tiền, giao dịch cổng), sales (`getOrdersForFinance`, `getOrderLines`, `getOrderForPayment`, `findMarketplaceOrders`), catalog (`getVariants` cho nhãn thuộc tính), staff (tên người), audit, platform (sự kiện). Không ai ở lớp dưới import finance: payment nhận hàm của finance qua `ctx`.

## API (gắn tại `/api/v1/finance`)

Xem: `finance.invoice.view`; ghi tiền: `finance.voucher.create` (T7; mặc định chỉ CEO có). Danh sách có `search` thì lọc trong bộ nhớ trên tập đã lọc theo DB (mã đơn, tên khách ở sales; A16). Chi tiết ở `api/openapi.ts`.

## Test

`test/integration/finance/` (helper riêng `helpers.ts`: `linkedOrder`, `paidOrder`, `refundPendingOrder`, `codOrder` dựng trạng thái theo đường thật). File dùng chúng đặt `PAYMENT_CREDENTIALS_KEY` trong `vi.hoisted`.
