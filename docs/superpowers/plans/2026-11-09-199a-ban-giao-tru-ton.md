# Bàn giao trừ tồn theo kiện (#199 phần a): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kiện rời kho thì tồn thực giảm đúng một lần (kho quét, sàn báo, nhảy cóc, bàn giao bắt buộc), CEO huỷ được bàn giao nhầm, và kho có route đọc kiện theo `21` §19.2.

**Architecture:** Luật thuần ở `fulfillment/domain/handover.ts` quyết tác động tồn, cách trừ theo mốc, dòng nào trừ. Một chỗ thi hành ở `fulfillment/service/handover-stock.ts` gọi cổng tồn (`reserve`, `ship`, `reverseShipment`, `stockOf`) trong giao dịch của bên gọi; mọi đường vào (route kho quét, đồng bộ sàn, hàm bù cho #198, dòng ghép SKU muộn cho #237) đi qua đó. `PackageSummary` dựng ở một nơi trong fulfillment, sales dùng lại.

**Tech Stack:** Node 24 (chạy thẳng `.ts`), Express 5, Zod 4, Drizzle ORM 0.45 + PostgreSQL 18, Vitest + testcontainers + Supertest.

**Spec:** `docs/superpowers/specs/2026-11-09-199a-ban-giao-tru-ton-design.md` (gọi tắt **S**).

## Global Constraints

- Import tương đối có đuôi `.ts`. Không `enum`, `namespace`, parameter property.
- Định danh tiếng Anh; comment, message, tên `describe`/`it` tiếng Việt; tên ca có mã `ca-theo-so-do.md` khi có (vd `D2-05`).
- Đầu vào HTTP qua `validate(...)`, `ctx.authorize(...)` đặt trước `validate`; lỗi nghiệp vụ ném `AppError(status, code, message)`.
- `domain/` không import lớp khác (luật `domain-thuan`). Module con cùng module lớn chỉ import `index.ts` của nhau; fulfillment không import sales (sales đã import fulfillment): dữ liệu đơn đi qua `ctx` (`withContext` ở `order/index.ts`), lọc theo đơn dùng SQL thô `"order".orders` như `sales/repository/orders.ts:159`.
- Cổng tồn gọi trong giao dịch của bên gọi; kiện đã khoá `FOR UPDATE` trước khi gọi (S 5.3).
- Migration: sửa `schema.ts` rồi `npm run db:generate -- --name <mo-ta>`; nhánh khác merge migration trước thì xoá migration của mình và sinh lại (`db/CLAUDE.md`), nhớ thêm lại câu `UPDATE` điền dữ liệu (Task 3).
- Test chỉ trong `test/`, import `#src/...ts`. Integration cần Docker. Body route parse bằng đúng schema Zod khai OpenAPI.
- Dùng `npm`. `npm run check` trước PR, `graphify update .` sau khi sửa code. File trong `docs/superpowers/` phải `git add -f`.
- Commit `#199: <việc>`, kết thúc `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Thân PR kết thúc `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Nhánh và PR

| PR | Repo, nhánh | Task |
|---|---|---|
| Documents | `Documents`, `docs/199a-ban-giao` từ `main` | 1 |
| Danh mục sự kiện | `commerio-backend`, `feature/199-su-kien-kien` từ `main` | 2 |
| Backend 199a | `commerio-backend`, `feature/199a-ban-giao` (đã có commit spec, plan); rebase lên nhánh của Task 2 sau khi Task 2 xong, base PR là nhánh đó tới khi nó merge | 3–12 |

## Chỗ plan chốt thêm so với spec

1. **Dữ liệu đơn cho route đọc (S D8, 5.5).** Fulfillment không join được bảng sales bằng schema Drizzle (luật `module-con-chi-qua-index`). Vì vậy:
   - lọc theo đơn (tab `reserved` chỉ đơn `processing`, tìm theo mã đơn, lọc `source`) dùng SQL thô `"order".orders`;
   - thông tin hiển thị của đơn lấy qua `ctx.orderRefsOf` do sales cung cấp, `order/index.ts` tiêm bằng `withContext` (cùng khuôn `incomingOf` ở `product/index.ts`).
2. **`setStockPort` nhận `Partial<StockPort>`** gộp với bản thật, để test cũ chỉ giả `reserve`/`release` vẫn chạy khi cổng có thêm `ship`, `reverseShipment`, `stockOf`.
3. **`pickupUnconfirmed`** là hàm thuần trong `domain/handover.ts` (S 5.5), dùng ở hàm dựng `PackageSummary`.
4. **Thử lại câu `UPDATE` điền dữ liệu của migration** (AC 14): test đọc câu `UPDATE` trong file migration và chạy nó trong một giao dịch rollback (DB test trống nên không có dòng cũ).

## Review Focus

1. **Kiện nhiều dòng cùng SKU** (Lazada mỗi món một dòng số lượng 1): tồn giảm đủ tổng số, mỗi dòng có `unit_cost` và `stock_deducted`. Test ở Task 5.
2. **Sàn nhảy cóc một kiện có dòng chưa ghép SKU:** chỉ trừ dòng đã ghép, dòng chưa ghép giữ `stock_deducted = false`, không lỗi. Test ở Task 7.
3. **Body `hand-over` có cùng một kiện hai lần:** 422, không bàn giao kiện nào. Test ở Task 10.
4. **Huỷ bàn giao kiện của đơn đang huỷ (`cancelling`):** kiện về `awaiting_pickup` và bật cờ Cần xử lý "Đơn đang huỷ: dỡ kiện về kệ" (S D11). Test ở Task 11.
5. **Tìm kiếm có ký tự `%`, `_`:** khớp đúng chữ, không khớp mọi kiện. Test ở Task 9.

---

## PR 1: Documents

### Task 1: Sửa `19`, `21` theo S §8

**Files:** `D:\DA-TMDT\Documents\19-mo-hinh-du-lieu.md` (dòng bảng `packages`), `D:\DA-TMDT\Documents\21-hop-dong-api-fe-be.md` (§11.2, §19.2)

- [ ] **Step 1:** Tạo nhánh `docs/199a-ban-giao` từ `origin/main` của repo Documents.
- [ ] **Step 2:** `19` bảng `packages`:
  - thêm `pickup_confirmed_at` (sàn xác nhận lấy; cờ `pickup_unconfirmed` suy từ cột này);
  - `handover_source` thêm `before_cutoff` (rời kho trước mốc, chỉ lưu);
  - thêm CHECK: kiện rời kho phải có `handover_source`.
- [ ] **Step 3:** `21` §11.2: cột bên phát của các sự kiện kiện ghi commerio-backend#199 (đang ghi #106); `package_lost` ghi #238.
- [ ] **Step 4:** `21` §19.2:
  - `hand-over`: `failed[].code` gồm `not_found, version_conflict, already_handed_over, invalid_transition, internal_error`;
  - `GET /fulfillment/packages`: sắp `ship_by` tăng dần, null cuối; `counts` theo `search`, `source`, `shopId`, không theo `tab`;
  - `pickup_unconfirmed` suy từ `pickup_confirmed_at`.
- [ ] **Step 5:** Commit, push, mở PR (người duyệt: Thành, Khoa), kèm link spec S.

```bash
git -C /d/DA-TMDT/Documents commit -am "19, 21 §11.2, §19.2: bàn giao trừ tồn theo kiện (commerio-backend#199 phần a)"
```

---

## PR 2: Danh mục sự kiện

### Task 2: Thêm sự kiện kiện của `21` §11.2 vào danh mục

**Files:**
- Modify: `src/modules/core/platform/domain/events.ts` (sau `fulfillment.package_status_changed`)
- Test: `test/unit/modules/core/platform/domain/events.test.ts`

**Interfaces:**
- Produces (khoá của `EVENT_SCHEMAS`, dùng `id`, `money`, `timestamp` có sẵn):
  - `'fulfillment.package_shipped'`: `{ packageId, orderId, lines: { variantId, quantity: int > 0, unitCost: money }[] }`
  - `'fulfillment.allocation_done'`: `{ variantIds: id[] }`
  - `'fulfillment.package_delivered'`: `{ packageId, orderId, shopId, deliveredAt: timestamp, lines: { variantId, quantity, unitPrice: money, unitCost: money.nullable() }[], platformSubsidy: money, shippingIncome: money, shippingCost: money }`
  - `'fulfillment.package_delivery_failed'`: `{ packageId, orderId, reason: string }`
  - `'fulfillment.package_returned'`: `{ packageId, orderId, shopId, returnedAt: timestamp }`
  - `'fulfillment.package_lost'`: `{ packageId, orderId, claimCode: string.nullable() }`

- [ ] **Step 1: Test đỏ**: một `it.each` parse payload mẫu đúng của sáu loại qua `EVENT_SCHEMAS[type]`, và một ca `package_shipped` có `unitCost: 100000` (số, không phải chuỗi) bị từ chối.
- [ ] **Step 2:** Chạy `npx vitest run test/unit/modules/core/platform/domain/events.test.ts`. Expected: FAIL, khoá chưa có.
- [ ] **Step 3:** Thêm sáu schema theo Interfaces, comment trỏ `21` §11.2 và issue phát (#199, #238).
- [ ] **Step 4:** Chạy lại test và `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit; push; mở PR vào `main`. Thân PR:
  - báo Bình: `PackageDelivered.unitCost` ở `finance/service/ledger.ts` đang là `string`, `21` cho phép `null`;
  - báo Thành: `allocation_done` sẵn sàng cho #223.

---

## PR 3: Backend 199a (`feature/199a-ban-giao`)

Trước Task 3: `git rebase feature/199-su-kien-kien` (nhánh của Task 2).

### Task 3: Migration và cột mới của `packages`

**Files:**
- Modify: `src/modules/order/fulfillment/repository/schema.ts`
- Create: `db/migrations/00NN_ban-giao-tru-ton.sql` (sinh), sửa tay thêm `UPDATE`
- Test: `test/integration/order/fulfillment/handover-migration.test.ts`

**Interfaces:**
- Produces:
  - `export const handoverSource = fulfillmentSchema.enum('handover_source', ['scan', 'marketplace', 'forced', 'before_cutoff'])`;
  - cột `packages.handoverSource` (`handover_source`), `handoverRevertedBy` (`uuid`), `pickupConfirmedAt` (`timestamptz`), đều null được;
  - CHECK `packages_handover_source` đúng câu ở S 5.1.

- [ ] **Step 1: Test đỏ (AC 14)**
  - `it('AC14: kiện rời kho mà thiếu handover_source bị CHECK chặn')`: chèn kiện `in_transit` có `handed_over_at`, không `handover_source` bằng `testPool()` → lỗi `23514`, `constraint = 'packages_handover_source'`.
  - `it('AC14: câu UPDATE của migration điền before_cutoff cho kiện đã rời kho')`, trong một giao dịch `begin … rollback` trên `testPool()`:
    1. `DROP CONSTRAINT packages_handover_source`;
    2. chèn một kiện `delivered` và một kiện `reserved`, cả hai thiếu nguồn;
    3. chạy câu `UPDATE` đọc từ file migration (dòng bắt đầu bằng `UPDATE "order"."packages"`);
    4. kiểm kiện `delivered` thành `before_cutoff`, kiện `reserved` vẫn null.
- [ ] **Step 2:** Chạy `npx vitest run test/integration/order/fulfillment/handover-migration.test.ts`. Expected: FAIL (cột, constraint chưa có).
- [ ] **Step 3:** Sửa `schema.ts` theo Interfaces.
  - Chạy `npm run db:generate -- --name ban-giao-tru-ton`.
  - Trong file sinh ra, chèn câu `UPDATE` của S 5.1 ngay trước `ADD CONSTRAINT "packages_handover_source"`, kèm comment một dòng giải thích.
- [ ] **Step 4:** Chạy lại test; chạy `npx vitest run test/unit/db test/integration/order`. Expected: PASS (journal, ràng buộc cũ).
- [ ] **Step 5:** Commit `#199: cột handover_source, pickup_confirmed_at, handover_reverted_by cho kiện; điền before_cutoff cho kiện đã rời kho`.

### Task 4: Luật thuần của bàn giao

**Files:**
- Create: `src/modules/order/fulfillment/domain/handover.ts`
- Test: `test/unit/modules/order/fulfillment/domain/handover.test.ts`

**Interfaces:**
- Consumes: `PackageStatus`, `isHandedOver` (`domain/package.ts`).
- Produces:
  - `type StockEffect = 'ship' | 'reverse' | 'none'`; `stockEffectOf(from: PackageStatus | null, to: PackageStatus): StockEffect`.
  - `type HandoverStockMode = 'deduct' | 'store_only' | 'defer'`; `handoverStockMode(p: { firstSeen: boolean; placedAt: Date; orderCutoffAt: Date | null; awaitingStocktake: boolean }): HandoverStockMode`.
  - `interface PlanLine { id: string; variantId: string | null; quantity: number; reservedQty: number; stockDeducted: boolean }`; `shipPlan(lines: readonly PlanLine[]): { held: PlanLine[]; unheld: PlanLine[] }`.
  - `type HandoverSource = 'scan' | 'marketplace' | 'forced' | 'before_cutoff'`.
  - `pickupUnconfirmed(p: { status: PackageStatus; handoverSource: HandoverSource | null; pickupConfirmedAt: Date | null; handedOverAt: Date | null }, now: number): boolean`: `true` khi kiện ở nhóm rời kho, `scan`, chưa xác nhận, `handedOverAt <= now − 24h`.

- [ ] **Step 1: Test đỏ**
  - `stockEffectOf`, dùng `it.each`:
    - `('awaiting_pickup','in_transit') → 'ship'`, `('packed','self_delivering') → 'ship'`;
    - `('reserved','delivered') → 'ship'`, `('backordered','in_transit') → 'ship'`, `(null,'in_transit') → 'ship'`;
    - `('in_transit','delivered') → 'none'`, `('in_transit','awaiting_pickup') → 'reverse'`;
    - `('reserved','packed') → 'none'`, `(null,'backordered') → 'none'`, `('returning','returned') → 'none'`.
  - `handoverStockMode`:
    - `awaitingStocktake: true` → `'defer'`, kể cả khi `firstSeen` và trước mốc;
    - `firstSeen`, `placedAt` 1 giây trước mốc → `'store_only'`;
    - `firstSeen`, đúng mốc → `'deduct'`;
    - không `firstSeen`, trước mốc → `'deduct'`;
    - mốc null → `'deduct'`.
  - `shipPlan`: dòng `{variantId:null}` và dòng `stockDeducted:true` bị bỏ; dòng `reservedQty = quantity` vào `held`, `reservedQty = 0` vào `unheld`.
  - `pickupUnconfirmed` (`now` cố định):
    - `scan`, chưa xác nhận, 24h trước → `true`;
    - 23h59m → `false`;
    - đã xác nhận → `false`;
    - `marketplace` → `false`;
    - kiện đã về `awaiting_pickup` → `false`.
- [ ] **Step 2:** Chạy `npx vitest run test/unit/modules/order/fulfillment/domain/handover.test.ts`. Expected: FAIL, module chưa có.
- [ ] **Step 3:** Viết `domain/handover.ts` theo Interfaces và S 5.2.
- [ ] **Step 4:** Chạy lại test và `npm run depcruise`. Expected: PASS, không vi phạm.
- [ ] **Step 5:** Commit `#199: luật thuần tác động tồn, mốc, dòng trừ của bàn giao`.

### Task 5: Lõi thi hành `settleHandover`, `revertHandover`

**Files:**
- Modify: `src/modules/order/fulfillment/service/stock-port.ts`
- Modify: `src/modules/order/fulfillment/repository/packages.ts`
- Create: `src/modules/order/fulfillment/service/handover-stock.ts`
- Create: `test/integration/order/fulfillment/helpers.ts`
- Test: `test/integration/order/fulfillment/handover-stock.test.ts`

**Interfaces:**
- Consumes: Task 4; `reserve`, `ship`, `reverseShipment`, `stockOf`, types `ShipLine`, `ShipOptions`, `StockLine`, `DocumentRef`, `StockSnapshot` từ `product/index.ts`; `publishEvent` của core.
- Produces:
  - `StockPort` thêm `ship(packageId, lines: readonly ShipLine[], opts: ShipOptions): Promise<DocumentRef>`, `reverseShipment(packageId, lines: readonly StockLine[], opts: { actorId: string; reason: string }): Promise<DocumentRef>`, `stockOf(variantIds: readonly string[]): Promise<Map<string, StockSnapshot>>`. `setStockPort(next: Partial<StockPort> = {})` gộp với bản thật.
  - Repository:
    - `interface HandoverPackage { id: string; code: string; orderId: string; shopId: string | null; status: PackageStatus; version: number; handoverSource: HandoverSource | null; pickupConfirmedAt: Date | null; handedOverAt: Date | null; needsAttention: boolean; lines: PlanLine[] }`
    - `lockPackage(id: string): Promise<HandoverPackage | undefined>` (`FOR UPDATE`, gồm dòng)
    - `markLinesReserved(lineIds: readonly string[]): Promise<void>`
    - `markLinesShipped(rows: readonly { id: string; unitCost: string }[]): Promise<void>` (đặt `stock_deducted = true`, `reserved_qty = 0`)
    - `markLinesReverted(lineIds: readonly string[]): Promise<void>` (`reserved_qty = quantity`, `stock_deducted = false`, `unit_cost = null`)
    - `updatePackage` nhận thêm `handoverSource`, `handoverRevertedBy`, `pickupConfirmedAt`, `handedOverBy`, cho phép đặt `handedOverAt`, `handedOverBy`, `handoverSource`, `pickupConfirmedAt` về `null`.
  - Service:
    - `settleHandover(pkg: HandoverPackage, opts: { actorId: string | null; mode: HandoverStockMode }): Promise<{ documents: DocumentRef[] }>`, đúng 6 bước S 5.3; `unitCost` của sự kiện là `avgCost` dạng chuỗi.
    - `revertHandover(pkg: HandoverPackage, actorId: string, reason: string): Promise<DocumentRef>`.
  - Helper test `seedPackage(companyId: string, p: { status: PackageStatus; lines: { variantId: string | null; quantity: number; reserved?: boolean }[]; handoverSource?: HandoverSource | null; handedOverAt?: Date | null; shopId?: string; orderStatus?: 'unpaid' | 'processing'; cancelling?: boolean; shipBy?: Date | null }): Promise<{ packageId: string; orderId: string; lineIds: string[] }>`.
    - Lập đơn bằng `createOrder(..., { source: 'marketplace' })`, rồi chèn kiện, dòng bằng `testPool()`.
    - Dòng `reserved` thì gọi `reserve` thật của inventory trong `withCompany`, để `stock_levels.reserved` khớp.

- [ ] **Step 1: Test đỏ** (`withCompany` gọi thẳng service; tồn đặt bằng `receive`, `setBuckets` của `test/integration/product/inventory/helpers.ts`; đọc tồn bằng `stockOf`)
  - `it('kiện đã giữ hàng: một phiếu XK, tồn thực và đang giữ giảm đúng số món, dòng có giá vốn, có package_shipped')`: tồn 10 giá 100000, kiện 2 cái đã giữ, `handoverSource: 'scan'`, `in_transit`. Sau `settleHandover({ actorId, mode: 'deduct' })`:
    - `documents.length = 1`; tồn `onHand 8`, `reserved 0`;
    - dòng có `unit_cost '100000.00'`, `stock_deducted true`, `reserved_qty 0`;
    - outbox có `fulfillment.package_shipped` với `lines[0].unitCost = '100000.00'`.
  - `it('Review Focus 1: ba dòng cùng SKU, mỗi dòng 1 cái → tồn giảm 3, ba dòng đều đã trừ')`.
  - `it('gọi lần hai không trừ thêm, documents rỗng')`.
  - `it('kiện chưa giữ, đủ khả dụng → giữ rồi ship thường, không Tồn âm')`: `invariant_broken = false`, `handover_source` vẫn `marketplace`.
  - `it('D2-31: kiện chưa giữ, thiếu khả dụng → ship forced')`:
    - tồn 1, kiện cần 3;
    - `onHand -2`, `invariant_broken true`;
    - `handover_source 'forced'`, `needs_attention true`, `flag_note` chứa `Bàn giao bắt buộc`.
  - `it('store_only → before_cutoff, không phiếu, unit_cost null')`; `it('defer → không đổi gì')`.
  - `it('revertHandover: phiếu DX, tồn cộng lại, dòng giữ hàng lại, kiện xoá mốc bàn giao, ghi người huỷ')`.
- [ ] **Step 2:** Chạy `npx vitest run test/integration/order/fulfillment/handover-stock.test.ts`. Expected: FAIL, module chưa có.
- [ ] **Step 3:** Viết theo Interfaces.
  - Bước 3 của S 5.3: `reserve` trả `false` thì `ship` forced chỉ các dòng `unheld`; `held` (nếu có) `ship` thường riêng.
  - Log `warn` `{ packageId, variantIds }` khi forced.
- [ ] **Step 4:** Chạy lại test, `npx vitest run test/integration/order` (test cũ dùng `setStockPort({ reserve, release })` phải xanh), `npm run typecheck && npm run depcruise`. Expected: PASS.
- [ ] **Step 5:** Commit `#199: lõi settleHandover, revertHandover gọi cổng tồn trong giao dịch của bên gọi`.

### Task 6: Hàm bù cho #198 và dòng ghép SKU muộn cho #237

**Files:**
- Modify: `src/modules/order/fulfillment/service/handover-stock.ts`, `repository/packages.ts`, `src/modules/order/fulfillment/index.ts`
- Test: `test/integration/order/fulfillment/handover-stock.test.ts` (describe mới)

**Interfaces:**
- Consumes: Task 5.
- Produces (export ở `fulfillment/index.ts`):
  - `settleDeferredHandovers(shopId: string, countedAt: Date): Promise<{ deducted: number; storedOnly: number }>`.
  - `shipLateMappedLines(packageId: string): Promise<DocumentRef[]>`.
  - Repository `lockDeferredPackages(shopId: string): Promise<HandoverPackage[]>`. Lấy kiện của gian hàng ở nhóm rời kho, `handover_source <> 'before_cutoff'`, còn dòng có `variant_id` mà `stock_deducted = false`; `FOR UPDATE`, sắp theo `code`.

- [ ] **Step 1: Test đỏ**
  - `it('AC10: chờ kiểm kê, hai kiện rời kho trước và sau countedAt')`:
    - seed hai kiện `marketplace` cùng `shopId`, `handedOverAt` = `countedAt − 1h` và `countedAt + 1h`;
    - gọi hàm bù → `{ deducted: 1, storedOnly: 1 }`, kiện trước thành `before_cutoff`;
    - gọi lần hai → `{ deducted: 0, storedOnly: 0 }`.
  - `it('AC11: dòng ghép SKU muộn trên kiện đã rời kho')`:
    - kiện `in_transit` có một dòng đã trừ và một dòng `variant_id` null;
    - test gán `variant_id` cho dòng đó bằng `testPool()`;
    - gọi `shipLateMappedLines` → thêm một phiếu `XK` chỉ cho dòng đó; dòng cũ không đổi.
  - `it('AC11: kiện before_cutoff hoặc chưa rời kho → không làm gì')`.
- [ ] **Step 2:** Chạy file test. Expected: FAIL, hàm chưa có.
- [ ] **Step 3:** Viết theo Interfaces và S 5.3.
- [ ] **Step 4:** Chạy lại file test và `npm run depcruise`. Expected: PASS.
- [ ] **Step 5:** Commit `#199: settleDeferredHandovers cho #198, shipLateMappedLines cho #237`.

### Task 7: Đồng bộ sàn đi qua lõi

**Files:**
- Modify: `src/modules/order/fulfillment/service/platform-packages.ts`, `repository/packages.ts` (`lockOrderPackages` trả dòng có `id`, `stockDeducted` và kiện có các trường của `HandoverPackage`)
- Modify: `src/modules/order/sales/service/ingest.ts` (`PlatformOrder.orderCutoffAt?: Date | null`, truyền xuống)
- Modify: `src/modules/channel/channel/repository/shops.ts` (`lockShopForOrders` trả thêm `orderCutoffAt`), `src/modules/channel/channel/service/order-pull.ts` (truyền `orderCutoffAt`)
- Test: `test/integration/order/fulfillment/platform-handover.test.ts`

**Interfaces:**
- Consumes: Task 4, Task 5.
- Produces: `PlatformPackageOrder` thêm `placedAt: Date; orderCutoffAt: Date | null`; hành vi theo S 5.4 "Đồng bộ sàn".

- [ ] **Step 1: Test đỏ** (gọi `ingestMarketplaceOrder` trong `withCompany` như `ingest.test.ts`, cổng tồn thật; fixture đơn chép từ `ingest.test.ts`)
  - `it('AC7 US-DH-10.2: kiện reserved, sàn báo in_transit → trừ đúng một lần, marketplace, có pickup_confirmed_at')`: kéo lần hai cùng trạng thái thì không có phiếu `XK` mới.
  - `it('AC7: kiện reserved, sàn báo delivered → trừ đúng một lần')`.
  - `it('AC8 D2-31: kiện backordered, sàn báo in_transit')`:
    - đủ hàng (đặt tồn sau khi kiện vào `backordered`) → `ship` thường;
    - thiếu → `forced`, Tồn âm.
  - `it('AC9: kiện lần đầu thấy đã in_transit')`:
    - `placedAt` trước `orderCutoffAt` → `before_cutoff`, không phiếu;
    - `placedAt` sau mốc → trừ.
  - `it('AC3: kiện kho đã quét, sàn báo in_transit rồi delivered → chỉ ghi pickup_confirmed_at, không phiếu mới')`: giả lập kho quét bằng API của Task 5, vì route có ở Task 10.
    1. Ingest đơn với trạng thái món `pending`; kiện giữ hàng thật.
    2. Trong `withCompany`: `lockPackage`, `updatePackage({ status: 'in_transit', handoverSource: 'scan', handedOverAt })`, `settleHandover({ actorId, mode: 'deduct' })`.
    3. Ingest lại cùng `externalOrderId` với trạng thái món `in_transit`, rồi `delivered`.
  - `it('AC10: gian hàng chờ kiểm kê (holdStock false), sàn báo in_transit → chưa trừ, handover_source marketplace')`.
  - `it('Review Focus 2: sàn nhảy cóc kiện có một dòng chưa ghép SKU → chỉ trừ dòng đã ghép')`: dòng chưa ghép `stock_deducted false`.
- [ ] **Step 2:** Chạy file test. Expected: FAIL, kiện đổi trạng thái mà không có phiếu `XK`.
- [ ] **Step 3:** Sửa theo S 5.4.
  - `changeStatus` gọi lõi khi `stockEffectOf = 'ship'`.
  - `createPackage` gọi lõi sau khi chèn dòng.
  - `applyStatus` ghi `pickup_confirmed_at` cho kiện `scan`.
  - Channel truyền `orderCutoffAt`.
- [ ] **Step 4:** Chạy file test, rồi `npx vitest run test/integration/order test/integration/channel`.
  - Ca cũ có kiện vào nhóm rời kho mà `reserve` giả: thêm `ship`, `stockOf` giả vào `setStockPort` của file đó, không sửa kỳ vọng.
  - Expected: PASS.
- [ ] **Step 5:** Commit `#199: đồng bộ sàn trừ tồn qua lõi bàn giao, mốc kéo đơn từ channel`.

### Task 8: `PackageSummary` dựng ở fulfillment, cờ `pickup_unconfirmed`

**Files:**
- Create: `src/modules/order/fulfillment/api/schemas.ts`, `src/modules/order/fulfillment/service/views.ts`
- Modify: `src/modules/order/sales/api/schemas.ts` (bỏ `PackageSummary`, `ShopRef`, `StatusChange`, import từ fulfillment), `src/modules/order/sales/service/orders.ts` (`getOrder` dùng `toPackageSummary`), `src/modules/order/fulfillment/index.ts`
- Test: `test/integration/order/sales/orders-api.test.ts` (thêm ca)

**Interfaces:**
- Consumes: `pickupUnconfirmed` (Task 4).
- Produces (export ở `fulfillment/index.ts`):
  - Schema `ShopRef` (giữ `.meta({ id: 'OrderShopRef' })`), `PackageSummary` (giữ `.meta({ id: 'PackageSummary' })`, `flags` thêm `'pickup_unconfirmed'`), `StatusChange`.
  - `interface PackageOrderRef { id: string; code: string; status: 'unpaid' | 'processing' | 'completed' | 'cancelled'; source: 'marketplace' | 'inbox' | 'manual'; shopId: string | null; customerName: string | null; paymentMethod: 'prepaid' | 'cod' | null; cancelling: boolean; platformCancelled: boolean; lines: Map<string, { sku: string; productName: string; attributesLabel: string }> }` (khoá `lines` là `orderLineId`).
  - `toPackageSummary(p: PackageViewRow, order: PackageOrderRef, shop: z.infer<typeof ShopRef> | null, now: number): z.infer<typeof PackageSummary>`, cùng giá trị trường như `sales/service/orders.ts` đang dựng, thêm cờ `pickup_unconfirmed`.

- [ ] **Step 1: Test đỏ (AC 13)**
  - `it('AC13: GET /orders/:id có cờ pickup_unconfirmed khi kho quét quá 24 giờ mà sàn chưa xác nhận; tắt khi đã xác nhận')`:
    - seed kiện `scan`, `in_transit`, `handedOverAt` = 25 giờ trước;
    - `Order.parse(body)`;
    - đặt `pickup_confirmed_at` thì cờ mất.
- [ ] **Step 2:** Chạy `npx vitest run test/integration/order/sales/orders-api.test.ts`. Expected: FAIL (cờ không có trong enum hoặc không bật).
- [ ] **Step 3:** Chuyển schema, viết `toPackageSummary`, sales gọi lại.
- [ ] **Step 4:** Chạy `npx vitest run test/integration/order && npm run typecheck && npm run depcruise` (typecheck phủ cả `test/blackbox`). Expected: PASS; mọi ca cũ của `GET /orders` xanh.
- [ ] **Step 5:** Commit `#199: PackageSummary dựng ở fulfillment, sales dùng lại; cờ pickup_unconfirmed`.

### Task 9: Route đọc `GET /fulfillment/packages`, `GET /fulfillment/packages/:id`

**Files:**
- Create: `src/modules/order/sales/service/package-orders.ts`, `src/modules/order/fulfillment/repository/package-list.ts`, `src/modules/order/fulfillment/service/packages.ts`
- Modify: `src/modules/order/sales/index.ts`, `src/modules/order/index.ts`, `src/modules/order/fulfillment/{index.ts, api/routes.ts, api/openapi.ts, api/schemas.ts}`, `src/wiring.ts`
- Test: `test/integration/order/fulfillment/packages-read.test.ts`

**Interfaces:**
- Consumes: Task 8.
- Produces:
  - Sales `orderRefsOf(orderIds: readonly string[]): Promise<Map<string, PackageOrderRef>>`, export ở `sales/index.ts`. Nhãn biến thể, SKU, khách tính như `getOrder` hiện nay.
  - `interface FulfillmentContext extends ModuleContext { readonly shopsOf?: (ids: readonly string[]) => Promise<Map<string, { shopName: string; platform: string }>>; readonly orderRefsOf?: (ids: readonly string[]) => Promise<Map<string, PackageOrderRef>> }`.
    - Hàm `orderRefsLookupOf(ctx)`: thiếu thì `AppError(500, 'internal_error', 'Chưa nối dữ liệu đơn của sales (src/modules/order/index.ts)')`.
    - `order/index.ts`: `withContext(fulfillmentModule, (ctx) => ({ ...ctx, orderRefsOf }))`.
    - `src/wiring.ts`: `AppContext` thêm `Required<Pick<FulfillmentContext, 'shopsOf'>>`.
  - `type PackageTab = 'backordered' | 'reserved' | 'packed' | 'awaiting_pickup' | 'shipping' | 'delivery_failed' | 'returning' | 'needs_open'`.
  - `findPackagePage(f: PackageFilter & { tab: PackageTab; limit: number; offset: number }): Promise<{ rows: PackageViewRow[]; total: number }>`, `countPackageTabs(f: PackageFilter): Promise<Record<PackageTab, number>>`, với `PackageFilter = { search?: string; source?: 'marketplace' | 'inbox' | 'manual'; shopId?: string }`.
    - `search` khớp mã kiện, mã đơn (SQL thô `"order".orders`), mã vận đơn, `ilike`, thoát `\`, `%`, `_`.
    - Sắp `ship_by asc nulls last, code asc`.
  - Service `listPackages(ctx: FulfillmentContext, q)`, `getPackage(ctx: FulfillmentContext, id: string)`.
  - Schema `PackageListQuery` (`tab` mặc định `reserved`, `page` ≥ 1, `pageSize` 1..100 mặc định 20, `search` ≤ 100), `PackagePage` (`.meta({ id: 'PackagePage' })`), `Package = PackageSummary.extend({ statusHistory: z.array(StatusChange) }).meta({ id: 'Package' })`.

- [ ] **Step 1: Test đỏ (AC 12; Review Focus 5)** (kiện seed bằng `seedPackage`; tên ca tiếng Việt)
  - `it('AC12: mỗi tab đúng kiện')`:
    - `reserved` chỉ kiện của đơn `processing` (kiện `reserved` của đơn `unpaid` không có);
    - `shipping` gồm `in_transit` và `self_delivering`;
    - `needs_open` theo cờ;
    - `counts` đủ 8 tab, không đổi theo `tab`.
  - `it('AC12: tìm theo mã kiện, mã đơn, mã vận đơn; lọc shopId; sắp ship_by null cuối')`.
  - `it('Review Focus 5: search "%" hoặc "_" không khớp kiện không chứa ký tự đó')`.
  - `it('AC12: GET /:id trả Package có statusHistory; công ty khác và id không phải uuid → 404')`.
  - `it('Kho xem được; Sale → 403')`.
  - Mọi body 200: `PackagePage.parse` / `Package.parse`.
- [ ] **Step 2:** Chạy file test. Expected: FAIL, route 404.
- [ ] **Step 3:** Viết theo Interfaces, khai OpenAPI hai route.
- [ ] **Step 4:** Chạy file test, `npx vitest run test/integration/order`, `npm run typecheck && npm run depcruise`. Expected: PASS, không vi phạm (fulfillment không import sales).
- [ ] **Step 5:** Commit `#199: route danh sách kiện theo tab và chi tiết kiện; sales đưa dữ liệu đơn qua ctx`.

### Task 10: Route kho quét bàn giao

**Files:**
- Create: `src/modules/order/fulfillment/service/handover.ts`
- Modify: `src/modules/order/fulfillment/api/{routes.ts, schemas.ts, openapi.ts}`
- Test: `test/integration/order/fulfillment/hand-over.test.ts`

**Interfaces:**
- Consumes: Task 5 (`lockPackage`, `settleHandover`), `packageMachine`, `assertTransition`, `recordTransition`, `publishEvent`.
- Produces:
  - `interface Actor { companyId: string; accountId: string; permissions: readonly string[]; enabledModules: readonly string[] }`.
  - `handOverPackages(actor: Actor, items: readonly { id: string; version: number }[]): Promise<{ handedOver: { id: string; code: string; issue: { id: string; number: string } }[]; failed: { packageId: string; code: string; detail: string }[] }>`. Mỗi kiện một `withCompany`. `AppError` vào `failed` (`code`, `detail = message`). Lỗi khác thành `internal_error`, kèm `logger.error({ err, packageId })`.
  - Schema `HandOverBody` (`packages` 1..50, `id` uuid, `version` int ≥ 0; id trùng → lỗi `errors.packages`), `HandOverResult` (`.meta({ id: 'HandOverResult' })`).
  - Route `POST /packages/hand-over`, `ctx.authorize('fulfillment.order.process')`.

- [ ] **Step 1: Test đỏ (AC 1–4; Review Focus 3)**
  - `it('D2-05 AC1: quét 3 kiện awaiting_pickup')`:
    - mỗi kiện `in_transit`, có `issue.number` dạng `XK-`;
    - tồn mỗi SKU giảm đúng số món;
    - `handover_source 'scan'`, `handed_over_by` là người quét;
    - có `package_status_changed`, `package_shipped`.
  - `it('AC2: lô có kiện sai version, kiện reserved, kiện của công ty khác')`: ba kiện đó vào `failed` với `version_conflict`, `invalid_transition`, `not_found`; kiện còn lại bàn giao.
  - `it('AC3: quét lại kiện đã bàn giao → already_handed_over; tồn không đổi')`.
  - `it('AC3: hai người quét cùng kiện đua nhau → một thành công, một already_handed_over, tồn trừ một lần')`: dùng `raceBehindLock` khoá dòng kiện.
  - `it('AC3: kiện sàn đã báo in_transit rồi kho quét → already_handed_over')`.
  - `it('D2-05q: Admin, Sale → 403')`.
  - `it('Review Focus 3: cùng một kiện hai lần trong body → 422, không kiện nào bàn giao')`.
  - Mọi body 200: `HandOverResult.parse`.
- [ ] **Step 2:** Chạy file test. Expected: FAIL, route 404.
- [ ] **Step 3:** Viết theo Interfaces và S 5.4 "Kho quét".
  - Kiện đã ở nhóm rời kho thì ném `AppError(409, 'already_handed_over', 'Kiện đã bàn giao')` trước `assertTransition`.
- [ ] **Step 4:** Chạy file test và `npx vitest run test/integration/order`. Expected: PASS.
- [ ] **Step 5:** Commit `#199: route kho quét bàn giao theo lô, mỗi kiện một giao dịch`.

### Task 11: Route huỷ bàn giao nhầm

**Files:**
- Modify: `src/modules/order/fulfillment/service/handover.ts`, `api/{routes.ts, schemas.ts, openapi.ts}`
- Test: `test/integration/order/fulfillment/undo-handover.test.ts`

**Interfaces:**
- Consumes: Task 5 (`revertHandover`), Task 9 (`getPackage`), Task 10 (`Actor`).
- Produces:
  - `undoHandover(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number; reason: string }): Promise<z.infer<typeof Package>>`. Thứ tự kiểm theo S 5.4 "Huỷ bàn giao nhầm".
  - Đơn có `cancelling` hoặc `platformCancelled` (đọc qua `orderRefsOf`): bật `needs_attention`, `flag_note = 'Đơn đang huỷ: dỡ kiện về kệ'`.
  - Schema `UndoHandoverBody` `{ version, reason: string.trim().max(500) }`.
  - Route `POST /packages/:id/undo-handover`, `ctx.authorize('fulfillment.handover.revert')`.

- [ ] **Step 1: Test đỏ (AC 5, 6, 4; Review Focus 4)**
  - `it('D2-06 AC5: CEO huỷ có lý do')`:
    - kiện `awaiting_pickup`, có phiếu `DX`; tồn thực, đang giữ cộng lại;
    - dòng `reserved_qty = quantity`, `stock_deducted false`;
    - `handover_reverted_by` là CEO; `statusHistory` có lý do;
    - `Package.parse`.
  - `it('AC5: bàn giao lại sau khi huỷ → trừ lại đúng một lần, phiếu XK mới')`.
  - `it('D2-06r: thiếu lý do → 422 reason_required')`.
  - `it('D2-06g: sàn đã xác nhận lấy → 409 handover_confirmed_by_platform')`.
  - `it('D2-06g: kiện vào in_transit do sàn báo → 409 handover_confirmed_by_platform')`.
  - `it('D2-06q: Kho, Admin, Sale → 403')`.
  - `it('version cũ → 409 version_conflict kèm current')`.
  - `it('Review Focus 4: đơn đang huỷ → kiện về awaiting_pickup, cờ Cần xử lý "Đơn đang huỷ: dỡ kiện về kệ"')`.
- [ ] **Step 2:** Chạy file test. Expected: FAIL, route 404.
- [ ] **Step 3:** Viết theo Interfaces.
- [ ] **Step 4:** Chạy file test và `npx vitest run test/integration/order`. Expected: PASS.
- [ ] **Step 5:** Commit `#199: route huỷ bàn giao nhầm, CEO duyệt, đảo đủ cả lượt`.

### Task 12: Tài liệu module, kiểm toàn bộ, mở PR

**Files:**
- Create: `src/modules/order/fulfillment/CLAUDE.md`. Ghi:
  - kiện và máy trạng thái;
  - luật trừ tồn (một chỗ thi hành, `handover_source`, mốc, chờ kiểm kê);
  - route, quyền, sự kiện phát;
  - hàm cho module khác: `settleDeferredHandovers` (#198), `shipLateMappedLines` (#237), `PackageSummary`;
  - giới hạn đã biết (`40P01` khi một đơn nhiều kiện; `handed_over_at` là lúc đồng bộ thấy).
- Modify: `src/modules/order/sales/CLAUDE.md`:
  - bỏ câu "`reserve` chưa có thân… 501" đã cũ;
  - mục "Chưa làm" bỏ "trừ tồn khi kiện rời kho";
  - ghi `orderRefsOf` cho fulfillment.

- [ ] **Step 1:** Viết hai file trên.
- [ ] **Step 2:** Chạy `npm run check && graphify update .`. Expected: xanh, depcruise không vi phạm.
- [ ] **Step 3:** Commit, push, mở PR vào `main` (base là nhánh Task 2 nếu chưa merge). Thân PR ghi:
  - thứ tự merge: Documents → danh mục sự kiện → PR này;
  - migration (số, câu `UPDATE`, cách lùi);
  - sửa vài dòng ở channel của Thành;
  - AC 1–15 nằm ở test nào;
  - việc của #198 (gọi `settleDeferredHandovers`), #237 (gọi `shipLateMappedLines`).
- [ ] **Step 4:** Cập nhật checklist issue #199 (phần a) và #238 (bàn giao bắt buộc chuyển sang #199 phần a, S D2).
