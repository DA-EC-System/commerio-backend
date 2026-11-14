# src/modules/order/fulfillment/

Kiện (giữ hàng, đóng gói, bàn giao, giao, hoàn), hàng trả không khớp, giá vốn theo đơn. Bảng trong schema `order`. Hợp đồng API: `Documents/21` §19.2; sự kiện §11.2; cổng tồn §11.1. Spec phần a của #199: `docs/superpowers/specs/2026-11-09-199a-ban-giao-tru-ton-design.md`; phần b: `docs/superpowers/specs/2026-11-09-199b-chia-hang-design.md`; phần c: `docs/superpowers/specs/2026-11-10-199c-giao-hoan-design.md`. Tách kiện #205: `docs/superpowers/specs/2026-11-14-205-tach-kien-design.md`.

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

**Một lượt**: `runAllocation(ctx, { variantIds } | { all: true }, { opening?, stocktake?, cause? })` ở `service/allocation.ts`, trong giao dịch của bên gọi, dưới khoá advisory `fulfillment.allocation:<công ty>` (hai lượt nối nhau). Luật thuần ở `domain/allocation.ts`.
1. **Lấy lại phần giữ** (`planReclaim`): SKU có đang giữ > tồn thực (đọc lại sau khi khoá kiện) thì nhả phần đang giữ thật (`reserved_qty`) của kiện `reserved` (đơn `unpaid` trước, `reserved_at` mới nhất trước) tới khi hết thiếu; kiện về `backordered` (mũi tên `reclaim`). Kiện từ `packed` trở đi không bị lấy.
   - **Lượt do phiếu kiểm kê** (`stocktake`, `opening` cũng là; `25` §7.4 gạch cuối, review #298): khoá luôn kiện đã đóng đang giữ SKU thiếu (`lockSealedHolders`, cùng lúc khoá kiện `reserved`); lấy lại hết mà tồn thực vẫn nhỏ hơn đang giữ thì các kiện đó bật Cần xử lý với `DISMANTLE_NOTE` (`planDismantle`; kiện đã có Cần xử lý giữ nguyên ghi chú; chưa có khung việc #209 nên dùng cờ thay việc "Dỡ kiện về kệ"). Trả `flagged`.
2. **Giữ hàng** (`allocationQueue`, `planAllocation`): ứng viên là kiện `backordered` và kiện đã đóng (`packed`, `awaiting_pickup`) chưa giữ hàng, mọi dòng đã ghép, không `needs_open`, đơn chưa huỷ, gian hàng không chờ kiểm kê. Thứ tự: kiện đã đóng trước, `ship_by` sớm (null cuối), đơn kéo về trước, mã kiện. Nguyên kiện; thiếu thì bỏ qua xét kiện sau. `reserve` trả `false` thì bỏ qua. Kiện `backordered` → `reserved` (mũi tên `hold`); kiện đã đóng giữ nguyên trạng thái, cờ "Dỡ kiện về kệ" của phiếu đầu kỳ (nếu có) được gỡ. Ghi `reserved_at` bằng giờ DB. Kiện của gian hàng chờ kiểm kê bị loại trước khi khoá.
3. Phát `fulfillment.allocation_done { variantIds, cause? }` (key là công ty), **luôn phát** kể cả khi không đổi gì: channel (#223) đẩy tồn theo sự kiện này.

**Đường vào**: consumer `inventory.stock_changed` (`fulfillment-allocation`, `onStockChanged`); consumer `inventory.stocktake_posted` (`fulfillment-stocktake`, `onStocktakePosted`): phiếu không nguồn (kiểm kê thường, #208) chạy lượt `stocktake` cho SKU của phiếu, phiếu nguồn `shop_setup` bỏ qua (channel gọi `settleOpeningStocktake`); việc pg-boss `fulfillment.allocation` mang `{ companyId, variantIds }` (`requestAllocation`, hàng `standard`): kiện huỷ nhả hàng, #237 ghép xong SKU, #239 dỡ kiện về kệ; kiện mới giữ được hàng chỉ phát `allocation_done` cho SKU của kiện; `settleOpeningStocktake` (dưới).

**Phiếu đầu kỳ**: `settleOpeningStocktake({ shopId, documentId, countedAt })` do channel (#289) gọi trong giao dịch thoát chờ kiểm kê, sau khi đặt `openingStocktake = null`: `settleDeferredHandovers` trước (kiện rời kho sau lúc đếm đã lấy hàng thật), rồi lượt `{ all: true, opening: true }` (không lọc gian hàng chờ; kiện đã đóng không giữ được thì Cần xử lý "Dỡ kiện về kệ…"), phát `allocation_done` có `cause`. Gọi lại không trừ, không giữ thêm.

**`ctx.stockHoldOf`** (channel `awaitingStocktakeShops`, tiêm ở `src/wiring.ts`): gian hàng đang chờ kiểm kê; `lock` khoá `FOR SHARE`.

## Giao, thất bại, hoàn (#199 phần c)

**Luật thuần** ở `domain/delivery.ts`; **một chỗ thi hành** ở `service/delivery.ts` (`reportDelivered`, `reportDeliveryFailed`, `receiveReturn`, `foundPackage`, `packageStatusOf`), chạy trong giao dịch của bên gọi, kiện đã khoá. Đường vào: đồng bộ sàn (`platform-packages.ts`), hàm bù (`settleDeferredHandovers`), route quét nhận hoàn, kiện nhảy tới `delivered` khi sàn mở yêu cầu trả (`deliverForReturn` của #202 gọi `reportDelivered`).

- **Chuẩn hoá trạng thái sàn**:
  - `lineStatus`: món huỷ có `cancelKind = 'failed_delivery'` (Lazada `cancellation-failed Delivery`) kể là `returning` (D2). Nhóm món sàn báo huỷ hết mà thành `returning` thì kết quả đồng bộ vẫn ghi `handed_over` vào `cancelled`: sales bật `platform_cancelled`, không huỷ đơn.
  - `deliveryTarget`: sàn báo hoàn xong (`returned`) thì kiện ở `returning` chờ kho quét (D1); riêng kiện lần đầu thấy của đơn đặt trước mốc (`store_only`) vào thẳng `returned`, chỉ lưu, không phiếu `KT`, không `package_returned` (D9). `return_failed` → `returning` kèm cờ.
  - Kiện `returned` (kho quét trước) mà sàn báo hoàn: bỏ qua, không cờ.
  - `platformUpdate`: kiện trước bàn giao (`backordered` … `awaiting_pickup`) mà sàn báo `delivery_failed`/`returning` là `jump`; lõi bàn giao bù trừ tồn một lần (D5). `lost` từ trước bàn giao vẫn cờ Cần xử lý.
- **Mốc từ hành trình** (`eventsOf`, `journeyTimes`): sự kiện của kiện khớp mã kiện sàn, không có thì mã vận đơn. `handed_over_at` = `pickup_confirmed_at` = sự kiện sau bàn giao sớm nhất; `delivered_at` = sự kiện `delivered` muộn nhất; lý do giao thất bại = mô tả `delivery_failed` muộn nhất. Thiếu, hay sau giờ đồng bộ, thì lấy giờ đồng bộ. Hành trình đi từ channel qua `PlatformOrder.packageEvents`.
- **`package_delivered`** (`reportDelivered(packageId)`, đọc lại kiện từ DB): phát đúng một lần, chặn bằng `delivery_posted_at` (ghi `now()` cùng giao dịch; kiện vào `delivered` lần hai không phát lại). Kiện đầu tiên phát `package_delivered` của đơn mang ship cấp đơn (`shippingIncome = shipping_fee`, `shippingCost = shipping_fee_original ?? shipping_fee`, trợ ship sàn vào `platformSubsidy`; D4, D10 Thành xác nhận ở Documents#99), kiện sau `"0.00"`. `unitPrice` là giá sau voucher shop; voucher sàn chia theo tỉ lệ số lượng. Kiện còn dòng hoãn trừ (đã ghép, chưa trừ, không `before_cutoff`) thì hoãn: `settleDeferredHandovers` gọi lại sau khi chốt giá vốn. Dòng chưa ghép SKU mang `variantId`, `unitCost` null (D6); dòng của kiện `before_cutoff` mang `variantId` thật, `unitCost` null. Đơn không có gian hàng không phát (log `warn`). Dòng kiện trỏ tới dòng đơn không có thì ném (đơn rollback).
- **`package_delivery_failed`**: mỗi lần kiện **đổi** sang `delivery_failed` (trực tiếp, nhảy cóc, kiện mới); lịch sử và sự kiện mang lý do, mặc định "Sàn báo giao không thành công". Sàn báo lại cùng trạng thái không phát.
- **`package_returned`**: khi kho nhận kiện về, qua một lõi chung `receiveBackPackage` cho `receiveReturn` (`returning → returned`, quét mã) và `foundPackage` (`lost → returned`, kiện thất lạc tìm thấy, `25` §8.3 "như `returned`"). `lines` của route (số kho quét, `ScanLines`) gộp với dòng kiện đã ghép SKU bằng `mergeReceiveLines` (`domain/delivery.ts`): món vắng `scanned = 0`, món ngoài kiện `expected = 0`, mảng rỗng hợp lệ, không gửi thì `expected = scanned = quantity` (giai đoạn chuyển tiếp của `21` §15.3). `variantId` không phải SKU của công ty: 422 `validation_failed`, `errors["lines.<i>.variantId"]`. Gọi `StockPort.receiveBack` kèm `meta.actorId` (người quét), mã kiện và `meta.unitCosts` = giá vốn đã lưu trên dòng kiện (`returnUnitCosts`: SKU nhiều dòng khác giá thì bình quân theo số lượng, chưa chốt giá thì null; `25` §7.1); kho cộng chờ xử lý ngay theo số quét (#208). Phiếu `KT` nháp cho mọi dòng đã ghép (kể cả `before_cutoff`, bàn giao bắt buộc, hoãn trừ) và món quét ngoài kiện; không có dòng nào thì không lập phiếu, log `info`. `ScanLines`, `mergeReceiveLines` là bản dùng chung: sales (`/returns/receive`) import qua `fulfillment/index.ts`.
- Cột `packages.delivery_posted_at` (migration `*_giao-hoan`, điền `= delivered_at` cho kiện đã giao trước 199c).

## Đóng gói, báo sẵn sàng giao, vận đơn (#239)

`pack`, `ready`, `open` kiểm trong giao dịch ngắn, gọi sàn ngoài giao dịch, rồi khoá dòng và ghi theo phiên bản. Khoá phiên theo kiện giữ qua cả ba bước, chờ tối đa 10 giây. Báo giao còn khoá theo mã kiện sàn của gian hàng để hai kiện cùng nhóm không gửi hai lệnh. Nếu lượt kéo đã đưa kiện tới đích với cùng mã sàn, trả bản chi tiết hiện tại và giữ lịch sử đã ghi.

Đóng gói so số quét theo biến thể đã ghép, vẫn gửi đủ mã món sàn. Nhóm gói gồm các kiện chưa huỷ cùng gian hàng và mã kiện sàn. Đóng gói chờ các đơn của nhóm sang xử lý và các kiện đã giữ hoặc đóng. Báo giao chờ cả nhóm đóng xong, gọi sàn một lần và cập nhật cả nhóm trong một giao dịch theo thứ tự id. Lỗi gọi sàn lúc báo giao bật `label_error` trên kiện đang bấm, báo giao thành công hoặc đồng bộ sàn chuyển khỏi `packed` thì xoá cờ.

`open` chỉ nhận kiện `packed`. Nếu kiện chưa giữ đủ hàng, giữ lại trước khi gọi repack và phát `allocation_done`. Lazada repack thành công thì xoá mã kiện và vận đơn cũ. TikTok giữ mã kiện. In vận đơn bỏ trùng mã theo gian hàng, tải tối đa ba gian hàng cùng lúc và gộp tối đa 50 MB PDF.

## Tách kiện (#205)

`POST /packages/:id/split` `{ version, parts }`: kiện cũ giữ phần còn lại (kể cả dòng chưa ghép SKU), mỗi phần thành một kiện mới mang mã `KH-` mới. Chỉ kiện `reserved`, `backordered`; `packed`, `awaiting_pickup` thì 409 `package_sealed`. Tách không là mũi tên của máy trạng thái (D3): kiện mới ghi lịch sử `create` (người bấm, "Tách từ <mã cũ>") và phát `package_status_changed` (`from: null`); kiện cũ ghi `split` với `from = to`, lý do liệt kê mã mới.

- **Luật thuần** `domain/split.ts` (`planSplit`, `carveLine`): chọn dòng theo thứ tự dòng vào; dòng số lượng lớn (đơn tay) chuyển một phần thì giảm dòng cũ, chèn dòng mới, phần giữ theo nguyên dòng (D12). Lỗi theo trường `parts.<i>.<j>.variantId`, `parts.<i>.<j>.quantity`, `parts` (kiện cũ hết món). `sku` chỉ chuyển trọn một SKU, một SKU không ở hai kiện (D8).
- **Ba bước** (`service/split.ts`) trong khoá phiên theo kiện: (1) giao dịch ngắn đọc và kiểm (trạng thái trước `version`), hỏi `splitLevel` của gian hàng ngoài giao dịch (đơn tay coi như `unit`; `none` thì 422 `split_not_supported`); (2) nhánh `sku` gọi sàn tách ngoài giao dịch; (2b) xin mã kiện mới trong giao dịch riêng, commit ngay (D15); (3) một giao dịch: khoá advisory phân hàng → `lockOrderPackages` → kiểm lại → chèn kiện, chuyển dòng → kiện cũ `backordered` thì `runAllocation` cho SKU của các kiện con (kiện đủ hàng sang `reserved` qua `hold`, lượt tự phát `allocation_done`). Trả `Order` của sales (`ctx.orderViewOf`).
- **Không gọi cổng tồn** (D4): inventory chỉ giữ tổng theo SKU, chuyển dòng đang giữ sang kiện khác không đổi tổng. Kiện `reserved` tách thì kiện mới `reserved`, `reserved_at` chép kiện cũ, không phát `allocation_done`. Gian hàng chờ kiểm kê đầu kỳ vẫn tách được, lượt phân hàng tự bỏ qua (D5).
- **Nhánh `sku`** (TikTok): đơn còn kiện chưa huỷ khác thì 422 `split_not_supported` (D13, chưa thử sàn nhận nhóm chỉ phủ một phần đơn). Nhóm gửi sàn: mã món của phần ở lại kiện cũ đứng đầu, rồi từng kiện mới; thiếu mã đơn hay mã món thì 409 `item_not_packable`. Bước ghi không so `version` (D7): kiện còn `reserved`/`backordered` và `planSplit` trên dòng vừa khoá ra đúng các dòng đã gửi sàn thì ghi, không thì 409 `version_conflict`. Mã sàn của kiện cũ ghi trước khi chèn kiện mới (tránh unique `packages_platform_code_order_uq` khi lượt kéo vừa gắn mã nhóm khác vào kiện cũ). Mọi lỗi sau khi sàn đã tách: log `error`, giao dịch riêng bật Cần xử lý trên kiện cũ với `SPLIT_UNSYNCED_NOTE` (D14), rồi ném lỗi gốc.
- **Đồng bộ giữ cách chia của app** (D10, `syncPlatformPackages`): món chưa có mã kiện sàn mà đã nằm trong kiện app thì gom theo kiện đó, không bật `resplit`; món có mã sàn gom theo mã như cũ, món của hai kiện app về chung một mã vẫn là "Sàn chia lại kiện" (#238).
- **CSDL** kiểm bằng: tổng `quantity − pending_drop_qty` của một dòng đơn trên các kiện chưa huỷ phải bằng `quantity − cancelled_qty` của dòng đơn, bằng ba constraint trigger kiểm lúc commit (`db/CLAUDE.md`). Tách kiện chỉ dời dòng nên luôn qua.

## Huỷ dòng (#205 PR 2)

Sàn huỷ lẻ một món (spec 205 §5.10, D16–D22). "Món bị huỷ" là món sàn báo `cancelled` mà `cancelKind` khác `failed_delivery` (D17: huỷ vì giao không thành là kiện hoàn về).

- **Xét theo kiện, trước khi gom nhóm** (D16, `syncPlatformPackages`): mỗi kiện của đơn qua `planLineCancel` (`domain/line-cancel.ts`). Kiện chỉ có một phần món bị huỷ thì xử lý theo bảng dưới, các món đó không vào bước gom nhóm theo mã kiện sàn (món huỷ có thể không còn mang mã sàn, rơi vào nhóm riêng sẽ huỷ cả kiện). Mọi món bị huỷ thì đi đường huỷ cả kiện (`cancelPlatformPackage`) như cũ.

  | Kiện | Xử lý |
  |---|---|
  | `backordered`, `reserved` | `release` phần đang giữ của dòng (dòng đã ghép), xoá dòng, `requestAllocation` cho SKU vừa nhả và SKU còn lại; kiện giữ trạng thái, `version` tăng, lịch sử `drop_lines` (`from = to`, nguồn `marketplace`, "Sàn huỷ <n> món", D20) |
  | `packed`, `awaiting_pickup` | `pending_drop_qty = quantity` trên dòng; kiện `needs_open` với `open_purpose = 'edit'` (đang chờ mở thì giữ mục đích, chỉ tăng `version`); vẫn giữ hàng. Dòng đã chờ bỏ thì không ghi lại |
  | Huỷ cả kiện đã đóng gói | Đường cũ (`needs_open`, `'cancel'`) cộng mọi dòng chờ bỏ; đang chờ mở để sửa (`'edit'`) thì nâng lên `'cancel'` (D21) |
  | Đã rời kho, đã huỷ | Không đổi gì (`25` E96) |

- **`cancelledLines`**: `order_line_id` của món đã gỡ, chờ bỏ, hay huỷ cùng kiện chưa rời kho; sales ghi `cancelled_qty = quantity` trong cùng giao dịch. Fulfillment không ghi `cancelled_qty`.
- **`alreadyCancelled`** (D18): sales báo món mà dòng đơn đã ghi huỷ đủ. Món đó không còn thuộc kiện nào (đã gỡ ở lượt trước) thì bỏ qua: không lập kiện `cancelled` mới, không tốn mã `KH-`.
- **Mở kiện** (`openPackage`): dòng chờ bỏ không được giữ lại; bước ghi nhả phần đang giữ của chúng rồi xoá, kiện về `reserved`, bỏ `needs_open`, `requestAllocation` cho SKU vừa nhả. Mọi dòng chờ bỏ thì đi `open_cancel` (D21): không gọi repack (sàn đã huỷ gói), nhả hết, `pending_drop_qty` về 0, kiện `cancelled`, lịch sử và `package_status_changed` mang `open_cancel`.

## Route (`/api/v1/fulfillment`)

| Route | Quyền | Việc |
|---|---|---|
| `GET /packages` | `fulfillment.order.process` | Tab (`PACKAGE_TABS`, mặc định `reserved` chỉ đơn `processing`; `shipping` = `in_transit` + `self_delivering`; `needs_open` theo cờ), `search` (mã kiện, mã đơn, mã vận đơn; `%`, `_` khớp đúng chữ), `source`, `shopId`, phân trang; sắp `ship_by` null cuối rồi mã; `counts` một câu, không theo `tab` |
| `GET /packages/:id` | `fulfillment.order.process` | `Package` = `PackageSummary` + `statusHistory` |
| `GET /pick-list` | `fulfillment.order.process` | Danh sách nhặt của 1–200 kiện chọn hoặc tối đa 500 kiện tab Cần đóng gói, trả số kiện và cờ cắt |
| `GET /packages/:id/carriers` | `fulfillment.order.process` | Nhà vận chuyển có thể chọn cho kiện |
| `POST /packages/:id/pack` | `fulfillment.order.process` | So số quét, đóng gói, lưu mã kiện sàn và vận đơn nếu sàn trả |
| `POST /packages/:id/ready` | `fulfillment.order.process` | Báo sẵn sàng giao cho kiện hoặc nhóm gói |
| `POST /packages/:id/open` | `fulfillment.order.process` | Mở kiện đã đóng, giữ lại hàng nếu cần; bỏ dòng chờ bỏ, mọi dòng chờ bỏ thì huỷ kiện (`open_cancel`, mục Huỷ dòng) |
| `POST /packages/:id/split` | `fulfillment.order.process` | Tách kiện `reserved`/`backordered` theo `parts` (mục Tách kiện); 404 → 409 `package_sealed`/`invalid_transition` → 409 `version_conflict` → 422 `split_not_supported` (sàn `none`) → 422 `validation_failed` → nhánh `sku`: 422 D13, 409 `item_not_packable`, lỗi sàn; trả `Order` |
| `GET /packages/documents` | `fulfillment.order.process` | Tải một PDF vận đơn gộp của 1–50 kiện |
| `POST /packages/hand-over` | `fulfillment.order.process` | 1–50 kiện, id không trùng (422); mỗi kiện một giao dịch, tuần tự; `failed[].code`: `not_found`, `already_handed_over` (kiểm trước `version`), `version_conflict`, `invalid_transition`, `internal_error` (log `error`, câu chung). `issue` null khi kiện chưa có dòng nào ghép SKU (kiện sàn tới chờ lấy hàng khi chưa ghép) |
| `POST /packages/:id/receive-return` | `fulfillment.order.process` | Kho quét nhận hàng hoàn `{ version, code, lines? }`: kiện có (404, kể cả công ty khác, id sai dạng) → máy trạng thái (409 `invalid_transition`, kể cả quét lần hai; kiểm trước `version` như bàn giao) → `version` (409 kèm `current`) → `code` khớp mã kiện hoặc mã vận đơn, không phân biệt hoa thường (422 `package_mismatch`, `errors.code`) → `lines` (422 `validation_failed` theo bảng `21` §15.3). Kiện `returned`, phiếu `KT` nháp theo số quét kèm giá vốn dòng kiện, `package_status_changed`, `package_returned`; trả `Package` |
| `POST /packages/:id/found` | `fulfillment.order.process` | Kho nhận kiện thất lạc tìm thấy `{ version, lines? }`: như `receive-return` nhưng không quét mã, chỉ kiện `lost` (409 `invalid_transition`). Kiện `returned`, phiếu `KT` nháp, `package_returned` |
| `POST /packages/:id/undo-handover` | `fulfillment.handover.revert` (CEO) | Bắt buộc lý do (422 `reason_required`); chỉ kiện `scan` mà sàn chưa xác nhận (409 `handover_confirmed_by_platform`); đơn `cancelling`/`platform_cancelled` thì kiện bật Cần xử lý "Đơn đang huỷ: dỡ kiện về kệ" (chưa có khung việc #209) |

Danh sách và chi tiết dựng `PackageSummary` theo lô ở `service/packages.ts` + `service/views.ts` (`toPackageSummary`, dùng chung với chi tiết đơn của sales). Thông tin đơn lấy qua `ctx.orderRefsOf` (sales, tiêm bằng `withContext` ở `order/index.ts` vì sales đã import fulfillment); lọc theo đơn dùng SQL thô `"order".orders` (`repository/package-list.ts`). Tên gian hàng qua `ctx.shopsOf` (`src/wiring.ts`).

## Cho module khác (`index.ts`)

- `syncPlatformPackages` (sales, lúc nhận đơn sàn). Nhận `alreadyCancelled` trên từng món, trả `cancelledLines` để sales ghi `cancelled_qty` (mục Huỷ dòng).
- `findPackagesOfOrders`, `PackageSummary`, `ShopRef`, `StatusChange`, `toPackageSummary`, `PackageOrderRef` (sales dựng chi tiết đơn).
- `settleDeferredHandovers(shopId, countedAt)` → `{ deducted, storedOnly }`: kiện rời kho từ `countedAt` trở đi thì trừ, trước đó thành `before_cutoff`; gọi lại không trừ thêm. Dùng bên trong `settleOpeningStocktake`.
- `shipLateMappedLines(packageId)` → phiếu `XK` mới: **#237** gọi sau khi gán `variant_id` cho dòng kiện. Kiện chưa rời kho hoặc `before_cutoff` thì không làm gì. Kiện chưa rời kho thì gọi `requestAllocation(variantIds)`.
- `settleOpeningStocktake({ shopId, documentId, countedAt })` → `{ deducted, storedOnly, held }`: **channel #289** gọi trong giao dịch thoát chờ kiểm kê.
- `requestAllocation(variantIds)`: xếp lượt phân hàng cùng giao dịch của bên gọi (#237, #239).
- `getOrderCogs` (finance).
- `packageStatusOf(packageIds)` → `Map<id, { orderId, status, deliveredAt }>` (**finance E139**): chạy trong `withCompany` của bên gọi; bỏ id sai dạng, rỗng thì không truy vấn; id công ty khác vắng trong `Map`.
- **#237** ghép SKU muộn phải bỏ qua kiện `returned` (hàng đã về kệ; trừ tồn lúc này là sai, spec 199c §10). Kiện đã `delivered` mà `delivery_posted_at` còn null (đang hoãn trừ) thì sau khi `shipLateMappedLines` trừ xong phải gọi `reportDelivered(packageId)`: hiện chỉ `settleDeferredHandovers` gọi lại, kiện còn dòng đã ghép chưa trừ sẽ không bao giờ phát `package_delivered`.
- `ctx.marketplacePackages` do channel tiêm ở `src/wiring.ts`, cung cấp `carriers`, `pack`, `readyToShip`, `repack`, `shippingDocuments`, `split`, `splitLevel` (mức tách kiện của gian hàng, #205).
- `ctx.orderViewOf(orderId)` (`getOrder` của sales) và `ctx.nextPackageCode()` (bộ đếm `KH-` của sales) do `order/index.ts` tiêm bằng `withContext` cho tách kiện (#205); thiếu thì 500 `internal_error` (`orderViewLookupOf`, `packageCodeLookupOf`).
- Test thay cổng tồn bằng `setStockPort({ ... })` (`service/stock-port.ts`): phần không truyền là bản thật.

## Giới hạn đã biết

- Đồng bộ một đơn nhiều kiện gọi cổng tồn nhiều lần trong một giao dịch: có thể deadlock `40P01` với giao dịch khác (thứ tự khoá chỉ đúng trong một lần gọi cổng); lượt kéo sau chạy lại.
- `handed_over_at` của kiện sàn báo mà không có hành trình (TikTok, trace Lazada lỗi hay không khớp kiện) là lúc đồng bộ thấy, lệch tối đa một chu kỳ kéo đơn (5 phút): hàm bù có thể xếp nhầm kiện rời kho sát `countedAt`. Trace Lazada thật chỉ có mốc `delivered` (dòng dưới), nên kiện lần đầu thấy đã giao lấy `handed_over_at` = `pickup_confirmed_at` = giờ giao, có thể muộn hơn lúc rời kho nhiều ngày: kiện rời kho trước `countedAt` mà giao sau bị hàm bù trừ tồn dù kiểm kê đã không đếm nó (trước 199c mốc này là giờ đồng bộ, còn muộn hơn). Sửa cần một nguồn giờ rời kho mà trace chưa cho.
- Kiện vừa có dòng giữ vừa có dòng bắt buộc (chỉ với dòng ghép SKU muộn) thành hai phiếu `XK`.
- Tìm kiếm `ilike` trên mã kiện, mã đơn chưa có index trigram (số kiện của đồ án nhỏ).
- Một lượt phân hàng gọi `reserve`/`release` nhiều lần, mỗi lần khoá dòng tồn của kiện đó: có thể `40P01` với lượt kéo đơn; consumer, pg-boss thử lại.
- Câu ứng viên phân hàng không `LIMIT` (lượt phải xét mọi kiện chờ của SKU); số kiện chờ của đồ án nhỏ.
- Kiện mới về có thể giữ hàng trước kiện `backordered` đang chờ lượt của cùng SKU.
- Hàng hoàn về khi sàn còn báo `delivery_failed`: kho chưa quét được (máy trạng thái chỉ cho `returning → returned`), chờ đồng bộ báo hoàn. `25` §8.3 cho chuyển tay sau 3 ngày nhưng `21` §19.2 chặn `return` với đơn sàn (`not_allowed_for_source`): lệch tài liệu, ngoài phạm vi 199c.
- Dòng chưa ghép SKU không vào phiếu `KT` (kho lập phiếu tay). Ghép muộn sau khi đã phát `package_delivered`: dòng đó đã báo `unitCost: null`, không phát bù.
- Trace Lazada (thử 13/11/2026 trên shop thử, `Documents/tich-hop-san/lazada.md` §11.7): `ofc_package_id` trùng `package_id` của món; chỉ gặp `ready_to` (bỏ) và `delivered`. Mốc rời kho, giao không thành công qua đơn vị vận chuyển chưa gặp thật (shop thử chỉ đi tới delivered, đơn SOF), kiểm bằng fixture.
- Đơn nhiều kiện vắt qua lúc chạy migration `*_giao-hoan`: kiện giao trước 199c được điền `delivery_posted_at` mà không phát sự kiện (không phát bù), kiện giao sau thấy "kiện khác đã báo" nên mang ship `"0.00"`; ship cấp đơn của các đơn đó không vào sổ. Kiện hoãn trừ đã `delivered` trước migration cũng coi như đã báo. Chấp nhận vì staging là dữ liệu demo.
- Phiếu `KT` của kiện hoàn lưu `order_id`, `shop_id` của kiện để truy ngược; kho chỉ phát `inventory.return_inspected` cho nguồn `return_request`, nguồn kiện không phát.
- "Dỡ kiện về kệ" sau phiếu kiểm kê là cờ Cần xử lý, chưa phải việc trong khung #209 (spec 199b D9). Ghép SKU, tồn đổi vì lý do khác (xuất huỷ, nhặt thiếu) không bật cờ này: `25` §7.4 chỉ đòi khi do kiểm kê.
- `lines` của `receive-return`, `found` còn tuỳ chọn (giai đoạn chuyển tiếp của `21` §15.3); thành bắt buộc sau FE#212 thì đổi `scanLines` ở `api/schemas.ts`. `found` mới có route nhận kiện về; báo và xác nhận thất lạc (`report-lost`, `confirm-lost`) thuộc #238.
- Lượt kéo đơn áp kết quả trước request thì lịch sử ghi nguồn sàn. Sau repack, lượt kéo có thể gắn lại mã cũ trong thời gian sàn còn trả mã đó. Lần đóng gói tiếp theo dùng mã mới sàn trả.
- Tách kiện TikTok (`sku`) chỉ khi kiện là kiện chưa huỷ duy nhất của đơn (D13); gỡ khi thử thật trên shop thử cho thấy sàn nhận nhóm chỉ phủ một phần đơn.
- Tách kiện `sku` mà bước ghi lỗi sau khi sàn đã tách: app một kiện, sàn hai kiện, lượt kéo không tự báo. Kiện cũ bật Cần xử lý (D14), xử lý tay tới khi có #238; bấm tách lại thì sàn từ chối.
- Tách kiện xin mã `KH-` trước bước ghi (D15): bước ghi lỗi thì mất số, dãy `KH-` có lỗ (mã kiện không phải chứng từ kế toán).
- Trigger `package_lines_line_total` không tự xếp hàng (D11, không khoá dòng đơn để tránh vòng khoá với luồng nhận đơn): hai giao dịch cùng ghi dòng kiện của một dòng đơn chỉ đúng khi cùng khoá kiện trước. Đường mới ghi dòng kiện, đổi `pending_drop_qty`, hay huỷ kiện phải khoá kiện (`lockOrderPackages`, `lockPackage`, `lockPackingPackage`) trước khi ghi, và ghi `cancelled_qty` (qua luồng nhận đơn) trong cùng giao dịch, không thì commit bị chặn.
- Kiện `awaiting_pickup` có dòng chờ bỏ chưa mở được (`open` chỉ nhận `packed`): chờ "dỡ kiện về kệ" của #238.
- Kiện đang `needs_open` vẫn báo sẵn sàng giao và bàn giao được (chưa chặn); khi đó dòng chờ bỏ bị trừ tồn như dòng thường.
- API kiện chưa trả `pendingDropQty`: kho xem món bị huỷ ở chi tiết đơn (lý do huỷ trên dòng đơn).
- `open` kiện có một phần dòng chờ bỏ vẫn gọi repack như kiện thường; chưa thử thật trên sàn với gói vừa bị huỷ một món.
- Chưa làm: FE (199d), mở kiện `awaiting_pickup`, sàn chia lại kiện, thất lạc (#238), route `self-deliver`, gộp kiện sau khi tách.
