# src/modules/order/fulfillment/

Kiện (giữ hàng, đóng gói, bàn giao, giao, hoàn), hàng trả không khớp, giá vốn theo đơn. Bảng trong schema `order`. Hợp đồng API: `Documents/21` §19.2; sự kiện §11.2; cổng tồn §11.1. Spec phần a của #199: `docs/superpowers/specs/2026-11-09-199a-ban-giao-tru-ton-design.md`.

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

**`shipLateMappedLines`, `settleDeferredHandovers`**: #237 chỉ gọi `shipLateMappedLines` cho kiện không còn chờ kiểm kê (kiện hoãn để hàm bù xử lý); #198 gọi `settleDeferredHandovers` sau khi giao dịch ghi sổ phiếu đầu kỳ commit, để giữ thứ tự khoá kiện → dòng tồn → `doc_counters`.

**`handover_source`** (`scan`, `marketplace`, `forced`, `before_cutoff`; CHECK `packages_handover_source`: kiện rời kho phải có): bên gọi ghi `scan`/`marketplace` lúc chuyển kiện vào nhóm rời kho, lõi chỉ đổi sang `forced`/`before_cutoff`. **`pickup_confirmed_at`**: sàn báo bàn giao thì bằng `handed_over_at`; kiện kho quét thì là lần đầu sàn báo kiện rời kho (không trừ thêm). Cờ `pickup_unconfirmed` suy ra (kho quét, sàn chưa xác nhận quá 24 giờ), không lưu.

**Mốc và chờ kiểm kê** (`25` §6.1, §8.1): kiện lần đầu thấy đã rời kho của đơn đặt trước `order_cutoff_at` thì chỉ lưu (`before_cutoff`); đơn về muộn đặt sau mốc vẫn trừ. Gian hàng chờ kiểm kê đầu kỳ (`holdStock = false`) thì hoãn (`defer`). `orderCutoffAt` đi từ channel (`lockShopForOrders`) qua `ingestMarketplaceOrder` xuống `PlatformPackageOrder`.

## Route (`/api/v1/fulfillment`)

| Route | Quyền | Việc |
|---|---|---|
| `GET /packages` | `fulfillment.order.process` | Tab (`PACKAGE_TABS`, mặc định `reserved` chỉ đơn `processing`; `shipping` = `in_transit` + `self_delivering`; `needs_open` theo cờ), `search` (mã kiện, mã đơn, mã vận đơn; `%`, `_` khớp đúng chữ), `source`, `shopId`, phân trang; sắp `ship_by` null cuối rồi mã; `counts` một câu, không theo `tab` |
| `GET /packages/:id` | `fulfillment.order.process` | `Package` = `PackageSummary` + `statusHistory` |
| `POST /packages/hand-over` | `fulfillment.order.process` | 1–50 kiện, id không trùng (422); mỗi kiện một giao dịch, tuần tự; `failed[].code`: `not_found`, `already_handed_over` (kiểm trước `version`), `version_conflict`, `invalid_transition`, `internal_error` (log `error`, câu chung). `issue` null khi kiện chưa có dòng nào ghép SKU (kiện sàn tới chờ lấy hàng khi chưa ghép) |
| `POST /packages/:id/undo-handover` | `fulfillment.handover.revert` (CEO) | Bắt buộc lý do (422 `reason_required`); chỉ kiện `scan` mà sàn chưa xác nhận (409 `handover_confirmed_by_platform`); đơn `cancelling`/`platform_cancelled` thì kiện bật Cần xử lý "Đơn đang huỷ: dỡ kiện về kệ" (chưa có khung việc #209) |

Danh sách và chi tiết dựng `PackageSummary` theo lô ở `service/packages.ts` + `service/views.ts` (`toPackageSummary`, dùng chung với chi tiết đơn của sales). Thông tin đơn lấy qua `ctx.orderRefsOf` (sales, tiêm bằng `withContext` ở `order/index.ts` vì sales đã import fulfillment); lọc theo đơn dùng SQL thô `"order".orders` (`repository/package-list.ts`). Tên gian hàng qua `ctx.shopsOf` (`src/wiring.ts`).

## Cho module khác (`index.ts`)

- `syncPlatformPackages` (sales, lúc nhận đơn sàn).
- `findPackagesOfOrders`, `PackageSummary`, `ShopRef`, `StatusChange`, `toPackageSummary`, `PackageOrderRef` (sales dựng chi tiết đơn).
- `settleDeferredHandovers(shopId, countedAt)` → `{ deducted, storedOnly }`: **#198** gọi sau khi phiếu kiểm kê đầu kỳ ghi sổ xong (giao dịch `withCompany` riêng). Kiện rời kho từ `countedAt` trở đi thì trừ, trước đó thành `before_cutoff`; gọi lại không trừ thêm.
- `settleOpeningStocktake({ shopId, documentId, countedAt })` → `{ deducted, storedOnly, held }` (Documents/21 §11.3): channel (#198 phần 2) gọi trong giao dịch thoát chờ kiểm kê. **Bản tạm** ở `service/settle-opening-stocktake.ts` (bù kiện hoãn trừ, phát `allocation_done` có `cause` với `variantIds` rỗng, `held` 0); #298 (199b) thay bằng bản thật ở `service/allocation.ts`.
- `shipLateMappedLines(packageId)` → phiếu `XK` mới: **#237** gọi sau khi gán `variant_id` cho dòng kiện. Kiện chưa rời kho hoặc `before_cutoff` thì không làm gì.
- `getOrderCogs` (finance).
- Test thay cổng tồn bằng `setStockPort({ ... })` (`service/stock-port.ts`): phần không truyền là bản thật.

## Giới hạn đã biết

- Đồng bộ một đơn nhiều kiện gọi cổng tồn nhiều lần trong một giao dịch: có thể deadlock `40P01` với giao dịch khác (thứ tự khoá chỉ đúng trong một lần gọi cổng); lượt kéo sau chạy lại.
- `handed_over_at` của kiện sàn báo là lúc đồng bộ thấy, lệch tối đa một chu kỳ kéo đơn (5 phút): hàm bù có thể xếp nhầm kiện rời kho sát `countedAt`.
- Kiện vừa có dòng giữ vừa có dòng bắt buộc (chỉ với dòng ghép SKU muộn) thành hai phiếu `XK`.
- Tìm kiếm `ilike` trên mã kiện, mã đơn chưa có index trigram (số kiện của đồ án nhỏ).
- Chưa làm: chia hàng `allocation_done` (199b); giao, thất bại, hoàn và sự kiện cho finance (199c); FE (199d); đóng gói, RTS (#239); sàn chia lại kiện, thất lạc (#238); route `self-deliver`.
