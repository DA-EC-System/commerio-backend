# src/modules/order/sales/

Đơn bán 4 trạng thái kèm cờ, khách hàng, yêu cầu trả. Bảng trong schema `order`. Hợp đồng API: `Documents/21` §19.1, §19.3.

## Đơn

Máy trạng thái ở `domain/order.ts`, cùng bảng FE `src/lib/machines/order.ts`: `unpaid` → `processing` (`pay` hệ thống, `confirm` đơn COD tay) → `completed` (`complete` hệ thống); huỷ từ `unpaid`, `processing` (`cancel` đơn tay, `platform_cancel` sàn, `cancel_on_platform` người bán huỷ đơn sàn). Mọi lần chuyển ghi `core.state_transitions` (`entity_type = 'orders'`).

- **Cờ lưu:** `needs_attention`, `cancel_requested`, `cancelling`, `platform_cancelled`, `shop_disconnected`. **Cờ suy ra** lúc đọc (`service/orders.ts`): `unmapped_sku` (dòng `variant_id` trống), `due_soon` (còn kiện chưa rời kho, dưới 24 giờ tới `ship_by`), `return_requested` (yêu cầu trả chưa đóng, chưa từ chối). `cod_mismatch` chưa có nguồn.
- **Giai đoạn hiển thị** `stageOf` và **lý do chưa hoàn tất** `completionBlocker` suy từ kiện. Danh sách phân trang trong SQL; cờ lưu, `unmapped_sku`, `return_requested` lọc bằng SQL; chỉ giai đoạn suy từ kiện và `due_soon` lọc trong bộ nhớ, trên 1.000 đơn chưa dừng mới nhất (`DERIVED_SCAN`).
- Tiền lưu `numeric`, API trả số nguyên đồng.

## Nhận đơn sàn (#105)

`service/ingest.ts` `ingestMarketplaceOrder(order)`, gọi trong `withCompany`; channel kéo định kỳ và push (#133) dùng chung. Một đơn một giao dịch: đơn, dòng (mỗi món Lazada một dòng số lượng 1), kiện, giữ hàng, lịch sử, outbox.

- Chèn `on conflict do nothing` rồi khoá đọc lại: hai lần kéo cùng đơn chỉ tạo một đơn. Mã `DH-000001`, mã kiện `KH-000001` từ `order.doc_counters`.
- Sàn đã trả (mọi trạng thái trừ `unpaid`) → `pay`. Cả đơn bị huỷ: chưa kiện nào đóng gói → `platform_cancel`, phát `sales.order_cancelled`; còn kiện đã đóng gói → cờ `cancelling` (mở kiện là #106); có kiện đã rời kho → cờ `platform_cancelled`.
- Kiện do `fulfillment/service/platform-packages.ts`: mỗi mã kiện sàn một kiện, kiện tạm nhận mã ở lần sau; trạng thái kiện là món chậm nhất; sàn nhảy cóc trên đường chính thì áp thẳng (`platform_sync`), không áp được thì cờ kiện cần xử lý. Giữ hàng qua `fulfillment/service/stock-port.ts` (bản "chưa giữ được" tới khi #111 có `reserve`).
- Phát `sales.order_created`, `sales.order_status_changed` (kèm cờ), `fulfillment.package_status_changed`.

## Thao tác đơn sàn (#105 PR 2, §19.3)

`service/cancel.ts`: `cancel-reasons`, `platform-cancel`, `cancel-request` (`sales.order.cancel`), `invoice-number` (`sales.order.create`). Thứ tự: đọc đơn → kiểm `version` (409 trước khi gọi sàn) → máy trạng thái → gọi sàn ngoài giao dịch qua `ctx.marketplaceOrders` (channel, tiêm ở `src/wiring.ts`) → ghi theo `version` kèm `recordAudit` (`order.orders`) và `sales.order_status_changed`.

- Người bán huỷ, hay đồng ý khách xin huỷ: đơn giữ trạng thái, cờ `cancelling`; đơn sang `cancelled` khi lần kéo sau thấy sàn báo huỷ (Thành chốt 29/10/2026). `reasonId` phải nằm trong danh sách sàn trả lúc gửi (hỏi lại sàn), không thì 422.
- Số hoá đơn chỉ lưu, chưa gửi `SetInvoiceNumber`.

## Tự hoàn tất (#105 PR 2)

`service/complete.ts`, mỗi giờ trong worker (`startBackground`): đơn `processing`, không `cancelling`, mọi kiện dừng, qua 7 ngày từ kiện giao cuối, không còn yêu cầu trả mở → `complete` (người làm trống, `source = system`), ghi `outcome`, `completed_at`, `return_window_ends_at`. Đơn COD tay chờ kế toán (`cod_unconfirmed`) chưa có nguồn.

## Cho module khác

`getOrderForPayment` (payment), `getOrdersForFinance`, `findMarketplaceOrders`, `getOrderLines` (finance), `getOrderChannels` (report), `ingestMarketplaceOrder` (channel). `ctx.shopsOf` (tên gian hàng) tiêm ở `src/wiring.ts`.

## Chưa làm

Đơn tạo tay, `confirm`, `cancel` đơn tay (issue riêng); thao tác kiện của người dùng, trừ tồn khi kiện rời kho (#106).
