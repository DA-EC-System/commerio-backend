# src/modules/order/sales/

Đơn bán 4 trạng thái kèm cờ, khách hàng, yêu cầu trả. Bảng trong schema `order`. Hợp đồng API: `Documents/21` §19.1, §19.3.

## Đơn

Máy trạng thái ở `domain/order.ts`, cùng bảng FE `src/lib/machines/order.ts`: `unpaid` → `processing` (`pay` hệ thống, `confirm` đơn COD tay) → `completed` (`complete` hệ thống); huỷ từ `unpaid`, `processing` (`cancel` đơn tay, `platform_cancel` sàn, `cancel_on_platform` người bán huỷ đơn sàn). Mọi lần chuyển ghi `core.state_transitions` (`entity_type = 'orders'`).

- **Cờ lưu:** `needs_attention`, `cancel_requested`, `cancelling`, `platform_cancelled`, `shop_disconnected`. **Cờ suy ra** lúc đọc (`service/orders.ts`): `unmapped_sku` (dòng chưa ghép: `variant_id` trống và không `stock_untracked`, `unmappedLine` ở `repository/orders.ts`; spec 237), `due_soon` (còn kiện chưa rời kho, dưới 24 giờ tới `ship_by`), `return_requested` (yêu cầu trả còn mở: `requested`, `awaiting_return`, `received`). `cod_mismatch` chưa có nguồn.
- **Giai đoạn hiển thị** `stageOf` và **lý do chưa hoàn tất** `completionBlocker` suy từ kiện. Danh sách phân trang trong SQL; cờ lưu, `unmapped_sku`, `return_requested` lọc bằng SQL; chỉ giai đoạn suy từ kiện và `due_soon` lọc trong bộ nhớ, trên 1.000 đơn chưa dừng mới nhất (`DERIVED_SCAN`).
- **Chi tiết đơn** dựng kiện bằng `toPackageSummary` của fulfillment; tên người báo thất lạc (`lostReport.by.name`, #238) tra một lần cho mọi kiện của đơn qua `findAccountSummaries` (`core`), đơn không có báo cáo thì không truy vấn.
- **Trạng thái thanh toán** `paymentStatus` (#234, §21.2) đọc qua `ctx.paymentStatusOf` (finance tiêm ở `src/wiring.ts`; sales không đọc bảng finance), đơn chưa có dòng là `none`; `mismatch` thì cờ `payment_mismatch`. Cờ này không lọc được ở `GET /sales/orders?flag=` (lọc ở `/finance/payments?status=mismatch`). Trạng thái đơn không đổi theo trạng thái thanh toán.
- Tiền lưu `numeric`, API trả số nguyên đồng.

## Nhận đơn sàn (#105)

`service/ingest.ts` `ingestMarketplaceOrder(order)`, gọi trong `withCompany`; channel gọi từ lượt kéo định kỳ (không có push, #133 đóng). Một đơn một giao dịch: đơn, dòng (mỗi món Lazada một dòng số lượng 1), kiện, giữ hàng, lịch sử, outbox.

- Chèn `on conflict do nothing` rồi khoá đọc lại: hai lần kéo cùng đơn chỉ tạo một đơn. Mã `DH-000001`, mã kiện `KH-000001` từ `order.doc_counters`.
- Sàn đã trả (mọi trạng thái trừ `unpaid`) → `pay`. Cả đơn bị huỷ: chưa kiện nào đóng gói → `platform_cancel`, phát `sales.order_cancelled`; còn kiện đã đóng gói → cờ `cancelling` (mở kiện là #106); có kiện đã rời kho → cờ `platform_cancelled`, và không còn kiện chờ mở thì gỡ `cancelling` (`25` §8.2: đơn Đang huỷ có kiện hoá ra đã bàn giao, vd kho xác nhận không thấy kiện khi dỡ `lose_on_unload` (#238), đi theo "Sàn huỷ đơn khi đã có kiện bàn giao"). Còn kiện chờ mở thì `cancelling` giữ nguyên.
- Kiện do `fulfillment/service/platform-packages.ts`: mỗi mã kiện sàn một kiện, kiện tạm nhận mã ở lần sau; trạng thái kiện là món chậm nhất; sàn nhảy cóc trên đường chính thì áp thẳng (`platform_sync`), không áp được thì cờ kiện cần xử lý. Món mang trạng thái app chưa biết: đơn bật Cần xử lý, note `UNKNOWN_STATUS_NOTE` kèm mã thô; lượt sau sàn trả mọi món mã đã biết, không chia lại kiện, không kéo lại kiện thì gỡ cờ (chỉ cờ mang note này, kể cả dạng cũ không mã; #358). Cờ của luồng khác (yêu cầu trả) không tự gỡ. Giữ hàng qua `fulfillment/service/stock-port.ts` (cổng thật của inventory, #206); kiện vào nhóm rời kho thì fulfillment trừ tồn (#199 phần a, `fulfillment/CLAUDE.md`). `PlatformOrder.holdStock = false` (gian hàng chờ kiểm kê đầu kỳ) thì không gọi `reserve`, kiện rời kho thì hoãn trừ; `PlatformOrder.orderCutoffAt` (mốc kéo đơn, channel truyền) quyết kiện lần đầu thấy đã rời kho có trừ tồn không.
- `PlatformOrder.packageEvents` (hành trình kiện channel đọc ngoài giao dịch, #199 phần c) và `cancelKind` của món truyền nguyên xuống `syncPlatformPackages`. Sàn huỷ mọi món vì giao không thành (`cancelKind = 'failed_delivery'`): kiện sang `returning`, fulfillment báo `handed_over` nên đơn bật cờ `platform_cancelled`, không huỷ (sales không có luật riêng).
- **Huỷ dòng** (#205 PR 2, spec 205 §5.10): `order_lines.cancelled_qty` (CHECK `order_lines_cancelled_qty`: 0..`quantity`) **chỉ** luồng này ghi. Trước khi đồng bộ kiện đọc dòng đã huỷ đủ (`cancelledLineIds`) và truyền `alreadyCancelled` cho từng món; sau đồng bộ ghi `cancelled_qty = quantity` cho `cancelledLines` fulfillment trả (`markLinesCancelled`, dòng đã ghi thì không tăng `version`): món sàn huỷ mà kiện chưa rời kho (gỡ khỏi kiện, chờ bỏ, huỷ cùng kiện). Kiện đã rời kho thì giữ 0. Không suy ngược từ dòng kiện: trigger kiểm bằng của CSDL (`db/CLAUDE.md`) mới có tác dụng. Quyết huỷ cả đơn không đổi.
- **Khép đơn đang huỷ sau khi kho mở kiện huỷ** (`settleCancelledOrder`, spec 205 D24): fulfillment gọi qua `ctx` sau khi kiện đi `open_cancel`, giao dịch riêng. Đơn còn mở, cờ `cancelling`, mọi dòng `cancelled_qty = quantity`, không còn kiện chưa huỷ thì `platform_cancel` như lượt kéo (lý do "Sàn huỷ đơn", `sales.order_cancelled`, `sales.order_status_changed`); không thì không làm gì. Lý do: sàn đã huỷ xong nên không đổi `updated_at`, lượt kéo không chạy lại luật huỷ đơn.
- Phát `sales.order_created`, `sales.order_status_changed` (kèm cờ), `fulfillment.package_status_changed`.
- **Ghép SKU** (spec 237 §5.7, D14): channel tra `LineSku` theo dòng thắng của SKU người bán và truyền `variantId`, `untracked` ("không quản tồn" đã duyệt). Dòng đơn **chèn mới** ghi theo kết quả tra (`stock_untracked = !variantId && untracked`, `sku` null khi không biến thể). Dòng đơn **đã có** giữ ghép đã lưu: `upsertMarketplaceLines` trả ghép đã lưu, ghép truyền xuống `syncPlatformPackages` (dòng kiện lập mới khi sàn chia lại, gắn mã) lấy từ đó, không từ lần tra; đổi ghép đơn đã về là việc của `applySkuMapping`. Cờ `unmapped_sku` của sự kiện đọc từ dòng đã lưu (`hasUnmappedLines`).

## Ghép SKU áp lên đơn đã về (#237 PR 1)

Spec `docs/superpowers/specs/2026-11-17-237-ghep-sku-dong-don-design.md` §5.4. `service/sku-mapping.ts` `applySkuMapping({ shopId, sellerSku, to, actorId, holdStock, orderCutoffAt })` → `{ lines, orders, needsUnload }`; channel gọi trong giao dịch ghép đã khoá dòng gian hàng (`listings/match` áp ngay hoặc ghép đã đúng, `mapping/approve`).

- Chỉ chọn dòng **chưa ghép** (P1) của đơn thuộc gian hàng có `external_sku = sellerSku`, mọi trạng thái đơn (kiện bàn giao bắt buộc của đơn đã hoàn tất vẫn phải trừ); khoá dòng đơn theo id (`lockUnmappedLinesOfShopSku`, P4: dòng đơn trước kiện như luồng nhận đơn). Đơn gian hàng khác cùng SKU người bán, dòng đã ghép khác không đổi.
- Giao `remapPackageLines` của fulfillment mọi việc trên kiện, tồn; dòng đơn có kết quả `applied` (hoặc không có dòng kiện nào) thì ghi `variant_id`, `stock_untracked`, `sku` (= SKU người bán khi có biến thể, null khi "không quản tồn"). `kept`, `needs_unload` giữ nguyên (PR 1 không ra hai kết quả này cho dòng chưa ghép).
- Đơn `unpaid`, `processing` có dòng đổi phát `sales.order_status_changed` (`from = to`, cờ lưu cộng `unmapped_sku` nếu còn dòng chưa ghép); đơn đã dừng vẫn được ghi dòng, không phát (P6). Log `info` một dòng (gian hàng, SKU người bán, số dòng, số đơn, số kiện cần dỡ).
- Idempotent: gọi lại khi đã áp xong không chọn dòng nào, không ghi, không phát. Lỗi nào (cổng tồn, `40P01`, CHECK) cũng ném: cả giao dịch ghép rollback.

## Thao tác đơn sàn (#105 PR 2, §19.3)

`service/cancel.ts`: `cancel-reasons`, `platform-cancel`, `cancel-request`, `cancel-reject-reasons` (`sales.order.cancel`), `invoice-number` (`sales.order.create`). Thứ tự: đọc đơn → kiểm `version` (409 trước khi gọi sàn) → máy trạng thái → gọi sàn ngoài giao dịch qua `ctx.marketplaceOrders` (channel, tiêm ở `src/wiring.ts`) → ghi theo `version` kèm `recordAudit` (`order.orders`) và `sales.order_status_changed`.

- Người bán huỷ, hay đồng ý khách xin huỷ: đơn giữ trạng thái, cờ `cancelling`; đơn sang `cancelled` khi lần kéo sau thấy sàn báo huỷ (Thành chốt 29/10/2026). `reasonId` phải nằm trong danh sách sàn trả lúc gửi (hỏi lại sàn), không thì 422.
- Từ chối khách xin huỷ (#227): `rejectReasonId` lấy từ `cancel-reject-reasons` (sàn không có danh sách thì rỗng). Sales không biết sàn nào bắt buộc: channel đổi `reject_reason_required` của adapter (TikTok) sang 422 `errors.rejectReasonId`; Lazada bỏ qua trường này.
- Số hoá đơn chỉ lưu, chưa gửi `SetInvoiceNumber`.

## Tự hoàn tất (#105 PR 2)

`service/complete.ts`, mỗi giờ trong worker (`startBackground`): đơn `processing`, mọi kiện dừng, qua 7 ngày từ kiện giao cuối, không còn yêu cầu trả mở → `complete` (người làm trống, `source = system`), ghi `outcome`, `completed_at`, `return_window_ends_at`. Đơn COD tay chờ kế toán (`cod_unconfirmed`) chưa có nguồn.

- Đơn `cancelling` (#238, `25` §8.2): còn kiện chờ mở thì kiện đó chưa dừng nên chưa hoàn tất; mọi kiện đã dừng và có kiện không huỷ (kiện hoá ra đã bàn giao) thì hoàn tất như thường và ghi `cancelling = false`, không chờ lượt kéo đơn (đơn sàn không đổi có thể không được kéo lại). Mọi kiện đều huỷ thì không hoàn tất: đơn đó phải sang `cancelled`.

## Yêu cầu trả (#202, §20, §20.1, 25 §9)

Máy trạng thái ở `domain/return.ts` (bảng §20): `requested` → `awaiting_return` (`accept`), `rejected` (`reject`), `refund_only`; `rejected` → `awaiting_return` (`platform_reopen`), `refund_only` (`platform_refund`), chỉ yêu cầu từ sàn; `awaiting_return` → `received` (`receive`, chỉ qua quét), `closed` (`no_show`); `received` → `closed` (`close`, hệ thống khi kiểm hàng hoàn xong); khách rút → `closed` (`buyer_cancel`). Mọi lần chuyển ghi `core.state_transitions` (`entity_type = 'return_requests'`). Còn mở = `requested`, `awaiting_return`, `received` (cờ `return_requested`, chặn tự hoàn tất; `hasOpenReturns` cho module khác).

- Route ở router riêng `returnsModule` (tên `returns`, gắn `/api/v1/returns`), cùng module con: `api/return-*.ts`, `service/returns.ts` (xem, thao tác), `service/return-receive.ts` (quét nhận, kiện không khớp mã `KTL-`), `service/return-ingest.ts` (từ sàn).
- Thao tác trên yêu cầu từ sàn: kiểm `version` → máy trạng thái → gọi sàn ngoài giao dịch (`ctx.marketplaceReturns`, channel tiêm ở `src/wiring.ts`) → ghi. `reject` cần `reasonId` trong danh sách sàn trả lúc gửi.
- Kho: `service/return-stock-port.ts` (`ReturnStockPort`, chữ ký 11/11/2026 `{ variantId, expected, scanned }`). Bản thật gọi thẳng `receiveBack` của inventory (#208): nguồn `return_request`, `unmatched_parcel`, `meta.fromUnmatchedParcelId` chuyển phiếu của kiện sang yêu cầu.
- Từ sàn: channel gọi `ingestMarketplaceReturn` sau mỗi lượt kéo đơn. Tạo ở `requested` (mã `YCT-`, dòng theo dòng đơn, kiện, giá vốn bình quân) rồi đi tới trạng thái sàn bằng `syncAction`; sàn tới trạng thái không có mũi tên thì giữ, bật Cần xử lý; sàn báo `received` thì chờ kho quét. Kiện còn đang giao nhảy tới `delivered` (`deliverForReturn` của fulfillment).
- Loại (`kind`): `return` hoặc `refund` (chỉ hoàn tiền, Lazada `ONLY_REFUND`): `refund` không có `accept` (guard `refund_only_request`), từ chối theo lý do `refuse-refund`.
- Sàn báo hàng đã về (`received`) khi app còn `requested`/`rejected`: đi `accept`/`platform_reopen` của sàn tới `awaiting_return`, chờ quét. `rejected` rồi sàn báo khách huỷ: giữ `rejected` (như TikTok). Kho đã quét (`received`) mà sàn còn báo `awaiting_return` (TikTok `BUYER_SHIPPED_ITEM` tới khi sàn ghi nhận đã nhận): giữ, không bật cờ (#364). Kéo lại không đổi gì thì không ghi.
- Kiện của dòng: luồng chính nhảy tới `delivered`; `returning`, `lost` (hoặc chưa rời kho) giữ nguyên, yêu cầu và đơn bật cờ; mọi kiện của dòng `returned` thì dòng mang `package_returned` (E109): quét yêu cầu mà mọi dòng đã hoàn đi như kiện không khớp. Giá vốn chỉ tính dòng kiện đã giao.
- Tiền: `refund_only`, `platform_refund`, `close` đặt `refunded` và phát `sales.return_refunded`. Consumer `sales-return-inspected` nghe `inventory.return_inspected`: chia số bán lại về dòng (`resell_qty`), `resell_cost`, đóng `inspected`.

## Cho module khác

`orderRefsOf` (fulfillment, qua `ctx` do `order/index.ts` tiêm: thông tin đơn cho route kiện), `getOrder` (fulfillment qua `ctx.orderViewOf`: route tách kiện trả `Order`, #205), `nextPackageCode` (mã `KH-` kế tiếp; nhận đơn sàn và tách kiện qua `ctx.nextPackageCode` dùng chung một dãy, #205), `settleCancelledOrder` (fulfillment qua `ctx`: khép đơn đang huỷ sau `open_cancel`, #205 D24), `getOrderForPayment` (payment), `getOrdersForFinance`, `findMarketplaceOrders`, `getOrderLines` (finance), `getOrderChannels` (report), `ingestMarketplaceOrder`, `ingestMarketplaceReturn`, `countOpenOrders` (channel, chặn ngắt gian hàng #207). `applySkuMapping` (channel, ghép SKU có hiệu lực áp lên đơn đã về, #237). `hasOpenReturns` (§11.3). `orderArchiveBlockers(variantIds)` (catalog qua `ctx.orderArchiveBlockers` ở `src/wiring.ts`, #204): câu lý do chặn lưu trữ SKU, đơn `unpaid`/`processing` có dòng chưa huỷ hết (spec 204 D9), yêu cầu trả đang mở. `orderInUse(variantIds)` (cùng cách nối): SKU nằm trên dòng đơn, yêu cầu trả, dòng kiện, kiện trả không khớp ở mọi trạng thái (đọc bảng fulfillment bằng SQL, cùng schema); catalog không xoá hẳn sản phẩm có SKU này. `ctx.shopsOf` (tên gian hàng) tiêm ở `src/wiring.ts`.

## Chưa làm

Đơn tạo tay, `confirm`, `cancel` đơn tay (issue riêng). Yêu cầu trả tạo tay (`POST /returns`, `/returns/returnable`, ngoài MVP), nhắc việc `return.*` (chờ #209), tệp đính kèm (#212).
