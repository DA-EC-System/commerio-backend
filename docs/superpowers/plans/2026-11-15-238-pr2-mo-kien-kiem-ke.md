# Mở kiện do kiểm kê (#238, PR 2): kế hoạch thi công

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phiếu kiểm kê đếm thấp hơn hàng đang nằm trong kiện đã đóng thì kiện vào tab Cần mở với mục đích `stocktake`, kho mở được, và cờ tự gỡ khi tồn đã đủ; thay cho cờ Cần xử lý không có thao tác đi kèm.

**Architecture:** Chỉ đổi loại cờ mà lượt phân hàng (`service/allocation.ts`) gắn và gỡ, thêm một bước tự gỡ trong cùng lượt, và cho `openPackage` gỡ cờ rồi xếp một lượt phân hàng. Không thêm route, không thêm sự kiện. Một migration thêm giá trị enum.

**Tech Stack:** Node.js 24 chạy thẳng `.ts`, Express 5, Zod 4, Drizzle ORM 0.45 + drizzle-kit 0.31, PostgreSQL 18, Vitest 5. Dùng `npm`.

**Spec:** `docs/superpowers/specs/2026-11-15-238-that-lac-chia-lai-kien-design.md`, mục 5.1 (PR 2), 5.5, D15, D21; AC 11, 11a; mục 10 (dòng "Mở kiện `stocktake` rồi sàn huỷ đơn").

## Global Constraints

- Đọc trước khi sửa: `CLAUDE.md` gốc, `src/modules/CLAUDE.md`, `src/modules/order/fulfillment/CLAUDE.md`, `db/CLAUDE.md`, `test/CLAUDE.md`; spec 199b (`docs/superpowers/specs/2026-11-09-199b-chia-hang-design.md`) mục 5.2 đến 5.5 và 5.10. `graphify query` trước khi grep; sửa xong `graphify update .`.
- **Nền:** nhánh `feature/238-mo-kien-kiem-ke` tách từ `feature/238-that-lac` (PR 1), vì cần luật xoá báo cáo thất lạc trong `updatePackage` (D21). PR 1 đã merge thì tách từ `origin/main`.
- Giá trị enum mới `stocktake` **không được dùng** trong bất kỳ migration nào của PR này: drizzle chạy mọi migration đang chờ trong một giao dịch và PostgreSQL không cho dùng giá trị enum mới trước khi commit. Dữ liệu cũ không chuyển; code nhận cả cờ dạng cũ (`needs_attention` + `DISMANTLE_NOTE`).
- Thứ tự khoá (spec 199b §5.10): gian hàng → advisory phân hàng → kiện → dòng tồn → `doc_counters`. Kiện khoá theo `code` tăng dần.
- CHECK `packages_open`: `needs_open = (open_purpose is not null)`; hai cột luôn ghi cùng nhau.
- Không bật cờ lên kiện đang chờ mở vì lý do khác (giữ mục đích cũ). Không tăng `version` của kiện khi không có gì đổi.
- Định danh tiếng Anh; comment, thông báo, tên test tiếng Việt. Import tương đối có đuôi `.ts`; test import `#src/...ts`. Lỗi nghiệp vụ ném `AppError`.
- Migration sinh ở task cuối. Không push, không mở PR.
- `npm run lint` trên máy Khang đỏ vì `.claude/worktrees/`: chạy `npx eslint . --ignore-pattern ".claude/**"` và các phần còn lại của `npm run check` riêng từng lệnh.
- `openPackage` (`service/packing.ts`) cũng bị PR #329, #330 sửa: PR nào merge sau thì gộp lại; phần của PR này chỉ là nhánh `openPurpose === 'stocktake'`.

## Sáu câu hỏi thiết kế (backend-design)

1. **Loại thành phần.** Consumer sự kiện (`inventory.stocktake_posted`, `inventory.stock_changed`) và việc nền `fulfillment.allocation`, chạy nối nhau theo công ty nhờ khoá advisory; một nhánh trong route `open` đã có.
2. **Dữ liệu và bất biến.** `needs_open` đi cùng `open_purpose` (CHECK). Kiện chờ mở vì `cancel`, `edit`, `resplit` không bị đổi mục đích bởi kiểm kê; ngược lại huỷ thắng `stocktake`.
3. **Lỗi.** Lượt phân hàng không ném lỗi nghiệp vụ. `open` giữ lỗi hiện có (`insufficient_stock` 422, `shop_awaiting_stocktake` 409, `version_conflict` 409).
4. **Phân quyền.** Không đổi: `open` cần `fulfillment.order.process`; lượt phân hàng là hệ thống trong `withCompany`.
5. **Gọi lặp và đồng thời.** Nhận lại cùng sự kiện kiểm kê: không bật thêm, không tăng `version`. Tự gỡ và `open` cùng lúc: cả hai khoá kiện; `open` gặp `version_conflict` nếu cờ vừa bị gỡ.
6. **Quan sát.** `logger.info({ flagged, cleared })` cuối lượt khi một trong hai khác rỗng. Không thêm metric.

## Review Focus

1. Kiện đang chờ mở vì `stocktake` mà sàn huỷ đơn: mục đích phải thành `cancel`, mở kiện ra là huỷ chứ không về `reserved` (Task 2).
2. Kiện đang chờ mở vì `cancel` mà kiểm kê đếm thiếu: giữ `cancel`, không tự gỡ khi tồn đủ (Task 1).
3. Nhận lại sự kiện kiểm kê: lượt hai không đổi `version` của kiện đã gắn cờ (Task 1).
4. Kiện gắn cờ `stocktake` có báo cáo thất lạc treo (`lose_on_unload` đang chờ xác nhận), tồn về đủ và cờ tự gỡ: báo cáo bị xoá, `report-lost` lại trả `not_awaiting_open` chứ không kẹt ở `already_reported` (Task 1).
5. Kiện còn mang cờ dạng cũ (`needs_attention` + `DISMANTLE_NOTE`) từ trước PR: giữ lại được hàng thì cờ cũ vẫn gỡ (Task 1).

## Bản đồ file

| File | Việc |
|---|---|
| `src/modules/order/fulfillment/repository/schema.ts` | Enum `open_purpose` thêm `stocktake` |
| `src/modules/order/fulfillment/repository/packages.ts`, `api/schemas.ts` | Kiểu `openPurpose` thêm `stocktake` |
| `src/modules/order/fulfillment/domain/allocation.ts` | `SealedHolder` thêm `needsOpen`; `planDismantle` bỏ kiện đang chờ mở |
| `src/modules/order/fulfillment/repository/allocation.ts` | `candidateWhere`; cột `needsOpen`, `openPurpose` của ứng viên và kiện đã đóng; `lockStocktakeFlagged` |
| `src/modules/order/fulfillment/service/allocation.ts` | Gắn cờ mới, gỡ cả hai dạng, bước tự gỡ |
| `src/modules/order/fulfillment/service/packing.ts` | `openPackage` gỡ cờ `stocktake`, xếp lượt phân hàng |
| `src/modules/order/fulfillment/service/platform-packages.ts` | `cancelPlatformPackage`: `stocktake` → `cancel` |
| `db/migrations/*` | Một migration (Task 3) |
| `src/modules/order/fulfillment/CLAUDE.md` | Cập nhật |

---

### Task 0: Nhánh

- [ ] **Step 1:** `git fetch origin`. PR 1 đã merge vào `main` → `git switch -c feature/238-mo-kien-kiem-ke origin/main`; chưa merge → `git switch -c feature/238-mo-kien-kiem-ke feature/238-that-lac`.
- [ ] **Step 2:** `git add docs/superpowers/plans/2026-11-15-238-pr2-mo-kien-kiem-ke.md && git commit -m "#238: kế hoạch PR 2 (mở kiện do kiểm kê)"`.

### Task 1: Lượt phân hàng gắn và gỡ cờ Cần mở

**Files:**
- Modify: `repository/schema.ts`, `repository/packages.ts`, `api/schemas.ts`, `domain/allocation.ts`, `repository/allocation.ts`, `service/allocation.ts` (cùng `src/modules/order/fulfillment/`)
- Test: `test/unit/modules/order/fulfillment/domain/allocation.test.ts`; `test/integration/order/fulfillment/stocktake-dismantle.test.ts`, `opening-stocktake.test.ts`, `reclaim.test.ts` (sửa); `test/integration/order/fulfillment/stocktake-open.test.ts` (mới)

**Interfaces (Produces):**

```ts
// schema.ts
export const openPurpose = fulfillmentSchema.enum('open_purpose', ['cancel', 'edit', 'resplit', 'stocktake']);
export type OpenPurpose = 'cancel' | 'edit' | 'resplit' | 'stocktake';      // dùng ở packages.ts, api/schemas.ts
// domain/allocation.ts
export interface SealedHolder { id: string; needsAttention: boolean; needsOpen: boolean; lines: StockLine[] }
// repository/allocation.ts
export type LockedAllocationCandidate = /* cũ */ & { needsOpen: boolean; openPurpose: OpenPurpose | null };
/** Kiện đã đóng đang chờ mở vì kiểm kê, đang giữ một SKU thuộc `variantIds`; khoá `FOR UPDATE`, theo `code`. */
export function lockStocktakeFlagged(variantIds: readonly string[]): Promise<{ id: string; lines: StockLine[] }[]>;
// service/allocation.ts: runAllocation trả thêm
cleared: string[];   // kiện vừa được gỡ cờ `stocktake` vì tồn đã đủ
```

Điểm chốt (spec mục 5.5):
- `candidateWhere`: thay `eq(packages.needsOpen, false)` bằng `(needs_open = false or open_purpose = 'stocktake')`.
- `planDismantle`: bỏ qua kiện `needsOpen` (đã chờ mở, giữ mục đích). Kiện `needsAttention` vì lý do khác **vẫn** được gắn cờ Cần mở (hai cờ độc lập), không đụng `flagNote`.
- Gắn cờ ở hai chỗ đang ghi `DISMANTLE_NOTE` (kiện đang giữ SKU thiếu; kiện đã đóng không giữ được sau phiếu đầu kỳ): ghi `{ needsOpen: true, openPurpose: 'stocktake' }`, chỉ khi kiện chưa `needsOpen`.
- Gỡ khi giữ lại được (vòng `planAllocation`): `openPurpose === 'stocktake'` → `{ needsOpen: false, openPurpose: null }`; cờ dạng cũ (`needsAttention && flagNote === DISMANTLE_NOTE`) → `{ needsAttention: false, flagNote: null }`. Giữ `export const DISMANTLE_NOTE`, ghi chú là dạng cũ.
- **Bước tự gỡ**, mọi lượt, đặt ngay sau bước lấy lại phần giữ và sau khi `skus` đã gộp `touched`: `lockStocktakeFlagged(skus)`; đọc `port.stockOf` cho mọi SKU mà các kiện đó đang giữ; kiện nào có **mọi** SKU đang giữ thoả `reserved <= onHand` thì `updatePackage(id, { needsOpen: false, openPurpose: null })` và vào `cleared`. Kiện vừa được gắn cờ trong chính lượt này không xét.
- `logger.info({ flagged, cleared }, 'lượt phân hàng đổi cờ Cần mở do kiểm kê')` khi một trong hai khác rỗng.

- [ ] **Step 1: Viết test.** Unit (`allocation.test.ts`): `planDismantle` bỏ kiện `needsOpen: true`, vẫn lấy kiện `needsAttention: true, needsOpen: false`. Integration, sửa ba file cũ theo cờ mới và thêm `stocktake-open.test.ts`:

```ts
it('AC11: phiếu kiểm kê đếm thấp hơn hàng trong kiện packed đang giữ: needs_open, open_purpose stocktake, nằm trong tab needs_open, needs_attention không đổi')
it('AC11: không mở mà hàng về đủ: lượt phân hàng kế gỡ cờ, kiện vẫn packed và vẫn giữ hàng')
it('tồn mới về chưa đủ cho mọi SKU kiện đang giữ: cờ còn nguyên')
it('AC11a: kiện packed chưa giữ hàng sau phiếu đầu kỳ: có cờ stocktake, vẫn là ứng viên; giữ được thì cờ gỡ')
it('Review 2: kiện đang chờ mở vì cancel bị đếm thiếu: giữ cancel; hàng về đủ cũng không gỡ')
it('Review 3: nhận lại cùng sự kiện kiểm kê: version của kiện đã gắn cờ không đổi')
it('Review 4: kiện gắn cờ stocktake có báo cáo thất lạc treo, cờ tự gỡ: ba cột báo cáo về null, report-lost trả 409 not_awaiting_open')
it('Review 5: kiện mang cờ dạng cũ (needs_attention + DISMANTLE_NOTE) giữ lại được hàng: cờ cũ gỡ')
it('kiện đã có needs_attention vì lý do khác bị đếm thiếu: thêm needs_open stocktake, flag_note giữ nguyên')
```

Dựng kiện và tồn theo mẫu của `stocktake-dismantle.test.ts` (cùng helper). "Nằm trong tab needs_open": gọi `GET /api/v1/fulfillment/packages?tab=needs_open` bằng token kho.

- [ ] **Step 2:** Vì enum chưa có trong DB test, sinh migration **tạm** (`npm run db:generate -- --name tam-mo-kien`), không commit. `npx vitest run --project integration test/integration/order/fulfillment/stocktake-open.test.ts` → FAIL.
- [ ] **Step 3:** Cài theo điểm chốt.
- [ ] **Step 4:** `npx vitest run --project unit test/unit/modules/order/fulfillment` và `npx vitest run --project integration test/integration/order/fulfillment` → PASS.
- [ ] **Step 5:** `git add src test && git commit -m "#238: kiểm kê đếm thiếu bật Cần mở (stocktake), tự gỡ khi tồn đủ"`.

### Task 2: Mở kiện `stocktake`, và huỷ thắng kiểm kê

**Files:**
- Modify: `src/modules/order/fulfillment/service/packing.ts` (`openPackage`), `src/modules/order/fulfillment/service/platform-packages.ts` (`cancelPlatformPackage`)
- Test: `test/integration/order/fulfillment/stocktake-open.test.ts` (thêm), `packing-actions.test.ts` (không đổi hành vi cũ)

**Interfaces:** Consumes `requestAllocation(variantIds)` (`service/allocation.ts`), `OpenPurpose` (Task 1).

Điểm chốt:
- `openPackage`, bước ghi cuối: kiện có `openPurpose === 'stocktake'` thì cùng câu `updatePackage` ghi `needsOpen: false, openPurpose: null`, rồi `requestAllocation` cho mọi SKU đã ghép của kiện (lượt đó lấy lại phần giữ nếu tồn thực vẫn nhỏ hơn đang giữ, kiện về `backordered`). Mục đích khác: hành vi hiện tại không đổi. `readPackage` chưa trả `openPurpose` thì thêm cột.
- Lời gọi `repack` trên sàn giữ nguyên như mở kiện thường: kho đã mở hộp thật nên gói trên sàn phải về chờ đóng.
- Kiện `awaiting_pickup` vẫn trả 409 như hiện tại (PR 3 mới mở); ghi một dòng trong `fulfillment/CLAUDE.md` rằng kiện `awaiting_pickup` gắn cờ `stocktake` chưa mở được cho tới PR 3.
- `cancelPlatformPackage`: kiện đã đóng đang `needsOpen` với `openPurpose === 'stocktake'` → `updatePackage(pkg.id, { openPurpose: 'cancel' })`, cập nhật `pkg`, vẫn trả `'needs_open'`.

- [ ] **Step 1: Viết test** (thêm vào `stocktake-open.test.ts`, dùng `packingApp` của `./helpers.ts` cho cổng sàn giả):

```ts
it('AC11: kho mở kiện stocktake: kiện về reserved, cờ gỡ; chạy lượt phân hàng đã xếp thì kiện về backordered vì tồn vẫn thiếu')
it('mở kiện stocktake khi tồn đã đủ: kiện ở reserved sau lượt phân hàng')
it('Review 1: kiện đang chờ mở vì stocktake, sàn huỷ đơn: open_purpose thành cancel, đơn mang cờ cancelling')
it('kiện awaiting_pickup gắn cờ stocktake: open trả 409 invalid_transition (tới PR 3)')
```

"Chạy lượt phân hàng đã xếp": gọi `runAllocation` trong `withCompany` với SKU của kiện, như các test phân hàng hiện có gọi trực tiếp thay cho hàng đợi.

- [ ] **Step 2:** Chạy file test → FAIL.
- [ ] **Step 3:** Cài.
- [ ] **Step 4:** `npx vitest run --project integration test/integration/order` → PASS.
- [ ] **Step 5:** `git commit -m "#238: mở kiện stocktake gỡ cờ và xếp lượt phân hàng; huỷ thắng kiểm kê"`.

### Task 3: Migration, tài liệu module, kiểm toàn bộ

- [ ] **Step 1:** Xoá migration tạm (`git checkout -- db/migrations && git clean -fd db/migrations`). `git fetch origin`; nhánh nền (PR 1 hoặc `main`) có migration mới thì gộp và `npm run db:regen` theo `db/CLAUDE.md`.
- [ ] **Step 2:** `npm run db:generate -- --name mo-kien-kiem-ke`. File chỉ được có một câu: `ALTER TYPE "order"."open_purpose" ADD VALUE 'stocktake';`. Có câu nào khác thì `schema.ts` đang lệch: dừng và tìm nguyên nhân, không sửa tay file SQL.
- [ ] **Step 3:** `npm run db:ci-check -- --base origin/main` → xanh (nếu nhánh nền là PR 1 chưa merge, lệnh so với `main` vẫn phải xanh vì migration của PR 2 đứng sau của PR 1).
- [ ] **Step 4:** Cập nhật `src/modules/order/fulfillment/CLAUDE.md`: mục phân hàng (cờ mới, bước tự gỡ, dạng cũ còn nhận), bảng route (`open` với `stocktake`), giới hạn `awaiting_pickup`. Mô tả PR ghi: lùi migration là không làm được trực tiếp (PostgreSQL không có `DROP VALUE`); giá trị thừa vô hại nếu lùi code.
- [ ] **Step 5:** `graphify update .`; `npx eslint . --ignore-pattern ".claude/**"`; `npm run typecheck`; `npm run depcruise`; `npm test` → xanh cả bốn.
- [ ] **Step 6:** `git add -A db/migrations db/CLAUDE.md src test && git commit -m "#238: migration open_purpose stocktake, tài liệu module"`. Không push.

## Việc ngoài kế hoạch này

- FE: nhãn `stocktake: 'Kiểm kê thiếu hàng'` trong `OPEN_PURPOSE_LABELS`, kiểu `OpenPurpose`.
- Documents: `21` §19.2 thêm giá trị `stocktake` cho `openPurpose`; `19` mục 2.
- Mở kiện `awaiting_pickup` có cờ Cần mở: PR 3.
