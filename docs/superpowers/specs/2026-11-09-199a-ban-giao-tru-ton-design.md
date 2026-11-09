# Spec: Bàn giao trừ tồn theo kiện (#199, phần a)

- **Ngày:** 09/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#199, `Documents/21` §11.1, §11.2, §19.2, `Documents/25` §6.1, §7.1, §8.1, §8.3, §8.4, `Documents/19` (bảng `packages`, `package_lines`), `Documents/27` US-DH-08, DH-09, DH-10, TK-11, `Documents/kiem-thu/ca-theo-so-do.md` §D2
- **Trạng thái:** nháp, chờ Khang duyệt
- **Phạm vi:** phần a của #199. #199 chia bốn phần (Khang chọn 09/11/2026), mỗi phần một spec:
  - a: bàn giao trừ tồn, huỷ bàn giao, route đọc kiện;
  - b: chia hàng, `allocation_done`;
  - c: đã giao, thất bại, hoàn và sự kiện cho finance, `packageStatusOf`;
  - d: FE và E2E.

  Bàn giao bắt buộc (sàn báo đã lấy khi kiện còn Thiếu hàng, ca D2-31) issue ghi thuộc #238; Khang chọn kéo vào phần a (09/11/2026) vì nó nằm trên cùng đường bàn giao.

---

## 1. Mục tiêu và tiêu chí thành công

1. Kiện rời kho thì tồn thực giảm **đúng một lần**, theo đúng các món trong kiện. Áp dụng dù kho quét, sàn báo, sàn báo nhảy cóc, sàn báo trùng hay hai bên đua nhau. Giá vốn lúc rời kho lưu trên dòng kiện.
2. CEO huỷ được bàn giao nhầm do kho quét khi sàn chưa xác nhận lấy. Tồn thực và đang giữ cộng lại, kiện giữ hàng lại.
3. Sàn báo đã lấy khi kiện còn Thiếu hàng: giữ được thì trừ như thường; không giữ được thì bàn giao bắt buộc (tồn thực có thể âm, cờ Tồn âm, kiện cần xử lý).
4. Kiện rời kho trước mốc kiểm kê không bị trừ. Gian hàng đang chờ kiểm kê đầu kỳ thì hoãn trừ tới khi phiếu đầu kỳ ghi sổ.
5. Kho có danh sách kiện theo tab và chi tiết kiện qua API `21` §19.2.

Đo bằng: AC ở mục 9 đều qua; body trả về parse được bằng schema Zod khai trong OpenAPI; `npm run check` xanh.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (8d34836):**
- Kiện lập từ đơn sàn ở `fulfillment/service/platform-packages.ts` (#105), gọi trong giao dịch kéo đơn của channel: `order-pull.ts` (mỗi 5 phút) → sales `ingestMarketplaceOrder` → `syncPlatformPackages`. Kiện mới giữ hàng ngay qua `reserve` thật (#266). Gian hàng chờ kiểm kê đầu kỳ thì `holdStock = false`.
- Trạng thái sàn áp lên kiện qua `platformUpdate` (`domain/package.ts`): `direct`, `jump` (nhảy tới trên đường chính, `backordered` tính như `reserved`), `invalid` (cờ Cần xử lý). Đổi trạng thái chỉ đổi cột, **chưa gọi `ship`**. `handed_over_at` là lúc đồng bộ thấy.
- Cổng tồn (`product/index.ts`, #266) đã có thân thật:
  - `reserve`, `release`;
  - `ship(packageId, lines: { variantId, quantity, packageLineId }[], { actorId, forced? })` → `{ documentId, number }`, có lưới chống gọi lặp theo `packageLineId`;
  - `reverseShipment(packageId, lines, { actorId, reason })`, đảo **đủ cả lượt**: theo bản sửa review của #266, đang được đưa lên `main` ở PR riêng;
  - `stockOf`.
- `package_lines` có `reserved_qty` (0 hoặc đủ), `unit_cost`, `stock_deducted`. `packages` chưa có `handover_source`.
- Route của fulfillment rỗng. Kiện chỉ ra FE qua `GET /orders`, `GET /orders/:id` của sales (`PackageSummary` ở `sales/api/schemas.ts`, dựng ở `sales/service/orders.ts`).
- Danh mục sự kiện chưa có `fulfillment.package_shipped`.

**Ràng buộc:**
- `order` ở lớp 3: được import `product/index.ts`, không import `channel`. Tên gian hàng lấy qua `ctx.shopsOf` như sales.
- Trong module lớn `order`, sales import fulfillment. Fulfillment không import sales (sẽ thành vòng), nhưng repository của fulfillment được join bảng của sales vì cùng schema `order` (luật ranh giới 2).
- Cổng tồn gọi trong giao dịch của bên gọi. Fulfillment lo chống gọi lặp: khoá kiện, đổi `reserved_qty`, `stock_deducted` có điều kiện trong cùng giao dịch (`21` §11.1).
- `ship` thường trên kiện chưa giữ hàng sẽ báo lỗi. Bên gọi truyền `forced: true` khi và chỉ khi có dòng `reserved_qty < quantity` (`21` §11.1).
- Thêm loại sự kiện là sửa file dùng chung `core/platform/domain/events.ts`: PR riêng, báo bên nghe (`src/modules/CLAUDE.md`).
- Code lệch Documents thì sửa Documents trước.

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Chia #199 thành a, b, c, d; làm theo thứ tự a → b → c → d | a, b là hai phần đổi số tồn; b mở đường cho #223 (channel đẩy tồn theo `allocation_done`). Khang chọn 09/11/2026 |
| D2 | Bàn giao bắt buộc (D2-31) làm ở phần a | Cùng đường bàn giao; để #238 thì tới lúc đó tồn thực cao hơn thực tế. Khang chọn 09/11/2026. Checklist #199, #238 sửa cho khớp |
| D3 | Một bảng tác động tồn theo mũi tên (`domain`) và một chỗ thi hành (`service/handover-stock.ts`); mọi đường vào đều qua đó | Luật "trừ đúng một lần, thử giữ rồi bắt buộc, chốt giá vốn" nằm một nơi, có unit test; b, c chỉ thêm dòng. Đã loại: mỗi đường vào tự gọi cổng (chép luật 4–5 nơi), trừ tồn bất đồng bộ qua sự kiện (trái `21` §11.1, có lúc tồn chưa trừ mà kiện đã đi). Khang chọn 09/11/2026 |
| D4 | Luật mốc (`25` §6.1, §8.1) làm ở phần a, kèm hàm bù `settleDeferredHandovers` cho #198 gọi | Luật trừ tồn nằm một nơi; #198 (Thành) chỉ việc gọi khi phiếu đầu kỳ ghi sổ. Khang chọn 09/11/2026 |
| D5 | Phần a làm cả `GET /fulfillment/packages` và `GET /fulfillment/packages/:id` | Màn bàn giao (d) và #239 dùng lại; test trọn qua HTTP. Khang chọn 09/11/2026 |
| D6 | Thêm `packages.pickup_confirmed_at` | `21` §19.2 cần biết sàn đã xác nhận lấy (chặn huỷ bàn giao, cờ `pickup_unconfirmed`); `19` chưa có cột nào ghi được điều này |
| D7 | `handover_source` thêm giá trị `before_cutoff` | Đánh dấu kiện rời kho trước mốc, chỉ lưu: hàm bù và dòng ghép SKU muộn phải bỏ qua chúng. Không suy được về sau vì `handed_over_at` là lúc đồng bộ thấy |
| D8 | Một nơi dựng `PackageSummary`: chuyển schema, hàm dựng sang fulfillment; sales gọi lại | Hai route trả cùng kiểu, tránh hai bản lệch nhau |
| D9 | Một PR danh mục sự kiện đi trước, thêm mọi sự kiện kiện của `21` §11.2 | Sửa file dùng chung một lần; finance đã chờ `package_delivered`, `package_returned` |
| D10 | Bàn giao theo lô: mỗi kiện một giao dịch | Kiện lỗi không chặn kiện khác (`21` §19.2); mỗi giao dịch gọi cổng tồn cho một kiện nên không deadlock giữa các kiện |
| D11 | Chưa có khung việc (#209): việc "Dỡ kiện về kệ" khi huỷ bàn giao kiện của đơn đang huỷ thay bằng cờ Cần xử lý kèm ghi chú | `21` §19.2 đòi tự tạo việc; khung chưa có |

## 4. Phạm vi

**Trong spec:**
- Documents (mục 8);
- PR danh mục sự kiện (D9);
- migration (mục 5.1);
- `domain/`: `stockEffectOf`, `handoverStockMode`, `shipPlan`;
- `service/handover-stock.ts`: `settleHandover`, `revertHandover`, `settleDeferredHandovers`, `shipLateMappedLines`;
- sửa `platform-packages.ts` đi qua lõi, truyền mốc từ channel qua sales;
- route `hand-over`, `undo-handover`, `GET /fulfillment/packages`, `GET /fulfillment/packages/:id`;
- chuyển `PackageSummary` sang fulfillment, cờ `pickup_unconfirmed`;
- test; `fulfillment/CLAUDE.md` (mới).

**Ngoài spec:**
- chia hàng, `hold`/`reclaim`, `allocation_done` (199b);
- đã giao, thất bại, giao lại, hoàn, nhận hoàn, `packageStatusOf`, phát `package_delivered|delivery_failed|returned` (199c);
- FE, E2E (199d);
- route `self-deliver` (chỉ đơn tạo tay, chưa có) — lõi đã trừ tồn đúng cho mũi tên `self_deliver` khi route này có;
- đóng gói, RTS, vận đơn, danh sách nhặt (#239);
- sàn chia lại kiện, thất lạc, Mở kiện (#238);
- việc nhắc theo khung #209;
- thoát chế độ chờ kiểm kê (#198, Thành; gọi `settleDeferredHandovers`);
- ghép SKU từ dòng đơn (#237; gọi `shipLateMappedLines`).

## 5. Thiết kế

### 5.1 Dữ liệu và migration

Một migration (số kế tiếp, hiện là `0026`; nhánh khác merge trước thì sinh lại):

```sql
CREATE TYPE "order"."handover_source" AS ENUM ('scan', 'marketplace', 'forced', 'before_cutoff');
ALTER TABLE "order"."packages" ADD COLUMN "handover_source" "order"."handover_source";
ALTER TABLE "order"."packages" ADD COLUMN "handover_reverted_by" uuid;
ALTER TABLE "order"."packages" ADD COLUMN "pickup_confirmed_at" timestamp with time zone;
-- Kiện đã rời kho trước #199 chưa từng qua `ship`: ghi nhận là chỉ lưu.
UPDATE "order"."packages" SET "handover_source" = 'before_cutoff'
  WHERE "status" IN ('in_transit','self_delivering','delivered','delivery_failed','returning','returned','lost')
    AND "handover_source" IS NULL;
ALTER TABLE "order"."packages" ADD CONSTRAINT "packages_handover_source"
  CHECK ("status" IN ('backordered','reserved','packed','awaiting_pickup','cancelled') OR "handover_source" IS NOT NULL);
```

- Ba cột thêm đều null được, chỉ đổi metadata. Bản app cũ bỏ qua các cột này.
- `UPDATE` điền dữ liệu nằm ngay trong migration: bảng `packages` trên staging là dữ liệu demo, ít dòng; CHECK cần dữ liệu sạch ngay. Lùi: `DROP CONSTRAINT`, `DROP COLUMN` ba cột, `DROP TYPE`.
- `handover_source`: `scan` (kho quét), `marketplace` (sàn báo, kể cả nhảy cóc), `forced` (bàn giao bắt buộc), `before_cutoff` (rời kho trước mốc, chỉ lưu).
- `pickup_confirmed_at`: lần đầu sàn báo kiện ở trạng thái rời kho sau khi kho đã quét. Kiện do sàn báo bàn giao thì bằng `handed_over_at`.
- `handover_reverted_by`: người huỷ bàn giao gần nhất (`19`).
- `package_lines` không đổi.

### 5.2 Luật thuần (`domain/handover.ts`)

```ts
type StockEffect = 'ship' | 'reverse' | 'none';
stockEffectOf(from: PackageStatus | null, to: PackageStatus): StockEffect
```
- `to` thuộc `HANDED_OVER` và (`from` null hoặc không thuộc `HANDED_OVER`) → `ship`. Phủ `hand_over`, `self_deliver`, nhảy cóc tới `in_transit` hoặc `delivered`, kiện mới tạo đã ở trạng thái rời kho.
- `from` thuộc `HANDED_OVER`, `to` không thuộc → `reverse` (chỉ `undo_handover`).
- Còn lại → `none`. Hàng hoàn không cộng tồn ở đây (qua phiếu kiểm hàng hoàn, 199c, #202).

```ts
handoverStockMode(p: { firstSeen: boolean; placedAt: Date; orderCutoffAt: Date | null; awaitingStocktake: boolean })
  : 'deduct' | 'store_only' | 'defer'
```
- `awaitingStocktake` → `defer`.
- `firstSeen` và `orderCutoffAt` khác null và `placedAt < orderCutoffAt` → `store_only` (kiện về qua lượt đơn còn mở lúc thiết lập, đã rời kho trước mốc).
- Còn lại → `deduct` (kể cả đơn về muộn, đặt sau mốc: `25` §8.1).

```ts
interface PlanLine { id: string; variantId: string | null; quantity: number; reservedQty: number; stockDeducted: boolean }
shipPlan(lines: readonly PlanLine[]): { held: PlanLine[]; unheld: PlanLine[] }
```
- Chỉ dòng có `variantId` và `stockDeducted = false`.
- `held`: `reservedQty = quantity`; `unheld`: `reservedQty < quantity`. Cần `forced` khi và chỉ khi `unheld` khác rỗng mà không giữ được.

### 5.3 Thi hành (`service/handover-stock.ts`)

Mọi hàm chạy trong giao dịch của bên gọi, kiện đã khoá `FOR UPDATE`. Bên gọi ghi `handover_source` (`scan` hoặc `marketplace`) lúc chuyển kiện vào nhóm rời kho; lõi chỉ đổi nó sang `forced` hoặc `before_cutoff`.

`settleHandover(pkg, { actorId: string | null, mode })` → `{ documents: DocumentRef[] }`:
1. `mode = 'store_only'`: ghi `handover_source = 'before_cutoff'`, dừng. `mode = 'defer'`: không làm gì (hàm bù xử lý sau).
2. `{ held, unheld } = shipPlan(lines)`; cả hai rỗng thì dừng. Đây là chốt trừ đúng một lần, cùng với lưới `packageLineId` của `ship`.
3. `unheld` khác rỗng: gọi `reserve(pkg.id, unheld)`.
   - Được: đặt `reserved_qty = quantity` cho các dòng đó, gộp vào `held`.
   - Không được: các dòng `unheld` đi `ship` với `forced: true`. Ghi `handover_source = 'forced'`, bật `needs_attention` với ghi chú "Bàn giao bắt buộc: thiếu tồn, cần kiểm kê lại", log `warn` kèm `packageId`, `variantIds`. Cờ Tồn âm do inventory tự bật.
4. `held` khác rỗng: `ship(pkg.id, held, { actorId })` thường. Trường hợp vừa có dòng giữ vừa có dòng bắt buộc (chỉ xảy ra với dòng ghép SKU muộn) thành hai phiếu `XK`.
5. Đọc `stockOf(variantIds)` trong cùng giao dịch. Mỗi dòng vừa trừ: `unit_cost = avgCost`, `stock_deducted = true`, `reserved_qty = 0`.
6. Phát `fulfillment.package_shipped { packageId, orderId, lines: { variantId, quantity, unitCost }[] }` với mọi dòng vừa trừ.

`revertHandover(pkg, actorId, reason)`:
- Gọi `reverseShipment(pkg.id, mọi dòng stock_deducted = true, { actorId, reason })` (đảo đủ cả lượt).
- Mỗi dòng đó: `reserved_qty = quantity`, `stock_deducted = false`, `unit_cost = null`.
- Kiện: `handover_source`, `handed_over_at`, `handed_over_by`, `pickup_confirmed_at` về null; `handover_reverted_by = actorId`.

`settleDeferredHandovers(shopId, countedAt)` (export, #198 gọi trong giao dịch ghi sổ phiếu đầu kỳ hoặc ngay sau đó):
- Khoá các kiện của gian hàng ở trạng thái rời kho, `handover_source` khác `before_cutoff`, còn dòng có SKU chưa trừ.
- `handed_over_at >= countedAt` → `settleHandover` với `mode = 'deduct'`; trước đó → `mode = 'store_only'`.
- Gọi lần hai không trừ thêm.

`shipLateMappedLines(packageId)` (export, #237 gọi sau khi gán `variant_id` cho dòng kiện):
- Kiện chưa rời kho hoặc `before_cutoff`: không làm gì (chia hàng của b lo kiện chưa rời kho).
- Còn lại: khoá kiện, `settleHandover` với `mode = 'deduct'`; `handover_source` giữ nguyên trừ khi bước 3 thành `forced`.

### 5.4 Các đường vào

**Kho quét:** `POST /fulfillment/packages/hand-over`, body `{ packages: { id, version }[] }` (1..50, id không trùng). Mỗi kiện một `withCompany` riêng:
1. Khoá kiện; không có → `not_found`; `version` khác → `version_conflict`.
2. `assertTransition(packageMachine, status, 'hand_over', …)`. Kiện đã ở nhóm rời kho → `already_handed_over`; trạng thái khác → `invalid_transition`.
3. Kiện sang `in_transit`, `handover_source = 'scan'`, `handed_over_by`, `handed_over_at = now()`; `recordTransition` (`source` mặc định); `settleHandover({ actorId, mode: 'deduct' })`.
4. Phát `fulfillment.package_status_changed`.

Response `{ handedOver: { id, code, issue: { id, number } }[], failed: { packageId, code, detail }[] }`. `issue` là phiếu `XK` của lần trừ (kiện `awaiting_pickup` luôn đủ SKU và đã giữ hàng, nên luôn có đúng một phiếu). Lỗi bất ngờ ở một kiện: rollback riêng kiện đó, `failed[]` với `code = 'internal_error'`, log `error`.

**Huỷ bàn giao nhầm:** `POST /fulfillment/packages/:id/undo-handover`, body `{ version, reason }`:
1. Khoá kiện, kiểm `version`.
2. `assertTransition(…, 'undo_handover', { reason })` (quyền `fulfillment.handover.revert`, bắt buộc lý do).
3. `handover_source <> 'scan'` hoặc `pickup_confirmed_at` khác null → 409 `handover_confirmed_by_platform`.
4. `revertHandover`; kiện về `awaiting_pickup`; `recordTransition` kèm lý do; phát `package_status_changed`.
5. Đơn có cờ `cancelling` hoặc `platform_cancelled` → bật `needs_attention` với ghi chú "Đơn đang huỷ: dỡ kiện về kệ" (D11).
6. Trả `Package`.

**Đồng bộ sàn** (`platform-packages.ts`):
- `PlatformPackageOrder` thêm `placedAt`, `orderCutoffAt`. `holdStock = false` nghĩa là đang chờ kiểm kê.
  - Channel: `lockShopForOrders` trả thêm `orderCutoffAt`, `order-pull.ts` truyền xuống `ingestMarketplaceOrder` (module của Thành, vài dòng, ghi rõ trong PR).
  - Sales `ingest` truyền `placedAt`, `orderCutoffAt` vào `syncPlatformPackages`.
- `applyStatus`, kiện đổi trạng thái (`direct` hoặc `jump`):
  - `stockEffectOf(from, to) = 'ship'` → ghi `handover_source = 'marketplace'`, `pickup_confirmed_at = handed_over_at`, rồi `settleHandover({ actorId: null, mode: holdStock ? 'deduct' : 'defer' })`. Nhảy cóc từ `backordered` đi qua bước 3 của 5.3 (thử giữ rồi bắt buộc).
  - Kiện đã rời kho với `handover_source = 'scan'` mà sàn báo trạng thái rời kho: ghi `pickup_confirmed_at` nếu đang null, không trừ thêm.
- `createPackage` với trạng thái ban đầu thuộc nhóm rời kho: chèn kiện với `handover_source = 'marketplace'`, `pickup_confirmed_at = handed_over_at`, chèn dòng, rồi `settleHandover` với `mode = handoverStockMode({ firstSeen: true, … })`.
- Mũi tên `invalid`: giữ như hiện nay (cờ Cần xử lý), không đổi tồn.
- Sàn huỷ sau khi kiện rời kho: giữ như hiện nay (không cộng tồn tới khi hoàn, 199c).

### 5.5 Route đọc và kiểu `Package`

- **D8:** `PackageSummary` (schema, `.meta({ id: 'PackageSummary' })` giữ nguyên tên) và hàm dựng chuyển sang `fulfillment/api/schemas.ts`, `fulfillment/service/views.ts`.
  - Repository fulfillment join `orders`, `order_lines` của sales (cùng schema `order`) để lấy mã đơn, trạng thái đơn, nguồn, khách, thanh toán, SKU, tên sản phẩm, nhãn biến thể đã chép trên dòng đơn.
  - Tên gian hàng: `ctx.shopsOf` (`FulfillmentContext`, tiêm ở `src/wiring.ts` như `SalesContext`).
  - Sales dùng lại hàm dựng qua `fulfillment/index.ts`. Hình `GET /orders` không đổi, trừ cờ mới.
- **`GET /fulfillment/packages`:**
  - Vào: `tab` (`backordered, reserved, packed, awaiting_pickup, shipping, delivery_failed, returning, needs_open`; mặc định `reserved`), `search` (mã kiện, mã đơn, mã vận đơn; không phân biệt hoa thường), `source`, `shopId`, `page`, `pageSize` (1..100, mặc định 20).
  - Tab `reserved` chỉ gồm kiện của đơn `processing`; `shipping` = `in_transit` và `self_delivering`; `needs_open` = cờ `needs_open`.
  - Sắp `ship_by` tăng dần, null cuối, rồi `code`.
  - Ra `Page<PackageSummary> & { counts: Record<tab, number> }`. `counts` theo `search`, `source`, `shopId` nhưng không theo `tab`.
  - Lọc, đếm, phân trang bằng SQL.
- **`GET /fulfillment/packages/:id`:** `Package` = `PackageSummary` + `statusHistory` (`getStatusHistory('packages', id)` của staff). Kiện công ty khác, id không phải uuid → 404.
- **Cờ `pickup_unconfirmed`** (suy ra, không lưu): `handover_source = 'scan'`, `pickup_confirmed_at` null, `handed_over_at <= now() − 24 giờ`, kiện còn ở nhóm rời kho. Thêm vào enum `flags` của `PackageSummary`.

### 5.6 Sự kiện

- **PR danh mục (D9)** thêm vào `core/platform/domain/events.ts`, payload theo `21` §11.2, tiền là chuỗi thập phân, ngày ISO:
  - `fulfillment.package_shipped { packageId, orderId, lines: { variantId, quantity, unitCost }[] }`;
  - `fulfillment.allocation_done { variantIds }` (199b);
  - `fulfillment.package_delivered`, `package_delivery_failed`, `package_returned` (199c);
  - `fulfillment.package_lost` (#238).

  Báo Bình (finance) và Thành (channel).
- Phần a phát `package_shipped` (mục 5.3 bước 7) và `package_status_changed` ở mọi lần chuyển trạng thái do kho quét, huỷ bàn giao, sàn báo. Ghi outbox trong cùng giao dịch.

### 5.7 Lỗi

| Tình huống | Xử lý |
|---|---|
| Body `hand-over` sai: rỗng, quá 50, id trùng, không phải uuid | 422 `validation_failed` |
| Một kiện trong lô: không có, công ty khác | `failed[]` `not_found` |
| Một kiện trong lô: `version` cũ | `failed[]` `version_conflict` |
| Một kiện trong lô: đã rời kho | `failed[]` `already_handed_over` |
| Một kiện trong lô: trạng thái khác `awaiting_pickup` | `failed[]` `invalid_transition` |
| Một kiện trong lô: lỗi bất ngờ | `failed[]` `internal_error`, log `error`, kiện khác chạy tiếp |
| `undo-handover`: `version` cũ | 409 `version_conflict` kèm `current` |
| `undo-handover`: sai trạng thái | 409 `invalid_transition` |
| `undo-handover`: không phải kho quét, hoặc sàn đã xác nhận lấy | 409 `handover_confirmed_by_platform` |
| `undo-handover`: thiếu lý do | 422 `reason_required` |
| Kiện không có hoặc của công ty khác (route một kiện) | 404 |
| Đồng bộ sàn: lỗi khi trừ tồn | Cả đơn rollback; lượt kéo sau thử lại (như hiện nay) |

### 5.8 Phân quyền, bảo mật

- `GET` hai route, `hand-over`: `fulfillment.order.process` (Kho, CEO).
- `undo-handover`: `fulfillment.handover.revert` (CEO).
- Mọi truy vấn trong `withCompany`; id kiện công ty khác không thấy (RLS và lọc `company_id`).

### 5.9 Chạy đồng thời và gọi lặp

- Route khoá dòng kiện `FOR UPDATE`; đồng bộ sàn khoá các kiện của đơn (`lockOrderPackages`, đã có). Cùng một khoá nên chạy lần lượt.
- Kho quét lặp, hai người quét: lần sau thấy `in_transit` → `already_handed_over`, không `ship` lần hai.
- Kho quét đua sàn báo: bên sau hoặc nhận `already_handed_over` (quét sau), hoặc chỉ ghi `pickup_confirmed_at` (sàn sau).
- Sàn báo lại: không còn dòng chưa trừ, không trừ thêm.
- Giới hạn đã biết: đồng bộ một đơn nhiều kiện gọi cổng nhiều lần trong một giao dịch, có thể deadlock `40P01` (như #266); lượt kéo sau chạy lại.

### 5.10 Hiệu năng

- `hand-over` 50 kiện: 50 giao dịch ngắn, mỗi giao dịch vài câu theo khoá chính và một lần cổng tồn. Không truy vấn theo dòng ngoài số dòng của kiện.
- `GET /fulfillment/packages`: một câu trang và một câu `counts` (`count(*) filter (where …)` theo tab), có `index` trên `status`; tìm kiếm `ilike` trên mã kiện, mã đơn, mã vận đơn (`index` trên `tracking_code` đã có). Chưa thêm index tìm kiếm: số kiện của đồ án nhỏ; ghi vào giới hạn đã biết.

### 5.11 Test

| File | Kiểm |
|---|---|
| `test/unit/modules/order/fulfillment/domain/handover.test.ts` | `stockEffectOf` (mọi cặp vào, ra, ngoài nhóm rời kho; kiện mới), `handoverStockMode`, `shipPlan` |
| `test/integration/order/fulfillment/hand-over.test.ts` | AC 1–4 |
| `test/integration/order/fulfillment/undo-handover.test.ts` | AC 5, 6 |
| `test/integration/order/fulfillment/platform-handover.test.ts` | AC 7–11 |
| `test/integration/order/fulfillment/packages-read.test.ts` | AC 12, 13 |
| `test/integration/order/fulfillment/handover-migration.test.ts` | AC 14 |

Kiện ở `awaiting_pickup` trong test chèn thẳng bằng role chủ bảng (đóng gói là #239). Tên ca mang mã `ca-theo-so-do.md`.

## 6. Thứ tự giao

1. **PR Documents** (mục 8). Merge trước.
2. **PR danh mục sự kiện** (D9), nhánh riêng từ `main`.
3. **PR backend 199a**, nhánh `feature/199a-ban-giao` từ `main`, sau PR đưa hai commit sửa review #266 lên `main` (đảo đủ lượt).

## 7. Ảnh hưởng tới FE

Phần d làm. Hợp đồng FE dùng: hai route đọc, `hand-over`, `undo-handover`, cờ `pickup_unconfirmed`, mã lỗi `handover_confirmed_by_platform` (FE đã có câu báo theo `21` §19.2).

## 8. Ảnh hưởng tới Documents

- `19` bảng `packages`: thêm `pickup_confirmed_at` (sàn xác nhận lấy); `handover_source` thêm `before_cutoff` (rời kho trước mốc, chỉ lưu); CHECK kiện rời kho phải có `handover_source`.
- `21` §11.2: payload `fulfillment.package_shipped` đã có; sửa cột bên phát của các sự kiện kiện thành commerio-backend#199 (đang ghi #106, issue cũ đã xoá), `package_lost` ghi #238.
- `21` §19.2: ghi rõ `pickup_unconfirmed` suy từ `pickup_confirmed_at`; `hand-over` trả `failed[].code` gồm `not_found, version_conflict, already_handed_over, invalid_transition, internal_error`; `GET /fulfillment/packages` sắp `ship_by` null cuối, `counts` không theo `tab`.

## 9. Acceptance criteria

1. **Bàn giao (D2-05, US-DH-08.1):** quét 3 kiện `awaiting_pickup`. Mỗi kiện sang `in_transit`, có phiếu `XK`; tồn thực và đang giữ của mỗi SKU giảm đúng số món, một lần; dòng kiện có `unit_cost` bằng giá vốn bình quân lúc đó, `stock_deducted = true`, `reserved_qty = 0`; `handover_source = 'scan'`; có `package_shipped`, `package_status_changed`.
2. **Lô có kiện lỗi (US-DH-08.2):** một kiện sai `version`, một kiện `reserved`: vào `failed[]` đúng mã; các kiện khác bàn giao.
3. **Trừ đúng một lần (US-DH-08.3):** quét lại → `already_handed_over`; hai lần quét đua (`raceBehindLock`) → một thành công, tồn trừ một lần; sàn báo `in_transit` sau khi quét → chỉ ghi `pickup_confirmed_at`; sàn báo trước rồi kho quét → `already_handed_over`.
4. **Quyền (D2-05q, D2-06q):** Admin, Sale gọi `hand-over` → 403; Kho, Admin, Sale gọi `undo-handover` → 403.
5. **Huỷ bàn giao (D2-06, US-DH-09.1):** CEO có lý do → kiện `awaiting_pickup`, phiếu `DX`; tồn thực, đang giữ cộng lại; dòng kiện `reserved_qty = quantity`, `stock_deducted = false`; `handover_reverted_by` là CEO; lịch sử có lý do. Bàn giao lại sau đó trừ lại đúng một lần.
6. **Chặn huỷ bàn giao (D2-06r, D2-06g):** thiếu lý do → 422 `reason_required`; sàn đã xác nhận lấy, hoặc kiện vào `in_transit` do sàn báo → 409 `handover_confirmed_by_platform`.
7. **Sàn nhảy cóc (US-DH-10.2):** kiện `reserved` mà sàn báo `in_transit`; kiện `reserved` mà sàn báo `delivered` → trừ tồn đúng một lần, `handover_source = 'marketplace'`, `pickup_confirmed_at` có giá trị. Đồng bộ lại cùng trạng thái không trừ thêm.
8. **Bàn giao bắt buộc (D2-31, US-TK-11.2):** kiện `backordered` mà sàn báo `in_transit`: đủ khả dụng → giữ rồi `ship` thường, không Tồn âm. Thiếu → `ship` bắt buộc: tồn thực âm, cờ Tồn âm của SKU, kiện `needs_attention`, `handover_source = 'forced'`.
9. **Mốc:** đơn đặt trước mốc, kiện lần đầu thấy đã `in_transit` → không phiếu `XK`, `handover_source = 'before_cutoff'`, `unit_cost` null. Đơn đặt sau mốc, kiện lần đầu thấy đã `in_transit` → trừ.
10. **Chờ kiểm kê:** gian hàng chờ kiểm kê, sàn báo hai kiện rời kho (một trước, một sau `countedAt`) → chưa trừ. `settleDeferredHandovers(shopId, countedAt)` → kiện sau `countedAt` trừ, kiện trước thành `before_cutoff`; gọi lần hai không đổi gì.
11. **Ghép SKU muộn:** kiện đã rời kho có một dòng chưa ghép; gán `variant_id` rồi gọi `shipLateMappedLines` → thêm một phiếu `XK` chỉ cho dòng đó. Kiện `before_cutoff` → không làm gì.
12. **Route đọc:**
    - `GET /fulfillment/packages`: đúng kiện theo từng tab (kể cả `reserved` chỉ đơn `processing`, `shipping` gồm hai trạng thái), `counts`, tìm theo mã kiện, mã đơn, mã vận đơn, sắp theo `ship_by` null cuối.
    - `GET /:id` trả `Package` có `statusHistory`; công ty khác → 404.
    - Body parse được bằng schema; `GET /orders` vẫn parse được.
13. **`pickup_unconfirmed`:** bật sau 24 giờ kể từ lúc kho quét khi sàn chưa xác nhận; tắt khi sàn xác nhận (thời gian giả lập bằng `vi.useFakeTimers` hoặc chỉnh `handed_over_at`).
14. **Migration:** kiện ở trạng thái rời kho có từ trước được điền `before_cutoff`; ghi kiện rời kho mà `handover_source` null bị CHECK chặn.
15. Test cũ xanh (đồng bộ kiện #105, `GET /orders`, cổng tồn); `npm run check` xanh, depcruise không báo vi phạm.

## 10. Rủi ro và điểm còn mở

- **Phụ thuộc PR đưa hai commit sửa review #266 lên `main`.** Phần a cần `reverseShipment` đảo đủ cả lượt. PR đó chưa merge thì phần a vẫn viết được (luôn truyền đủ dòng của lượt) nhưng merge sau nó.
- **`handed_over_at` là lúc đồng bộ thấy, không phải lúc sàn lấy thật.** Lệch tối đa một chu kỳ kéo đơn (5 phút) và thời gian sàn chưa đổi `updated_at`. Ảnh hưởng: so với `countedAt` ở hàm bù có thể xếp nhầm kiện rời kho sát mốc. Chấp nhận; sàn có mốc thật (trace, 199c) thì dùng mốc đó.
- **Sửa module của người khác:** channel `order-pull.ts`, `shops.ts` (Thành) truyền `orderCutoffAt`. Báo trong PR.
- **Chuyển `PackageSummary` sang fulfillment** đụng `sales/service/orders.ts`, `sales/api/schemas.ts`. Hình response giữ nguyên; test `GET /orders` hiện có là lưới an toàn.
- **Bàn giao bắt buộc đổi phạm vi #238.** Sửa checklist #199, #238 khi merge.
- **Hai phiếu `XK` cho một kiện** khi vừa có dòng đã giữ vừa có dòng bắt buộc (chỉ với dòng ghép SKU muộn). Response `hand-over` khai một `issue`: kiện `awaiting_pickup` không rơi vào trường hợp này.
