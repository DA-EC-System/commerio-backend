# #237 PR 2: đổi ghép SKU đã có đơn dùng — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CEO đổi một ghép SKU đã có đơn dùng thì đơn còn mở đổi theo: kiện chưa đóng nhả A, giữ B trong cùng giao dịch; kiện đã đóng bật Cần mở `remap`, mở ra mới áp; kiện đã rời kho không đổi (US-DH-05 dòng 3).

**Architecture:** Luật thuần `planRemap` (`fulfillment/domain/remap.ts`) thêm bảng 2, 3 và dấu `remap_pending` theo dòng; luật mục đích Cần mở gom vào `domain/open-purpose.ts`. `service/remap.ts` thi hành, dùng chung cho đường ghép (sales `applySkuMapping`) và đường mở kiện (`openPackage`). Mở kiện đơn sàn đọc ghép hiện hành qua `ctx.skuMappingOf` (channel, `src/wiring.ts`) và ghi dòng đơn qua hàm sales tiêm bằng `withContext` (`order/index.ts`).

**Tech Stack:** Node 24, TypeScript 6, Express 5, Zod 4, Drizzle ORM, PostgreSQL 18, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-237-ghep-sku-dong-don-design.md` (phần PR 2: §2 "Hiện trạng cho PR 2", §5.4, §5.5 bảng 2 và 3, §5.6, D15 đến D27, §9 phần PR 2, §10 phần PR 2). Nhánh `feature/237-doi-ghep-da-dung`, worktree `.claude/worktrees/237-doi-ghep`, nền `main` fdd0af01.

## Global Constraints

- Import tương đối có đuôi `.ts`; không `enum`, `namespace`, parameter property (dùng mảng `as const`).
- Định danh tiếng Anh; comment, log, thông báo lỗi tiếng Việt.
- Không route mới, không mã lỗi mới (spec §5.10, mục "Dữ liệu và API của PR 2").
- Một migration `*_doi-ghep-da-dung`, sinh bằng `npm run db:generate -- --name doi-ghep-da-dung` sau khi `schema.ts` chốt (Task 1). Không câu nào trong lượt migration dùng giá trị `'remap'` (`db/CLAUDE.md` mục thêm giá trị enum).
- Thứ tự khoá: gian hàng → dòng đơn → khoá advisory phân hàng → kiện (id tăng) → dòng tồn (spec §5.8, D21).
- Lỗi nào trong lúc áp (cổng tồn, `40P01`, CHECK) cũng ném: cả giao dịch rollback. Không `try/catch` nuốt lỗi.
- Test chỉ ở `test/`, import `#src/...ts`, tên `it` tiếng Việt, mang mã ca `D2-G10` trở đi (bảng mã ở Task 10).
- Fulfillment không import sales; channel không bị fulfillment import (lớp module, `src/modules/CLAUDE.md`).

## Thiết kế theo 6 bước (đã chạy skill)

Đã nạp trước khi viết: `backend-design:think-before-coding`, `query-discipline`, `error-handling-as-design`, `observability-by-default`, `testing-with-discernment`, `migration-safety`, `idempotency-and-side-effects`, `supabase-postgres-best-practices` (đọc `lock-deadlock-prevention`, `lock-advisory`, `schema-constraints`), context7 Drizzle (`pgEnum`, `check()` trong đối số thứ ba của bảng). Kết quả áp vào plan:

1. **Loại:** hai đường đồng bộ trong giao dịch người dùng (route ghép của channel, route mở kiện). Tải: thao tác tay, vài lần mỗi giờ; một SKU có vài chục đơn mở.
2. **Dữ liệu, bất biến:** CHECK `package_lines_remap_pending` (chỉ dòng đã ghép mới chờ đổi ghép); CHECK `packages_open` có sẵn giữ cờ và mục đích đi cùng nhau. Dấu chỉ có nghĩa khi kiện còn đóng: view lọc, không thêm CHECK theo trạng thái kiện (kiện rời kho để dấu nằm im, D25).
3. **Lỗi:** không lỗi mới cho người gọi. Cổng tồn lỗi → ném, rollback (AC 25). Đua giữa mở kiện và đổi ghép → 409 `version_conflict` có sẵn (20e).
4. **Quyền:** không đổi: `channel.listing.match` + luật CEO duyệt của #220; `fulfillment.order.process` cho mở kiện.
5. **Lặp, đua:** bấm đổi ghép lại cùng đích không ghi gì (19e, `version` giữ). Khoá theo thứ tự cố định ở Global Constraints (`lock-deadlock-prevention`); khoá advisory theo giao dịch xin lại trong cùng phiên không tự chặn (`lock-advisory`). Không có lời gọi ra ngoài mới trong giao dịch (`repack` vẫn ngoài giao dịch như nay).
6. **Quan sát:** log `info` "kiện đã đóng chờ dỡ để đổi ghép" (`packageId`, `sellerSku`), "mở kiện áp lại ghép SKU" (`packageId`, `changed`), log áp ghép của sales thêm `needsUnload`. Không thêm số liệu: thao tác tay, lịch sử `remap` trên kiện là dấu vết đủ.
- **Truy vấn:** chọn dòng đơn theo `(shop, external_sku)` thêm nhánh `exists` sang `package_lines` theo `order_line_id` (đã có index); không N+1: một câu đọc `external_sku` cho mọi dòng của kiện mở, một lời gọi `skuMappingOf` cho mọi SKU người bán của kiện.
- **Migration:** thêm giá trị enum (không lùi được, ghi trong PR); cột `boolean not null default false` (mặc định hằng, không viết lại bảng); CHECK thêm thẳng, không `NOT VALID` (cột mới toàn `false` nên qua ngay, bảng nhỏ; spec §10). Down: không có `DROP VALUE`, cột và CHECK xoá được.

## Review Focus

1. Đổi A → "không quản tồn" trên kiện đã đóng, rồi kho mở kiện: dòng thành `stock_untracked`, phần giữ A nhả, kiện vẫn `reserved`. Test ở Task 8.
2. Mở kiện khi ghép hiện hành của SKU là `unmapped` (listing đã gỡ, hay chỉ còn ghép chờ duyệt): dòng giữ ghép đang có, không bị gỡ ghép, dấu vẫn xoá và kiện vẫn mở được. Test ở Task 8.
3. Kiện `reserved` có hai dòng A và B, đổi A → B: hai dòng cùng biến thể B, giữ đủ tổng; thiếu B thì cả kiện về `backordered`. Test ở Task 4.
4. Gian hàng chờ kiểm kê, dòng "không quản tồn" ở kiện `reserved` sang biến thể: không gọi cổng tồn, kiện `reclaim` về `backordered`, không xếp lượt. Test ở Task 4.
5. Mở một kiện thay đã đóng còn đang chờ thay (#238 D23): không áp ghép (D26), mở như cũ. Test ở Task 8.

---

## Bản đồ file

| File | Việc |
|---|---|
| `src/modules/order/fulfillment/domain/open-purpose.ts` (mới) | `OPEN_PURPOSES`, `OpenPurpose`, `raisePurpose`, `purposeAfterClear` |
| `src/modules/order/fulfillment/domain/remap.ts` | `planRemap` thêm bảng 2, 3, dấu, mục đích, D24, D26 |
| `src/modules/order/fulfillment/repository/schema.ts` | Enum lấy từ `OPEN_PURPOSES`; cột, CHECK `remap_pending` |
| `src/modules/order/fulfillment/repository/packages.ts` | Đọc `remapPending`, `openPurpose`; ghi dấu; `openFlagRules` thêm `remap`; view đọc dấu |
| `src/modules/order/fulfillment/repository/packing.ts` | `lineSellerSkusOf` (join `order_lines`) |
| `src/modules/order/fulfillment/service/remap.ts` | Thi hành kế hoạch mới; `applyRemapToPackage` dùng chung |
| `src/modules/order/fulfillment/service/open-remap.ts` (mới) | Tính dòng lệch ghép của kiện mở, áp sau khi mở |
| `src/modules/order/fulfillment/service/packing.ts` | `openPackage`: bước kiểm bỏ dòng lệch, bước ghi khoá theo D21 rồi áp |
| `src/modules/order/fulfillment/service/resplit.ts`, `service/platform-packages.ts` | Thứ tự mục đích (D17), gỡ cờ còn dấu (D18) |
| `src/modules/order/fulfillment/service/packages.ts` | `FulfillmentContext` thêm ba hàm |
| `src/modules/order/fulfillment/service/views.ts`, `api/schemas.ts`, `api/openapi.ts` | `openPurpose: remap`, `lines[].remapPending` |
| `src/modules/order/sales/repository/orders.ts`, `service/sku-mapping.ts`, `index.ts` | Chọn dòng đổi ghép (D27), khoá và ghi dòng đơn cho mở kiện |
| `src/modules/order/index.ts`, `src/wiring.ts`, `src/modules/channel/channel/...` | Tiêm `lockOrderLines`, `applyLineSkus`, `skuMappingOf` |
| `db/migrations/*_doi-ghep-da-dung.sql` | Sinh bằng drizzle |

---

### Task 1: Dữ liệu: giá trị `remap`, cột `remap_pending`, migration

**Files:**
- Create: `src/modules/order/fulfillment/domain/open-purpose.ts` (chỉ hằng và kiểu ở task này)
- Modify: `src/modules/order/fulfillment/repository/schema.ts:29-30`, `:160-190` (bảng `package_lines`)
- Modify: `src/modules/order/fulfillment/repository/packages.ts` (`planLinesOf`, `lockPackagesOfOrderLines`, `lockPackage`, `PackageLineRow`)
- Test: `test/integration/order/fulfillment/constraints.test.ts`

**Interfaces:**
- Produces: `OPEN_PURPOSES = ['cancel', 'edit', 'resplit', 'stocktake', 'remap'] as const`, `type OpenPurpose = (typeof OPEN_PURPOSES)[number]` (domain); `schema.ts` giữ export `OpenPurpose` bằng cách re-export kiểu domain. `PackageLineRow` thêm `remapPending: boolean`. `lockPackagesOfOrderLines` và `lockPackage` trả thêm `openPurpose: OpenPurpose | null` (kiểu `RemapLockedPackage = HandoverPackage & { openPurpose: OpenPurpose | null; lines: PackageLineRow[] }`, export từ `packages.ts`).

- [ ] **Step 1: Viết test đỏ** trong `constraints.test.ts`: `it('D2-G11 CHECK package_lines_remap_pending: dòng chưa ghép không mang dấu chờ đổi ghép')`: seed kiện `packed` có một dòng chưa ghép (`variantId: null`), `update "order".package_lines set remap_pending = true` bằng `testPool()` → lỗi `23514` tên `package_lines_remap_pending`. Cùng file: `it('D2-G11 kiện đóng nhận Cần mở với mục đích remap')`: `update "order".packages set needs_open = true, open_purpose = 'remap'` thành công.
- [ ] **Step 2: Chạy** `npx vitest run --project integration test/integration/order/fulfillment/constraints.test.ts` → FAIL (cột, giá trị enum chưa có).
- [ ] **Step 3: Sửa schema.** `openPurpose = fulfillmentSchema.enum('open_purpose', OPEN_PURPOSES)`. `package_lines` thêm `remapPending: boolean('remap_pending').notNull().default(false)` và `check('package_lines_remap_pending', sql\`not ${t.remapPending} or ${t.variantId} is not null or ${t.stockUntracked}\`)`. Thêm `remapPending` vào select của `planLinesOf`, `openPurpose` vào select của `lockPackagesOfOrderLines` và `lockPackage`.
- [ ] **Step 4: Sinh migration** `npm run db:generate -- --name doi-ghep-da-dung`. Mở file sinh ra, kiểm đúng ba câu: `ALTER TYPE "order"."open_purpose" ADD VALUE 'remap';`, `ALTER TABLE "order"."package_lines" ADD COLUMN "remap_pending" boolean DEFAULT false NOT NULL;`, `ALTER TABLE ... ADD CONSTRAINT "package_lines_remap_pending" CHECK (...)`. Không câu nào khác.
- [ ] **Step 5: Chạy lại test ở Step 2** → PASS. Chạy `npm run typecheck` → không lỗi.
- [ ] **Step 6: Commit** `#237: cột remap_pending, mục đích Cần mở remap (migration doi-ghep-da-dung)`.

### Task 2: Luật thuần mục đích Cần mở (D17, D18)

**Files:**
- Modify: `src/modules/order/fulfillment/domain/open-purpose.ts`
- Test: `test/unit/modules/order/fulfillment/domain/open-purpose.test.ts`

**Interfaces:**
- Produces:
  - `raisePurpose(pkg: { needsOpen: boolean; openPurpose: OpenPurpose | null }, wanted: 'cancel' | 'resplit' | 'remap'): { needsOpen: true; openPurpose: OpenPurpose } | null`: kiện chưa có cờ → `wanted`; mục đích đang có bị `wanted` thắng → `wanted`; còn lại `null` (giữ). Bảng thắng: `cancel` thắng `edit`, `stocktake`, `resplit`, `remap`; `resplit` thắng `edit`, `stocktake`, `remap`; `remap` thắng `stocktake`.
  - `purposeAfterClear(stillPending: boolean): { needsOpen: false; openPurpose: null } | { openPurpose: 'remap' }` (D18).

- [ ] **Step 1: Viết test đỏ**, mỗi `it` một dòng của bảng: chưa cờ + `remap` → `{ needsOpen: true, openPurpose: 'remap' }`; `stocktake` + `remap` → `remap`; `edit` + `remap` → `null`; `resplit` + `remap` → `null`; `cancel` + `resplit` → `null`; `remap` + `resplit` → `resplit`; `remap` + `cancel` → `cancel`; `edit` + `resplit` → `resplit` (giữ hành vi cũ); `purposeAfterClear(true)` → `{ openPurpose: 'remap' }`; `purposeAfterClear(false)` → gỡ.
- [ ] **Step 2: Chạy** `npx vitest run --project unit test/unit/modules/order/fulfillment/domain/open-purpose.test.ts` → FAIL.
- [ ] **Step 3: Viết hai hàm** theo Interfaces, bảng thắng là một `Record` hằng.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit** `#237: luật thuần thứ tự mục đích Cần mở (D17, D18)`.

### Task 3: `planRemap` bảng 2, bảng 3, dấu, D24, D26

**Files:**
- Modify: `src/modules/order/fulfillment/domain/remap.ts`
- Test: `test/unit/modules/order/fulfillment/domain/remap.test.ts`

**Interfaces:**
- Consumes: `raisePurpose` (Task 2), `OpenPurpose`.
- Produces:
  - `RemapPackage` thêm `needsOpen: boolean`, `openPurpose: OpenPurpose | null`; `lines[]` thêm `pendingDropQty: number`, `remapPending: boolean`.
  - `planRemap(pkg, changes, opts: { holdStock: boolean; orderCutoffAt: Date | null; awaitingLineIds?: ReadonlySet<string> })`.
  - `RemapPlan` thêm: `releases: { lineId: string; variantId: string; quantity: number }[]`, `marks: string[]`, `unmarks: string[]`, `purpose: { needsOpen: true; openPurpose: OpenPurpose } | null`, `allocateAlso: string[]` (biến thể, đã sắp, không trùng).

Luật theo từng dòng kiện có trong `changes` (`from = lineSkuOf(l)`, `to`), xét theo thứ tự:

| Điều kiện | Kết quả | Ghi |
|---|---|---|
| `awaitingLineIds` có dòng (D26) | `kept` | không |
| `from` = `to` | `applied` | dòng có `remapPending`, kiện `packed`/`awaiting_pickup` → `unmarks` |
| `from` chưa ghép | bảng 1 như PR 1 (cả dòng chờ bỏ) | như PR 1 |
| đã ghép, `pendingDropQty > 0` | không có trong `outcomes` (không tính, §5.4) | không |
| đã ghép, kiện `cancelled` | không có trong `outcomes` | không |
| đã ghép, kiện đã rời kho (`HANDED_OVER`, gồm `returned`, `lost`) | `kept` | không |
| `from` biến thể A, kiện `backordered`/`reserved` | `applied` | `writes`; `reservedQty > 0` và `holdStock` → `releases` (A) |
| `from` biến thể A, kiện `packed`/`awaiting_pickup` | `needs_unload` | chưa có dấu → `marks`; `purpose = raisePurpose(pkg, 'remap')` (một lần mỗi kiện) |
| `from` "không quản tồn" (bảng 3), kiện chưa rời kho | `applied` | `writes` |

Sau vòng dòng:
- **D24:** kiện `packed`/`awaiting_pickup`, `openPurpose === 'remap'`, không còn dòng có dấu (dấu cũ trừ `unmarks`, cộng `marks`) → `purpose = { needsOpen: true, openPurpose: 'stocktake' }`, `allocateAlso` cộng mọi biến thể của kiện.
- `allocateAlso` cộng biến thể của `releases`.
- Bước tồn (`stockStep`) tính trên dòng sau khi ghi, dòng trong `releases` coi như `reservedQty = 0` trước khi xét. Sửa một chỗ ở nhánh `backordered`: chỉ `hold` khi `awaitingLineIds` không có dòng nào của kiện (D26, gồm cả bảng 1). Các nhánh khác giữ nguyên: dòng A vừa nhả trên kiện `reserved` sang B thành dòng "mới có biến thể" → `reserve_new` (`sealed: false`); sang "không quản tồn" thì không có dòng mới → `none`.
- `reportDelivered` giữ như PR 1 (chỉ khi có `writes` trên kiện `delivered`; bảng 2 không ghi kiện đã rời kho nên không đổi).

- [ ] **Step 1: Viết test đỏ** (mỗi `it` một hàng, dữ liệu dựng bằng hàm `pkg(...)` sẵn có trong file test, thêm trường mới với mặc định `needsOpen: false, openPurpose: null, pendingDropQty: 0, remapPending: false`):
  - `D2-G10 bảng 2 reserved giữ A → B: writes B, releases A đủ số, stock reserve_new không sealed, allocateAlso = [A]`
  - `D2-G10 bảng 2 backordered giữ một phần A → B: releases phần đang giữ, writes, stock allocate gồm B, allocateAlso có A`
  - `D2-G11 bảng 2 packed giữ A → B: không writes, marks = [dòng], purpose remap, outcome needs_unload, stock none`
  - `D2-G11 bảng 2 packed đã có dấu, mục đích remap → B lần nữa: không marks, purpose null (19e)`
  - `D2-G11 bảng 2 packed mục đích stocktake → B: purpose thành remap (19b)`
  - `D2-G11 bảng 2 packed mục đích edit → B: marks, purpose null (giữ edit)`
  - `D2-G12 đổi về như cũ: dòng có dấu, from = to → unmarks, purpose stocktake, allocateAlso = biến thể của kiện (20b)`
  - `D2-G12 hai dòng có dấu, đổi một về như cũ: unmarks một, purpose null (20c)`
  - `D2-G14 bảng 2 in_transit đã trừ A: kept, không ghi gì (22)`
  - `D2-G14 bảng 2 kiện cancelled: không có trong outcomes (22a)`
  - `D2-G14 dòng đã ghép chờ bỏ: không có trong outcomes, không marks`
  - `D2-G15 bảng 2 reserved giữ A → không quản tồn: writes untracked, releases A, stock none, allocateAlso [A] (23)`
  - `D2-G15 bảng 3 backordered untracked → B: writes, stock allocate (24)`
  - `D2-G15 bảng 3 packed untracked → B, kiện đang giữ dòng khác: writes, stock reserve_new sealed (24a)`
  - `D2-G15 bảng 3 in_transit: kept`
  - `D2-G18 dòng chờ thay (awaitingLineIds) → kept; kiện backordered có dòng chờ thay không hold dù dòng khác sang không quản tồn (18b, D26)`
  - `D2-G10 holdStock false, reserved giữ A → B: không releases`
  - Review Focus 3: `D2-G10 reserved hai dòng A, B; A → B: writes dòng A, releases A, reserve_new chỉ dòng vừa đổi`
- [ ] **Step 2: Chạy** `npx vitest run --project unit test/unit/modules/order/fulfillment/domain/remap.test.ts` → các ca mới FAIL, ca PR 1 vẫn PASS sau khi thêm trường mặc định.
- [ ] **Step 3: Sửa `planRemap`, `stockStep`** theo bảng trên. Cập nhật comment đầu file (bảng 1, 2, 3).
- [ ] **Step 4: Chạy lại** → mọi ca PASS.
- [ ] **Step 5: Commit** `#237: planRemap bảng 2, 3, dấu chờ đổi ghép, D24, D26`.

### Task 4: Thi hành kế hoạch mới trong `service/remap.ts`

**Files:**
- Modify: `src/modules/order/fulfillment/service/remap.ts`
- Modify: `src/modules/order/fulfillment/repository/packages.ts`: thêm `setRemapPending(lineIds: readonly string[], value: boolean): Promise<void>`, `clearLinesReserved(lineIds: readonly string[]): Promise<void>` (`reserved_qty = 0`), `clearRemapPendingOf(packageId: string): Promise<void>`
- Test: `test/integration/order/fulfillment/remap.test.ts`

**Interfaces:**
- Consumes: `planRemap` mới (Task 3), `replacementPairs` (`domain/resplit.ts`), `RemapLockedPackage` (Task 1).
- Produces: `applyRemapToPackage(pkg: RemapLockedPackage, changes: ReadonlyMap<string, MappedSku>, opts: RemapOptions & { awaitingLineIds: ReadonlySet<string> }): Promise<Map<string, RemapOutcome>>` (kết quả theo id dòng kiện; Task 8 dùng). `remapPackageLines` giữ chữ ký, gọi `applyRemapToPackage` cho từng kiện đã khoá với `awaitingLineIds` = `newLineId` của `replacementPairs(locked, pkg.id)` (kiện cũ chứa dòng chờ bỏ cùng dòng đơn đã nằm trong tập khoá vì có dòng của dòng đơn đó).

Thứ tự trong `applyRemapToPackage` cho một kiện: `releases` (`stockPort().release`, rồi `clearLinesReserved`) → `writeLines` → `setRemapPending(marks, true)`, `setRemapPending(unmarks, false)` → `updatePackage(pkg.id, purpose ?? {})` (luôn gọi khi có bất kỳ ghi nào để `version` tăng) → `recordTransition` `remap` (lý do `opts.reason`, thêm `: chờ dỡ kiện` khi có `marks` mà không có `writes`) → `applyStock` (như PR 1) → `requestAllocation(plan.allocateAlso)` khi không rỗng → `reportDelivered` như PR 1. Không có `writes`, `marks`, `unmarks`, `purpose` thì không ghi gì (19e). Có `marks` thì log `info` `{ packageId, sellerSku? }` "kiện đã đóng chờ dỡ để đổi ghép" (lý do đã mang SKU người bán; log `opts.reason`).

- [ ] **Step 1: Viết test đỏ** (dùng `setup`, `seedPackage`, `remap`, `jobsOf`, `historyOf`, `versionOf` sẵn có; `seedPackage` nhận `needsOpen`, `openPurpose` có sẵn, thêm `'remap'` vào kiểu `openPurpose` của helper):
  - `D2-G10 17: kiện reserved giữ A, B đủ → nhả A, giữ B, kiện reserved, có việc phân hàng gồm A, lịch sử remap` (kiểm `stock_levels.reserved` của A về 0, của B bằng số lượng).
  - `D2-G10 18: B không đủ → mọi dòng nhả, kiện backordered (lịch sử reclaim), dòng là B, việc phân hàng gồm A và B`.
  - `D2-G10 18a: kiện backordered giữ một phần A → nhả phần đang giữ, dòng B, xếp lượt`.
  - `D2-G11 19: kiện packed giữ A → dòng vẫn A, remap_pending, needs_open + remap, version tăng, lịch sử "…: chờ dỡ kiện", kết quả needs_unload`.
  - `D2-G11 19e: gọi lại cùng B → không ghi, version giữ, không lịch sử mới, kết quả needs_unload`.
  - `D2-G12 20b: kiện ở 19, đổi về A → dấu xoá, mục đích stocktake, có việc phân hàng; chạy runAllocation cho A thì cờ gỡ`.
  - `D2-G12 20f: kiện ở 19 có báo thất lạc chờ xác nhận (ghi lost_reported_by, lost_claim_code bằng testPool), đổi về A rồi runAllocation → mục đích stocktake, cờ và báo cáo còn`.
  - `D2-G12 19f: kiện ở 19 có thêm một dòng chờ bỏ (pending_drop_qty = quantity), đổi về A → dấu xoá, mục đích stocktake, runAllocation không gỡ cờ`.
  - `D2-G14 22: kiện in_transit đã trừ A → không phiếu mới, dòng giữ A, kết quả kept`.
  - `D2-G15 23: kiện reserved giữ A → không quản tồn: nhả A, dòng stock_untracked, kiện reserved`.
  - `D2-G15 24: dòng stock_untracked ở kiện backordered → B: dòng có B, có việc phân hàng`.
  - `D2-G15 24a: dòng stock_untracked ở kiện packed đang giữ dòng khác → B: dòng B, không Cần mở; B đủ thì giữ, thiếu thì kiện giữ nguyên và xếp lượt`.
  - `D2-G18 18b: kiện thay backordered có dòng chờ thay A, kiện cũ packed có dòng chờ bỏ A → đổi ghép: dòng chờ thay giữ A, kiện thay không sang reserved` (dựng bằng `resplit-fixtures.ts`).
  - Review Focus 3: `D2-G10 kiện reserved hai dòng A, B; đổi A → B: hai dòng B, giữ đủ tổng; B thiếu thì kiện backordered`.
  - Review Focus 4: `D2-G15 gian hàng chờ kiểm kê: dòng untracked ở kiện reserved → B: không gọi cổng tồn (setStockPort ném nếu gọi), kiện backordered, không việc phân hàng`.
  - `D2-G16 25: cổng tồn ném lỗi lúc reserve B → hàm ném, dòng vẫn A, A vẫn được giữ, kiện vẫn reserved` (sau khi rollback giao dịch `withCompany`).
- [ ] **Step 2: Chạy** `npx vitest run --project integration test/integration/order/fulfillment/remap.test.ts` → ca mới FAIL.
- [ ] **Step 3: Viết repository mới, `applyRemapToPackage`**, sửa `remapPackageLines` gọi nó. Cập nhật `pkg.lines` tại chỗ sau mỗi bước như PR 1 (`reservedQty = 0` sau nhả).
- [ ] **Step 4: Chạy lại** → PASS, ca PR 1 trong file vẫn PASS.
- [ ] **Step 5: Commit** `#237: thi hành đổi ghép trên kiện (bảng 2, 3), dấu chờ dỡ, D24`.

### Task 5: Sales chọn dòng đổi ghép (D27) và qua API

**Files:**
- Modify: `src/modules/order/sales/repository/orders.ts` (thay `lockUnmappedLinesOfShopSku`, sửa `setOrderLineSku`)
- Modify: `src/modules/order/sales/service/sku-mapping.ts`
- Test: `test/integration/order/sales/sku-mapping.test.ts`, `test/integration/channel/channel/listing-match-orders.test.ts`

**Interfaces:**
- Produces:
  - `lockLinesToRemap(shopId: string, sellerSku: string, to: MappedSku): Promise<{ id: string; orderId: string; variantId: string | null; stockUntracked: boolean }[]>` (thay `lockUnmappedLinesOfShopSku`, xoá hàm cũ). Điều kiện: `external_sku = sellerSku`, đơn thuộc gian hàng, và một trong: dòng chưa ghép (mọi trạng thái đơn, như PR 1); đơn `unpaid`/`processing` và dòng khác `to` (`to` biến thể: `variant_id is distinct from to.variantId or stock_untracked`; `to` untracked: `not stock_untracked`); đơn `unpaid`/`processing` và `exists` dòng kiện của dòng đó có `remap_pending` (D27). `for update`, sắp theo id.
  - `setOrderLineSku(ids: readonly string[], to: MappedSku): Promise<void>`: `sku` lấy từ cột `external_sku` khi có biến thể (bỏ tham số `sellerSku`).
  - `applySkuMapping` giữ chữ ký và kết quả; chỉ ghi dòng `applied` mà ghép đang có khác `to`.
  - Tách `publishOrdersChanged(orderIds: readonly string[]): Promise<void>` (vòng phát `sales.order_status_changed` cho đơn `unpaid`/`processing` hiện có) để Task 8 dùng lại.

- [ ] **Step 1: Viết test đỏ** ở `sku-mapping.test.ts`:
  - `D2-G14 22a: đơn có kiện cancelled mang A và kiện reserved mang A cho cùng dòng đơn → dòng đơn thành B, dòng của kiện huỷ giữ A`.
  - `D2-G14 22b: đơn completed, cancelled có dòng A → không đổi`.
  - `D2-G12 20b qua sales: kiện ở 19 (dòng đơn A), đổi về A → dòng đơn được chọn dù đã bằng to, dấu xoá, dòng đơn không ghi (version giữ)`.
  - `D2-G11 19 qua sales: dòng đơn giữ A, kết quả needsUnload = 1`.
  - Ở `listing-match-orders.test.ts` (API thật, CEO): `D2-G10 17 qua listings/match: CEO đổi ghép A → B (200), đơn đã về có kiện reserved → dòng đơn và dòng kiện là B`; `D2-G11 19 qua listings/match: kiện packed → GET /fulfillment/packages/:id có openPurpose remap; POST …/ready 409 awaiting_open; POST /fulfillment/packages/hand-over trả failed[].code awaiting_open`; `D2-G16 25: cổng tồn ném lỗi (setStockPort) → 500, listing vẫn ghép A, dòng đơn, dòng kiện, cờ không đổi`.
- [ ] **Step 2: Chạy** hai file → ca mới FAIL.
- [ ] **Step 3: Sửa repository và service** theo Interfaces. Log `info` giữ một dòng, đã có `needsUnload`.
- [ ] **Step 4: Chạy lại hai file và** `npx vitest run --project integration test/integration/order/sales` → PASS (ca PR 1 vẫn qua).
- [ ] **Step 5: Commit** `#237: sales chọn dòng đổi ghép của đơn còn mở và dòng có dấu chờ dỡ (D27)`.

### Task 6: Mục đích Cần mở trên các đường khác (D17, D18, D19)

**Files:**
- Modify: `src/modules/order/fulfillment/service/resplit.ts:114-118` (`mark_drop`), `:190-192` (`takeOverReplaced`)
- Modify: `src/modules/order/fulfillment/service/platform-packages.ts:491` (`markWholePendingDrop`)
- Modify: `src/modules/order/fulfillment/repository/packages.ts:101` (`openFlagRules`)
- Test: `test/integration/order/fulfillment/resplit-sync.test.ts`, `line-cancel.test.ts`, `platform-handover.test.ts`

**Interfaces:**
- Consumes: `raisePurpose`, `purposeAfterClear` (Task 2); dấu `remapPending` trên `PackageRow.lines` (Task 1).
- `mark_drop`: `purpose = raisePurpose(pkg, 'resplit') ?? {}`.
- `markWholePendingDrop`: điều kiện đổi mục đích thành `pkg.needsOpen && raisePurpose(pkg, 'cancel')`.
- `takeOverReplaced` nhánh kiện cũ còn dòng, hết dòng chờ bỏ, mục đích `resplit`: `updatePackage(old.id, purposeAfterClear(old.lines.some((l) => l.remapPending)))`.
- `openFlagRules`: `attention` thêm `'remap'`.

- [ ] **Step 1: Viết test đỏ:**
  - `resplit-sync.test.ts`: `D2-G12 19c: kiện packed Cần mở resplit có dòng sống mang dấu, kiện thay được lấy → mục đích thành remap, không gỡ`; `D2-G12 19d: kiện mang remap, sàn chia lại kiện → mục đích resplit`.
  - `line-cancel.test.ts`: `D2-G12 19d: kiện mang remap, sàn huỷ cả kiện → mục đích cancel`.
  - `platform-handover.test.ts`: `D2-G14 21: kiện packed mang remap và dấu, sàn báo rời kho → trừ theo A một phiếu XK, dòng giữ A, cờ Cần mở gỡ, Cần xử lý LEFT_WHILE_AWAITING_OPEN_NOTE`.
- [ ] **Step 2: Chạy** ba file → ca mới FAIL.
- [ ] **Step 3: Sửa bốn chỗ** theo Interfaces.
- [ ] **Step 4: Chạy lại ba file** → PASS.
- [ ] **Step 5: Commit** `#237: thứ tự mục đích remap trên chia lại, huỷ kiện, kiện rời kho (D17–D19)`.

### Task 7: View và hợp đồng API

**Files:**
- Modify: `src/modules/order/fulfillment/repository/packages.ts` (`PackageViewRow.lines`, `attachViewLines` đọc `remapPending`)
- Modify: `src/modules/order/fulfillment/service/views.ts:85-120`
- Modify: `src/modules/order/fulfillment/api/schemas.ts:48` (`openPurpose` dùng `z.enum(OPEN_PURPOSES)`), `:60-75` (`lines[].remapPending`)
- Modify: `src/modules/order/fulfillment/api/openapi.ts` nếu mô tả `open` nằm ở đó
- Test: `test/integration/order/fulfillment/packages-read.test.ts`

**Interfaces:**
- `PackageSummary.lines[].remapPending: boolean` = `pl.remapPending && isSealed(p.status)` (mô tả: "Món trong hộp theo ghép cũ, kho mở kiện để áp ghép mới; chỉ true khi kiện còn đóng"). `openPurpose` mô tả thêm `remap` = "Đổi ghép SKU: dỡ kiện, mở ra là áp ghép mới". Mô tả thao tác `open`: "Kiện đơn sàn: áp ghép hiện hành; dòng mới không giữ được thì kiện về `backordered`".

- [ ] **Step 1: Viết test đỏ** `D2-G17 26: GET /fulfillment/packages/:id của kiện ở 19 → openPurpose remap, lines[].remapPending đúng, untracked đúng; kiện đó sang in_transit thì remapPending false` (parse bằng `Package` schema Zod).
- [ ] **Step 2: Chạy** → FAIL.
- [ ] **Step 3: Sửa view, schema, OpenAPI.**
- [ ] **Step 4: Chạy lại, chạy** `npx vitest run --project unit test/api` → PASS.
- [ ] **Step 5: Commit** `#237: Package trả openPurpose remap, lines[].remapPending`.

### Task 8: Mở kiện áp lại ghép (D20, D21)

**Files:**
- Create: `src/modules/order/fulfillment/service/open-remap.ts`
- Modify: `src/modules/order/fulfillment/service/packing.ts:266-400` (`openPackage`)
- Modify: `src/modules/order/fulfillment/repository/packing.ts` (thêm `lineSellerSkusOf`)
- Modify: `src/modules/order/fulfillment/service/packages.ts:17-33` (`FulfillmentContext`)
- Modify: `src/modules/order/sales/repository/orders.ts`, `sales/service/sku-mapping.ts`, `sales/index.ts`, `src/modules/order/index.ts:16-18`
- Modify: `src/modules/channel/channel/service/mapping.ts` (export `skuMappingOf`), `src/modules/channel/index.ts`, `src/wiring.ts:44`, `:60-70`
- Modify: `test/integration/order/fulfillment/helpers.ts` (`SeedLine.externalSku`, `packingApp(fake, ctx?)`)
- Test: `test/integration/order/fulfillment/open-remap.test.ts` (mới), `test/integration/order/fulfillment/packing-wiring.test.ts`

**Interfaces:**
- `FulfillmentContext` thêm:
  - `skuMappingOf?: (shopId: string, sellerSkus: readonly string[]) => Promise<Map<string, LineSku>>` (channel, `src/wiring.ts`; `AppContext` thêm vào `Required<Pick<FulfillmentContext, …>>`).
  - `lockOrderLines?: (ids: readonly string[]) => Promise<void>` (sales `lockOrderLinesById`: `select id … where id in (…) order by id for update`).
  - `applyLineSkus?: (rows: readonly { orderLineId: string; to: MappedSku }[]) => Promise<void>` (sales: gom theo `to`, `setOrderLineSku`, rồi `publishOrdersChanged` cho các đơn có dòng đổi).
  - Thiếu `skuMappingOf` thì bỏ bước áp (spec §5.6); có `skuMappingOf` mà thiếu hai hàm sales thì 500 `internal_error` như `settleCancelledOrder`.
- Channel: `skuMappingOf(shopId, sellerSkus)` bọc `variantsBySellerSku`, export qua `channel/index.ts`.
- `lineSellerSkusOf(packageId: string): Promise<Map<string, string | null>>`: id dòng kiện → `order_lines.external_sku` (join cùng schema, một câu).
- `open-remap.ts`:
  - `openRemapChanges(ctx: FulfillmentContext, pkg: { id: string; shopId: string | null; lines: readonly PackageLineRow[] }): Promise<Map<string, MappedSku>>` (dòng đơn → ghép mới): chỉ dòng sống; bỏ dòng mà ghép hiện hành vắng hay `unmapped` (Review Focus 2); bỏ dòng đã đúng ghép. Kiện không gian hàng hay thiếu `skuMappingOf` → `Map` rỗng.
  - `applyOpenRemap(ctx, pkgId: string, changes: ReadonlyMap<string, MappedSku>, opts: { actorId: string; holdStock: boolean }): Promise<{ changed: number; released: string[] }>`: đọc lại kiện đã khoá (`lockPackage`, đang giữ khoá nên không chờ), `applyRemapToPackage` với lý do `Mở kiện: áp ghép SKU <các SKU người bán, cách nhau dấu phẩy>`, `awaitingLineIds` rỗng, `orderCutoffAt: null`; ghi dòng đơn `applied` qua `ctx.applyLineSkus`; rồi nếu `holdStock`, dòng sống có biến thể mà `reservedQty < quantity` (gồm dòng bước kiểm đã bỏ qua) thì `reserve` như "giữ dòng mới" của kiện `reserved` (được: `markLinesReserved`, `allocation_done`; không được: nhả cả kiện, `reclaim`, xếp lượt mọi biến thể). Log `info` "mở kiện áp lại ghép SKU" `{ packageId, changed }`.

Sửa `openPackage`:
- **Bước kiểm**: sau `transition(…'open')`, `changes = await openRemapChanges(ctx, pkg)`; `missing` bỏ dòng có `orderLineId` trong `changes`.
- **Bước ghi** (nhánh không `open_cancel`, kiện có `shopId`): `holdStock` từ `stockHoldLookupOf(ctx)([shopId], { lock: true })` → `readPackingPackage(id)` lấy id dòng đơn → `ctx.lockOrderLines(ids)` → `takeAllocationLock(companyId)` (mọi kiện đơn sàn, không chỉ `resplit`) → `readPackage(id, true)` → `checkVersion` như nay. Nhánh `open_cancel` giữ thứ tự cũ.
- Sau các việc mở hiện có: `updatePackage` gỡ cờ khi mục đích là `remap` (thêm vào nhóm `stocktake`, `resplit`, có dòng chờ bỏ); `clearRemapPendingOf(id)` ở cả hai nhánh. Rồi, nếu kiện có `shopId` và không phải kiện chờ thay (`awaitingReplacementIds([id])` rỗng, Review Focus 5): tính lại `changes` trên dòng đã khoá (ghép đọc lại dưới khoá gian hàng) và `applyOpenRemap`.
- `kept` (xếp lượt dòng còn lại) gồm cả mục đích `remap`; cộng `released` của `applyOpenRemap`.

- [ ] **Step 1: Sửa helper test**: `SeedLine.externalSku?: string` (seed ghi `order_lines.external_sku` bằng `testPool()`); `packingApp(fake = {}, ctx: Partial<AppContext> = {})` trộn `ctx` vào `appContext`.
- [ ] **Step 2: Viết test đỏ** `open-remap.test.ts` (kiện của `channelShop`, `skuMappingOf` giả là biến `Map` đổi được giữa các bước, `repack` giả trả `'repacked'`):
  - `D2-G13 20: kiện ở 19 (A → B, có dấu, Cần mở remap), kho mở → kiện reserved, dòng đơn và dòng kiện là B, giữ B, cờ gỡ, dấu xoá, lịch sử open rồi remap`.
  - `D2-G13 20: như trên nhưng B thiếu → kiện backordered, mở vẫn 200`.
  - `D2-G11 19a: kiện awaiting_pickup ở 19, mở → giữ vận đơn, không gọi repack (repack giả ném nếu gọi), dòng thành B`.
  - `D2-G13 20a: kiện packed giữ A, ghép đã là B, không dấu, Cần mở edit có dòng chờ bỏ → mở: dòng sống thành B, dòng chờ bỏ bỏ ra`.
  - `D2-G13 20d: kiện packed chưa giữ A, A hết hàng, ghép đã là B (B đủ) → mở không 422, dòng B, kiện reserved`.
  - `D2-G13 20e: trong lúc repack, ghép đổi B → C (dấu không đổi, version giữ) → bước ghi áp C`; `D2-G13 20e: trong lúc repack, ghép đổi về A (xoá dấu, version tăng) → 409 version_conflict, kiện vẫn packed`. Đổi ghép trong `repack` giả bằng `withCompany(companyId, () => remapPackageLines(...))` sau khi đổi `Map`.
  - Review Focus 1: `D2-G15 kiện packed giữ A, đổi sang không quản tồn rồi mở → dòng stock_untracked, A nhả, kiện reserved`.
  - Review Focus 2: `D2-G13 ghép hiện hành unmapped (Map không có SKU) → mở: dòng giữ A, dấu xoá, kiện reserved`.
  - Review Focus 5: `D2-G18 kiện thay đã đóng đang chờ thay, ghép đã đổi → mở: không áp, dòng giữ ghép cũ`.
  - `packing-wiring.test.ts`: `createModuleContext() có skuMappingOf; app thật mở kiện của đơn sàn có listing đổi ghép (qua listings/match) thì dòng thành B` (một ca đi đủ channel, sales).
- [ ] **Step 3: Chạy** `npx vitest run --project integration test/integration/order/fulfillment/open-remap.test.ts test/integration/order/fulfillment/packing-wiring.test.ts` → FAIL.
- [ ] **Step 4: Viết** repository, sales, channel, wiring, `open-remap.ts`, sửa `openPackage` theo Interfaces.
- [ ] **Step 5: Chạy lại hai file**, rồi `npx vitest run --project integration test/integration/order/fulfillment` (mở kiện cũ: `stocktake-open`, `resplit-open`, `packing-actions` vẫn qua) → PASS.
- [ ] **Step 6: Chạy** `npm run depcruise` → không vi phạm (fulfillment không import sales, channel).
- [ ] **Step 7: Commit** `#237: mở kiện đơn sàn áp lại ghép hiện hành (D20, D21)`.

### Task 9: CLAUDE.md, kiểm toàn bộ

**Files:**
- Modify: `src/modules/order/fulfillment/CLAUDE.md` (mục Ghép SKU muộn thêm bảng 2, 3 và dấu; mục Đóng gói: `open` áp ghép, D28 nêu `remap`; mục Phân hàng: `remap` không là ứng viên; `openFlagRules` có `remap`; mục Giới hạn: bỏ dòng "Chưa làm: đổi ghép đã dùng…", thêm các dòng §10 phần PR 2 của spec)
- Modify: `src/modules/order/sales/CLAUDE.md` (mục #237: đổi tên thành "PR 1, PR 2", luật chọn dòng D27, `lockOrderLines`/`applyLineSkus` ở "Cho module khác")
- Modify: `src/modules/channel/channel/CLAUDE.md` (`skuMappingOf` cho fulfillment)

- [ ] **Step 1: Sửa ba CLAUDE.md** theo danh sách trên.
- [ ] **Step 2: Chạy** `npm run check` → lint, typecheck, depcruise, test đều xanh. Ghi số file, số test vào mô tả PR.
- [ ] **Step 3: Chạy** `npm run db:ci-check -- --base origin/main` → đạt. Main có migration mới từ lúc tạo nhánh thì `git fetch origin && git merge origin/main`, `npm run db:regen`, commit `db/migrations`.
- [ ] **Step 4: Chạy** `graphify update .` (ở worktree; nếu đồ thị chỉ ở bản checkout chính thì ghi vào PR là cập nhật sau khi merge, như PR 1).
- [ ] **Step 5: Commit** `#237: CLAUDE.md cho đổi ghép đã dùng`.

### Task 10: Documents, mã ca, issue, PR

**Files (repo `DA-EC-System/Documents`, nhánh riêng, PR riêng):**
- `21-hop-dong-api-fe-be.md` §19.2 (`openPurpose` thêm `remap`, `lines[].remapPending`, thao tác `open`, thứ tự mục đích D17, sàn báo rời kho khi còn `remap` D19), §18.3 (`listings/match`, `mapping/:action`: đổi ghép đã có đơn áp lên đơn còn mở theo bảng 2, 3; bỏ câu "dòng đã ghép giữ ghép cũ…")
- `19-mo-hinh-du-lieu.md` (giá trị `remap`, cột `remap_pending`, CHECK `package_lines_remap_pending`)
- `26-ke-hoach-kiem-thu.md` §3.2 (bỏ câu "Đổi ghép đã dùng … là PR 2, chưa có ca"; thêm bảng mã dưới), `27-user-story.md` (US-DH-05 dòng 3 ghi mã ca; US-DH-15 thêm "đổi ghép SKU" vào lý do mở kiện)

| Mã | Ca trong spec §9 PR 2 |
|---|---|
| D2-G10 | 17, 18, 18a: kiện chưa đóng đổi ghép |
| D2-G11 | 19, 19a, 19b, 19e: kiện đã đóng bật Cần mở `remap` |
| D2-G12 | 19c, 19d, 19f, 20b, 20c, 20f: mục đích, gỡ cờ |
| D2-G13 | 20, 20a, 20d, 20e: mở kiện áp lại ghép |
| D2-G14 | 21, 22, 22a, 22b: kiện đã rời kho, kiện huỷ, đơn đã dừng |
| D2-G15 | 23, 24, 24a: "không quản tồn" |
| D2-G16 | 25: lỗi giữa lúc đổi ghép |
| D2-G17 | 26: API |
| D2-G18 | 18b: kiện chờ thay (D26) |

- [ ] **Step 1: Mở PR Documents** với các sửa trên, ghi `commerio-backend#237` (PR 2).
- [ ] **Step 2: Sửa issue #237** (`gh issue edit 237`): tick các gạch PR 1 đã xong (#383) và gạch đổi ánh xạ (PR này), sửa mục "Đối chiếu code (02/11/2026)" theo code hiện tại, ghi PR 3 cho gạch báo cáo.
- [ ] **Step 3: Mở PR backend** vào `main`: `Refs #237` (PR 2/3, không đóng issue), spec, plan, migration (giá trị enum không lùi được), cách kiểm (`npm run check`, `db:ci-check`), mã ca, FE#359 cho phần FE.
- [ ] **Step 4: Cập nhật memory** `issue-237` (trạng thái PR 2, PR Documents, PR 3 còn lại).
