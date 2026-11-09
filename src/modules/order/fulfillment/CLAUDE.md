# src/modules/order/fulfillment/

Kiện (giữ hàng, đóng gói, bàn giao, giao, hoàn), hàng trả không khớp, giá vốn theo đơn. Bảng trong schema `order`. Hợp đồng API: `Documents/21` §19.2; sự kiện §11.2; cổng tồn §11.1. Spec phần a của #199: `docs/superpowers/specs/2026-11-09-199a-ban-giao-tru-ton-design.md`; phần b: `docs/superpowers/specs/2026-11-09-199b-chia-hang-design.md`; phần c: `docs/superpowers/specs/2026-11-10-199c-giao-hoan-design.md`.

## Kiện và máy trạng thái

`domain/package.ts`, cùng bảng FE `src/lib/machines/order.ts`. Nhóm `HOLDING` (`reserved`, `packed`, `awaiting_pickup`: tính vào đang giữ), `HANDED_OVER` (`in_transit` … `lost`: tồn thực đã trừ), `SEALED` (đã đóng gói: huỷ phải mở kiện). Mọi lần chuyển ghi `core.state_transitions` (`entity_type = 'packages'`) và phát `fulfillment.package_status_changed` (key là `orderId`).

Kiện của đơn sàn lập và cập nhật ở `service/platform-packages.ts` (#105) trong giao dịch kéo đơn của channel: mỗi mã kiện sàn một kiện, trạng thái là món chậm nhất, sàn nhảy cóc trên đường chính thì áp thẳng (`platformUpdate`), không áp được thì cờ Cần xử lý.

## Trừ tồn khi kiện rời kho (#199 phần a)

**Một chỗ thi hành**: `service/handover-stock.ts`. Mọi đường vào đi qua đây, trong giao dịch của bên gọi, kiện đã khoá `FOR UPDATE`.

- `domain/handover.ts` (thuần): `stockEffectOf(from, to)` (vào nhóm rời kho → `ship`, ra → `reverse`), `handoverStockMode` (`deduct` / `store_only` / `defer`), `shipPlan` (dòng đã ghép SKU, chưa trừ; chia đã giữ và chưa giữ), `pickupUnconfirmed`.
- `settleHandover(pkg, { actorId, mode })`:
  - `store_only` ghi `handover_source = 'before_cutoff'`; `defer` không làm gì;
  - dòng chưa giữ thì thử `reserve`; không giữ được thì `ship` với `forced` (bàn giao bắt buộc, `25` §8.4): tồn thực có thể âm, cờ Tồn âm do inventory bật, kiện `handover_source = 'forced'`, `needs_attention` với ghi chú "Bàn giao bắt buộc…", log `warn`;
  - mỗi dòng vừa trừ chốt `unit_cost` = giá vốn bình quân (`stockOf` ngay sau `ship`), `stock_deducted = true`, `reserved_qty = 0`;
  - phát `fulfillment.package_shipped { packageId, orderId, lines: { variantId, quantity, unitCost } }`.
- Chốt "trừ đúng một lần": `stock_deducted` đổi trong cùng giao dịch, cộng lưới `packageLineId` của `ship`. Gọi lại không còn dòng chưa trừ thì không làm gì.
- `revertHandover`: `reverseShipment` đủ cả lượt (phiếu `DX`), dòng giữ hàng lại, kiện về `awaiting_pickup` cùng câu với xoá mốc bàn giao (CHECK), ghi `handover_reverted_by`.

**Sàn không kéo kiện ra khỏi nhóm rời kho**: `undo_handover` chỉ CEO làm (kèm đảo tồn). Kho quét mà sàn còn báo chờ lấy thì đồng bộ bỏ qua; kiện khác bị sàn báo lùi thì gắn cờ Cần xử lý.

**`shipLateMappedLines`, `settleDeferredHandovers`**: #237 chỉ gọi `shipLateMappedLines` cho kiện không còn chờ kiểm kê (kiện hoãn để hàm bù xử lý). `settleDeferredHandovers` không ai gọi thẳng: `settleOpeningStocktake` (phần b) gọi nó trước khi phân hàng.

**`handover_source`** (`scan`, `marketplace`, `forced`, `before_cutoff`; CHECK `packages_handover_source`: kiện rời kho phải có): bên gọi ghi `scan`/`marketplace` lúc chuyển kiện vào nhóm rời kho, lõi chỉ đổi sang `forced`/`before_cutoff`. **`pickup_confirmed_at`**: sàn báo bàn giao thì bằng `handed_over_at`; kiện kho quét thì là lần đầu sàn báo kiện rời kho (không trừ thêm). Cờ `pickup_unconfirmed` suy ra (kho quét, sàn chưa xác nhận quá 24 giờ), không lưu.

**Mốc và chờ kiểm kê** (`25` §6.1, §8.1): kiện lần đầu thấy đã rời kho của đơn đặt trước `order_cutoff_at` thì chỉ lưu (`before_cutoff`); đơn về muộn đặt sau mốc vẫn trừ. Gian hàng chờ kiểm kê đầu kỳ (`holdStock = false`) thì hoãn (`defer`). Kho quét cũng hoãn (phần b, D7): route `hand-over` khoá dòng gian hàng `FOR SHARE` qua `ctx.stockHoldOf` trước khi khoá kiện, kiện hoãn trả `issue: null`. `orderCutoffAt` đi từ channel (`lockShopForOrders`) qua `ingestMarketplaceOrder` xuống `PlatformPackageOrder`.

## Phân hàng (#199 phần b)

**Một lượt**: `runAllocation(ctx, { variantIds } | { all: true }, { opening?, cause? })` ở `service/allocation.ts`, trong giao dịch của bên gọi, dưới khoá advisory `fulfillment.allocation:<công ty>` (hai lượt nối nhau). Luật thuần ở `domain/allocation.ts`.
1. **Lấy lại phần giữ** (`planReclaim`): SKU có đang giữ > tồn thực (đọc lại sau khi khoá kiện) thì nhả phần đang giữ thật (`reserved_qty`) của kiện `reserved` (đơn `unpaid` trước, `reserved_at` mới nhất trước) tới khi hết thiếu; kiện về `backordered` (mũi tên `reclaim`). Kiện từ `packed` trở đi không bị lấy.
2. **Giữ hàng** (`allocationQueue`, `planAllocation`): ứng viên là kiện `backordered` và kiện đã đóng (`packed`, `awaiting_pickup`) chưa giữ hàng, mọi dòng đã ghép, không `needs_open`, đơn chưa huỷ, gian hàng không chờ kiểm kê. Thứ tự: kiện đã đóng trước, `ship_by` sớm (null cuối), đơn kéo về trước, mã kiện. Nguyên kiện; thiếu thì bỏ qua xét kiện sau. `reserve` trả `false` thì bỏ qua. Kiện `backordered` → `reserved` (mũi tên `hold`); kiện đã đóng giữ nguyên trạng thái, cờ "Dỡ kiện về kệ" của phiếu đầu kỳ (nếu có) được gỡ. Ghi `reserved_at` bằng giờ DB. Kiện của gian hàng chờ kiểm kê bị loại trước khi khoá.
3. Phát `fulfillment.allocation_done { variantIds, cause? }` (key là công ty), **luôn phát** kể cả khi không đổi gì: channel (#223) đẩy tồn theo sự kiện này.

**Đường vào**: consumer `inventory.stock_changed` (`fulfillment-allocation`, `onStockChanged`); việc pg-boss `fulfillment.allocation` mang `{ companyId, variantIds }` (`requestAllocation`, hàng `standard`): kiện huỷ nhả hàng, #237 ghép xong SKU, #239 dỡ kiện về kệ; kiện mới giữ được hàng chỉ phát `allocation_done` cho SKU của kiện; `settleOpeningStocktake` (dưới).

**Phiếu đầu kỳ**: `settleOpeningStocktake({ shopId, documentId, countedAt })` do channel (#289) gọi trong giao dịch thoát chờ kiểm kê, sau khi đặt `openingStocktake = null`: `settleDeferredHandovers` trước (kiện rời kho sau lúc đếm đã lấy hàng thật), rồi lượt `{ all: true, opening: true }` (không lọc gian hàng chờ; kiện đã đóng không giữ được thì Cần xử lý "Dỡ kiện về kệ…"), phát `allocation_done` có `cause`. Gọi lại không trừ, không giữ thêm.

**`ctx.stockHoldOf`** (channel `awaitingStocktakeShops`, tiêm ở `src/wiring.ts`): gian hàng đang chờ kiểm kê; `lock` khoá `FOR SHARE`.

## Giao, thất bại, hoàn (#199 phần c)

**Luật thuần** ở `domain/delivery.ts`; **một chỗ thi hành** ở `service/delivery.ts` (`reportDelivered`, `reportDeliveryFailed`, `receiveReturn`, `packageStatusOf`), chạy trong giao dịch của bên gọi, kiện đã khoá. Ba đường vào: đồng bộ sàn (`platform-packages.ts`), hàm bù (`settleDeferredHandovers`), route quét nhận hoàn.

- **Chuẩn hoá trạng thái sàn**:
  - `lineStatus`: món huỷ có `cancelKind = 'failed_delivery'` (Lazada `cancellation-failed Delivery`) kể là `returning` (D2). Nhóm món sàn báo huỷ hết mà thành `returning` thì kết quả đồng bộ vẫn ghi `handed_over` vào `cancelled`: sales bật `platform_cancelled`, không huỷ đơn.
  - `deliveryTarget`: sàn báo hoàn xong (`returned`) thì kiện ở `returning` chờ kho quét (D1); riêng kiện lần đầu thấy của đơn đặt trước mốc (`store_only`) vào thẳng `returned`, chỉ lưu, không phiếu `KT`, không `package_returned` (D9). `return_failed` → `returning` kèm cờ.
  - Kiện `returned` (kho quét trước) mà sàn báo hoàn: bỏ qua, không cờ.
  - `platformUpdate`: kiện trước bàn giao (`backordered` … `awaiting_pickup`) mà sàn báo `delivery_failed`/`returning` là `jump`; lõi bàn giao bù trừ tồn một lần (D5). `lost` từ trước bàn giao vẫn cờ Cần xử lý.
- **Mốc từ hành trình** (`eventsOf`, `journeyTimes`): sự kiện của kiện khớp mã kiện sàn, không có thì mã vận đơn. `handed_over_at` = `pickup_confirmed_at` = sự kiện sau bàn giao sớm nhất; `delivered_at` = sự kiện `delivered` muộn nhất; lý do giao thất bại = mô tả `delivery_failed` muộn nhất. Thiếu, hay sau giờ đồng bộ, thì lấy giờ đồng bộ. Hành trình đi từ channel qua `PlatformOrder.packageEvents`.
- **`package_delivered`** (`reportDelivered(packageId)`, đọc lại kiện từ DB): phát đúng một lần, chặn bằng `delivery_posted_at` (ghi `now()` cùng giao dịch; kiện vào `delivered` lần hai không phát lại). Kiện giao xong đầu tiên của đơn mang ship cấp đơn (`shippingIncome = shipping_fee`, `shippingCost = shipping_fee_original ?? shipping_fee`, trợ ship sàn vào `platformSubsidy`; D4, D10 chờ Bình), kiện sau `"0.00"`. `unitPrice` là giá sau voucher shop; voucher sàn chia theo tỉ lệ số lượng. Kiện còn dòng hoãn trừ (đã ghép, chưa trừ, không `before_cutoff`) thì hoãn: `settleDeferredHandovers` gọi lại sau khi chốt giá vốn. Dòng chưa ghép SKU, dòng `before_cutoff` mang `variantId`/`unitCost` null (D6). Đơn không có gian hàng không phát (log `warn`). Dòng kiện trỏ tới dòng đơn không có thì ném (đơn rollback).
- **`package_delivery_failed`**: mỗi lần kiện **đổi** sang `delivery_failed` (trực tiếp, nhảy cóc, kiện mới); lịch sử và sự kiện mang lý do, mặc định "Sàn báo giao không thành công". Sàn báo lại cùng trạng thái không phát.
- **`package_returned`**: chỉ khi kho quét nhận hàng hoàn (`receiveReturn`). Lập phiếu `KT` nháp qua `StockPort.receiveBack` cho mọi dòng đã ghép (kể cả `before_cutoff`, bàn giao bắt buộc, hoãn trừ); không dòng nào ghép thì không lập phiếu, log `info`.
- Cột `packages.delivery_posted_at` (migration `0029`, điền `= delivered_at` cho kiện đã giao trước 199c).

## Route (`/api/v1/fulfillment`)

| Route | Quyền | Việc |
|---|---|---|
| `GET /packages` | `fulfillment.order.process` | Tab (`PACKAGE_TABS`, mặc định `reserved` chỉ đơn `processing`; `shipping` = `in_transit` + `self_delivering`; `needs_open` theo cờ), `search` (mã kiện, mã đơn, mã vận đơn; `%`, `_` khớp đúng chữ), `source`, `shopId`, phân trang; sắp `ship_by` null cuối rồi mã; `counts` một câu, không theo `tab` |
| `GET /packages/:id` | `fulfillment.order.process` | `Package` = `PackageSummary` + `statusHistory` |
| `POST /packages/hand-over` | `fulfillment.order.process` | 1–50 kiện, id không trùng (422); mỗi kiện một giao dịch, tuần tự; `failed[].code`: `not_found`, `already_handed_over` (kiểm trước `version`), `version_conflict`, `invalid_transition`, `internal_error` (log `error`, câu chung). `issue` null khi kiện chưa có dòng nào ghép SKU (kiện sàn tới chờ lấy hàng khi chưa ghép) |
| `POST /packages/:id/receive-return` | `fulfillment.order.process` | Kho quét nhận hàng hoàn `{ version, code }`: kiện có (404, kể cả công ty khác, id sai dạng) → `version` (409 kèm `current`) → máy trạng thái (409 `invalid_transition`, kể cả quét lần hai) → `code` khớp mã kiện hoặc mã vận đơn, không phân biệt hoa thường (422 `package_mismatch`, `errors.code`). Kiện `returned`, phiếu `KT` nháp, `package_status_changed`, `package_returned`; trả `Package` |
| `POST /packages/:id/undo-handover` | `fulfillment.handover.revert` (CEO) | Bắt buộc lý do (422 `reason_required`); chỉ kiện `scan` mà sàn chưa xác nhận (409 `handover_confirmed_by_platform`); đơn `cancelling`/`platform_cancelled` thì kiện bật Cần xử lý "Đơn đang huỷ: dỡ kiện về kệ" (chưa có khung việc #209) |

Danh sách và chi tiết dựng `PackageSummary` theo lô ở `service/packages.ts` + `service/views.ts` (`toPackageSummary`, dùng chung với chi tiết đơn của sales). Thông tin đơn lấy qua `ctx.orderRefsOf` (sales, tiêm bằng `withContext` ở `order/index.ts` vì sales đã import fulfillment); lọc theo đơn dùng SQL thô `"order".orders` (`repository/package-list.ts`). Tên gian hàng qua `ctx.shopsOf` (`src/wiring.ts`).

## Cho module khác (`index.ts`)

- `syncPlatformPackages` (sales, lúc nhận đơn sàn).
- `findPackagesOfOrders`, `PackageSummary`, `ShopRef`, `StatusChange`, `toPackageSummary`, `PackageOrderRef` (sales dựng chi tiết đơn).
- `settleDeferredHandovers(shopId, countedAt)` → `{ deducted, storedOnly }`: kiện rời kho từ `countedAt` trở đi thì trừ, trước đó thành `before_cutoff`; gọi lại không trừ thêm. Dùng bên trong `settleOpeningStocktake`.
- `shipLateMappedLines(packageId)` → phiếu `XK` mới: **#237** gọi sau khi gán `variant_id` cho dòng kiện. Kiện chưa rời kho hoặc `before_cutoff` thì không làm gì. Kiện chưa rời kho thì gọi `requestAllocation(variantIds)`.
- `settleOpeningStocktake({ shopId, documentId, countedAt })` → `{ deducted, storedOnly, held }`: **channel #289** gọi trong giao dịch thoát chờ kiểm kê.
- `requestAllocation(variantIds)`: xếp lượt phân hàng cùng giao dịch của bên gọi (#237, #239).
- `getOrderCogs` (finance).
- `packageStatusOf(packageIds)` → `Map<id, { orderId, status, deliveredAt }>` (**finance E139**): chạy trong `withCompany` của bên gọi; bỏ id sai dạng, rỗng thì không truy vấn; id công ty khác vắng trong `Map`.
- **#237** ghép SKU muộn phải bỏ qua kiện `returned` (hàng đã về kệ; trừ tồn lúc này là sai, spec 199c §10).
- Test thay cổng tồn bằng `setStockPort({ ... })` (`service/stock-port.ts`): phần không truyền là bản thật.

## Giới hạn đã biết

- Đồng bộ một đơn nhiều kiện gọi cổng tồn nhiều lần trong một giao dịch: có thể deadlock `40P01` với giao dịch khác (thứ tự khoá chỉ đúng trong một lần gọi cổng); lượt kéo sau chạy lại.
- `handed_over_at` của kiện sàn báo mà không có hành trình (TikTok, trace Lazada lỗi hay không khớp kiện) là lúc đồng bộ thấy, lệch tối đa một chu kỳ kéo đơn (5 phút): hàm bù có thể xếp nhầm kiện rời kho sát `countedAt`.
- Kiện vừa có dòng giữ vừa có dòng bắt buộc (chỉ với dòng ghép SKU muộn) thành hai phiếu `XK`.
- Tìm kiếm `ilike` trên mã kiện, mã đơn chưa có index trigram (số kiện của đồ án nhỏ).
- Một lượt phân hàng gọi `reserve`/`release` nhiều lần, mỗi lần khoá dòng tồn của kiện đó: có thể `40P01` với lượt kéo đơn; consumer, pg-boss thử lại.
- Câu ứng viên phân hàng không `LIMIT` (lượt phải xét mọi kiện chờ của SKU); số kiện chờ của đồ án nhỏ.
- Kiện mới về có thể giữ hàng trước kiện `backordered` đang chờ lượt của cùng SKU.
- Hàng hoàn về khi sàn còn báo `delivery_failed`: kho chưa quét được (máy trạng thái chỉ cho `returning → returned`), chờ đồng bộ báo hoàn. `25` §8.3 cho chuyển tay sau 3 ngày nhưng `21` §19.2 chặn `return` với đơn sàn (`not_allowed_for_source`): lệch tài liệu, ngoài phạm vi 199c.
- Dòng chưa ghép SKU không vào phiếu `KT` (kho lập phiếu tay). Ghép muộn sau khi đã phát `package_delivered`: dòng đó đã báo `unitCost: null`, không phát bù.
- Trace Lazada chưa thử khớp `ofc_package_id` với `package_id` của món trên shop thử: không khớp thì khớp theo mã vận đơn, không được nữa thì kiện dùng giờ đồng bộ.
- "Dỡ kiện về kệ" sau kiểm kê thường (không phải phiếu đầu kỳ) chưa làm: cần nghe `stocktake_posted` và khung việc #209 (spec 199b D9).
- Chưa làm: FE (199d); đóng gói, RTS (#239); sàn chia lại kiện, thất lạc (#238); route `self-deliver`.
