# src/modules/order/sales/

Đơn bán 4 trạng thái kèm cờ, khách hàng, yêu cầu trả. Bảng trong schema `order`. Hợp đồng API: `Documents/21` §19.1, §19.3.

## Đơn

Máy trạng thái ở `domain/order.ts`, cùng bảng FE `src/lib/machines/order.ts`: `unpaid` → `processing` (`pay` hệ thống, `confirm` đơn COD tay) → `completed` (`complete` hệ thống); huỷ từ `unpaid`, `processing` (`cancel` đơn tay, `platform_cancel` sàn, `cancel_on_platform` người bán huỷ đơn sàn). Mọi lần chuyển ghi `core.state_transitions` (`entity_type = 'orders'`).

- **Cờ lưu:** `needs_attention`, `cancel_requested`, `cancelling`, `platform_cancelled`, `shop_disconnected`. **Cờ suy ra** lúc đọc (`service/orders.ts`): `unmapped_sku` (dòng `variant_id` trống), `due_soon` (còn kiện chưa rời kho, dưới 24 giờ tới `ship_by`), `return_requested` (yêu cầu trả còn mở: `requested`, `awaiting_return`, `received`). `cod_mismatch` chưa có nguồn.
- **Giai đoạn hiển thị** `stageOf` và **lý do chưa hoàn tất** `completionBlocker` suy từ kiện. Danh sách phân trang trong SQL; cờ lưu, `unmapped_sku`, `return_requested` lọc bằng SQL; chỉ giai đoạn suy từ kiện và `due_soon` lọc trong bộ nhớ, trên 1.000 đơn chưa dừng mới nhất (`DERIVED_SCAN`).
- **Trạng thái thanh toán** `paymentStatus` (#234, §21.2) đọc qua `ctx.paymentStatusOf` (finance tiêm ở `src/wiring.ts`; sales không đọc bảng finance), đơn chưa có dòng là `none`; `mismatch` thì cờ `payment_mismatch`. Cờ này không lọc được ở `GET /sales/orders?flag=` (lọc ở `/finance/payments?status=mismatch`). Trạng thái đơn không đổi theo trạng thái thanh toán.
- Tiền lưu `numeric`, API trả số nguyên đồng.

## Nhận đơn sàn (#105)

`service/ingest.ts` `ingestMarketplaceOrder(order)`, gọi trong `withCompany`; channel gọi từ lượt kéo định kỳ (không có push, #133 đóng). Một đơn một giao dịch: đơn, dòng (mỗi món Lazada một dòng số lượng 1), kiện, giữ hàng, lịch sử, outbox.

- Chèn `on conflict do nothing` rồi khoá đọc lại: hai lần kéo cùng đơn chỉ tạo một đơn. Mã `DH-000001`, mã kiện `KH-000001` từ `order.doc_counters`.
- Sàn đã trả (mọi trạng thái trừ `unpaid`) → `pay`. Cả đơn bị huỷ: chưa kiện nào đóng gói → `platform_cancel`, phát `sales.order_cancelled`; còn kiện đã đóng gói → cờ `cancelling` (mở kiện là #106); có kiện đã rời kho → cờ `platform_cancelled`.
- Kiện do `fulfillment/service/platform-packages.ts`: mỗi mã kiện sàn một kiện, kiện tạm nhận mã ở lần sau; trạng thái kiện là món chậm nhất; sàn nhảy cóc trên đường chính thì áp thẳng (`platform_sync`), không áp được thì cờ kiện cần xử lý. Giữ hàng qua `fulfillment/service/stock-port.ts` (cổng thật của inventory, #206); kiện vào nhóm rời kho thì fulfillment trừ tồn (#199 phần a, `fulfillment/CLAUDE.md`). `PlatformOrder.holdStock = false` (gian hàng chờ kiểm kê đầu kỳ) thì không gọi `reserve`, kiện rời kho thì hoãn trừ; `PlatformOrder.orderCutoffAt` (mốc kéo đơn, channel truyền) quyết kiện lần đầu thấy đã rời kho có trừ tồn không.
- Phát `sales.order_created`, `sales.order_status_changed` (kèm cờ), `fulfillment.package_status_changed`.

## Thao tác đơn sàn (#105 PR 2, §19.3)

`service/cancel.ts`: `cancel-reasons`, `platform-cancel`, `cancel-request` (`sales.order.cancel`), `invoice-number` (`sales.order.create`). Thứ tự: đọc đơn → kiểm `version` (409 trước khi gọi sàn) → máy trạng thái → gọi sàn ngoài giao dịch qua `ctx.marketplaceOrders` (channel, tiêm ở `src/wiring.ts`) → ghi theo `version` kèm `recordAudit` (`order.orders`) và `sales.order_status_changed`.

- Người bán huỷ, hay đồng ý khách xin huỷ: đơn giữ trạng thái, cờ `cancelling`; đơn sang `cancelled` khi lần kéo sau thấy sàn báo huỷ (Thành chốt 29/10/2026). `reasonId` phải nằm trong danh sách sàn trả lúc gửi (hỏi lại sàn), không thì 422.
- Số hoá đơn chỉ lưu, chưa gửi `SetInvoiceNumber`.

## Tự hoàn tất (#105 PR 2)

`service/complete.ts`, mỗi giờ trong worker (`startBackground`): đơn `processing`, không `cancelling`, mọi kiện dừng, qua 7 ngày từ kiện giao cuối, không còn yêu cầu trả mở → `complete` (người làm trống, `source = system`), ghi `outcome`, `completed_at`, `return_window_ends_at`. Đơn COD tay chờ kế toán (`cod_unconfirmed`) chưa có nguồn.

## Yêu cầu trả (#202, §20, §20.1, 25 §9)

Máy trạng thái ở `domain/return.ts` (bảng §20): `requested` → `awaiting_return` (`accept`), `rejected` (`reject`), `refund_only`; `rejected` → `awaiting_return` (`platform_reopen`), `refund_only` (`platform_refund`), chỉ yêu cầu từ sàn; `awaiting_return` → `received` (`receive`, chỉ qua quét), `closed` (`no_show`); `received` → `closed` (`close`, hệ thống khi kiểm hàng hoàn xong); khách rút → `closed` (`buyer_cancel`). Mọi lần chuyển ghi `core.state_transitions` (`entity_type = 'return_requests'`). Còn mở = `requested`, `awaiting_return`, `received` (cờ `return_requested`, chặn tự hoàn tất; `hasOpenReturns` cho module khác).

- Route ở router riêng `returnsModule` (tên `returns`, gắn `/api/v1/returns`), cùng module con: `api/return-*.ts`, `service/returns.ts` (xem, thao tác), `service/return-receive.ts` (quét nhận, kiện không khớp mã `KTL-`), `service/return-ingest.ts` (từ sàn).
- Thao tác trên yêu cầu từ sàn: kiểm `version` → máy trạng thái → gọi sàn ngoài giao dịch (`ctx.marketplaceReturns`, channel tiêm ở `src/wiring.ts`) → ghi. `reject` cần `reasonId` trong danh sách sàn trả lúc gửi.
- Kho: `service/return-stock-port.ts` (`ReturnStockPort`, chữ ký 11/11/2026 `{ variantId, expected, scanned }`). Bản thật gọi thẳng `receiveBack` của inventory (#208): nguồn `return_request`, `unmatched_parcel`, `meta.fromUnmatchedParcelId` chuyển phiếu của kiện sang yêu cầu.
- Từ sàn: channel gọi `ingestMarketplaceReturn` sau mỗi lượt kéo đơn. Tạo ở `requested` (mã `YCT-`, dòng theo dòng đơn, kiện, giá vốn bình quân) rồi đi tới trạng thái sàn bằng `syncAction`; sàn tới trạng thái không có mũi tên thì giữ, bật Cần xử lý; sàn báo `received` thì chờ kho quét. Kiện còn đang giao nhảy tới `delivered` (`deliverForReturn` của fulfillment).
- Loại (`kind`): `return` hoặc `refund` (chỉ hoàn tiền, Lazada `ONLY_REFUND`): `refund` không có `accept` (guard `refund_only_request`), từ chối theo lý do `refuse-refund`.
- Sàn báo hàng đã về (`received`) khi app còn `requested`/`rejected`: đi `accept`/`platform_reopen` của sàn tới `awaiting_return`, chờ quét. `rejected` rồi sàn báo khách huỷ: giữ `rejected` (như TikTok). Kéo lại không đổi gì thì không ghi.
- Kiện của dòng: luồng chính nhảy tới `delivered`; `returning`, `lost` (hoặc chưa rời kho) giữ nguyên, yêu cầu và đơn bật cờ; mọi kiện của dòng `returned` thì dòng mang `package_returned` (E109): quét yêu cầu mà mọi dòng đã hoàn đi như kiện không khớp. Giá vốn chỉ tính dòng kiện đã giao.
- Tiền: `refund_only`, `platform_refund`, `close` đặt `refunded` và phát `sales.return_refunded`. Consumer `sales-return-inspected` nghe `inventory.return_inspected`: chia số bán lại về dòng (`resell_qty`), `resell_cost`, đóng `inspected`.

## Cho module khác

`orderRefsOf` (fulfillment, qua `ctx` do `order/index.ts` tiêm: thông tin đơn cho route kiện), `getOrderForPayment` (payment), `getOrdersForFinance`, `findMarketplaceOrders`, `getOrderLines` (finance), `getOrderChannels` (report), `ingestMarketplaceOrder`, `ingestMarketplaceReturn`, `countOpenOrders` (channel, chặn ngắt gian hàng #207). `hasOpenReturns` (§11.3). `ctx.shopsOf` (tên gian hàng) tiêm ở `src/wiring.ts`.

## Chưa làm

Đơn tạo tay, `confirm`, `cancel` đơn tay (issue riêng). Yêu cầu trả tạo tay (`POST /returns`, `/returns/returnable`, ngoài MVP), nhắc việc `return.*` (chờ #209), tệp đính kèm (#212).
