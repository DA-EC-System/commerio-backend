# Spec: Chia hàng cho kiện, lấy lại phần giữ, phiếu kiểm kê đầu kỳ (#199, phần b)

- **Ngày:** 09/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#199, `Documents/21` §11.1, §11.2, §11.3, §18.6.11, §19.2, `Documents/25` §6.1, §7.1, §7.3, §7.4, §8.1, §8.3, §8.4, `Documents/19` (bảng `packages`), `Documents/27` US-DH-04, US-TK-06, `Documents/kiem-thu/ca-theo-so-do.md` §D2 (D2-01, D2-02)
- **Trạng thái:** nháp, chờ Khang duyệt
- **Phạm vi:** phần b của #199. Phần a đã merge (#291). Gộp thêm hai việc Khang chốt ngày 09/11/2026 sau khi soát 199a:
  - kho quét lúc gian hàng chờ kiểm kê đầu kỳ thì hoãn trừ (câu hỏi còn mở thứ nhất của #291);
  - chuỗi "bù kiện hoãn trừ → phân hàng → `allocation_done` có `cause`" sau phiếu đầu kỳ do fulfillment làm, channel gọi. Thay câu "#198 gọi `settleDeferredHandovers`" của 199a: nhánh #289 không gọi hàm này.

---

## 1. Mục tiêu và tiêu chí thành công

1. Số có thể bán tăng thì kiện chưa giữ hàng được giữ theo thứ tự `25` §7.4, nguyên kiện. Kiện không đủ thì bỏ qua, xét kiện sau.
2. Tồn thực nhỏ hơn đang giữ thì lấy lại phần giữ của kiện `reserved`: đơn `unpaid` trước, kiện giữ sau cùng trước. Kiện bị lấy về Thiếu hàng.
3. Sau mỗi lượt phân hàng phát `fulfillment.allocation_done`, kể cả khi không đổi gì, để channel đẩy tồn sau khi đã chia hàng (`21` §11.1).
4. Phiếu đầu kỳ ghi sổ: trong giao dịch thoát chờ của channel, bù kiện hoãn trừ, phân hàng mọi kiện chưa bàn giao, phát `allocation_done` có `cause`. Gian hàng không kẹt ở bước chờ phân hàng.
5. Kho quét lúc gian hàng chờ kiểm kê thì hoãn trừ như đường sàn báo, và không kiện hoãn nào bị bỏ sót khi bù.

Đo bằng: AC ở mục 9 đều qua; `npm run check` xanh.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (ef8bc68, đã có 199a):**
- Kiện mới của đơn sàn thử `reserve` ngay (`createPackage`). Không đủ hàng thì: món `pending` thành `backordered`; món đã `packed` hoặc `awaiting_pickup` thì kiện giữ nguyên trạng thái đó với `reserved_qty = 0` (`platform-packages.ts:174-176`). Gian hàng chờ kiểm kê (`holdStock = false`) thì không gọi `reserve`.
- Không có gì giữ lại kiện `backordered` khi hàng về, cũng không có gì lấy lại phần giữ khi tồn thực giảm.
- `cancelPlatformPackage` nhả hàng (`release`) khi kiện huỷ.
- Inventory phát `inventory.stock_changed` mỗi lần tồn thực đổi (`posting.ts`), kể cả phiếu `XK` của bàn giao và `DX` của huỷ bàn giao. `reserve`, `release` không phát (`21` §11.1).
- Channel còn nghe `stock_changed` để đẩy tồn; #223 sẽ chuyển sang `allocation_done`.
- `settleDeferredHandovers` (199a) chưa có ai gọi.
- Route `hand-over` luôn trừ ngay (`handover.ts:43`, `mode: 'deduct'`).
- `packages` chưa có cột ghi lúc kiện giữ hàng.
- Máy trạng thái kiện đã có hai mũi tên của hệ thống: `hold` (`backordered → reserved`), `reclaim` (`reserved → backordered`).
- `inventory.stocktake_posted` chưa có trong danh mục sự kiện (nằm ở #289, #277; merge sau).

**Ràng buộc:**
- `order` ở lớp 3: không import `channel`. Channel (lớp 5) được import `order/index.ts`. Dữ liệu gian hàng của channel vào fulfillment qua `ctx`, tiêm ở `src/wiring.ts`.
- Cổng tồn gọi trong giao dịch của bên gọi; fulfillment chống lặp bằng khoá kiện và đổi `reserved_qty` có điều kiện trong cùng giao dịch (`21` §11.1).
- Consumer thử lại theo `retryDelaysMs` rồi đưa vào DLQ: handler không được chờ một module khác vô hạn.
- Code lệch Documents thì sửa Documents trước.

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Fulfillment export `settleOpeningStocktake`; channel gọi trong giao dịch thoát chờ kiểm kê (#289), sau khi đặt `openingStocktake = null` | Hai consumer độc lập thì có khoảng hở: fulfillment bù xong mà channel chưa thoát, kiện hoãn trong khoảng đó không bao giờ được bù, kiện lập trong khoảng đó không được giữ. Một giao dịch, cùng thứ tự khoá "gian hàng → kiện" với kéo đơn; lỗi thì rollback cả gói. 199b không cần `stocktake_posted` có trong danh mục. Đã loại: fulfillment tự nghe kèm dấu "đã bù" theo gian hàng (thêm bảng, khoá vào đường kéo đơn), fulfillment nghe rồi thử lại tới khi channel thoát (rủi ro DLQ, gian hàng kẹt). Khang chọn 09/11/2026 |
| D2 | Sau phiếu đầu kỳ: bù kiện hoãn trừ **trước**, phân hàng **sau** | Kiện rời kho sau lúc đếm đã thật sự lấy hàng; phân hàng trước thì kiện chưa đi giữ mất phần đó và kiện đã đi thành bàn giao bắt buộc dù không có gì sai. `25` §6.1 bước 3 đang ghi ngược, sửa ở PR Documents. Khang chọn 09/11/2026 |
| D3 | Mỗi lượt phân hàng một giao dịch riêng, khoá advisory theo công ty. `stock_changed` qua consumer; kiện huỷ xếp việc pg-boss trong cùng giao dịch | Giao dịch kéo đơn không khoá kiện của đơn khác (không làm nặng thêm giới hạn `40P01` của 199a); hai lượt không chen nhau nên thứ tự ưu tiên luôn đúng. Đã loại: phân hàng ngay trong giao dịch gây biến động, quét định kỳ. Khang chọn 09/11/2026 |
| D4 | `allocation_done` luôn phát sau mỗi lượt, kể cả khi không đổi gì; kiện mới giữ được hàng thì phát cho SKU của kiện | Channel (#223) bỏ nghe `stock_changed`, nên số có thể bán giảm cũng phải đi qua sự kiện này mới được đẩy ngay (`25` §7.3) |
| D5 | Kiện đã đóng (`packed`, `awaiting_pickup`) mà chưa giữ hàng cũng được phân hàng, xếp trước kiện Thiếu hàng. Sau phiếu đầu kỳ mà vẫn không giữ được thì bật Cần xử lý "dỡ kiện về kệ" | Hàng đã nằm trong hộp mà vẫn tính vào số có thể bán thì channel đẩy tồn cao hơn thực tế. `25` §6.1 ghi "phân hàng cho mọi kiện chưa bàn giao". Chưa có khung việc #209 nên thay việc "Dỡ kiện về kệ" bằng cờ, như D11 của 199a. Khang chọn 09/11/2026 |
| D6 | Thêm `packages.reserved_at` | Lấy lại phần giữ theo "kiện giữ sau cùng trước" (`25` §7.4) cần biết lúc giữ. `core.state_transitions` là bảng module khác, không join được |
| D7 | Kho quét lúc gian hàng chờ kiểm kê thì hoãn trừ; route khoá dòng gian hàng `FOR SHARE` qua `ctx.stockHoldOf` trước khi khoá kiện | Trừ ngay thì gian hàng mới (chưa có tồn) thành bàn giao bắt buộc: bật Tồn âm, Cần xử lý, chốt giá vốn khi chưa có phiếu đầu kỳ. Khoá gian hàng trước thì channel không thoát chờ được giữa lúc một lần quét đang chạy, kiện hoãn không bị sót. Khang chọn 09/11/2026 |
| D8 | Việc pg-boss `fulfillment.allocation` mang `{ companyId, variantIds }` (SKU của kiện vừa nhả), hàng `standard`, không gộp trùng. Mỗi việc chạy một lượt cho đúng các SKU đó | `allocation_done` của lượt phải mang SKU vừa nhả để channel đẩy phần tồn tăng, kể cả khi lượt không giữ được kiện nào (D4); gộp trùng theo công ty thì việc sau bị bỏ, mất SKU. Việc trùng chạy lại vô hại vì lượt đọc lại trạng thái. Hàng `stately` còn ép việc thứ hai sang `failed` khi đã có việc ở `retry` (tài liệu pg-boss). Sửa lúc viết plan, 09/11/2026 |
| D9 | "Dỡ kiện về kệ" sau kiểm kê thường (không phải phiếu đầu kỳ) để sau | Cần biết `stock_changed` do kiểm kê, tức nghe `stocktake_posted` (chưa có trên `main`), và cần khung việc #209. Trong lúc chờ, SKU vẫn mang cờ Tồn âm do inventory bật |

## 4. Phạm vi

**Trong spec:**
- PR Documents (mục 8);
- migration `reserved_at` (5.1);
- `domain/allocation.ts`: `allocationQueue`, `planAllocation`, `planReclaim`;
- `service/allocation.ts`: `runAllocation`, `settleOpeningStocktake`, `requestAllocation`, handler của consumer và của việc nền;
- `startBackground` của fulfillment: consumer `inventory.stock_changed`, hàng việc `fulfillment.allocation`;
- `platform-packages.ts`: kiện mới giữ được hàng thì phát `allocation_done`; kiện huỷ nhả hàng thì xếp việc; ghi `reserved_at`;
- route `hand-over` hoãn trừ khi gian hàng chờ kiểm kê;
- `ctx.stockHoldOf`: hàm đọc ở channel (vài dòng, ghi rõ trong PR), tiêm ở `src/wiring.ts`;
- test; cập nhật `fulfillment/CLAUDE.md`.

**Ngoài spec:**
- channel gọi `settleOpeningStocktake` trong giao dịch thoát chờ (#289, Thành);
- channel đẩy tồn theo `allocation_done`, bỏ consumer `stock_changed` (#223, Thành);
- "Dỡ kiện về kệ" sau kiểm kê thường (D9);
- kiện chờ thay, sàn chia lại kiện (#238); tách kiện (#177);
- ghép SKU (#237) và dỡ kiện về kệ (#239): chỉ cần gọi `requestAllocation()` khi có;
- báo Sale khi kiện về Thiếu hàng (US-DH-04 dòng 1, 3), theo khung nhắc #209;
- 199c (giao, thất bại, hoàn, sự kiện cho finance), 199d (FE, E2E).

## 5. Thiết kế

### 5.1 Dữ liệu và migration

Migration `0028` (số kế tiếp trên `main`; nhánh khác merge trước thì sinh lại):

```sql
ALTER TABLE "order"."packages" ADD COLUMN "reserved_at" timestamp with time zone;
-- Kiện đang giữ hàng có từ trước 199b: lấy lúc lập kiện làm lúc giữ (xấp xỉ).
UPDATE "order"."packages" p SET "reserved_at" = p."created_at"
  WHERE p."status" IN ('reserved','packed','awaiting_pickup')
    AND EXISTS (SELECT 1 FROM "order"."package_lines" l WHERE l."package_id" = p."id" AND l."reserved_qty" > 0);
```

- Cột null được, chỉ đổi metadata; bản app cũ bỏ qua. Lùi: `DROP COLUMN "reserved_at"`.
- Nghĩa: lần gần nhất các dòng của kiện được giữ. Đặt `now()` cùng giao dịch với mọi lần kiện chưa rời kho được giữ (lập kiện có giữ, phân hàng, huỷ bàn giao); đặt null cùng giao dịch với mọi lần nhả (huỷ kiện, lấy lại phần giữ). `settleHandover` thử giữ rồi trừ ngay nên không ghi. Kiện đã rời kho giữ nguyên giá trị cũ, không ai đọc.
- `package_lines` không đổi.

### 5.2 Luật thuần (`domain/allocation.ts`)

```ts
interface AllocationCandidate {
  id: string; code: string; status: PackageStatus; shipBy: Date | null; orderCreatedAt: Date;
  lines: { variantId: string; quantity: number }[];
}
allocationQueue(candidates: readonly AllocationCandidate[]): AllocationCandidate[]
```
Sắp theo: (1) kiện `packed`, `awaiting_pickup` trước kiện `backordered` (D5); (2) `shipBy` tăng dần, null cuối; (3) `orderCreatedAt` tăng dần (đơn kéo về trước); (4) `code`.

```ts
planAllocation(queue: readonly AllocationCandidate[], available: ReadonlyMap<string, number>): AllocationCandidate[]
```
Đi lần lượt; kiện nào mọi SKU đều đủ (gộp số của các dòng cùng SKU) thì chọn và trừ vào bản đếm tạm; thiếu thì bỏ qua, xét kiện sau (`25` §7.4). Không giữ từng phần.

```ts
interface ReclaimCandidate { id: string; orderStatus: 'unpaid' | 'processing'; reservedAt: Date | null; lines: { variantId: string; quantity: number }[] }
planReclaim(deficits: ReadonlyMap<string, number>, candidates: readonly ReclaimCandidate[]): ReclaimCandidate[]
```
`deficits`: SKU → `đang giữ − tồn thực` (> 0). Sắp đơn `unpaid` trước `processing`; trong nhóm `reservedAt` giảm dần, null cuối, rồi `id`. Lấy cả kiện có chứa SKU còn thiếu, trừ phần thiếu theo mọi dòng của kiện, dừng khi không còn SKU nào thiếu. Kiện không chứa SKU còn thiếu thì bỏ qua.

Kiện ứng viên giữ hàng (lọc ở repository, mục 5.3):
- `backordered`, hoặc `packed`/`awaiting_pickup` mà mọi dòng `reserved_qty = 0`;
- mọi dòng đã ghép SKU;
- `needs_open = false`;
- đơn chưa `cancelled`;
- gian hàng không chờ kiểm kê (trừ lượt sau phiếu đầu kỳ, 5.5).

Kiện ứng viên lấy lại: chỉ `reserved` (`25` §7.4: từ `packed` trở đi không bị lấy lại), của đơn `unpaid` hoặc `processing`.

### 5.3 Một lượt phân hàng (`service/allocation.ts`)

```ts
runAllocation(ctx: AllocationContext, p: { variantIds: readonly string[] } | { all: true }, opts?: { opening?: boolean; cause?: AllocationCause }): Promise<{ held: string[]; reclaimed: string[]; variantIds: string[] }>
```

Chạy trong giao dịch của bên gọi (`withCompany`):

1. `pg_advisory_xact_lock(hashtextextended('fulfillment.allocation:' || companyId, 0))`.
2. **Lấy lại phần giữ.** `stockOf(SKU của lượt)`; với `{ all: true }` thì SKU của mọi kiện đang giữ và mọi ứng viên. SKU có `reserved > onHand` vào `deficits`. Khoá kiện `reserved` chứa các SKU đó (`FOR UPDATE`, theo `code`), `planReclaim`. Mỗi kiện được chọn:
   - `release(packageId, mọi dòng)`;
   - dòng `reserved_qty = 0`; kiện `status = 'backordered'`, `reserved_at = null`;
   - `assertTransition(packageMachine, 'reserved', 'reclaim', { actor: null })`, `recordTransition` (`source` mặc định `system`), phát `package_status_changed`.
   
   SKU khác của các kiện vừa bị lấy được thêm vào tập SKU của lượt.
3. **Giữ hàng.** Khoá ứng viên chứa SKU của lượt (`FOR UPDATE`, theo `code`); với `{ all: true }` thì mọi ứng viên của công ty. Đọc `availableOf(mọi SKU của ứng viên)`, `allocationQueue`, `planAllocation`. Mỗi kiện được chọn:
   - `reserve(packageId, mọi dòng)`; `reserved: false` (giao dịch khác vừa lấy mất hàng) thì bỏ qua;
   - được: dòng `reserved_qty = quantity`, `reserved_at = now()`; kiện `backordered` chuyển `reserved` (mũi tên `hold`, lịch sử, sự kiện); kiện đã đóng giữ nguyên trạng thái.
4. **Lượt sau phiếu đầu kỳ** (`opening`): kiện đã đóng vẫn không giữ được thì `needs_attention = true`, `flag_note = 'Dỡ kiện về kệ: số đếm thấp hơn hàng trong kiện'` (D5). Kiện đã bật cờ thì không ghi lại.
5. Phát `fulfillment.allocation_done { variantIds, cause? }`, `aggregateId = companyId`. `variantIds` = SKU kích hoạt ∪ SKU của kiện vừa lấy lại ∪ SKU của kiện vừa giữ, không trùng, sắp tăng dần. Luôn phát (D4).

`AllocationContext` = `Pick<FulfillmentContext, 'stockHoldOf'>` (5.6). Lượt `opening` không đọc `ctx` (5.5).

Trạng thái và ngày lập của đơn (lọc đơn `cancelled`, nhóm `unpaid`/`processing`, thứ tự "đơn kéo về trước") đọc bằng SQL thô `"order".orders` trong repository của fulfillment, cùng cách `repository/package-list.ts` của 199a (fulfillment không import sales).

### 5.4 Đường vào

| Kích hoạt | Ở đâu | Làm gì |
|---|---|---|
| `inventory.stock_changed` | consumer `fulfillment-allocation`, đăng ký ở `startBackground` | `runAllocation(ctx, { variantIds: [payload.variantId] })` trong `withCompany` của khung consumer. Không dùng số trong payload. Hàng về, kiểm kê, xuất huỷ, bàn giao (cả bắt buộc, `25` §8.4 quy tắc 3 "chạy ngay bước lấy lại phần giữ"), huỷ bàn giao đều đi đường này |
| Kiện huỷ có nhả hàng | `cancelPlatformPackage` (giao dịch kéo đơn) | `requestAllocation(SKU của kiện)`, tức `sendJob(allocationQueue, { companyId, variantIds })` cùng giao dịch |
| Việc `fulfillment.allocation` | `workQueue` ở `startBackground` | `withCompany(companyId, () => runAllocation(ctx, { variantIds }))` |
| Kiện mới giữ được hàng | `createPackage` | Phát `allocation_done { variantIds: SKU của kiện }` cùng giao dịch; không chạy lượt |
| Ghép xong SKU (#237), dỡ kiện về kệ (#239) | sau này | Gọi `requestAllocation(variantIds)` (export ở `fulfillment/index.ts`) |
| Phiếu đầu kỳ ghi sổ | channel, giao dịch thoát chờ (#289) | `settleOpeningStocktake(...)` (5.5) |

Hàng việc: `defineQueue('fulfillment.allocation', JobDataSchema.extend({ variantIds: z.array(z.uuid()).min(1) }))`, chính sách mặc định `standard` (D8).

### 5.5 `settleOpeningStocktake`

```ts
settleOpeningStocktake(p: { shopId: string; documentId: string; countedAt: Date }): Promise<{ deducted: number; storedOnly: number; held: number }>
```

Export ở `fulfillment/index.ts` (qua `order/index.ts`). Channel gọi trong giao dịch thoát chờ kiểm kê, sau khi đã đặt `openingStocktake = null`, `orderCutoffAt = countedAt`:

1. `settleDeferredHandovers(shopId, countedAt)` (199a): kiện rời kho từ `countedAt` trở đi trừ tồn (thử giữ trước, `25` §8.1), trước đó thành `before_cutoff`.
2. `runAllocation(_, { all: true }, { opening: true, cause: { type: 'stocktake', documentId } })`.

- Lượt `opening` không lọc gian hàng chờ kiểm kê: gian hàng gọi vừa thoát chờ trong cùng giao dịch, và theo `25` §6.1 chỉ gian hàng đầu tiên của công ty có chế độ này.
- Gọi lần hai: không trừ thêm, không giữ thêm, phát lại `allocation_done` có `cause` (channel xử lý trùng được).
- Lỗi ném ra cho channel: giao dịch thoát chờ rollback, consumer của channel thử lại cả gói.

### 5.6 `ctx.stockHoldOf`

```ts
stockHoldOf(shopIds: readonly string[], opts?: { lock?: boolean }): Promise<Set<string>>
```
- Trả các gian hàng trong `shopIds` đang chờ kiểm kê đầu kỳ (`channel.shops.opening_stocktake_id is not null`). `lock: true` thì `SELECT … FOR SHARE` dòng gian hàng, cùng loại khoá với `lockShopForOrders`.
- Channel export hàm đọc này (repository + `index.ts`, vài dòng). `src/wiring.ts` tiêm vào `FulfillmentContext` như `shopsOf`; `AppContext` thêm `Required<Pick<FulfillmentContext, 'stockHoldOf'>>`.
- Thiếu thì `AppError(500, 'internal_error', 'Chưa nối trạng thái gian hàng của channel (src/wiring.ts)')`, cùng khuôn `orderRefsLookupOf`.
- Dùng ở: lượt phân hàng thường (lọc ứng viên, không khoá); route `hand-over` (khoá, 5.7).

### 5.7 Kho quét lúc gian hàng chờ kiểm kê

`handOverPackages(ctx, actor, items)` (thêm `ctx`). Mỗi kiện, trong `withCompany`:
1. Đọc `shopId` của kiện, không khoá; không có kiện → `not_found`.
2. `shopId` khác null: `awaiting = (await stockHoldOf([shopId], { lock: true })).has(shopId)`.
3. `lockPackage`, các kiểm như 199a.
4. `settleHandover(pkg, { actorId, mode: awaiting ? 'defer' : 'deduct' })`.

- Kiện hoãn: sang `in_transit`, `handover_source = 'scan'`, `handed_over_at` là giờ quét; response `issue: null`. Phiếu đầu kỳ ghi sổ thì `settleDeferredHandovers` trừ (quét từ `countedAt` trở đi) hoặc ghi `before_cutoff` (quét trước đó).
- Kiện của đơn tạo tay (`shopId` null): trừ ngay như hiện nay.
- Huỷ bàn giao kiện đang hoãn: không có dòng đã trừ nên `revertHandover` bỏ qua `reverseShipment` (199a đã xử lý `deducted` rỗng), dòng giữ nguyên `reserved_qty = 0`. Kiện về `awaiting_pickup`, có lịch sử kèm lý do. Không có phiếu `DX`, tồn không đổi.

### 5.8 Sự kiện

- Phát `fulfillment.allocation_done` (đã có trong danh mục, kể cả `cause`, từ #288): cuối mỗi lượt; khi kiện mới giữ được hàng.
- Phát `fulfillment.package_status_changed` ở mỗi `hold`, `reclaim`.
- Nghe `inventory.stock_changed` (consumer `fulfillment-allocation`).
- Không nghe `inventory.stocktake_posted` (D1).

### 5.9 Lỗi

| Tình huống | Xử lý |
|---|---|
| Lượt phân hàng lỗi DB hoặc `40P01` | Rollback cả lượt. Consumer thử lại theo `retryDelaysMs` rồi DLQ; việc pg-boss thử lại theo `attempts`. Lượt đọc lại trạng thái từ đầu nên chạy lại không sai |
| `reserve` trả `false` giữa lượt | Bỏ qua kiện đó, xét kiện sau |
| `release` nhả quá số đang giữ | Lỗi lập trình (inventory ném). Không bắt; log `error` ở khung consumer, thử lại rồi DLQ |
| `settleOpeningStocktake` lỗi | Ném cho channel; giao dịch thoát chờ rollback |
| `ctx.stockHoldOf` chưa nối | `AppError(500, 'internal_error', …)` (5.6) |
| `hand-over` gặp lỗi khi đọc trạng thái gian hàng | Như lỗi bất ngờ của 199a: kiện đó vào `failed[]` với `internal_error`, kiện khác chạy tiếp |

### 5.10 Chạy đồng thời

Thứ tự khoá:

| Giao dịch | Thứ tự |
|---|---|
| Kéo đơn (199a) | dòng gian hàng `FOR SHARE` → kiện của đơn → dòng tồn |
| Kho quét | dòng gian hàng `FOR SHARE` → kiện → dòng tồn |
| Thoát chờ kiểm kê (channel gọi `settleOpeningStocktake`) | dòng gian hàng `FOR NO KEY UPDATE` → khoá advisory phân hàng → kiện (bù, rồi phân hàng) → dòng tồn → `doc_counters` |
| Lượt phân hàng (consumer, việc nền) | khoá advisory phân hàng → kiện → dòng tồn. Đọc trạng thái gian hàng không khoá |

- Hai lượt của cùng công ty chạy nối nhau (khoá advisory).
- Thoát chờ giữ khoá gian hàng nên không có lượt kéo đơn hay lần quét nào của gian hàng đó chạy song song; khoá advisory xếp nó sau lượt đang chạy. Lượt phân hàng không bao giờ chờ khoá gian hàng, nên không thành vòng.
- Lượt thường chạy trong lúc channel chưa commit thoát chờ: thấy gian hàng còn chờ, bỏ kiện của gian hàng đó; lượt `opening` trong giao dịch thoát chờ sẽ xét chúng.
- Giới hạn đã biết: một lượt gọi `reserve`, `release` nhiều lần, mỗi lần khoá dòng tồn của riêng kiện đó, nên vẫn có thể `40P01` với lượt kéo đơn (cùng loại giới hạn của 199a). Bên thua thử lại.
- Kiện mới về có thể giữ hàng trước kiện `backordered` đang chờ lượt phân hàng của cùng SKU (lượt chạy sau khi sự kiện tới). Chấp nhận: `25` §8.1 cho kiện mới giữ ngay.

### 5.11 Hiệu năng

- Lượt theo SKU: một câu chọn ứng viên theo `package_lines.variant_id` (đã có index) và `packages.status` (đã có index), một câu đọc dòng của các ứng viên, một lần `availableOf`, rồi một lần `reserve` cho mỗi kiện được chọn. Không truy vấn theo từng dòng.
- Lượt cả công ty (việc nền, phiếu đầu kỳ): như trên với mọi ứng viên của công ty. Số kiện chưa giữ của đồ án nhỏ; ghi vào giới hạn đã biết.
- `stock_changed` cho kiện đang giữ (bàn giao thường) chạy một lượt không có gì để làm: vài câu đọc và một sự kiện.

### 5.12 Test

| File | Kiểm |
|---|---|
| `test/unit/modules/order/fulfillment/domain/allocation.test.ts` | `allocationQueue`, `planAllocation`, `planReclaim` |
| `test/integration/order/fulfillment/allocation.test.ts` | AC 1–5, 10 |
| `test/integration/order/fulfillment/reclaim.test.ts` | AC 6 |
| `test/integration/order/fulfillment/allocation-triggers.test.ts` | AC 7–9 |
| `test/integration/order/fulfillment/opening-stocktake.test.ts` | AC 11–13, 16 |
| `test/integration/order/fulfillment/hand-over.test.ts`, `undo-handover.test.ts` | AC 14, 15 (thêm ca) |
| `test/integration/order/fulfillment/allocation-migration.test.ts` | AC 17 |

- Handler của consumer và của việc nền export từ `service/allocation.ts` để test chạy đúng đường của chúng.
- Lượt thoát chờ trong test: giao dịch đặt `channel.shops.opening_stocktake_id = null` bằng SQL rồi gọi `settleOpeningStocktake`, thay cho handler của #289.
- Tồn đặt bằng helper của `test/integration/product/inventory/helpers.ts`; kiện bằng `seedPackage` (199a), thêm tham số `reservedAt`, `needsOpen`, `orderCreatedAt` nếu cần.

## 6. Thứ tự giao

1. **PR Documents** (mục 8). Merge trước.
2. **PR backend 199b**, nhánh `feature/199b-chia-hang` từ `main` (ef8bc68).
3. Sau khi merge: báo Thành gọi `settleOpeningStocktake` trong #289, chuyển #223 sang nghe `allocation_done`.

## 7. Ảnh hưởng tới FE

Không đổi hợp đồng route. Kiện tự đổi giữa Thiếu hàng và Đã giữ hàng (lịch sử ghi `hold`, `reclaim` do hệ thống). `hand-over` có thể trả `issue: null` cho kiện của gian hàng chờ kiểm kê. Phần d làm.

## 8. Ảnh hưởng tới Documents

- `25` §6.1 bước 3: thứ tự "áp các cập nhật đã hoãn (bù kiện rời kho sau mốc) rồi mới phân hàng cho mọi kiện chưa bàn giao" (D2).
- `25` §7.4: kiện đã đóng mà chưa giữ hàng (sàn báo đã đóng gói) cũng được phân hàng, xếp trước kiện Thiếu hàng (D5).
- `21` §11.1, §11.2 (dòng `allocation_done`, `stocktake_posted`): channel gọi `settleOpeningStocktake` trong giao dịch thoát chờ, thay cho "fulfillment nghe `stocktake_posted`" (D1); `allocation_done` luôn phát sau mỗi lần nhận `stock_changed` và khi kiện mới giữ được hàng (D4).
- `21` §11.3: thêm dòng `settleOpeningStocktake({ shopId, documentId, countedAt })` (fulfillment cung cấp, channel gọi).
- `21` §19.2: `hand-over` trả `issue: null` khi kiện thuộc gian hàng chờ kiểm kê (hoãn trừ).
- `19` bảng `packages`: thêm `reserved_at` (lần gần nhất kiện giữ hàng, dùng khi lấy lại phần giữ).

## 9. Acceptance criteria

1. **Phân hàng theo hạn (D2-01, US-DH-04.2):** hai kiện `backordered` cùng SKU, `ship_by` khác nhau; nhập hàng đủ cho một kiện → kiện hạn sớm sang `reserved`, dòng `reserved_qty = quantity`, có `reserved_at`, lịch sử `hold`, `package_status_changed`; kiện kia vẫn `backordered`; có `allocation_done` chứa SKU.
2. **Bỏ qua, xét tiếp:** kiện đầu hàng đợi thiếu, kiện sau đủ → kiện sau được giữ, kiện đầu ở lại.
3. **Cùng hạn:** đơn kéo về trước được giữ; kiện `ship_by` null xếp sau kiện có hạn.
4. **Kiện đã đóng chưa giữ (D5):** kiện `packed` có `reserved_qty = 0` được giữ trước kiện `backordered` hạn sớm hơn; trạng thái vẫn `packed`.
5. **Không xét:** kiện có dòng chưa ghép SKU; kiện của gian hàng chờ kiểm kê; kiện `needs_open`.
6. **Lấy lại phần giữ (D2-02, US-TK-06.3):** tồn thực giảm dưới đang giữ → kiện của đơn `unpaid` bị lấy trước đơn `processing`; trong nhóm, kiện `reserved_at` mới nhất trước; dừng khi đủ; kiện `packed` không bị lấy; kiện bị lấy về `backordered`, `reserved_at` null, lịch sử `reclaim`; SKU khác của kiện bị lấy được phân cho kiện khác trong cùng lượt.
7. **Luôn phát:** `stock_changed` mà không có gì để giữ hay lấy lại vẫn phát `allocation_done { variantIds: [SKU đó] }`.
8. **Kiện mới:** giữ được hàng thì có `allocation_done` với SKU của kiện trong cùng giao dịch; không giữ được thì không có.
9. **Kiện huỷ:** kiện `reserved` bị sàn huỷ → có việc `fulfillment.allocation`; chạy việc → kiện `backordered` khác của SKU đó được giữ.
10. **Đua:** hai lượt cùng công ty chạy song song (`raceBehindLock` trên khoá advisory) → kiện chỉ được giữ một lần, số đang giữ đúng.
11. **Phiếu đầu kỳ, bù trước (D2):** gian hàng chờ kiểm kê có kiện rời kho sau `countedAt` (hoãn), một kiện `awaiting_pickup` chưa giữ, một kiện `backordered`; tồn sau phiếu đủ cho kiện rời kho và kiện đã đóng, thiếu cho kiện `backordered` → kiện rời kho trừ thường (`handover_source` không phải `forced`, không Tồn âm), kiện đã đóng được giữ, kiện `backordered` ở lại; có `allocation_done` với `cause = { type: 'stocktake', documentId }`.
12. **Phiếu đầu kỳ, kiện đã đóng không giữ được:** `needs_attention`, ghi chú "Dỡ kiện về kệ…".
13. **Phiếu đầu kỳ không có gì để làm:** vẫn phát `allocation_done` có `cause`, `variantIds` rỗng; gọi lần hai không phiếu `XK` mới, không giữ thêm, phát lại `cause`.
14. **Kho quét lúc chờ kiểm kê (D7):** kiện `in_transit`, `handover_source = 'scan'`, không phiếu `XK`, `issue` null. `settleOpeningStocktake` sau đó: quét sau `countedAt` → trừ một lần; quét trước → `before_cutoff`.
15. **Huỷ bàn giao kiện đang hoãn:** kiện về `awaiting_pickup`, không phiếu `DX`, tồn không đổi, lịch sử có lý do.
16. **Quét đua thoát chờ:** giao dịch thoát chờ giữ khoá dòng gian hàng (`raceBehindLock`), một lần quét bị chặn; thoát chờ commit rồi lần quét chạy → kiện trừ ngay đúng một lần, không còn kiện hoãn chưa bù.
17. **Migration:** kiện đang giữ hàng có từ trước được điền `reserved_at = created_at`; kiện `backordered` vẫn null.
18. Test cũ xanh (199a, đồng bộ kiện #105, `GET /orders`, cổng tồn); `npm run check` xanh, depcruise không báo vi phạm.

## 10. Rủi ro và điểm còn mở

- **Sửa module của người khác:** channel thêm hàm `stockHoldOf` (đọc, vài dòng), `src/wiring.ts` tiêm. Báo trong PR.
- **Phụ thuộc #289:** tới khi #289 gọi `settleOpeningStocktake`, gian hàng thoát chờ trên `main` không bù kiện hoãn, không phân hàng sau phiếu đầu kỳ. Hai bên đều chưa merge phần thoát chờ nên chưa ảnh hưởng dữ liệu.
- **Phụ thuộc #223:** tới khi channel chuyển sang nghe `allocation_done`, channel vẫn đẩy tồn theo `stock_changed` (số chưa trừ phần vừa giữ). Hành vi như hiện nay, không tệ hơn.
- **`reserved_at` xấp xỉ** cho kiện đang giữ có từ trước (lấy `created_at`). Dữ liệu staging là demo.
- **Lượt cả công ty** quét mọi kiện chưa giữ; nếu số kiện lớn thì cần chia theo SKU (giới hạn đã biết).
- **Câu báo 409 `handover_confirmed_by_platform`** cho kiện quét đã thành bàn giao bắt buộc (câu hỏi còn mở thứ hai của #291): giữ nguyên, ngoài phạm vi.
