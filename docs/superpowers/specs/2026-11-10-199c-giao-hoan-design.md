# Spec: Giao xong, giao thất bại, hoàn về và sự kiện cho finance (#199, phần c)

- **Ngày:** 10/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#199, `Documents/21` §11.2, §11.3, §19.2, `Documents/25` §8.1, §8.3, §8.4, §10.1, §10.2, `Documents/19` (bảng `packages`), `Documents/27` US-DH-10, US-DH-11, `Documents/kiem-thu/ca-theo-so-do.md` §D2 (D2-24), `Documents/tich-hop-san/lazada.md` §7.4, §11.5
- **Trạng thái:** nháp, chờ Khang duyệt
- **Phạm vi:** phần c của #199. Phần a đã merge (#291); phần b ở PR #298 (chưa merge). Gộp thêm hai việc Khang chốt ngày 10/11/2026:
  - quét nhận hàng hoàn (`receive-return`, US-DH-11), vì `package_returned` phát lúc kiện vào `returned` và `returned` nghĩa là kho đã quét (spec 199a §4 đã xếp "nhận hoàn" vào 199c);
  - sàn huỷ món vì giao không thành thì kiện sang `returning` (`25` §8.4 quy tắc 4), chuyển từ checklist #238 về.

---

## 1. Mục tiêu và tiêu chí thành công

1. Kiện sau bàn giao đi đúng tới lúc kết thúc theo sàn báo: đã giao, giao thất bại, giao lại, đang hoàn. Sàn báo nhảy qua các bước thì bù tồn đúng một lần.
2. Finance nhận `package_delivered` đủ số để ghi sổ thu chi mà không gọi lại module đơn, đúng một lần cho mỗi kiện, giá vốn là giá lúc bàn giao.
3. Kho quét nhận kiện hoàn thì kiện sang `returned`, sinh phiếu kiểm hàng hoàn, phát `package_returned`. Sàn báo hoàn xong không tự đưa kiện sang `returned`.
4. Finance đọc được trạng thái kiện qua `packageStatusOf` (E139).
5. Mốc giao và lý do giao thất bại lấy theo hành trình thật của sàn khi có.

Đo bằng: AC ở mục 9 đều qua; body route parse được bằng schema Zod khai trong OpenAPI; `npm run check` xanh.

## 2. Bối cảnh và ràng buộc

**Hiện trạng (nhánh `feature/199b-chia-hang`, 3e9a99c):**
- Adapter Lazada đã ánh xạ trạng thái món sang trạng thái kiện (`LINE_STATUS` ở `channel/service/marketplaces/lazada.ts`): `delivered`, `failed_delivery`/`failed` → `delivery_failed`, `shipped_back` → `returning`, `shipped_back_success`/`returned` → `returned`, `shipped_back_failed` → `return_failed`. `lazadaCancelSource` đã đọc `cancellation-failed Delivery` thành `cancelKind = 'failed_delivery'`, lưu ở `order_lines.cancel_kind`.
- `platform-packages.ts` lấy món chậm nhất làm trạng thái kiện, áp qua `platformUpdate`: `direct` (có mũi tên), `jump` (nhảy tới trên đường chính `reserved → … → delivered`), `invalid` (cờ Cần xử lý). Vào nhóm rời kho thì trừ tồn qua lõi `handover-stock.ts` (199a).
- Hệ quả hiện nay:
  - `shipped_back_success` đưa kiện `returning → returned` qua mũi tên `receive_return` mà không có kho quét, không phiếu kiểm hàng hoàn (trái `25` §8.3);
  - kiện đã rời kho mà sàn huỷ món vì giao không thành thì giữ nguyên trạng thái (`cancelPlatformPackage` trả `handed_over`);
  - kiện trước bàn giao mà sàn báo luôn `delivery_failed`/`returning` thì chỉ bật cờ, không trừ tồn, kẹt ở trạng thái cũ;
  - `delivered_at`, `handed_over_at` là lúc đồng bộ thấy.
- Chưa phát `package_delivered`, `package_delivery_failed`, `package_returned` (đã có trong danh mục từ #288). Finance đã có `recordPackageDelivered`, `recordPackageReturned` nhưng chưa đăng ký consumer; `postDelivered` gọi `new Decimal(unitCost)`, chưa chịu `null`.
- Chưa có `packageStatusOf`, chưa có route `receive-return`.
- Chưa ai gọi `/logistic/order/trace`; chỉ có stub ở `scripts/lazada-mock/stubs.ts`.
- `receiveBack(source, lines)` (inventory, #206) lập phiếu `KT` nháp, gọi lại cùng nguồn trả phiếu cũ; chưa nhận `meta` (#208).
- Dòng đơn: `unit_price` là giá một món; `seller_discount`, `platform_discount` là tổng của cả dòng (`line_total = unit_price − seller_discount − platform_discount`, `sales/service/ingest.ts:193`). Đơn: `shipping_fee` (ship khách trả), `shipping_fee_original`, `shipping_fee_discount_seller`, `shipping_fee_discount_platform` (#260, null được).

**Ràng buộc:**
- `order` ở lớp 3: không import `channel`. Gọi sàn chỉ ở channel, ngoài giao dịch (`getAdapter`, không `if (platform === …)` ngoài file adapter).
- Fulfillment không import sales: dữ liệu tiền của dòng đơn, đơn đọc bằng SQL thô `"order".order_lines`, `"order".orders` như `repository/package-list.ts` (199a).
- Sự kiện ghi outbox trong cùng giao dịch nghiệp vụ. Sửa `core/platform/domain/events.ts` là sửa file dùng chung: PR riêng, báo bên nghe.
- Code lệch Documents thì sửa Documents trước.

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Kiện chỉ sang `returned` khi kho quét (`POST /fulfillment/packages/:id/receive-return`). Sàn báo hoàn xong (`shipped_back_success`) thì kiện ở lại `returning` | `25` §8.3: `returned` là "đã quét nhận, đã sinh phiếu kiểm hàng hoàn". Đã loại: sàn báo là `returned` (kho chưa xác nhận hàng về), cả hai bên ai tới trước thì dùng (phiếu sinh khi hàng chưa chắc về). Khang chọn 10/11/2026 |
| D2 | Món huỷ có `cancelKind = 'failed_delivery'` tính là `returning`; làm ở 199c, gạch khỏi #238 | Cùng đường đồng bộ trạng thái giao; kiện vào `returning` phải đi tiếp tới quét nhận của 199c. Khang chọn 10/11/2026 |
| D3 | Trạng thái vẫn lấy theo trạng thái món của sàn; `/logistic/order/trace` chỉ lấy mốc giờ và lý do giao thất bại. Gọi trace ở channel, ngoài giao dịch, chỉ cho đơn có món sau bàn giao; lỗi trace không chặn lượt kéo | `status_code` của trace chưa có tài liệu; trạng thái món đã ánh xạ đủ. Đã loại: trace làm nguồn trạng thái (tốn gọi API, mã chưa rõ), chưa dùng trace (mốc lệch, không có lý do). Khang chọn 10/11/2026 |
| D4 | Ship cấp đơn (`shipping_fee`, `shipping_fee_original`, `shipping_fee_discount_platform`) ghi trọn vào kiện giao xong đầu tiên của đơn; kiện sau mang `"0"` | Khách trả ship một lần cho cả đơn; lãi theo đơn đúng; kiện hoàn sau đó không làm mất phần ship đã trả. Đã loại: chia theo giá trị kiện, theo `shipping_amount` của món. Khang chọn 10/11/2026 |
| D5 | Kiện trước bàn giao (`backordered` … `awaiting_pickup`) mà sàn báo `delivery_failed` hoặc `returning`: bù bàn giao (trừ tồn một lần qua lõi 199a) rồi áp | Hàng chắc chắn đã rời kho; giữ cờ thì kiện kẹt, không tới được quét nhận hàng hoàn. Cùng cách `25` §8.1 làm với kiện lần đầu thấy. Khang chọn 10/11/2026 |
| D6 | `package_delivered.lines[].variantId` cho phép `null` (dòng chưa ghép SKU, dòng "không quản tồn") | Bỏ dòng thì finance mất doanh thu của dòng đó; finance chỉ dùng `unitPrice`, `quantity`, `unitCost`. Khang chọn 10/11/2026 |
| D7 | Một chỗ thi hành tác động sau bàn giao (`service/delivery.ts`), luật thuần ở `domain/delivery.ts`; mọi đường vào (đồng bộ sàn, quét nhận hoàn, hàm bù) gọi trong giao dịch của bên gọi | Cùng khuôn lõi bàn giao 199a. Đã loại: phát sự kiện tài chính từ consumer `package_status_changed` (giao dịch khác, đọc lại, chống trùng thêm), việc nền riêng gọi trace cho mọi kiện đang giao |
| D8 | Thêm `packages.delivery_posted_at` (lúc đã phát `package_delivered`) | Phát đúng một lần kể cả khi kiện vào `delivered` lần hai (#238); biết kiện giao đầu tiên của đơn (D4); hoãn phát cho kiện hoãn trừ tới khi hàm bù chốt giá vốn |
| D9 | Kiện lần đầu thấy đã hoàn về (`returned`) của đơn đặt trước mốc kéo đơn (`store_only`) vào thẳng `returned`, chỉ lưu | Kiểm kê đầu kỳ đã đếm hàng đó; bắt kho quét kiện đã về từ trước mốc là việc thừa và phiếu `KT` sẽ cộng trùng |
| D10 | `shippingIncome = shipping_fee`, `shippingCost = shipping_fee_original` (null thì `shipping_fee`), `platformSubsidy` gồm `shipping_fee_discount_platform` | Ship thực nhận = khách trả + sàn trợ − phí đầy đủ = phần shop chịu, khớp "thực nhận" ở `25` §10.2 và các dòng giao dịch tài chính của Lazada. **Đề xuất, chờ Bình xác nhận ở PR Documents** |

## 4. Phạm vi

**Trong spec:**
- PR Documents (mục 8); PR danh mục sự kiện (`variantId` null được);
- migration `delivery_posted_at` (5.1);
- `domain/delivery.ts`, sửa `platformUpdate` ở `domain/package.ts` (5.2);
- `service/delivery.ts`, `repository/delivery.ts` (5.3);
- sửa `platform-packages.ts`, `handover-stock.ts` (`settleDeferredHandovers`) gọi vào lõi (5.4);
- route `receive-return` (5.5); `packageStatusOf` (5.6);
- adapter Lazada đọc trace, `order-pull` gọi trace, sales truyền `cancelKind` và sự kiện kiện xuống fulfillment (5.7);
- test; cập nhật `fulfillment/CLAUDE.md`, `channel/CLAUDE.md`.

**Ngoài spec:**
- route `POST /fulfillment/packages/:id/delivery`, `self-deliver` cho đơn tạo tay (US-DH-17 ngoài MVP);
- thất lạc, sàn báo kiện sống lại (`platform_lost`, `platform_revive`, `found`), sàn chia lại kiện (#238);
- trace của TikTok (adapter TikTok không có hàm, đi theo trạng thái món);
- finance đăng ký consumer `package_delivered`, `package_returned`, sửa `postDelivered` chịu `unitCost: null`, dùng `packageStatusOf` cho E139 (Bình);
- `meta` của `receiveBack` (#208);
- nhắc kiện `returning` quá 14 ngày, `delivery_failed` quá 3 ngày (khung #209);
- FE, E2E (199d).

## 5. Thiết kế

### 5.1 Dữ liệu và migration

Migration `0029` (số kế tiếp sau `0028` của 199b; nhánh khác merge trước thì sinh lại):

```sql
ALTER TABLE "order"."packages" ADD COLUMN "delivery_posted_at" timestamp with time zone;
-- Kiện đã giao trước 199c: coi như đã báo, không phát bù sự kiện cho dữ liệu cũ.
UPDATE "order"."packages" SET "delivery_posted_at" = "delivered_at"
  WHERE "status" = 'delivered' AND "delivered_at" IS NOT NULL;
```

- Cột null được, chỉ đổi metadata; bản app cũ bỏ qua. `UPDATE` nằm trong migration vì `packages` trên staging là dữ liệu demo (cùng cách `0027`, `0028`). Lùi: `DROP COLUMN "delivery_posted_at"`.
- Nghĩa: lúc `fulfillment.package_delivered` của kiện được ghi outbox. Đặt `now()` trong cùng giao dịch phát; không bao giờ đặt lại null.
- Lý do giao thất bại không thêm cột: ghi ở `core.state_transitions.reason` và trong sự kiện.

### 5.2 Luật thuần (`domain/delivery.ts`, `domain/package.ts`)

```ts
interface PackageEvent { status: PlatformLineStatus; at: Date; description: string | null }
```
Sự kiện hành trình của một kiện (từ trace, 5.7), đã lọc đúng kiện.

```ts
lineStatus(l: { status: PlatformLineStatus | null; cancelKind: CancelKind | null }): PlatformLineStatus | null
```
Món `cancelled` có `cancelKind = 'failed_delivery'` → `returning` (D2); còn lại giữ nguyên. `groupStatus` của `platform-packages.ts` dùng hàm này trước khi chọn món chậm nhất.

```ts
deliveryTarget(remote: Exclude<PlatformLineStatus, 'pending' | 'cancelled'>, p: { firstSeen: boolean; storeOnly: boolean }): PackageStatus
```
- `returned`: `firstSeen && storeOnly` → `returned` (D9); còn lại → `returning` (D1).
- `return_failed` → `returning` (cờ như hiện nay).
- Còn lại: trạng thái cùng tên.

`platformUpdate(from, to)` (sửa): thêm `jump` khi `from` thuộc `backordered`, `reserved`, `packed`, `awaiting_pickup` và `to` là `delivery_failed` hoặc `returning` (D5). `stockEffectOf(from, to)` đã trả `ship` cho mọi lần vào nhóm rời kho nên lõi bàn giao tự bù.

```ts
journeyTimes(events: readonly PackageEvent[], now: Date): { leftAt: Date | null; deliveredAt: Date | null; failReason: string | null }
```
- `leftAt`: `at` sớm nhất của các sự kiện sau bàn giao (`in_transit`, `delivered`, `delivery_failed`, `returning`, `returned`, `lost`).
- `deliveredAt`: `at` muộn nhất của sự kiện `delivered`.
- `failReason`: `description` của sự kiện `delivery_failed` muộn nhất, cắt khoảng trắng, rỗng thì null.
- Mốc sau `now` thì lấy `now`.

```ts
interface DeliveredLine { variantId: string | null; quantity: number; unitCost: string | null; order: { quantity: number; unitPrice: string; sellerDiscount: string; platformDiscount: string } }
interface OrderShipping { shippingFee: string; shippingFeeOriginal: string | null; shippingFeeDiscountPlatform: string | null }
deliveredAmounts(lines: readonly DeliveredLine[], shipping: OrderShipping, first: boolean)
  : { lines: { variantId: string | null; quantity: number; unitPrice: string; unitCost: string | null }[]; platformSubsidy: string; shippingIncome: string; shippingCost: string }
```
- `unitPrice` = `order.unitPrice − order.sellerDiscount ÷ order.quantity` (giá sau voucher shop).
- `platformSubsidy` = Σ `order.platformDiscount × quantity ÷ order.quantity`, cộng `shippingFeeDiscountPlatform ?? 0` khi `first`.
- `first`: `shippingIncome = shippingFee`, `shippingCost = shippingFeeOriginal ?? shippingFee` (D10). Không `first`: cả hai `"0"`.
- Tính bằng `decimal.js`, làm tròn 2 chữ số (`ROUND_HALF_UP`), ra chuỗi `toFixed(2)`.

### 5.3 Thi hành (`service/delivery.ts`, `repository/delivery.ts`)

Mọi hàm chạy trong giao dịch của bên gọi, kiện đã khoá `FOR UPDATE`.

`reportDelivered(pkg: { id; orderId; shopId; deliveredAt }): Promise<boolean>`:
1. Đọc `delivery_posted_at` của kiện; khác null → `false`.
2. Kiện còn dòng hoãn trừ (`variant_id` khác null, `stock_deducted = false`, `handover_source` khác `before_cutoff`) → `false`; `settleDeferredHandovers` gọi lại sau khi bù.
3. `shopId` null (đơn tạo tay, chưa có đường vào ở MVP) → `false`, log `warn`.
4. Đọc dòng kiện kèm dòng đơn (`deliveryLinesOf`, một câu SQL thô join `"order".order_lines`), ship của đơn (`orderShippingOf`), `first` = không kiện nào khác của đơn có `delivery_posted_at` (`anotherDeliveryPosted`). Dòng kiện trỏ tới dòng đơn không có → ném lỗi.
5. `deliveredAmounts`, phát `fulfillment.package_delivered { packageId, orderId, shopId, deliveredAt (ISO), ...amounts }` (`aggregateId = orderId`), đặt `delivery_posted_at = now()`. Trả `true`.

`reportDeliveryFailed(pkg, reason: string)`: phát `fulfillment.package_delivery_failed { packageId, orderId, reason }`.

`receiveReturn(ctx, actor, id, { version, code })`: mục 5.5.

Repository: `deliveryLinesOf(packageId)`, `orderShippingOf(orderId)`, `anotherDeliveryPosted(orderId, packageId)`, `markDeliveryPosted(packageId)`, `packageStatuses(ids)`.

### 5.4 Đồng bộ sàn và hàm bù

**`syncPlatformPackages`** (`PlatformPackageLine` thêm `cancelKind`; `PlatformPackageOrder` thêm `packageEvents: readonly RemotePackageEventIn[]`, rỗng khi sàn không có trace):
- Mỗi nhóm món lọc sự kiện của kiện theo mã kiện sàn, không thấy thì theo mã vận đơn; `journeyTimes`.
- `groupStatus` dùng `lineStatus` (5.2).
- **Kiện đã có:**
  - `to = deliveryTarget(remote, { firstSeen: false, storeOnly: false })`.
  - Kiện `returned` mà `to = returning` → bỏ qua, không cờ (kho quét trước, sàn chậm hơn).
  - `platformUpdate` như 5.2. Vào nhóm rời kho: `handed_over_at`, `pickup_confirmed_at` = `leftAt ?? now` (thay `now` của 199a). Kiện kho đã quét chỉ ghi `pickup_confirmed_at = leftAt ?? now`.
  - Vào `delivered`: `delivered_at = deliveredAt ?? now`; sau `settleHandover` (nếu có) gọi `reportDelivered`.
  - Vào `delivery_failed`: lịch sử ghi `reason`; `reportDeliveryFailed(pkg, failReason ?? 'Sàn báo giao không thành công')`.
- **Kiện mới** (`createPackage`): tính `mode = handoverStockMode(...)` trước khi chèn; `initial = deliveryTarget(remote, { firstSeen: true, storeOnly: mode === 'store_only' })` (`pending` → `backordered` như cũ). Mốc như trên. Sau `settleHandover`: kiện `delivered` → `reportDelivered`; `delivery_failed` → `reportDeliveryFailed`. Kiện vào thẳng `returned` (D9): không `receiveBack`, không `package_returned`.
- Kiện vào `returning` (kể cả do D2, D5): chỉ `package_status_changed` như mọi lần chuyển.
- **Đơn mà mọi món huỷ vì giao không thành** (bổ sung lúc viết plan, 10/11/2026): sales huỷ đơn khi mọi món sàn báo `cancelled` và không kiện nào báo `handed_over`/`needs_open` (`sales/service/ingest.ts:229`). Nhóm món sàn báo `cancelled` nhưng `lineStatus` đổi thành `returning` (D2) thì sau khi áp, kết quả đồng bộ vẫn ghi `handed_over` vào `cancelled`, như kiện đã rời kho bị sàn huỷ. Sales vì vậy bật cờ `platform_cancelled`, không huỷ đơn (`25` §8.2: sàn huỷ khi đã có kiện bàn giao). Sales không phải sửa luật huỷ.

**`settleDeferredHandovers`**: sau `settleHandover` của mỗi kiện, kiện đang `delivered` thì `reportDelivered` (kiện hoãn trừ đã giao trước khi phiếu đầu kỳ ghi sổ nay có giá vốn, hoặc là `before_cutoff` với `unitCost: null`).

### 5.5 Quét nhận hàng hoàn

`POST /fulfillment/packages/:id/receive-return`, `ctx.authorize('fulfillment.order.process')` trước `validate`. Body `ReceiveReturnBody { version: int ≥ 0, code: string.trim() 1..100 }`.

Trong `withCompany`:
1. `lockPackage(id)`; không có (kể cả công ty khác, id không phải uuid) → 404.
2. `version` khác → 409 `version_conflict` kèm `current`.
3. `assertTransition(packageMachine, status, 'receive_return', { actor, record })`; sai trạng thái → 409 `invalid_transition`.
4. `code` khớp `packages.code` hoặc `tracking_code`, không phân biệt hoa thường → tiếp; không khớp → 422 `package_mismatch` (`errors.code`).
5. Dòng có `variant_id` gộp theo SKU; có ít nhất một dòng thì `receiveBack({ type: 'package', id }, lines)` (phiếu `KT` nháp, tồn chưa đổi tới khi phiếu ghi sổ). Không dòng nào đã ghép thì không lập phiếu, log `info`.
6. Kiện sang `returned` (`UPDATE … WHERE status AND version`), `recordTransition` với người quét, phát `package_status_changed`, `package_returned { packageId, orderId, shopId, returnedAt: now }` (kiện có `shopId`).
7. Trả `Package` (`getPackage`).

- Phiếu lập cho mọi dòng đã ghép, kể cả kiện `before_cutoff`, kiện bàn giao bắt buộc, kiện hoãn trừ: hàng đã về kệ thật. Kiện `before_cutoff`: kiểm kê đầu kỳ không đếm hàng đang ở ngoài, cộng lại là đúng. Kiện hoãn trừ rời kho sau lúc đếm: hàm bù trừ một lần, phiếu cộng một lần.
- Quét lần hai: kiện đã `returned` → 409 `invalid_transition`; `receiveBack` cùng nguồn trả phiếu cũ nếu có gọi.
- Schema `ReceiveReturnBody` khai OpenAPI; response `Package` (đã có).

### 5.6 `packageStatusOf`

```ts
packageStatusOf(packageIds: readonly string[]): Promise<Map<string, { orderId: string; status: PackageStatus; deliveredAt: string | null }>>
```
- Chạy trong `withCompany` của bên gọi. Bỏ id không phải uuid; rỗng → `new Map()` không truy vấn. Một câu `where id = any($1)`.
- Id công ty khác không có trong Map (RLS và lọc `company_id`). `deliveredAt` là ISO của `delivered_at`.
- Export ở `fulfillment/index.ts`, qua `order/index.ts`. Finance (lớp 4) import thẳng, không sửa `src/wiring.ts`.

### 5.7 Trace (channel, sales)

**Adapter** (`marketplaces/common.ts`):
```ts
interface RemotePackageEvent { packageCode: string | null; trackingCode: string | null; status: RemoteLineStatus; at: Date; description: string | null }
getPackageEvents?(accessToken: string, externalOrderId: string): Promise<RemotePackageEvent[]>
```
- Lazada: `GET /logistic/order/trace` `order_id`. Mỗi `module[].package_detail_info_list[]` (`ofc_package_id`, `tracking_number`), mỗi `logistic_detail_info_list[]`: `status = lazadaPackageStatus(detail_type)`, `at = new Date(event_time)` (mili giây), `description`. `detail_type` lạ, `event_time` không phải số → bỏ dòng đó. Lỗi sàn đi qua `MarketplaceError` như các hàm khác.
- `RemoteOrder` thêm `packageEvents?: RemotePackageEvent[]`.
- `ofc_package_id` chưa chắc trùng `package_id` (`FP…`) của món: fulfillment khớp theo mã kiện sàn trước, rồi mã vận đơn (5.4). Thử trên shop thử, ghi kết quả vào `lazada.md` §11.5.

**`order-pull.ts`**: sau khi có `RemoteOrder` và trước giao dịch ingest, đơn có món ở `in_transit`, `delivered`, `delivery_failed`, `returning`, `returned`, `return_failed`, `lost`, hoặc món huỷ với `cancelKind = 'failed_delivery'`, và adapter có `getPackageEvents` thì gọi qua `onMarketplace` (giới hạn tốc độ sẵn có). Lỗi bất kỳ → log `warn { shopId, externalOrderId, err }`, đi tiếp với `[]`.

**Sales `ingest.ts`**: `PlatformOrder` thêm `packageEvents`, dòng thêm `cancelKind` (đã có ở `info`), truyền xuống `syncPlatformPackages`.

### 5.8 Sự kiện

| Sự kiện | Khi | Payload |
|---|---|---|
| `fulfillment.package_delivered` | Kiện vào `delivered` và `reportDelivered` trả `true`; hoặc hàm bù chốt giá vốn cho kiện đã `delivered` | `21` §11.2, `variantId` null được (D6), tiền theo 5.2 |
| `fulfillment.package_delivery_failed` | Mỗi lần kiện vào `delivery_failed` (trực tiếp, nhảy cóc, kiện mới) | `{ packageId, orderId, reason }` |
| `fulfillment.package_returned` | Kho quét nhận hàng hoàn (5.5) | `{ packageId, orderId, shopId, returnedAt }` |
| `fulfillment.package_status_changed` | Mọi lần chuyển (như hiện nay) | không đổi |

- **PR danh mục sự kiện:** `package_delivered.lines[].variantId: id.nullable()`, comment trỏ `21` §11.2. Báo Bình: `PackageDelivered` ở `finance/service/ledger.ts` và `postDelivered` phải chịu `variantId`, `unitCost` null trước khi đăng ký consumer.
- `aggregateId` là `orderId` cho cả ba sự kiện (cùng key với `package_status_changed`, giữ thứ tự theo đơn).

### 5.9 Lỗi

| Tình huống | Xử lý |
|---|---|
| Trace lỗi, hết giờ, dạng lạ | Log `warn`, dùng giờ đồng bộ, lý do mặc định; không chặn lượt kéo |
| Bù bàn giao (D5) lỗi trong đồng bộ | Cả đơn rollback; lượt kéo sau thử lại (như 199a) |
| Dòng kiện trỏ tới dòng đơn không có khi dựng `package_delivered` | Ném lỗi, đơn rollback, log `error` ở khung kéo đơn; không thay bằng `0` |
| `receive-return`: kiện không có, công ty khác | 404 |
| `receive-return`: `version` cũ | 409 `version_conflict` kèm `current` |
| `receive-return`: kiện không ở `returning` | 409 `invalid_transition` |
| `receive-return`: mã quét không khớp | 422 `package_mismatch` |
| `receive-return`: Admin, Sale | 403 `forbidden` |
| `receive-return`: `receiveBack` lỗi bất ngờ | Rollback, 500 |

### 5.10 Chạy đồng thời

- Đồng bộ khoá mọi kiện của đơn (`lockOrderPackages`), route quét khoá dòng kiện (`lockPackage`): cùng khoá nên chạy lần lượt. Kho quét trước rồi sàn báo hoàn → đồng bộ bỏ qua (5.4). Sàn báo trước → kiện vẫn `returning`, kho quét bình thường.
- "Kiện giao đầu tiên" (D4) xét dưới khoá mọi kiện của đơn (đồng bộ) hoặc trong giao dịch thoát chờ đang khoá dòng gian hàng `FOR NO KEY UPDATE` (hàm bù), mà kéo đơn của gian hàng đó cần khoá `FOR SHARE` cùng dòng: hai bên không chạy song song.
- Nhảy cóc kèm bù bàn giao (D5) có cùng giới hạn `40P01` của 199a.

### 5.11 Hiệu năng

- Đồng bộ: thêm một lần gọi trace cho mỗi đơn đổi trạng thái sau bàn giao (đơn không đổi `updated_at` thì không ingest lại, không gọi). Ngoài giao dịch.
- `reportDelivered`: ba câu đọc theo khoá chính hoặc `order_id` (có index) và một câu ghi; không truy vấn theo từng dòng.
- `packageStatusOf`: một câu theo khoá chính.

### 5.12 Test

| File | Kiểm |
|---|---|
| `test/unit/modules/order/fulfillment/domain/delivery.test.ts` | `lineStatus`, `deliveryTarget` (D1, D2, D9), `platformUpdate` thêm (D5; `lost` vẫn `invalid`), `journeyTimes` (sớm nhất, muộn nhất, mốc tương lai, lý do rỗng), `deliveredAmounts` (kiện đầu, kiện sau, tỉ lệ số lượng, null, làm tròn) |
| `test/unit/modules/channel/channel/service/marketplaces/lazada-trace.test.ts` | Đọc response trace (mẫu của stub và mẫu shop thử `detail_type: "delivered"`, `status_code: "1400"`); `detail_type` lạ bị bỏ |
| `test/integration/order/fulfillment/platform-delivery.test.ts` | AC 1–10 |
| `test/integration/order/fulfillment/opening-stocktake.test.ts` (thêm ca) | AC 11 |
| `test/integration/order/fulfillment/receive-return.test.ts` | AC 12–14 |
| `test/integration/order/fulfillment/package-status-of.test.ts` | AC 15 |
| `test/integration/channel/channel/order-pull-trace.test.ts` | AC 16 (adapter giả) |
| `test/integration/order/fulfillment/delivery-migration.test.ts` | AC 17 |

- Đồng bộ chạy qua `ingestMarketplaceOrder` trong `withCompany` (fixture như `platform-handover.test.ts`), cổng tồn thật.
- Tồn đặt bằng helper của `test/integration/product/inventory/helpers.ts`; kiện bằng `seedPackage`.
- Body 200 parse bằng `Package`; payload sự kiện parse bằng `EVENT_SCHEMAS`.

## 6. Thứ tự giao

1. **PR Documents** (mục 8). Merge trước; Bình xác nhận D6, D10.
2. **PR danh mục sự kiện**, nhánh riêng từ `main`: `variantId` null được.
3. **PR backend 199c**, nhánh `feature/199c-giao-hoan` từ `feature/199b-chia-hang` (3e9a99c); base PR là `main` sau khi #298 merge, trước đó rebase theo.
4. Sau khi merge: sửa checklist #199 (c), #238 (gạch "giao không thành → `returning`"); báo Bình đăng ký consumer và dùng `packageStatusOf`; báo Thành phần sửa ở channel.

## 7. Ảnh hưởng tới FE

- Route mới `POST /fulfillment/packages/:id/receive-return` (`{ version, code }` → `Package`; 422 `package_mismatch`), cho tab `returning` (phần d).
- Kiện không còn tự sang `returned` khi sàn báo hoàn xong: tab `returning` giữ kiện tới khi kho quét.
- `deliveredAt`, `handedOverAt` lấy theo hành trình của sàn khi có. Lịch sử `delivery_failed` có lý do.

## 8. Ảnh hưởng tới Documents

- `21` §11.2:
  - dòng `package_delivered`: `variantId: string | null`; cách tính `unitPrice`, `platformSubsidy`, `shippingIncome`, `shippingCost` (5.2, D4, D10); phát một lần, kiện hoãn trừ phát sau khi phiếu đầu kỳ ghi sổ;
  - dòng `package_returned`: phát khi kho quét nhận hàng hoàn; không phát cho kiện lần đầu thấy đã hoàn về trước mốc (D9);
  - dòng `package_delivery_failed`: `reason` lấy từ hành trình của sàn khi có.
- `21` §19.2:
  - đoạn "Sàn đẩy trạng thái kiện": kiện trước bàn giao mà sàn báo `delivery_failed`/`returning` thì bù bàn giao rồi áp (D5); sàn báo hoàn xong thì kiện ở `returning` chờ quét (D1); lý do huỷ "giao không thành" (Lazada `cancellation-failed Delivery`) thì `returning` (D2); kiện đã `returned` thì bỏ qua sàn báo hoàn trễ;
  - `receive-return`: `package_mismatch` là 422.
- `25` §8.4 quy tắc 2 (nhảy tới nhánh giao lỗi từ trước bàn giao), quy tắc 4 (cách nhận biết của Lazada).
- `19` bảng `packages`: thêm `delivery_posted_at`.
- `tich-hop-san/lazada.md` §7.4, §11.5: dùng trace lấy mốc, lý do; khớp kiện theo `ofc_package_id` rồi `tracking_number`; nhận biết giao không thành.

## 9. Acceptance criteria

1. **Giao xong (US-DH-10.1):** kiện `in_transit`, sàn báo `delivered`, trace có sự kiện `delivered` lúc T → kiện `delivered`, `delivered_at = T`, lịch sử `deliver` nguồn `marketplace`; `package_delivered` có `deliveredAt = T`, mỗi dòng `unitPrice` = giá sau voucher shop, `unitCost` = giá vốn lúc bàn giao; kiện là kiện đầu của đơn nên `shippingIncome = shipping_fee`, `shippingCost = shipping_fee_original`, `platformSubsidy` = voucher sàn + trợ ship sàn; `delivery_posted_at` có giá trị.
2. **Kiện thứ hai của đơn:** giao sau → `shippingIncome = shippingCost = "0"`, `platformSubsidy` chỉ phần voucher sàn của dòng.
3. **Một lần:** kéo lại cùng trạng thái → không phát lần hai.
4. **Không trace:** adapter không có `getPackageEvents` hoặc trace lỗi → `delivered_at` là giờ đồng bộ; lượt kéo không lỗi.
5. **Giao thất bại (US-DH-10.1):** kiện `in_transit`, sàn báo `failed_delivery`, trace có mô tả → kiện `delivery_failed`, lịch sử có lý do, `package_delivery_failed.reason` = mô tả; không trace → "Sàn báo giao không thành công".
6. **Giao lại:** `delivery_failed → in_transit → delivered` → một `package_delivered`.
7. **Hoàn (US-DH-10.1):** sàn báo `shipped_back` → `returning`; món huỷ `cancellation-failed Delivery` trên kiện `in_transit` → `returning`, đơn (mọi món như vậy) vẫn `processing` và bật cờ `platform_cancelled`, không có `sales.order_cancelled`; sàn báo `shipped_back_success` → kiện vẫn `returning`, không phiếu `KT`, không `package_returned`.
8. **Nhảy ngoài đường chính (US-DH-10.2, D5):** kiện `reserved`, sàn báo `failed_delivery` → một phiếu `XK`, kiện `delivery_failed`, có `package_shipped`, `package_delivery_failed`; kéo lại không trừ thêm. Kiện `backordered` thiếu hàng, sàn báo `shipped_back` → bàn giao bắt buộc rồi `returning`. Sàn báo `lost` từ `reserved` → cờ Cần xử lý như cũ.
9. **Kiện mới đã hoàn (D9):** đơn đặt trước mốc, kiện lần đầu thấy `shipped_back_success` → `returned`, `before_cutoff`, không phiếu `KT`, không `package_returned`. Đơn đặt sau mốc → `returning`, có phiếu `XK`.
10. **Dòng null:** kiện `before_cutoff` giao xong → `unitCost: null`; kiện có dòng chưa ghép → dòng đó `variantId: null`, `unitCost: null`, `unitPrice` đủ.
11. **Hoãn trừ:** gian hàng chờ kiểm kê, kiện rời kho sau `countedAt` rồi giao xong → chưa phát `package_delivered`. `settleOpeningStocktake` → phiếu `XK`, rồi `package_delivered` có `unitCost` khác null; gọi lại không phát thêm.
12. **Quét nhận hàng hoàn (D2-24, US-DH-11.1):** kiện `returning`, Kho quét đúng mã kiện → `returned`, một phiếu `KT` nháp với số dự kiến đúng theo SKU, tồn thực chưa đổi, lịch sử ghi người quét, có `package_status_changed`, `package_returned`; body `Package.parse` được. Quét bằng mã vận đơn (khác hoa thường) cũng được.
13. **Chặn (US-DH-11.2, D2-24q):** mã không khớp → 422 `package_mismatch`, kiện không đổi; Admin, Sale → 403; `version` cũ → 409 `version_conflict`; quét lần hai → 409 `invalid_transition`, vẫn một phiếu `KT`; kiện `delivery_failed` → 409 `invalid_transition`.
14. **Đồng bộ sau khi quét:** kiện `returned`, sàn báo `shipped_back` hoặc `shipped_back_success` → không đổi, không cờ.
15. **`packageStatusOf`:** trả đúng `orderId`, `status`, `deliveredAt`; id công ty khác, id không phải uuid không có trong Map; rỗng không truy vấn.
16. **Trace ở channel:** `order-pull` chỉ gọi `getPackageEvents` cho đơn có món sau bàn giao; trace ném lỗi thì đơn vẫn ingest, có log `warn`. Adapter Lazada đọc đúng response mẫu.
17. **Migration:** kiện `delivered` có từ trước được điền `delivery_posted_at = delivered_at`; kiện khác vẫn null.
18. Test cũ xanh (199a, 199b, đồng bộ kiện #105, `GET /orders`, cổng tồn, channel); `npm run check` xanh, depcruise không báo vi phạm.

## 10. Rủi ro và điểm còn mở

- **D10 chờ Bình:** nếu Bình muốn `shippingCost` là phần shop chịu (`shipping_fee_discount_seller`) thì chỉ đổi `deliveredAmounts` và mục 8, không đổi cấu trúc.
- **Trace Lazada chưa thử trên shop thử:** khớp `ofc_package_id` với `package_id`, các `detail_type` ngoài `delivered`. Không khớp được thì kiện dùng giờ đồng bộ (không sai trạng thái).
- **Finance chưa chịu `null`:** tới khi Bình sửa `postDelivered` và đăng ký consumer, sự kiện nằm trên Kafka chưa ai ghi sổ. Consumer `shared` mới đăng ký đọc từ đầu topic (`fromBeginning`, `core/platform/service/outbox/consumer.ts:272`) nhưng chỉ trong thời gian topic còn giữ; sự kiện cũ hơn thời gian giữ thì mất, cần Bình đăng ký sớm.
- **Hàng hoàn về khi sàn còn báo `delivery_failed`:** kho chưa quét được, chờ đồng bộ báo hoàn. `25` §8.3 cho chuyển tay sau 3 ngày nhưng `21` §19.2 chặn `return` với đơn sàn (`not_allowed_for_source`); lệch tài liệu, ngoài phạm vi, ghi vào giới hạn đã biết.
- **Dòng chưa ghép SKU** không vào phiếu `KT`; kho lập phiếu tay. Ghép muộn (`shipLateMappedLines`) cho kiện đã `returned` sẽ trừ tồn cho hàng đã về kệ: #237 phải bỏ qua kiện `returned` (ghi ở "Cho module khác").
- **Ghép muộn sau khi đã phát `package_delivered`:** dòng đó đã báo `unitCost: null`, finance giữ `costMissing`; không phát bù.
- **Sửa module của người khác:** channel (`common.ts`, `lazada.ts`, `order-pull.ts`) của Thành; báo trong PR.
