# #237 PR 1: Ghép SKU áp lên đơn đã về — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ghép một SKU sàn có hiệu lực (ghép ngay, CEO tự duyệt, CEO duyệt ghép chờ) thì mọi dòng **chưa ghép** của đơn đã về cùng gian hàng được gán biến thể hoặc "không quản tồn" trong cùng giao dịch; kiện giữ hàng, trừ tồn bù, báo giao xong theo trạng thái.

**Architecture:** Channel (`mapping.ts`) gọi `applySkuMapping` của sales trong giao dịch ghép (đã khoá dòng gian hàng). Sales khoá dòng đơn, giao `remapPackageLines` của fulfillment mọi việc trên kiện và tồn, rồi ghi dòng đơn và phát sự kiện đơn. "Không quản tồn" là cột `stock_untracked` trên `order_lines` và `package_lines`.

**Tech Stack:** Node 24 (chạy thẳng `.ts`), Express 5, TypeScript 6, Zod 4, Drizzle ORM + PostgreSQL 18 (staging PG17), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-237-ghep-sku-dong-don-design.md` (đọc kèm; plan này chỉ làm PR 1, mục 6 của spec).

## Global Constraints

- Định danh tiếng Anh; comment, thông báo lỗi, tên `describe`/`it` tiếng Việt.
- Import tương đối có đuôi `.ts`; không `enum`, `namespace`, parameter property.
- Module khác import qua `index.ts`; channel (lớp 5) gọi `order` (lớp 3) trực tiếp; `shared` không biết module.
- Tiền là `numeric`/`decimal.js`; không thêm route, không thêm mã lỗi.
- Test chỉ ở `test/`, import `#src/...ts`; integration tự tạo công ty riêng, không giả định bảng trống.
- Migration sinh **một lần** ở Task 1 bằng `npm run db:generate -- --name ghep-sku-dong-don` sau khi cả hai `schema.ts` đã chốt; không sửa tay file sinh. Cần đổi schema sau đó thì xoá migration của nhánh và sinh lại, không thêm migration thứ hai. Không dùng tính năng chỉ PG18.
- Thứ tự khoá (spec §5.8, quyết định P4 dưới): gian hàng → dòng đơn → advisory `fulfillment.allocation:<công ty>` → kiện (id tăng) → dòng tồn.
- Mỗi bước nghiệp vụ chạy trong giao dịch và `withCompany` của bên gọi; không mở giao dịch mới.
- Trước khi mở PR: `npm run check` xanh, `npm run db:ci-check -- --base origin/main` xanh, `graphify update .`.

## Thiết kế theo 6 bước (backend-design)

1. **Loại:** lệnh nội bộ chạy trong giao dịch của request HTTP (`POST listings/match`, `mapping/approve`), không route mới.
2. **Dữ liệu và bất biến:** trạng thái ghép của dòng là `LineSku` (`variant` | `untracked` | `unmapped`); CSDL ép `stock_untracked` ⇒ không biến thể, không giữ, không trừ. Một dòng kiện bị trừ đúng một lần (`stock_deducted` + lưới `packageLineId`).
3. **Lỗi:** mọi lỗi (cổng tồn, `40P01`, CHECK) làm rollback cả giao dịch ghép; người bấm nhận lỗi gốc và bấm lại. Không nuốt lỗi.
4. **Quyền:** route đã kiểm (`channel.listing.match`; duyệt cần `listing.manage` + CEO). `applySkuMapping` tin bên gọi, chạy trong `withCompany` nên RLS giới hạn công ty; đơn của gian hàng khác không bị chọn vì lọc theo `shop_id`.
5. **Idempotence, đồng thời:** chỉ chọn dòng còn chưa ghép, nên gọi lại không làm gì; khoá gian hàng `FOR NO KEY UPDATE` chặn lượt kéo đơn và bàn giao của gian hàng; khoá dòng đơn rồi advisory phân hàng như mục Global Constraints.
6. **Quan sát:** một log `info` mỗi lần áp (gian hàng, SKU người bán, số dòng, số đơn); lịch sử kiện `remap`; sự kiện `sales.order_status_changed`, `fulfillment.package_shipped`, `fulfillment.package_delivered` như luồng sẵn có.

## Quyết định khi lập plan (Claude, Khang xem khi duyệt plan)

- **P1** PR 1 chỉ chọn dòng **chưa ghép** (`variant_id is null and not stock_untracked`). Đổi ghép đã dùng (bảng 2, 3 của spec) không chọn dòng nào: kết quả quan sát được giống "trả `kept`" của spec mục 6, ít code hơn. PR 2 mở rộng câu chọn.
- **P2** "Giữ dòng mới" chỉ khi kiện đang giữ hàng (`reserved`, hoặc kiện đã đóng có dòng `reserved_qty > 0`). Kiện đã đóng chưa giữ dòng nào (lập lúc còn dòng chưa ghép) thì xếp lượt phân hàng cho mọi biến thể của kiện: lượt giữ nguyên kiện (luật "nguyên kiện" của `25` §7.4), không giữ lẻ một dòng.
- **P3** Kiện rời kho trước `orderCutoffAt` (D11): gọi `settleHandover(pkg, { mode: 'store_only' })` để ghi `before_cutoff`, **chỉ khi** kiện chưa có dòng nào `stock_deducted`. Không ghi mốc thì lần ghép dòng khác của cùng kiện sau này sẽ trừ cả dòng này (`settleHandover` trừ mọi dòng đã ghép chưa trừ). Kiện đã có dòng trừ thì trừ như thường.
- **P4** Sales khoá dòng đơn (`FOR UPDATE`) trước khi gọi fulfillment: khớp thứ tự của luồng nhận đơn (đơn → dòng đơn → kiện).
- **P5** Mỗi kiện có dòng ghi ra một dòng lịch sử `remap` (`from = to` = trạng thái lúc khoá, người làm, lý do "Ghép SKU <SKU người bán>"), ghi trước khi `hold`/`reclaim` (hai bước này tự ghi lịch sử, `actor_id` null như lượt phân hàng).
- **P6** Sự kiện `sales.order_status_changed` chỉ phát cho đơn `unpaid`, `processing` (`from = to`); đơn đã dừng vẫn được ghi dòng.

## Review Focus

1. Kiện có **hai** dòng chưa ghép của hai SKU sàn khác nhau, ghép một SKU: kiện vẫn chưa đủ điều kiện giữ (còn dòng chưa ghép), không `hold`, không giữ lẻ; kiện đã rời kho chỉ trừ dòng vừa ghép. Test ở Task 6.
2. Kiện `backordered` trộn dòng có biến thể và dòng `stock_untracked`: lượt phân hàng giữ được, chỉ gọi `reserve` và chỉ đặt `reserved_qty` cho dòng có biến thể (không vỡ CHECK `package_lines_untracked`). Hiện `lockAllocationCandidates` truyền mọi dòng (`linesOf` dùng `variantId!`). Test ở Task 3.
3. Kiện `reserved` có dòng chưa ghép (kiện lập lúc đã đóng gói rồi được mở) mà biến thể mới không đủ tồn: nhả cả kiện về `backordered`, không để kiện `reserved` giữ thiếu. Test ở Task 6.
4. Đơn cùng SKU người bán ở gian hàng khác, và dòng đã ghép khác của cùng đơn, không bị đổi. Test ở Task 7.
5. Bấm ghép lại khi đã áp xong: không phiếu `XK` mới, không phát sự kiện đơn lần hai, không dòng lịch sử `remap` mới. Test ở Task 7.

---

### Task 1: Cột `stock_untracked` và migration

**Files:**
- Modify: `src/modules/order/sales/repository/schema.ts:142-190` (bảng `order_lines`)
- Modify: `src/modules/order/fulfillment/repository/schema.ts:137-169` (bảng `package_lines`)
- Create (sinh): `db/migrations/<timestamp>_ghep-sku-dong-don.sql`, snapshot, `_journal.json`
- Test: `test/integration/order/sales/constraints.test.ts`, `test/integration/order/fulfillment/constraints.test.ts`

**Interfaces:**
- Produces: cột Drizzle `orderLines.stockUntracked`, `packageLines.stockUntracked` (`boolean`, not null, default false); CHECK `order_lines_untracked`, `package_lines_untracked`.

- [ ] **Step 1: Viết test CHECK thất bại** (theo cách hai file đang chèn dòng bằng `testPool()` và bắt `23514`)
  - `order_lines_untracked`: cập nhật một dòng đơn có `variant_id` sang `stock_untracked = true` → lỗi `23514`, `constraint = 'order_lines_untracked'`; dòng `variant_id` null thì được.
  - `package_lines_untracked`: dòng kiện `variant_id` null, `stock_untracked = true` mà `reserved_qty > 0` → `23514`; có `variant_id` → `23514`; `stock_deducted = true` → `23514`; null biến thể, 0 giữ, chưa trừ → được.
- [ ] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project integration test/integration/order/sales/constraints.test.ts test/integration/order/fulfillment/constraints.test.ts` → FAIL (cột chưa có).
- [ ] **Step 3: Khai cột và CHECK**
  - `order_lines`: `stockUntracked: boolean('stock_untracked').notNull().default(false)`; `check('order_lines_untracked', sql\`not ${t.stockUntracked} or ${t.variantId} is null\`)`. Comment: ghép "không quản tồn" (25 §8.1), không giữ, không trừ; chưa ghép là `variant_id is null and not stock_untracked`.
  - `package_lines`: cùng cột; `check('package_lines_untracked', sql\`not ${t.stockUntracked} or (${t.variantId} is null and ${t.reservedQty} = 0 and not ${t.stockDeducted})\`)`.
- [ ] **Step 4: Sinh migration** — `npm run db:generate -- --name ghep-sku-dong-don`. Kiểm file: hai `ADD COLUMN ... boolean DEFAULT false NOT NULL` và hai `ADD CONSTRAINT ... CHECK`, không câu nào khác. (Thêm cột có mặc định hằng không viết lại bảng; CHECK quét bảng một lần dưới khoá, bảng staging nhỏ.)
- [ ] **Step 5: Chạy lại test, thấy xanh** — cùng lệnh Step 2 → PASS. Chạy thêm `npx vitest run test/unit/db/journal.test.ts` → PASS.
- [ ] **Step 6: Commit** — `#237: cột stock_untracked cho dòng đơn, dòng kiện`.

### Task 2: Sales đọc "chưa ghép" theo hai cột, API `untracked`

**Files:**
- Modify: `src/modules/order/sales/repository/orders.ts:86-95` (`hasUnmappedLines`)
- Modify: `src/modules/order/sales/repository/order-views.ts:50-56`, `:164-168` (lọc cờ, `lineFacts`)
- Modify: `src/modules/order/sales/service/orders.ts:278-300` (dựng `lines`)
- Modify: `src/modules/order/sales/api/schemas.ts:117-140` (`OrderLine`)
- Test: `test/integration/order/sales/orders-api.test.ts`

**Interfaces:**
- Consumes: `orderLines.stockUntracked` (Task 1).
- Produces: biểu thức "dòng chưa ghép" dùng chung trong `order-views.ts`/`orders.ts`: `and(isNull(orderLines.variantId), eq(orderLines.stockUntracked, false))`; `OrderLine.untracked: boolean`.

- [ ] **Step 1: Viết test thất bại (AC15)** — trong `orders-api.test.ts`, ca "dòng ghép không quản tồn không mang cờ Chưa ghép":
  - Dựng đơn sàn có hai dòng `variant_id` null (cách file đang dựng đơn), đặt một dòng `stock_untracked = true` bằng `testPool()`.
  - `GET /api/v1/sales/orders/:id` → `flags` chứa `unmapped_sku`; `lines` có đúng một phần tử `untracked: true`.
  - Đặt dòng còn lại `stock_untracked = true` → `flags` không có `unmapped_sku`; `GET /sales/orders?flag=unmapped_sku` không còn đơn này; tóm tắt đơn ở danh sách không có cờ.
- [ ] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project integration test/integration/order/sales/orders-api.test.ts` → FAIL.
- [ ] **Step 3: Sửa ba chỗ đọc và schema** — `hasUnmappedLines`, `case 'unmapped_sku'`, câu `unmapped` của `lineFacts` dùng biểu thức trên. `OrderLine` thêm `untracked: z.boolean().meta({ description: 'Ghép "không quản tồn": không giữ, không trừ tồn. `variantId` null và `untracked` false là chưa ghép (cờ `unmapped_sku`)' })`; sửa mô tả của `variantId` cho khớp. `service/orders.ts` trả `untracked: l.stockUntracked`.
- [ ] **Step 4: Chạy lại, thấy xanh** — cùng lệnh → PASS.
- [ ] **Step 5: Commit** — `#237: cờ Chưa ghép bỏ dòng không quản tồn, OrderLine.untracked`.

### Task 3: Fulfillment nhận dòng `stock_untracked` (lập kiện, phân hàng)

**Files:**
- Create: `src/modules/order/fulfillment/domain/remap.ts` (chỉ kiểu và hàm thuần ở task này)
- Modify: `src/modules/order/fulfillment/repository/packages.ts:42-54` (`insertPackageLines`), `:162-187` (`PackageLineRow`, `planLinesOf`)
- Modify: `src/modules/order/fulfillment/service/platform-packages.ts:57-75` (`PlatformPackageLine`), `:222-260` (`createPackage`)
- Modify: `src/modules/order/fulfillment/repository/allocation.ts:22-28` (`candidateWhere`), `:51`, `:143-144` (`linesOf`, `lineIds`)
- Modify: `src/modules/order/fulfillment/index.ts` (export kiểu)
- Test: `test/unit/modules/order/fulfillment/domain/remap.test.ts`, `test/integration/order/fulfillment/allocation.test.ts`

**Interfaces:**
- Produces (export qua `fulfillment/index.ts`, nên cũng qua `order/index.ts`):
  - `type LineSku = { kind: 'variant'; variantId: string } | { kind: 'untracked' } | { kind: 'unmapped' }`
  - `type MappedSku = Exclude<LineSku, { kind: 'unmapped' }>`
  - `lineSkuOf(l: { variantId: string | null; stockUntracked: boolean }): LineSku`
  - `nothingToHold(lines: readonly { variantId: string | null; stockUntracked: boolean; reservedQty: number; quantity: number }[]): boolean` — không dòng chưa ghép và mọi dòng có biến thể đã giữ đủ.
- Produces (nội bộ fulfillment): `PlatformPackageLine.untracked?: boolean`; `insertPackageLines` nhận `stockUntracked?: boolean` mỗi dòng; `PackageLineRow` thêm `stockUntracked: boolean`.

- [ ] **Step 1: Unit test thất bại** — `remap.test.ts`, `describe('lineSkuOf, nothingToHold')`: `lineSkuOf({ variantId: 'v', stockUntracked: false })` → `{ kind: 'variant', variantId: 'v' }`; `{ null, true }` → `untracked`; `{ null, false }` → `unmapped`. `nothingToHold`: mọi dòng `untracked` → true; một dòng biến thể `reservedQty 0` → false; một dòng `unmapped` → false; biến thể đã giữ đủ + untracked → true.
- [ ] **Step 2: Integration test thất bại (Review Focus 2)** — trong `allocation.test.ts`: `seedPackage` kiện `backordered` có một dòng biến thể `v` (tồn 0) và một dòng `variantId: null`, đặt dòng đó `stock_untracked = true` bằng `testPool()`; `receive` 1 rồi `runAllocation(ctx, { variantIds: [v] })` → kiện `reserved`, dòng `v` `reserved_qty = 1`, dòng untracked `reserved_qty = 0`. Ca kiện còn một dòng chưa ghép thật (không `stock_untracked`) → vẫn `backordered`.
- [ ] **Step 3: Chạy, thấy đỏ** — `npx vitest run --project unit test/unit/modules/order/fulfillment/domain/remap.test.ts` → FAIL; integration → FAIL.
- [ ] **Step 4: Viết** `domain/remap.ts` (hai hàm trên). Sửa:
  - `insertPackageLines`, `planLinesOf` đọc/ghi `stockUntracked`.
  - `createPackage`: `mapped = lines.every((l) => l.variantId || l.untracked)`; dòng chèn `stockUntracked: !l.variantId && !!l.untracked`, `reservedQty: reserved && l.variantId ? l.quantity : 0`; `wantsStock && mapped && stockLines(lines).length === 0` → coi là giữ được, **không** gọi cổng tồn, kể cả `holdStock` false (spec D10); chỉ phát `allocation_done` khi danh sách biến thể khác rỗng.
  - `candidateWhere`: điều kiện "không có dòng chưa ghép" thành `... variant_id is null and not stock_untracked`.
  - `lockAllocationCandidates`: `lines`, `lineIds` chỉ lấy dòng có `variantId`.
- [ ] **Step 5: Chạy lại, thấy xanh** — unit + `npx vitest run --project integration test/integration/order/fulfillment` → PASS (cả file cũ). Phần lập kiện (`createPackage`) có test ở Task 4 vì cần `PlatformOrder.lines[].untracked`.
- [ ] **Step 6: Commit** — `#237: kiện nhận dòng không quản tồn, phân hàng bỏ qua dòng đó`.

### Task 4: Nhận đơn dùng ghép đã lưu; channel tra ra `LineSku`

**Files:**
- Modify: `src/modules/order/sales/service/ingest.ts:23-65` (`PlatformOrder.lines[].untracked?`), `:132` (export `storedFlags`), `:212-260` (upsert, gọi `syncPlatformPackages`), `:320-330` (cờ sự kiện)
- Modify: `src/modules/order/sales/repository/orders.ts:115-148` (`upsertMarketplaceLines` trả giá trị đã lưu)
- Modify: `src/modules/channel/channel/repository/raw-orders.ts:34-49` (`variantsBySellerSku`)
- Modify: `src/modules/channel/channel/service/order-pull.ts:86-95`
- Modify: `test/integration/order/fulfillment/platform-fixtures.ts` (`remote()` nhận `untracked?: number`: số dòng không quản tồn)
- Test: `test/integration/order/sales/ingest.test.ts`, `test/integration/order/fulfillment/platform-delivery.test.ts`, `test/integration/channel/channel/order-pull.test.ts`

**Interfaces:**
- Consumes: `LineSku`, `lineSkuOf` (Task 3); `PlatformPackageLine.untracked` (Task 3).
- Produces:
  - `upsertMarketplaceLines(orderId, lines): Promise<Map<string /* externalLineId */, { id: string; variantId: string | null; stockUntracked: boolean }>>` — giá trị **đã lưu** (dòng cũ giữ biến thể cũ).
  - `PlatformOrder.lines[i].untracked?: boolean` (thiếu là false).
  - `export function storedFlags(...)` (đổi từ hàm nội bộ).
  - `variantsBySellerSku(shopId, sellerSkus): Promise<Map<string, LineSku>>` — dòng thắng `mapped` → `variant`; `unmanaged` có `approved_by` → `untracked`; còn lại → `unmapped`.

- [ ] **Step 1: Test thất bại**
  - `ingest.test.ts` **AC11 (phần đơn):** đơn có dòng `untracked: true` → dòng đơn `stock_untracked = true`, `variant_id` null, `sku` null; sự kiện `sales.order_status_changed` không có `unmapped_sku`.
  - `ingest.test.ts` **AC16d:** đơn đã về với dòng có biến thể A; kéo lại cùng đơn nhưng dòng đó mang biến thể B và mã kiện sàn mới (làm app lập kiện mới) → dòng kiện mới mang A; dòng đơn vẫn A; cờ sự kiện tính từ dòng đã lưu.
  - `test/integration/order/fulfillment/platform-delivery.test.ts` (dùng `platform-fixtures.ts`, thêm tham số `untracked` cho `remote()`): **AC16b** đơn chỉ một dòng `untracked`, món `pending` → kiện `reserved`, `reserved_qty = 0`, không việc `fulfillment.allocation`, không `fulfillment.allocation_done`, tồn không đổi; `holdStock: false` cũng `reserved`. **AC11 (phần giao)** dòng biến thể + dòng untracked, sàn báo `delivered` → `fulfillment.package_delivered` mang dòng untracked `variantId: null`, `unitCost: null`, dòng biến thể có `unitCost`.
  - `order-pull.test.ts` **AC12:** listing chỉ có ghép chờ "không quản tồn" (chưa duyệt) → đơn kéo về có dòng chưa ghép, đơn có cờ; listing "không quản tồn" đã duyệt → dòng `stock_untracked`.
- [ ] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project integration test/integration/order/sales/ingest.test.ts test/integration/order/fulfillment/platform-delivery.test.ts test/integration/channel/channel/order-pull.test.ts` → FAIL.
- [ ] **Step 3: Sửa**
  - `ingest.ts`: chèn dòng với `stockUntracked: !l.variantId && !!l.untracked`; `syncPlatformPackages` nhận `variantId`, `untracked` lấy từ Map đã lưu (không từ `o.lines`); cờ `unmapped_sku` của sự kiện = `await hasUnmappedLines(orderId)`.
  - `upsertMarketplaceLines`: câu đọc cuối chọn thêm `variantId`, `stockUntracked`.
  - `variantsBySellerSku`: chọn thêm `mode`, `approvedBy`; trả `LineSku` (import kiểu từ `../../../order/index.ts`).
  - `order-pull.ts`: `variantId: s?.kind === 'variant' ? s.variantId : null, untracked: s?.kind === 'untracked'`.
- [ ] **Step 4: Chạy lại, thấy xanh** — cùng lệnh, cộng `test/integration/order/fulfillment` và `test/integration/channel/channel/listing-match.test.ts` (dùng `variantsBySellerSku`) → PASS.
- [ ] **Step 5: Commit** — `#237: nhận đơn ghi không quản tồn, kéo lại dùng ghép đã lưu`.

### Task 5: Luật thuần `planRemap` (bảng 1 của spec)

**Files:**
- Modify: `src/modules/order/fulfillment/domain/remap.ts`
- Test: `test/unit/modules/order/fulfillment/domain/remap.test.ts`

**Interfaces:**
- Consumes: `LineSku`, `MappedSku`, `nothingToHold` (Task 3); `PackageStatus`, `HANDED_OVER` (`domain/package.ts`).
- Produces:

```ts
export interface RemapPackage {
  status: PackageStatus;
  handedOverAt: Date | null;
  handoverSource: HandoverSource | null;
  lines: readonly { id: string; orderLineId: string; variantId: string | null; stockUntracked: boolean; quantity: number; reservedQty: number; stockDeducted: boolean }[];
}
export type RemapOutcome = 'applied' | 'kept' | 'needs_unload';
export interface RemapPlan {
  /** Dòng kiện ghi trạng thái ghép mới. */
  writes: { lineId: string; to: MappedSku }[];
  /** Kết quả theo dòng kiện (mọi dòng có trong `changes`). */
  outcomes: Map<string, RemapOutcome>;
  /** Việc trên kiện sau khi ghi, theo thứ tự thi hành. */
  stock:
    | { kind: 'none' }
    | { kind: 'hold' }                                   // backordered, không còn gì để giữ
    | { kind: 'allocate'; variantIds: string[] }         // xếp lượt phân hàng
    | { kind: 'reserve_new'; lineIds: string[]; sealed: boolean } // giữ dòng mới (P2), chỉ khi `holdStock`
    | { kind: 'reclaim' }                                // kiện `reserved` có dòng mới mà `holdStock` false: nhả, về backordered, không xếp lượt
    | { kind: 'ship' }                                   // shipLateMappedLines
    | { kind: 'store_only' };                            // ghi before_cutoff (P3)
  /** Kiện `delivered`: gọi `reportDelivered` sau bước tồn. */
  reportDelivered: boolean;
}
export function planRemap(
  pkg: RemapPackage,
  changes: ReadonlyMap<string /* orderLineId */, MappedSku>,
  opts: { holdStock: boolean; orderCutoffAt: Date | null },
): RemapPlan
```

- [ ] **Step 1: Unit test thất bại** — `describe('planRemap: ghép lần đầu (spec 237 bảng 1)')`, mỗi ca một `it`, kiện dựng tay:
  - `cancelled`, `returned`: `writes` có dòng, `stock.kind = 'none'`, `reportDelivered` false.
  - `backordered`, dòng duy nhất → `untracked`: `stock = { kind: 'hold' }`.
  - `backordered`, dòng → biến thể `v`, dòng khác biến thể `w`: `stock = { kind: 'allocate', variantIds: ['v', 'w'] }` (xếp tăng, không trùng).
  - `backordered` còn một dòng chưa ghép khác (Review Focus 1): `stock = { kind: 'allocate', ... }`, **không** `hold`.
  - `reserved`, dòng → `v`, `holdStock`: `{ kind: 'reserve_new', lineIds: [id], sealed: false }`; `holdStock` false: `{ kind: 'reclaim' }` (spec §5.5 "`holdStock = false`"). `packed` + `holdStock` false: `none`.
  - `packed` có dòng khác `reserved_qty > 0`, dòng → `v`: `{ kind: 'reserve_new', sealed: true }`; `packed` không dòng nào đang giữ: `{ kind: 'allocate', variantIds: <mọi biến thể của kiện> }` (P2).
  - `reserved`/`packed`, dòng → `untracked`: `stock.kind = 'none'`.
  - `in_transit`, `holdStock`, `handedOverAt` ≥ `orderCutoffAt`, dòng → `v`: `{ kind: 'ship' }`; `orderCutoffAt` null: `ship`.
  - `in_transit`, `handedOverAt < orderCutoffAt`, không dòng nào `stockDeducted`: `{ kind: 'store_only' }` (16c); có dòng đã trừ: `ship` (P3).
  - `in_transit`, `handoverSource = 'before_cutoff'`: `none` (đã ghi mốc).
  - `in_transit`, `holdStock` false: `none` (hàm bù lo, D8).
  - `delivered`, dòng → `v`: `ship`, `reportDelivered` true; dòng → `untracked`: `none`, `reportDelivered` true.
  - Mọi ca: `outcomes` của dòng trong `changes` là `applied`; dòng kiện đã không còn `unmapped` (đã ghép) mà có trong `changes` → `kept`, không vào `writes` (P1, phòng thủ).
- [ ] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project unit test/unit/modules/order/fulfillment/domain/remap.test.ts` → FAIL.
- [ ] **Step 3: Viết `planRemap`** — luật theo bảng 1 spec §5.5 cùng P2, P3; "đang giữ" = `status === 'reserved'` hoặc có dòng `reservedQty > 0`; "trước mốc" = `orderCutoffAt && handedOverAt && handedOverAt < orderCutoffAt`. Không I/O.
- [ ] **Step 4: Chạy lại, thấy xanh** → PASS.
- [ ] **Step 5: Commit** — `#237: luật thuần planRemap cho ghép lần đầu`.

### Task 6: `remapPackageLines` (fulfillment thi hành)

**Files:**
- Create: `src/modules/order/fulfillment/service/remap.ts`
- Modify: `src/modules/order/fulfillment/repository/packages.ts` (hai hàm mới), `src/modules/order/fulfillment/service/allocation.ts:38-43` (export `move` thành `movePackage`)
- Modify: `src/modules/order/fulfillment/index.ts`
- Test: `test/integration/order/fulfillment/remap.test.ts`

**Interfaces:**
- Consumes: `planRemap`, `RemapOutcome`, `MappedSku` (Task 5); `shipLateMappedLines`, `settleHandover` (`service/handover-stock.ts`); `reportDelivered` (`service/delivery.ts`); `requestAllocation`, `takeAllocationLock`; `stockPort()`.
- Produces:
  - `lockPackagesOfOrderLines(orderLineIds: readonly string[]): Promise<(HandoverPackage & { lines: PackageLineRow[] })[]>` (repository; kiện có dòng trỏ tới các dòng đơn, mọi trạng thái, `order by id`, `for update`, kèm `planLinesOf`).
  - `setLineSku(lineIds: readonly string[], to: MappedSku): Promise<void>` (repository; ghi `variant_id`, `stock_untracked`, `version + 1`, `updated_at`).
  - `movePackage(p: { id: string; orderId: string }, from: PackageStatus, action: 'hold' | 'reclaim', extra)` (đổi tên `move`, export từ `allocation.ts`).
  - **Export qua `fulfillment/index.ts`:**

```ts
export async function remapPackageLines(
  changes: readonly { orderLineId: string; to: MappedSku }[],
  opts: { actorId: string; holdStock: boolean; orderCutoffAt: Date | null; reason: string },
): Promise<Map<string /* orderLineId */, RemapOutcome>>
```
  Dòng đơn không có dòng kiện nào không có trong Map (bên gọi coi là `applied`). Dòng đơn có nhiều dòng kiện: `applied` khi mọi dòng kiện `applied`, không thì kết quả "nặng" nhất (`needs_unload` > `kept`).

- [ ] **Step 1: Integration test thất bại** — `remap.test.ts`, kiện dựng bằng `seedPackage` (dòng `variantId: null` + `fallbackVariantId`), tồn bằng `receive` (`product/inventory/helpers.ts`), gọi trong `withCompany(companyId, () => remapPackageLines([...], { actorId, holdStock: true, orderCutoffAt: null, reason: 'Ghép SKU LZ-1' }))`:
  - `backordered` → biến thể, đủ tồn: dòng kiện có biến thể; có việc `fulfillment.allocation` (đọc `pgboss` job như `allocation.test.ts`) với biến thể đó; một dòng lịch sử `remap` (`from = to = 'backordered'`, `actor_id` = actorId, `reason`).
  - **16a:** `backordered`, dòng duy nhất → `untracked`: kiện `reserved` (lịch sử `hold`), `reserved_at` có, không gọi cổng tồn (`setStockPort({ reserve: () => { throw … } })` không ném).
  - **Review Focus 3:** `reserved` có dòng biến thể đang giữ + dòng chưa ghép, biến thể mới tồn 0: kiện `backordered` (lịch sử `reclaim`), mọi dòng `reserved_qty = 0`, tồn đang giữ của biến thể cũ về 0, có việc phân hàng. Đủ tồn: kiện vẫn `reserved`, dòng mới `reserved_qty = quantity`.
  - **AC3:** `in_transit`, `forced`, dòng chưa ghép (dựng như `shippedWithUnmapped` ở `handover-stock.test.ts`): một phiếu `XK` mới chỉ gồm dòng đó, `stock_deducted`, `unit_cost` = bình quân; gọi lại với cùng dòng → không phiếu mới (dòng đã ghép nên `kept`).
  - **AC4:** `delivered`, `delivery_posted_at` null (đặt bằng SQL), dòng khác đã trừ + dòng chưa ghép: sau khi gọi, đúng một `fulfillment.package_delivered` trong outbox, dòng mang `unitCost` thật.
  - **AC5:** `delivered` đã có `delivery_posted_at`: trừ tồn, không thêm `package_delivered`.
  - **AC6:** `returned`: dòng có biến thể, không phiếu `XK`, tồn không đổi.
  - **AC7:** `before_cutoff`: dòng có biến thể, không phiếu.
  - **16c:** `in_transit`, `handed_over_at` trước `orderCutoffAt` truyền vào, chưa dòng nào trừ: không phiếu, kiện `handover_source = 'before_cutoff'`.
  - **AC8 (phần fulfillment):** `holdStock: false`: kiện `backordered` không gọi `reserve`, kiện `in_transit` không `ship`; sau đó `settleDeferredHandovers(shopId, countedAt trước handed_over_at)` trừ kiện `in_transit`.
  - **Review Focus 1:** `in_transit` có hai dòng chưa ghép, ghép một: chỉ dòng đó vào phiếu `XK`; dòng kia vẫn `variant_id` null.
  - **AC14 (phần fulfillment):** `setStockPort({ ship: async () => { throw new Error('hỏng') } })` → hàm ném; giao dịch của test rollback thì dòng kiện vẫn chưa ghép.
- [ ] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project integration test/integration/order/fulfillment/remap.test.ts` → FAIL.
- [ ] **Step 3: Viết `remapPackageLines`** — trình tự trong một lần gọi:
  1. `takeAllocationLock(requireCompanyId(...))`.
  2. `lockPackagesOfOrderLines(...)`; với mỗi kiện: `planRemap` → `setLineSku` theo `writes` (gom theo `to`) → cập nhật `pkg.lines` tại chỗ → `recordTransition({ entityType: 'packages', from: s, to: s, action: 'remap', actorId, reason })` và `updatePackage(pkg.id, {})` để tăng `version` (P5).
  3. Thi hành `stock`: `hold` → `movePackage(..., 'hold', { reservedAt: sql\`now()\` })`; `allocate` → `requestAllocation`; `reclaim` → `release` phần đang giữ, `setReserved(pkg.id, false)`, `movePackage(..., 'reclaim', {})`, không xếp lượt; `reserve_new` → `stockPort().reserve(pkg.id, dòng mới)`, được thì `markLinesReserved`; không được: kiện `reserved` → `release` phần đang giữ (dòng có `reservedQty > 0`), `setReserved(pkg.id, false)`, `movePackage(..., 'reclaim', {})`, `requestAllocation(mọi biến thể của kiện)`; kiện đã đóng → `requestAllocation(biến thể mới)`; `ship` → `shipLateMappedLines(pkg.id)`; `store_only` → `settleHandover(pkg, { actorId, mode: 'store_only' })`.
  4. `reportDelivered(pkg.id)` khi `plan.reportDelivered`.
  5. Trả Map theo dòng đơn.
- [ ] **Step 4: Chạy lại, thấy xanh** — `remap.test.ts` và cả thư mục `test/integration/order/fulfillment` (đổi tên `move`) → PASS.
- [ ] **Step 5: Commit** — `#237: remapPackageLines giữ hàng, trừ tồn bù, báo giao xong khi ghép muộn`.

### Task 7: `applySkuMapping` (sales)

**Files:**
- Create: `src/modules/order/sales/service/sku-mapping.ts`
- Modify: `src/modules/order/sales/repository/orders.ts` (ba hàm mới), `src/modules/order/sales/index.ts`
- Test: `test/integration/order/sales/sku-mapping.test.ts`

**Interfaces:**
- Consumes: `remapPackageLines`, `MappedSku` (Task 6, qua `../../fulfillment/index.ts`); `storedFlags`, `hasUnmappedLines` (Task 4).
- Produces:
  - Repository: `lockUnmappedLinesOfShopSku(shopId: string, sellerSku: string): Promise<{ id: string; orderId: string }[]>` — `order_lines` có `external_sku = sellerSku`, `variant_id is null and not stock_untracked`, `order_id in (select id from "order".orders where shop_id = $shopId)`; `order by id`; `for update` (câu một bảng, khoá đúng dòng đơn). `setOrderLineSku(ids: readonly string[], to: MappedSku, sellerSku: string): Promise<void>` — `variant_id`, `stock_untracked`, `sku` (= `sellerSku` khi `variant`, null khi `untracked`), `version + 1`, `updated_at`. `findOrderRows(ids: readonly string[]): Promise<MarketplaceOrderRow[]>` (không khoá, cùng `rowColumns`).
  - **Export qua `sales/index.ts` → `order/index.ts`:**

```ts
export async function applySkuMapping(input: {
  shopId: string;
  sellerSku: string;
  to: MappedSku;
  actorId: string;
  holdStock: boolean;
  orderCutoffAt: Date | null;
}): Promise<{ lines: number; orders: number; needsUnload: number }>
```

- [ ] **Step 1: Integration test thất bại** — đơn dựng bằng `remote()` + `ingest()` của `fulfillment/platform-fixtures.ts`, đổi `sellerSku` của dòng chưa ghép thành một SKU chung; gọi `withCompany(companyId, () => applySkuMapping({ ... }))`:
  - **AC1:** hai đơn cùng `shopId`, dòng chưa ghép cùng SKU, kiện `backordered`, đủ tồn → hai dòng đơn và hai dòng kiện có biến thể, `sku` = SKU người bán; `GET`/`hasUnmappedLines` false; mỗi đơn một `sales.order_status_changed` (`from = to`, `flags` không có `unmapped_sku`); có việc `fulfillment.allocation`; trả `{ lines: 2, orders: 2, needsUnload: 0 }`.
  - **Review Focus 4 / AC2:** đơn của `shopId` khác cùng SKU người bán, và dòng đã ghép khác của cùng đơn → không đổi.
  - **AC10 (phần sales):** `to: { kind: 'untracked' }` → dòng đơn và dòng kiện `stock_untracked`, `sku` null, cờ tắt; kiện chỉ còn dòng đó thì `reserved` không qua cổng tồn.
  - **AC13 / Review Focus 5:** gọi lần hai → trả `{ lines: 0, orders: 0, needsUnload: 0 }`; số phiếu `XK`, số sự kiện đơn, số dòng lịch sử `remap` không đổi.
  - **AC14:** `setStockPort` làm `ship` ném, đơn có kiện `in_transit` chưa ghép → `applySkuMapping` ném; chạy trong `withCompany` (giao dịch tự rollback) → dòng đơn vẫn chưa ghép, không sự kiện.
  - Đơn `completed` có kiện bàn giao bắt buộc chưa ghép (D3): dòng được ghép và trừ tồn; không phát `sales.order_status_changed` (P6).
- [ ] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project integration test/integration/order/sales/sku-mapping.test.ts` → FAIL.
- [ ] **Step 3: Viết `applySkuMapping`** — `lockUnmappedLinesOfShopSku` → rỗng thì trả 0 → `remapPackageLines(changes, { actorId, holdStock, orderCutoffAt, reason: \`Ghép SKU ${sellerSku}\` })` → dòng `applied` hoặc vắng trong Map thì `setOrderLineSku` → `findOrderRows` của các đơn có dòng đổi, đơn `unpaid`/`processing` phát `sales.order_status_changed` (`flags = storedFlags(row)` cộng `unmapped_sku` nếu `hasUnmappedLines`) → `logger.info({ shopId, sellerSku, lines, orders, needsUnload }, 'áp ghép SKU lên đơn đã về')`.
- [ ] **Step 4: Chạy lại, thấy xanh** — cùng lệnh và `test/integration/order/sales` → PASS.
- [ ] **Step 5: Commit** — `#237: applySkuMapping áp ghép lên dòng đơn đã về`.

### Task 8: Channel gọi `applySkuMapping` khi ghép có hiệu lực

**Files:**
- Modify: `src/modules/channel/channel/service/mapping.ts:149-246` (`matchListing`), `:269-326` (`decide`)
- Modify: `src/modules/channel/channel/api/openapi.ts:252`, `:267` (mô tả hai route)
- Test: `test/integration/channel/channel/listing-match-orders.test.ts`

**Interfaces:**
- Consumes: `applySkuMapping` (Task 7, qua `../../../order/index.ts`); `variantsBySellerSku` (Task 4); `lockShopRow` (trả `ShopRow` có `openingStocktakeId`, `orderCutoffAt`).
- Produces: hàm nội bộ `applyToOrders(shop: ShopRow, sellerSku: string | null, actorId: string): Promise<void>` trong `mapping.ts`: `sellerSku` null thì thôi; `to = (await variantsBySellerSku(shop.id, [sellerSku])).get(sellerSku)` (dòng thắng, D12); `unmapped` hoặc vắng thì thôi; còn lại gọi `applySkuMapping({ shopId: shop.id, sellerSku, to, actorId, holdStock: shop.openingStocktakeId === null, orderCutoffAt: shop.orderCutoffAt })`.

- [ ] **Step 1: Integration test thất bại** — dựng gian hàng, adapter giả, bản sao SKU sàn như `beforeAll` của `listing-match.test.ts` (nối token, `activateShop`, `fakeAdapter`, `reload`); biến thể **thật** (`createVariant`, `receive`; `setProductPort(null)` để `assertVariantFree` đọc catalog thật); đơn đã về bằng `ingestMarketplaceOrder` trong `withCompany` với `shopId` của gian hàng và `sellerSku` của SKU sàn, `variantId: null`:
  - **AC1 (đầu-cuối):** Sale `POST listings/match` biến thể → 200; dòng đơn có biến thể; `GET /sales/orders/:id` không còn `unmapped_sku`.
  - **AC9:** Sale ghép "không quản tồn" → 202; dòng đơn còn chưa ghép.
  - **AC10:** CEO `mapping/approve` ghép chờ ở AC9 → 200; dòng đơn `stock_untracked`, cờ tắt.
  - **AC16:** SKU đã ghép A, đơn đã về mang A; CEO đổi sang B → 200; dòng đơn vẫn A; đơn kéo về sau (ingest với biến thể tra lại qua `variantsBySellerSku`) mang B.
  - **AC13:** đơn về trước khi ghép, ghép đã đúng (đặt listing `mapped` bằng SQL như dữ liệu trước PR) → Sale bấm ghép lại cùng biến thể → 200, dòng đơn được áp.
  - **16e:** hai listing chưa gỡ cùng `seller_sku` (chèn bằng SQL, khác `external_sku_id`), dòng thắng là listing mới hơn ghép A; Sale ghép listing cũ sang B → dòng đơn theo A.
  - **AC14 (đầu-cuối):** `setStockPort` của fulfillment làm `ship` ném, đơn có kiện `in_transit` chưa ghép → route trả 500; listing **không** đổi (`rowOf`), dòng đơn chưa ghép.
  - `decide` khoá gian hàng: `raceBehindLock` giữ `select … from channel.shops … for share` (như lượt nhận đơn), gửi `mapping/approve` → request bị chặn tới khi giao dịch giữ khoá commit.
- [ ] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project integration test/integration/channel/channel/listing-match-orders.test.ts` → FAIL.
- [ ] **Step 3: Sửa `mapping.ts`**
  - `matchListing`: giữ kết quả `const locked = (await lockShopRow(shop.id))!`; gọi `applyToOrders(locked, row.sellerSku, actor.accountId)` ở nhánh "ghép đã đúng" trước `return`, và `applyToOrders(locked, saved.sellerSku, actor.accountId)` ở nhánh áp ngay sau `recordTransition`. Nhánh lưu ghép chờ (202) không gọi.
  - `decide`: đầu giao dịch `const locked = (await lockShopRow(shop.id))!` (sau `ownShop`); nhánh `approve` gọi `applyToOrders(locked, saved.sellerSku, actor.accountId)` sau `recordTransition`. `reject` không gọi.
  - Comment đầu file: bỏ câu "Đơn đã nhận giữ ghép cũ"; thay bằng luật áp lên đơn đã về (dòng chưa ghép; đổi ghép là PR 2).
  - `openapi.ts`: mô tả `listings/match`, `mapping/:action` thêm "Ghép có hiệu lực thì áp lên dòng chưa ghép của đơn đã nhận: giữ hàng, trừ tồn bù (#237)".
- [ ] **Step 4: Chạy lại, thấy xanh** — file mới, `listing-match.test.ts`, `order-pull.test.ts` → PASS.
- [ ] **Step 5: Commit** — `#237: ghép SKU có hiệu lực thì áp lên đơn đã về`.

### Task 9: CLAUDE.md, kiểm toàn bộ

**Files:**
- Modify: `src/modules/order/sales/CLAUDE.md` (mục Đơn: cờ `unmapped_sku` mới; mục mới "Ghép SKU áp lên đơn (#237)"; "Cho module khác" thêm `applySkuMapping` (channel gọi))
- Modify: `src/modules/order/fulfillment/CLAUDE.md` (mục mới "Ghép SKU muộn (#237)": `remapPackageLines`, luật bảng 1, P2, P3, P5; sửa mục `shipLateMappedLines` và dòng 143; "Giới hạn đã biết": phiếu kiểm kê thường trừ lần nữa (D11), kiện `returned` không cộng bù, kiện đã đóng chưa giữ đi lượt phân hàng; "Chưa làm": đổi ghép đã dùng là #237 PR 2)
- Modify: `src/modules/channel/channel/CLAUDE.md:158-163` (Ghép SKU tay: áp lên đơn đã về, `variantsBySellerSku` trả `LineSku`, `decide` khoá gian hàng)

- [ ] **Step 1: Sửa ba file CLAUDE.md** theo danh sách trên, giữ văn phong hiện có (câu ngắn, trỏ spec 237 và mã quyết định).
- [ ] **Step 2: Kiểm** — `npm run check` → PASS; `npm run db:ci-check -- --base origin/main` → PASS (migration đứng sau main, schema khớp).
- [ ] **Step 3: Cập nhật graph** — `graphify update .`.
- [ ] **Step 4: Commit** — `#237: CLAUDE.md cho ghép SKU áp lên đơn đã về`.

### Task 10: Documents và issue (repo `D:\DA-TMDT\Documents`, PR riêng)

**Files:**
- Modify: `21-hop-dong-api-fe-be.md` §18.3 (hai dòng `listings/match`, `mapping/:action`), §19.1 (`OrderLine.untracked`, định nghĩa cờ `unmapped_sku`)
- Modify: `19-mo-hinh-du-lieu.md` (cột `stock_untracked` hai bảng, CHECK `order_lines_untracked`, `package_lines_untracked`)
- Modify: `kiem-thu/ca-theo-so-do.md`, `27-user-story.md` US-DH-05 (mã ca cho dòng 1, 2; dòng 3 chờ PR 2)

- [ ] **Step 1:** Trong repo Documents, `git fetch origin && git switch -c docs/237-ghep-sku-dong-don origin/main` (không đụng nhánh `docs/204-...` đang mở).
- [ ] **Step 2:** Sửa §18.3: bỏ "tới lúc đó đơn đã nhận giữ biến thể cũ, chỉ đơn kéo về sau theo ghép mới"; ghi "ghép có hiệu lực (200 hoặc duyệt) áp lên dòng chưa ghép của đơn đã nhận: kiện chưa rời kho thử giữ hàng, kiện đã rời kho trừ tồn bù đúng một lần (trừ kiện rời kho trước mốc kéo đơn, kiện đã hoàn), kiện đã giao chưa báo thì báo; đổi ghép đã dùng: commerio-backend#237 PR 2". §19.1: `untracked: boolean`.
- [ ] **Step 3:** Cấp mã ca cho US-DH-05 dòng 1, 2 theo quy ước của `ca-theo-so-do.md`; thêm mã vào tên `it` tương ứng ở Task 7, Task 8 (commit nhỏ trong nhánh backend).
- [ ] **Step 4:** Commit, push, mở PR Documents (mô tả trỏ commerio-backend#237). Sửa issue #237: gạch "Route ghép từ dòng đơn" theo D1 (dùng `listings/match`), bỏ tham chiếu `finance/service/boundary.ts:41`. Hai việc này ra ngoài repo: hỏi Khang trước khi push và sửa issue.

---

## Ngoài plan này

- Bảng 2, 3 của spec, mục 5.6 (đổi ghép đã dùng, áp lại khi mở kiện): PR 2.
- Kiện cũ sau khi tách (#205) chỉ còn dòng `stock_untracked` ở `backordered`: chưa tự `hold` (tách hiếm khi để lại toàn dòng quà tặng); ghi vào "Giới hạn đã biết" của fulfillment ở Task 9.
- FE (FE#129, FE#130).
