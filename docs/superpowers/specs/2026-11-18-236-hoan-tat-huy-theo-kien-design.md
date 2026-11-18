# Spec: Hoàn tất, huỷ đơn theo kiện (#236, gộp #390)

- **Ngày:** 18/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#236 (và bình luận 17/11/2026), commerio-backend#390; `Documents/25` §8.2, §8.3; `Documents/21` §11.2, §18.4, §19.1 (bảng thao tác đơn, đoạn "Hoàn tất"); `Documents/27` US-DH-13, US-DH-14, US-DH-16; `Documents/kiem-thu/ca-theo-so-do.md` mục D1; `Documents/tich-hop-san/tiktok.md`
- **Trạng thái:** Khang duyệt 18/11/2026 (D2 `auto_cancel`, D3 giữ `platform_cancel`)
- **Nền:** `main` fbf7e052 (đã có #200 năng lực sàn, #362 `returnWindowDays` bắt buộc, #221 kéo đơn TikTok (PR #310), #238 PR 1–3, #202, #205)
- **Nhánh:** `feature/236-hoan-tat-huy-theo-kien` (PR 1), PR sau theo mục 6

---

## 1. Mục tiêu và tiêu chí thành công

1. Đơn `processing` tự sang `completed` **đúng bốn điều kiện** của `25` §8.2: (1) mọi kiện dừng **và có ít nhất một kiện không huỷ**; (2) có kiện đã giao thì đã hết hạn trả theo cách sàn báo (`capabilities.returnWindow`); (3) không còn yêu cầu trả mở; (4) kiện tự giao có thu COD đã được xác nhận số thực thu.
2. Hạn trả theo gian hàng: sàn `days` (Lazada) = mốc giao của kiện giao cuối + `Shop.returnWindowDays` (null thì 7 ngày); sàn `platform_status` (TikTok) = lúc sàn báo đơn hết quyền trả (`COMPLETED`). Không còn hằng 7 ngày viết cứng.
3. Đơn `processing` có mọi kiện `cancelled` sang `cancelled` bằng bước của hệ thống, không bao giờ sang `completed` với kết quả "Không giao được".
4. Đơn `completed` có kiện mở lại thì giữ `completed`, bật Cần xử lý, **kết quả đơn tính lại**; đúng cho mọi đường làm kiện đổi (sàn kéo lại kiện, người dùng bấm Tìm thấy, yêu cầu trả đẩy kiện sang đã giao).
5. Chi tiết đơn trả `returnWindowEndsAt`, `completionBlocker` đúng với bốn điều kiện trên.

Đo bằng: AC ở mục 9 đều qua; `npm run check` xanh; AC US-DH-16 (dòng 1, 1b, 2) có test mang mã ca.

**Vì sao:** báo cáo doanh thu chỉ tính đơn đã chốt. Hiện đơn của gian hàng đặt hạn trả 15 ngày vẫn chốt sau 7 ngày (tiền và lãi chốt sớm khi khách còn quyền trả, #390); đơn TikTok chốt theo 7 ngày dù sàn có trạng thái riêng; đơn mọi kiện huỷ bị chốt thành "Không giao được"; kết quả đơn không đổi khi kiện thất lạc được sàn báo đã giao.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (fbf7e052):**

- `sales/domain/order.ts`: `RETURN_WINDOW_DAYS = 7` (dòng 70) dùng ở `completionBlocker` (dòng 85), `service/complete.ts:34` (ghi `return_window_ends_at` lúc hoàn tất), `service/orders.ts:303` (chi tiết đơn, tính cả cho đơn đã hoàn tất). `completionBlocker` (dòng 83) chỉ kiểm "mọi kiện dừng", **không** kiểm "có kiện không huỷ".
- `codUnconfirmed: false` viết cứng ở `complete.ts:24`, `orders.ts:255`. Bảng `order.packages` đã có `self_delivery`, `cod_expected`, `cod_collected`, `cod_confirmed_by`, `cod_confirmed_at`, CHECK `packages_cod_second_person`; chưa đường nào ghi các cột COD. Kiện sàn luôn `self_delivery = false` (`platform-packages.ts:330`); kiện tự giao chỉ có ở đơn tạo tay (chưa làm).
- `findCompletionCandidates` (`repository/orders.ts:258`): `processing`, có kiện, mọi kiện dừng, và (không `cancelling` hoặc còn kiện không huỷ). Đơn **không** `cancelling` mà mọi kiện huỷ lọt vào và bị hoàn tất với `outcome = none`. Đơn `cancelling` mà mọi kiện huỷ bị loại khỏi danh sách: nếu `settleCancelledOrder` (giao dịch riêng sau `open_cancel`, `ingest.ts:195`) lỗi thì đơn kẹt `processing` mãi.
- `orderMachine` (BE, `order.ts:43`) **chưa có** thao tác huỷ khi mọi kiện huỷ, `complete` không có guard. FE `src/lib/machines/order.ts` (FE 66a17d3) đã có: `complete` guard `all_packages_cancelled`; `auto_cancel` (`processing → cancelled`, hệ thống, nhãn "Mọi kiện đã huỷ", guard `packages_not_cancelled`). `ca-theo-so-do.md` D1-03, D1-10, D1-10x, D1-X01, X03, X04 dùng đúng tên của FE. Riêng `21` §19.1 (dòng 1753) đặt tên thao tác là `all_packages_cancelled` (D2).
- Năng lực sàn (#200): `ShopCapabilities.returnWindow` (`channel/domain/shop.ts:130`), Lazada `days`, TikTok `platform_status`, sàn không adapter bộ thận trọng `platform_status`. Cột `channel.shops.return_window_days` (CHECK 1–60), #362 bắt buộc với sàn `days`; gian hàng thiết lập trước #362 có thể null.
- Sales lấy thông tin gian hàng qua `ctx.shopsOf` (`getShops` của channel, `shops-lookup.ts`, trả `{ id, shopName, platform }`, kể cả gian hàng đã ngắt; cần `withCompany`). `AppContext` (`src/wiring.ts:41`) đã bắt buộc `SalesContext.shopsOf`. Worker gọi `startBackground(ctx)` (`entrypoints/worker.ts:36`) nhưng `startSalesBackground()` chưa nhận `ctx`.
- TikTok (#221, `tiktok-orders.ts`): `COMPLETED` → món `delivered`; `RemoteOrder.rawStatus` = `status` của đơn; `deliveredAt` = `delivery_time` chỉ lưu ở `raw_orders`; `updatedAt` = `update_time`. Ingest lưu `orders.raw_marketplace_status` (`ingest.ts:321`). `PlatformOrder` dựng bằng `{ ...remote, shopId, holdStock, orderCutoffAt, lines }` (`order-pull.ts:92`) nên trường mới của `RemoteOrder` đi xuống sales. Lượt kéo đơn còn mở không lấy `DELIVERED` (`tiktok-orders.ts:30`); lượt kéo thường đi theo cửa sổ `update_time`.
- Kiện mở lại: `ingest.ts:304` bật `needs_attention` khi `packages.revived` (sàn kéo lại kiện `lost`/`returning`, `REVIVE_FROM` ở `fulfillment/domain/package.ts:99`), không tính lại `outcome`. Người dùng bấm `found` (`lost → returned`, `fulfillment/service/delivery.ts`) không đụng đơn. `fulfillment.package_status_changed` `{ packageId, orderId, from, to }` phát ở 9 file của fulfillment; **chưa consumer nào nghe**. Envelope có `occurredAt`; consumer chạy trong `withCompany` của sự kiện (`outbox/consumer.ts:172`).
- `outcome` chỉ ghi ở `complete.ts`, đọc ở API (`schemas.ts:84`); `insight` chưa đọc.
- `sales.order_cancelled.by` là `'platform' | 'seller'` (`core/platform/domain/events.ts:94`); `21` §11.2 ghi `'shop' | 'marketplace'` (lệch có sẵn, ngoài #236). Finance chỉ dùng `orderId` (`markOrderCancelled`).
- `core.state_transitions.action` là `text`: thêm thao tác không cần migration.

**Ràng buộc:**

- Chiều lớp: `order` (lớp 3) không import `channel` (lớp 5); dữ liệu gian hàng qua `ctx` do `src/wiring.ts` tiêm.
- Code ngoài adapter không rẽ nhánh theo sàn (`channel/channel/CLAUDE.md`): sales không so chuỗi `COMPLETED`.
- Tiền là `decimal.js`, không `number` (so `cod_expected > 0`).
- Không đổi schema (cột `return_window_ends_at`, `outcome`, `completed_at`, các cột COD đã có). Chỉ PR 2 có một migration dữ liệu viết tay (5.3, D13).
- `getShops` là cùng một hàm tiêm làm `shopsOf` cho finance, fulfillment, sales (`src/wiring.ts:51`); sales trải kết quả vào object `shop` của API (`service/orders.ts:134`), kiểm hợp đồng blackbox từ chối trường thừa. Không thêm trường vào `getShops`.
- Consumer `shared` mới đọc topic từ đầu (`outbox/consumer.ts:272`, Kafka giữ 7 ngày): lần deploy đầu nhận lại sự kiện cũ.
- `npm run check` chạy depcruise: không import chéo module con ngoài `index.ts`.

## 3. Phạm vi

**Trong phạm vi (BE):**

- Bốn điều kiện hoàn tất; hạn trả theo `returnWindow` của sàn và `returnWindowDays` của gian hàng (đóng #390).
- Tín hiệu hết quyền trả từ adapter TikTok.
- Thao tác hệ thống huỷ đơn khi mọi kiện huỷ; lưới đỡ cho đơn Đang huỷ kẹt.
- Consumer kiện mở lại: cờ và kết quả đơn.
- `returnWindowEndsAt`, `completionBlocker` của chi tiết đơn.

**Ngoài phạm vi:**

- FE (trang chi tiết đơn, hộp thoại huỷ, nút yêu cầu huỷ, E2E Playwright `pnpm e2e`): repo FE. FE đã có `auto_cancel` trong máy trạng thái; FE nên hiện hạn trả theo `returnWindowEndsAt` của BE thay hằng số ngày của mình.
- Đơn về muộn đã ở trạng thái kết thúc lập thẳng `completed`/`cancelled` (`25` §8.1): #240.
- Ghi số COD thực thu, xác nhận COD (đơn tạo tay): issue đơn tạo tay.
- Kéo lại đơn TikTok `DELIVERED` cũ để bắt `COMPLETED` nếu sàn không đổi `update_time` (mục 10).
- Sửa `21` §11.2 `by` cho khớp code: ghi ở mục 8, không bắt buộc cho #236.

**Không được xảy ra:**

- Đơn chốt trước hạn trả của gian hàng; đơn TikTok chốt khi sàn chưa báo `COMPLETED` mà có kiện đã giao.
- Đơn mọi kiện huỷ thành `completed`.
- Đơn đã `completed` đổi trạng thái do kiện mở lại.
- Consumer đè ghi chú Cần xử lý của luồng khác.
- Sales đọc bảng của channel, hay so mã trạng thái riêng của một sàn.

## 4. Các cách đã xét

| Cách | Nội dung | Được | Mất |
|---|---|---|---|
| **A (chọn, Khang chốt 18/11/2026)** | Dồn về hai chỗ: **job khép đơn** mỗi giờ quyết cả `complete` lẫn huỷ khi mọi kiện huỷ (kèm lưới đỡ đơn Đang huỷ); **một consumer** nghe `fulfillment.package_status_changed` lo kiện mở lại | Luật một chỗ; đường đổi kiện thêm sau không sót; không migration | Đơn mọi kiện huỷ có thể hiện "Chờ hoàn tất" tới một giờ; kết quả đơn tính lại trễ vài giây qua outbox |
| B | Mỗi đường đổi kiện (kéo đơn, mở kiện, Tìm thấy, nhận yêu cầu trả…) tự kiểm huỷ đơn và tính lại kết quả trong giao dịch của nó | Đổi ngay | Luật rải 4–5 chỗ; đã có tiền lệ sót (Tìm thấy không bật cờ đơn) |

Hạn trả `days` có hai cách: đọc cấu hình gian hàng **lúc kiểm** (chọn, #390 ghi vậy, D5) hay chụp số ngày lên đơn lúc nhận (cần cột mới, migration; đổi cấu hình không áp cho đơn đã về). TikTok có hai cách: adapter báo một trường chung (chọn, D7) hay sales so `raw_marketplace_status = 'COMPLETED'` (vi phạm luật không rẽ nhánh theo sàn).

## 5. Thiết kế

### 5.1 Luật thuần (`sales/domain/order.ts`)

- `DEFAULT_RETURN_WINDOW_DAYS = 7` thay `RETURN_WINDOW_DAYS`.
- Chính sách hạn trả: `ReturnPolicy = { returnWindow: 'days' | 'platform_status'; returnWindowDays: number | null }`. Gian hàng không tìm thấy dùng `{ returnWindow: 'days', returnWindowDays: null }`.
- `returnWindowEndsAt(policy, lastDeliveredAt, storedEndsAt): Date | null`:
  - Không có kiện đã giao (`lastDeliveredAt` null): `null` (điều kiện 2 không áp).
  - `days`: `lastDeliveredAt + (returnWindowDays ?? 7) ngày`.
  - `platform_status`: `storedEndsAt` (null = sàn chưa báo).
- `codUnconfirmed(packages)`: có kiện `selfDelivery`, `status = 'delivered'`, `codExpected > 0` (Decimal), `codConfirmedAt` null.
- Bước khép đơn `closingStep(input)` (tên do người làm chọn) thay `completionBlocker`, trả một trong: `{ blocker: 'packages_open' | 'return_window' | 'return_requested' | 'cod_unconfirmed' }`, `{ action: 'auto_cancel' }`, `{ action: 'complete' }`. Thứ tự:
  1. Không kiện nào, hoặc còn kiện chưa dừng → `packages_open`.
  2. Mọi kiện `cancelled` → `auto_cancel` (**PR 3**; PR 1, PR 2 giữ hành vi hiện tại cho đơn này, D16).
  3. Có kiện đã giao và (`endsAt` null hoặc `endsAt > now`) → `return_window`.
  4. Yêu cầu trả mở > 0 → `return_requested`.
  5. `codUnconfirmed` → `cod_unconfirmed`.
  6. → `complete`.
- PR 1 tính sàn `platform_status` như `days` 7 ngày (hành vi hiện tại của đơn TikTok); PR 2 mới bật nhánh `platform_status` (D13).
- Máy trạng thái (PR 3, theo D2), khớp FE: `complete` thêm guard `allCancelled(packages) ? 'all_packages_cancelled' : null`; thêm `{ from: 'processing', to: 'cancelled', action: 'auto_cancel', system: true, guard: allCancelled ? null : 'packages_not_cancelled' }`. `allCancelled` = có kiện và mọi kiện `cancelled` (như FE). `OrderAction` thêm `auto_cancel`.
- `outcomeOf` giữ nguyên.

### 5.2 Chính sách hạn trả của gian hàng (channel → sales)

- Channel thêm hàm `returnPoliciesOf(shopIds): Promise<Map<shopId, ReturnPolicy>>` (cạnh `getShops` ở `shops-lookup.ts`, gọi trong `withCompany`; `returnWindow` từ `capabilitiesOf(platform)`, `returnWindowDays` từ cột `return_window_days`, kể cả gian hàng đã ngắt; một câu cho cả lô). Tiêm làm `ctx.returnPoliciesOf` ở `src/wiring.ts`, thêm vào `Required<Pick<SalesContext, …>>` của `AppContext` (D6).
- `SalesContext` khai `returnPoliciesOf`. Sales bọc một hàm điền mặc định (5.1) cho gian hàng vắng. `getShops`, `ShopRef` không đổi.
- `startSalesBackground(ctx)` nhận `ctx`, truyền xuống job.

### 5.3 TikTok: sàn báo hết quyền trả

- `RemoteOrder` (`channel/service/marketplaces/common.ts`) thêm `returnWindowEndedAt?: Date | null`: mốc sàn báo đơn hết quyền trả, chỉ sàn `returnWindow = 'platform_status'` điền.
- `toTiktokOrder`: `returnWindowEndedAt = status === 'COMPLETED' || status === 'CANCELLED' ? updatedAt : null` (D14: đơn sàn đã huỷ không còn chờ `COMPLETED`; thiếu nhánh này thì đơn có kiện đã giao mà sàn huỷ sau đó kẹt `return_window` mãi). Lazada không điền.
- `PlatformOrder` (`sales/service/ingest.ts`) thêm `returnWindowEndedAt?: Date | null` (đi xuống nhờ `...remote`).
- `ingestMarketplaceOrder`: `o.returnWindowEndedAt` có giá trị mà `orders.return_window_ends_at` còn null thì ghi cột này cùng lần cập nhật đơn; đã có giá trị thì giữ (D7). Không tính là đơn đổi nếu chỉ cột này đổi (thực tế đi kèm `raw_marketplace_status` đổi nên đơn vẫn được ghi và phát sự kiện như cũ).
- Job đọc cột này qua `returnWindowEndsAt(policy, …, storedEndsAt)`.
- **Bù đơn cũ** (D13): đơn đã ở `COMPLETED`/`CANCELLED` trên sàn trước PR 2 sẽ không được kéo lại (lượt kéo bỏ đơn có `update_time` không mới hơn `raw_orders`, `order-pull.ts:161`). PR 2 kèm một migration dữ liệu viết tay (`npm run db:generate -- --name tiktok-han-tra --custom`): `return_window_ends_at = raw_orders.external_update_time` cho đơn `processing` của gian hàng `tiktok`, `raw_marketplace_status` là `COMPLETED` hoặc `CANCELLED`, cột còn null. Chuỗi sàn chỉ nằm trong migration chạy một lần, không trong code chạy. Kèm test migration (tiền lệ `test/integration/product/catalog/product-code-migration.test.ts`).

### 5.4 Job khép đơn (`sales/service/complete.ts`)

- `findCompletionCandidates`: `processing`, có kiện, mọi kiện dừng; bỏ điều kiện `cancelling` (đơn Đang huỷ mọi kiện huỷ cũng vào). Trả thêm `shopId`.
- Mỗi lượt: gom ứng viên theo công ty; mỗi công ty gọi `ctx.returnPoliciesOf` **một lần** cho các gian hàng của ứng viên (trong `withCompany` của công ty đó). Mỗi đơn vẫn một `withCompany` riêng, lỗi một đơn không chặn đơn khác (như hiện tại).
- Mỗi đơn: đọc đơn, kiện, yêu cầu trả mở; `closingStep`:
  - `complete`: như hiện tại; `return_window_ends_at` = `returnWindowEndsAt(…)` theo chính sách; giữ nhánh gỡ cờ Đang huỷ, bật Sàn đã huỷ (#238).
  - `auto_cancel`, đơn có cờ `cancelling`: gọi `settleCancelledOrder(orderId)` (cùng file service, đã kiểm lại dưới khoá và đủ điều kiện dòng) — lưới đỡ khi lần gọi sau `open_cancel` lỗi. Ghi `platform_cancel` (D3).
  - `auto_cancel`, không cờ `cancelling`: cập nhật theo `version` sang `cancelled`, `cancel_reason = 'Mọi kiện đã huỷ'`; `recordTransition` `action = 'auto_cancel'`, `source = 'system'`, người làm trống; phát `sales.order_cancelled` `{ orderId, code, source, by }` với `by` theo D4, rồi `sales.order_status_changed` (cờ lưu, cộng `unmapped_sku` nếu còn dòng chưa ghép, như `settleCancelledOrder`).
  - `blocker`: không làm gì.
- Tên log, tên hàm có thể đổi sang "khép đơn"; `completeDueOrdersOnce` vẫn export (test dùng), nhận thêm `ctx`.

### 5.5 Consumer kiện mở lại

- `startSalesBackground` đăng ký `registerConsumer('fulfillment.package_status_changed', …, { consumer: 'sales-package-reopened' })`.
- Handler (đã trong `withCompany` của sự kiện): khoá đơn (`lockOrderRow`). Đơn không `completed` thì bỏ.
- **Kết quả đơn** (D9): mọi sự kiện kiện của đơn `completed` đều tính lại `outcome = outcomeOf(trạng thái hiện tại của các kiện)`, ghi nếu khác. Tính theo trạng thái hiện tại nên đúng cả chuỗi nhiều bước (`lost → in_transit` rồi `in_transit → delivered`), không phụ thuộc thứ tự sự kiện.
- **Cờ Cần xử lý** (D9): bật khi kiện mở lại, tức (a) `from` thuộc `STOPPED` và `occurredAt > completed_at`, hoặc (b) đơn hiện có kiện chưa dừng. `attention_note` (`Kiện <mã> đổi <from> → <to> sau khi đơn hoàn tất`) ghi khi đơn chưa bật cờ, **hoặc** note đang có là note "trạng thái app chưa biết" của #358 (`UNKNOWN_STATUS_NOTE`, lượt kéo sạch sẽ tự gỡ cờ mang note đó và làm mất lần mở lại). Note của luồng khác giữ nguyên.
- Có đổi thì phát `sales.order_status_changed` `from = to = 'completed'` kèm cờ.
- Idempotent: chạy lại cùng sự kiện, hay nhận lại sự kiện cũ, tính ra cùng kết quả, không ghi thêm.
- Đường kéo đơn vẫn bật cờ như cũ (`ingest.ts:304`); consumer tới sau thấy cờ đã bật (note không phải #358) thì chỉ tính lại `outcome`.
- `return_window_ends_at`, `completed_at` không đổi.
- Lần deploy đầu nhận lại tới 7 ngày sự kiện cũ (mục 2): kết quả đơn tính lại theo trạng thái hiện tại (vô hại); đơn hoàn tất trong 7 ngày đó có kiện thật sự mở lại sau khi hoàn tất thì bật cờ (đúng ý). Không lọc theo giờ deploy (D15).

### 5.6 COD (điều kiện 4)

Job và chi tiết đơn tính `codUnconfirmed` từ dòng kiện đã đọc (`findPackagesOfOrders` lấy đủ cột). Không ghi gì. Nhánh này chưa có dữ liệu thật tới khi có đơn tạo tay (D10).

### 5.7 Chi tiết đơn (`GET /sales/orders/:id`, `service/orders.ts`)

- Gọi `ctx.returnPoliciesOf([o.shopId])` song song với `shopsOf` đang có.
- `returnWindowEndsAt`: đơn `completed`/`cancelled` → cột đã lưu; đơn `processing` → `returnWindowEndsAt(policy, lastDelivered, cột)`; đơn `unpaid` → null (D12).
- `completionBlocker`: đơn `processing` → `blocker` của `closingStep`; bước `complete` → null; bước `auto_cancel` → **`all_packages_cancelled`** (PR 3, D16: thêm giá trị vào enum ở `api/schemas.ts:174` và `21` §19.1; FE đã trả đúng giá trị này ở `src/lib/machines/order.ts:308` và có nhãn "Mọi kiện đã huỷ" ở `features/sales/shared.ts:89`). Trạng thái khác → null.
- `OrderViewRow` cần thêm `returnWindowEndsAt` nếu `select` chưa lấy.

### 5.8 Khoá, đua

- Job ghi theo `version` (`updateOrderAt`), lệch thì lượt sau xét lại (như hiện tại). `settleCancelledOrder` tự khoá đơn.
- Consumer khoá đơn trước, chỉ đọc kiện (không khoá kiện): cùng thứ tự "đơn trước kiện" của lượt kéo.
- Kéo đơn ghi `return_window_ends_at` dưới khoá đơn của lượt kéo; job đọc không khoá, ghi theo `version`.

## 6. Chia PR

| PR | Nội dung | Phụ thuộc | Migration |
|---|---|---|---|
| **1** (đóng #390) | 5.1 (trừ nhánh `auto_cancel`, máy trạng thái; `platform_status` tạm tính 7 ngày), 5.2, 5.4 nhánh `complete` theo chính sách, 5.6, 5.7 (trừ giá trị `all_packages_cancelled`). Đơn mọi kiện huỷ giữ hành vi hiện tại | Không; làm ngay | Không |
| **2** | 5.3 (kể cả bù đơn cũ), nhánh `platform_status` của 5.1; AC TikTok | PR 1 (chồng nhánh hoặc sau merge) | Có, chỉ dữ liệu (viết tay) |
| **3** | Nhánh `auto_cancel` và máy trạng thái 5.1, 5.4 nhánh `auto_cancel` và lưới đỡ, 5.5, giá trị `all_packages_cancelled` của 5.7 | PR 1 (D2, D3 đã chốt) | Không |

Mỗi PR cập nhật `src/modules/order/sales/CLAUDE.md` (mục Tự hoàn tất, Cho module khác); PR 1 bỏ câu "Hạn trả của đơn chưa đọc cột này (`order` còn cứng 7 ngày)" ở `channel/channel/CLAUDE.md`, thêm dòng `returnPoliciesOf` ở mục Cho module khác; PR 2 sửa bảng TikTok (dòng `COMPLETED`) ở `channel/channel/CLAUDE.md`.

## 7. Quyết định

Khang chốt: **D1** cách A (mục 4).

**Khang chốt 18/11/2026 (code lệch Documents, sửa Documents theo):**

- **D2** Tên thao tác huỷ khi mọi kiện huỷ là **`auto_cancel`** (guard `packages_not_cancelled`; `all_packages_cancelled` là mã chặn của `complete`), như FE và `ca-theo-so-do.md` D1-03, D1-10; sửa `21` §19.1 dòng 1753.
- **D3** Đơn Đang huỷ đã mở xong mọi kiện **giữ `platform_cancel`** của `settleCancelledOrder` (spec 205 D24: nguyên nhân là sàn huỷ, lý do "Sàn huỷ đơn", `by: 'platform'`); sửa câu "hoặc cờ Đang huỷ đã mở xong mọi kiện" ở `21` §19.1 và dòng `processing → cancelled` ở `25` §8.2. Lưới đỡ của job (5.4) gọi `settleCancelledOrder` nên cũng ghi `platform_cancel`.

**Claude đề xuất, Khang xem khi duyệt spec:**

- **D4** `by` của `sales.order_cancelled` khi `auto_cancel`: `'platform'` cho đơn `marketplace`, `'seller'` cho đơn khác. Không đổi schema sự kiện dùng chung (không cần PR riêng, không báo bên nghe).
- **D5** Hạn trả `days` tính lúc kiểm theo cấu hình hiện tại: Admin đổi số ngày thì áp cho mọi đơn chưa hoàn tất của gian hàng (#390). Gian hàng null hoặc không tìm thấy: 7 ngày.
- **D6** Chính sách lấy qua hàm `ctx.returnPoliciesOf` mới, không mở rộng `getShops`: kết quả `getShops` bị trải vào object `shop` của API (`service/orders.ts:134`) và dùng chung cho finance, fulfillment; thêm trường sẽ lộ ra hợp đồng.
- **D7** TikTok báo bằng `RemoteOrder.returnWindowEndedAt` (mốc = `update_time` của lượt thấy trạng thái kết thúc, ghi một lần, không đè). Sales không biết tên trạng thái sàn.
- **D8** Sàn `platform_status` không có hạn dự phòng theo ngày: sàn chưa báo thì đơn có kiện đã giao chưa hoàn tất.
- **D9** Consumer tính lại kết quả đơn theo trạng thái hiện tại cho **mọi** sự kiện kiện của đơn `completed`; cờ Cần xử lý chỉ bật khi kiện thật sự mở lại (5.5). Không đè ghi chú của luồng khác, trừ note tự gỡ của #358.
- **D10** Điều kiện COD viết ngay trên cột có sẵn dù chưa có dữ liệu.
- **D11** Gộp #390 thành PR 1 của #236; đóng #390 khi PR 1 merge.
- **D12** Chi tiết đơn đã hoàn tất trả hạn trả đã lưu, không tính lại theo cấu hình mới.
- **D13** Không để khoảng hở khi deploy: PR 1 giữ 7 ngày cho sàn `platform_status` (merge `main` là deploy staging; bật nhánh này trước PR 2 thì mọi đơn TikTok có kiện đã giao kẹt). PR 2 bật nhánh và bù đơn đã `COMPLETED`/`CANCELLED` bằng migration dữ liệu (5.3).
- **D14** TikTok `CANCELLED` cũng là mốc hết quyền trả. Lý do: sàn không cho người bán huỷ đơn đã giao (`tich-hop-san/tiktok.md` dòng 50, 25011050), nên đơn `CANCELLED` có kiện đã giao là ca hiếm; không có nhánh này thì đơn đó kẹt mãi vì không có nút hoàn tất tay. Chưa thử trên sàn (mục 10).
- **D15** Consumer không lọc sự kiện cũ lúc deploy đầu (5.5).
- **D16** Sửa điều kiện (1) (đơn mọi kiện huỷ không hoàn tất) để ở PR 3 cùng `auto_cancel`, không ở PR 1: tránh để đơn đó nằm `processing` không lý do giữa hai PR. Chi tiết đơn trả `completionBlocker = all_packages_cancelled` cho đơn đang chờ huỷ, khớp FE (5.7).

## 8. Documents cần sửa (hai PR ở repo Documents)

**Cùng hoặc trước PR 1:**

- `21` §19.1 đoạn "Hoàn tất": gian hàng `days` chưa nhập số ngày tính 7 ngày; đơn đã hoàn tất trả hạn trả đã lưu.
- `27` US-DH-16 dòng 1b, 2 và `kiem-thu/ca-theo-so-do.md`: cấp mã ca (hiện "(chưa có ca)"); test PR 1 mang mã đó. Mã chưa có khi mở PR 1 thì test ghi "US-DH-16 1b", "US-DH-16 2" và đổi khi Documents merge.

**Cùng PR 2:** `21` §19.1 "Hoàn tất": `returnWindowEndsAt` với `platform_status` = lúc app thấy sàn báo đơn kết thúc (`COMPLETED`, `CANCELLED`; mốc `update_time` của đơn trên sàn), null tới lúc đó.

**Cùng hoặc trước PR 3:**

- `21` §19.1 bảng thao tác đơn: dòng 1753 theo D2 (tên thao tác, mã chặn), câu về cờ Đang huỷ theo D3; enum `completionBlocker` thêm `all_packages_cancelled` (D16).
- `25` §8.2 dòng `processing → cancelled`: theo D3.
- (Tuỳ, ngoài #236) `21` §11.2 `sales.order_cancelled`: `by: 'platform' | 'seller'` cho khớp code.
- Issue #236: gạch đầu "Job hoàn tất…" thêm nửa sau của điều kiện (1); ghi #390 là PR 1; DoD E2E là việc FE. Issue #390: ghi đi theo spec này.

## 9. Tiêu chí chấp nhận và test

Đọc `test/CLAUDE.md` trước khi viết. Unit: `test/unit/modules/order/sales/domain/order.test.ts` (`closingStep` đủ nhánh và thứ tự, `returnWindowEndsAt`, `codUnconfirmed`, máy trạng thái). Integration: `test/integration/order/sales/complete.test.ts` (mở rộng), `test/integration/order/sales/package-reopened.test.ts` (mới), `test/integration/channel/channel/tiktok-order-pull.test.ts`; API: `test/integration/order/sales/orders-api.test.ts`. Unit của `toTiktokOrder` đặt cạnh test TikTok hiện có. Gian hàng thật (có `return_window_days`) tạo bằng helper của channel; ca không cần gian hàng giữ `shopId` ngẫu nhiên như test hiện tại.

**PR 1**

| # | Ca | Cho | Khi | Thì |
|---|---|---|---|---|
| 1 | | Gian hàng Lazada `returnWindowDays = 15`, kiện giao cuối 8 ngày trước | Job chạy | Đơn vẫn `processing`; chi tiết `completionBlocker = return_window`, `returnWindowEndsAt` = mốc giao + 15 ngày |
| 2 | D1-03 | Như 1, giao 16 ngày trước | Job chạy | `completed`, `outcome = full`, `return_window_ends_at` = mốc giao + 15 ngày |
| 3 | | Gian hàng `returnWindowDays = null`, giao 8 ngày trước | Job chạy | `completed` (7 ngày) |
| 4 | | Đơn của `shopId` không có gian hàng | Job chạy | Tính 7 ngày (ca hiện có trong `complete.test.ts` vẫn xanh) |
| 5 | | Đơn ở ca 1 | Admin đổi `returnWindowDays` 15 → 5, job chạy | `completed` |
| 6 | US-DH-16 1b | Mọi kiện không huỷ `returned`/`lost`, không yêu cầu trả mở | Job chạy | `completed` ngay, `outcome = none`, `return_window_ends_at` null |
| 7 | US-DH-16 2 | Còn yêu cầu trả `requested` | Job chạy | Chưa hoàn tất; `completionBlocker = return_requested` |
| 8 | | Kiện tự giao `delivered`, `cod_expected > 0`, `cod_confirmed_at` null (chèn trực tiếp) | Job chạy | Chưa hoàn tất; `completionBlocker = cod_unconfirmed`. Ghi `cod_confirmed_at` (người khác người giao) thì lượt sau hoàn tất |
| 9 | | Kiện tự giao `cod_expected` null hoặc 0 | Job chạy | Không chặn |
| 10 | | Đơn `completed` ở ca 2 | Admin đổi số ngày, `GET` chi tiết | `returnWindowEndsAt` = giá trị đã lưu |
| 11 | | Ba đơn của hai gian hàng cùng công ty | Một lượt job (`returnPoliciesOf` giả đếm lời gọi) | Gọi một lần cho công ty |
| 11a | | Gian hàng TikTok, kiện giao 8 ngày trước, sàn chưa `COMPLETED` | Job chạy (PR 1) | `completed` (tạm 7 ngày, D13) |
| 11b | | Đơn `processing` không cờ Đang huỷ, mọi kiện `cancelled` | Job chạy (PR 1) | Như hiện tại (D16); đổi ở PR 3 |
| 11c | | `GET /sales/orders` và chi tiết đơn | | Object `shop` không có trường mới (kiểm hợp đồng) |

**PR 2**

| # | Ca | Cho | Khi | Thì |
|---|---|---|---|---|
| 12 | | Đơn TikTok `DELIVERED` / `COMPLETED` / `CANCELLED` | `toTiktokOrder` | `returnWindowEndedAt` null / = `update_time` / = `update_time` |
| 12a | | Gian hàng TikTok, kiện giao 8 ngày trước, sàn chưa `COMPLETED` | Job chạy (PR 2) | Chưa hoàn tất (khác ca 11a) |
| 12b | | Đơn `processing` của gian hàng TikTok, `raw_marketplace_status = COMPLETED`, `return_window_ends_at` null, `raw_orders` có `external_update_time` | Chạy migration bù | Cột = `external_update_time`; đơn Lazada, đơn đã có cột, đơn `completed` không đổi |
| 13 | | Gian hàng TikTok, kiện `delivered` 30 ngày trước, sàn còn `DELIVERED` | Job chạy | Chưa hoàn tất; `completionBlocker = return_window`, `returnWindowEndsAt` null |
| 14 | | Như 13 | Lượt kéo thấy `COMPLETED`, rồi job chạy | Cột `return_window_ends_at` = `update_time`; `completed`, `outcome = full` |
| 15 | | Đơn ở 14 | Kéo lại với `update_time` mới hơn | Cột giữ giá trị đầu |
| 16 | | Gian hàng TikTok, mọi kiện không huỷ `returned` | Job chạy | `completed` không chờ `COMPLETED` |
| 17 | | Đơn Lazada | Kéo đơn | `returnWindowEndedAt` vắng; cột không đổi |

**PR 3**

| # | Ca | Cho | Khi | Thì |
|---|---|---|---|---|
| 18 | D1-10 | Đơn `processing` không cờ Đang huỷ, mọi kiện `cancelled` | Job chạy | `cancelled`, lịch sử `auto_cancel` `source = system`, lý do "Mọi kiện đã huỷ"; phát `sales.order_cancelled` (`by` theo D4) và `sales.order_status_changed`; **không** `completed` |
| 19 | D1-03 (điều kiện) | Máy trạng thái, kiện đều `cancelled` | `complete` | 409 `all_packages_cancelled` |
| 20 | D1-10 (điều kiện) | Máy trạng thái, có kiện không huỷ | `auto_cancel` | 409 `packages_not_cancelled` |
| 21 | D1-10x, D1-03x | Người dùng (có `actor`) | `auto_cancel`, `complete` | 409 `invalid_transition` |
| 22 | D1-X01, X03, X04 | Đơn `unpaid` / `completed` / `cancelled` | `auto_cancel` | 409 `invalid_transition` |
| 23 | | Đơn cờ Đang huỷ, mọi kiện `cancelled`, mọi dòng huỷ đủ, `settleCancelledOrder` chưa chạy | Job chạy | Đơn `cancelled`, lịch sử `platform_cancel`, lý do "Sàn huỷ đơn" (D3) |
| 24 | | Đơn Đang huỷ còn kiện chờ mở | Job chạy | Không đổi (ca hiện có) |
| 24a | | Đơn processing mọi kiện `cancelled` | `GET` chi tiết | `completionBlocker = all_packages_cancelled` |
| 25 | | Đơn `completed`, kiện `lost` | Kéo đơn: sàn báo kiện đã giao | Đơn giữ `completed`, `needs_attention`, `outcome` tính lại (vd `none` → `full`) |
| 25a | | Đơn `completed`, kiện `lost` | Sàn báo `in_transit`, lượt sau báo `delivered` | Sau bước 1 cờ bật, `outcome` theo kiện hiện tại; sau bước 2 `outcome = full` |
| 26 | | Đơn `completed`, kiện `lost` | Người dùng `found` | Đơn giữ `completed`, `needs_attention` bật kèm note mới, `outcome` giữ |
| 27 | | Như 26, đơn đã bật cờ với note của luồng khác | `found` | Note cũ giữ nguyên |
| 27a | | Như 26, đơn đã bật cờ với note `UNKNOWN_STATUS_NOTE` (#358) | `found`, rồi lượt kéo sạch | Note thành note mở lại; lượt kéo không gỡ cờ |
| 28 | | Sự kiện `from` dừng, `occurredAt` trước `completed_at`, mọi kiện hiện đã dừng | Consumer nhận | Không bật cờ; `outcome` vẫn đúng theo kiện hiện tại |
| 29 | | Consumer nhận cùng sự kiện hai lần | | Lần hai không ghi, không phát |

## 10. Giới hạn đã biết

- Đơn mọi kiện huỷ hiện "Chờ hoàn tất" tới một giờ (job mỗi giờ). Hiện chỉ đơn Đang huỷ có `settleCancelledOrder` lỗi rơi vào ca này; đơn tạo tay sau này dùng nhánh này là chính.
- **TikTok `update_time` khi `DELIVERED → COMPLETED`:** chưa thử. Nếu sàn không tăng `update_time`, lượt kéo theo cửa sổ không thấy đơn đổi và đơn TikTok có kiện đã giao không bao giờ hoàn tất. Trước khi merge PR 2: `npm run smoke:tiktok -- order 586932266789143562` (đơn `COMPLETED` của shop thử), so `update_time` với `delivery_time`; cách xa nhiều ngày thì coi là sàn có tăng. Không tăng thì mở issue kéo lại đơn `DELIVERED`.
- Mốc hết quyền trả TikTok là `update_time` của lượt thấy `COMPLETED`, không phải giờ chuyển thật trên sàn.
- Sàn không có adapter (bộ thận trọng `platform_status`): đơn có kiện đã giao không tự hoàn tất. Sàn không có adapter thì không kéo được đơn nên chưa gặp.
- Lazada: mốc giao rơi về giờ đồng bộ khi không đọc được hành trình (#199 phần c); hạn trả tính từ đó.
- Giảm số ngày của gian hàng có thể làm một loạt đơn hoàn tất ở lượt kế (D5).
- TikTok `CANCELLED` coi là hết quyền trả (D14): chưa thử trên sàn với đơn đã giao rồi bị huỷ.
- Kiện mở lại không đổi `return_window_ends_at`, không mở lại đơn.
- Consumer chậm (Kafka dừng) thì cờ và kết quả đơn trễ theo.
- So `occurredAt` (giờ bắt đầu giao dịch của DB) với `completed_at` (giờ `now` của lượt job, đầu lượt): kiện đổi từ trạng thái dừng giữa lúc lượt bắt đầu và lúc đơn đó được khép có thể làm bật cờ thừa. Hiếm (lượt job vài giây), cờ thừa chỉ cần người xem rồi gỡ.
- Lần deploy đầu của consumer nhận lại sự kiện tới 7 ngày (D15).
- Điều kiện COD chưa có dữ liệu thật (D10).

## 11. Để người làm tự quyết

- Tên `closingStep`, `returnWindowEndsAt`, `returnPoliciesOf`, tên consumer; hình dạng chính xác của giá trị trả về.
- Cách gom chính sách theo công ty trong job (một giao dịch đọc riêng hay đọc trong giao dịch của đơn đầu).
- Câu ghi chú Cần xử lý của consumer.
- Consumer dùng `lockOrderRow` + `updateOrder` hay `updateOrderAt(version)`; miễn không đè note và idempotent.
- Đặt test `toTiktokOrder` ở file nào trong `test/unit/modules/channel/channel/service/marketplaces/`.
- `completeDueOrdersOnce` nhận `ctx` ở tham số đầu hay trong object tuỳ chọn.
