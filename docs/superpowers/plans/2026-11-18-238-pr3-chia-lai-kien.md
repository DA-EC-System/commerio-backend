# Sàn chia lại kiện (#238, PR 3): kế hoạch thi công

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khi danh sách kiện của sàn khác danh sách trong app, app tự xử lý: khớp theo tập món thì chỉ gắn lại mã; phần chưa đóng thì huỷ hoặc bớt dòng và lập kiện mới giữ hàng trước; phần đã đóng thì bật Dỡ kiện về kệ và lập kiện chờ thay; mở kiện `awaiting_pickup` giữ vận đơn. Mở khoá ca TikTok của #221.

**Architecture:** Một luật thuần `domain/resplit.ts` lập kế hoạch từ kiện của đơn và nhóm món sàn; `service/resplit.ts` thi hành trong giao dịch kéo đơn, dưới khoá advisory phân hàng chỉ khi có bước. `syncPlatformPackages` dùng kế hoạch thay cho cách tìm kiện `existing.find(mã) || owner.get(món)`. Mở kiện, đóng gói, báo sẵn sàng, bàn giao, phân hàng sửa theo D24 đến D28. Một migration: hai cột trên `packages`.

**Tech Stack:** Node.js 24 chạy thẳng `.ts`, Express 5, Zod 4, Drizzle ORM 0.45 + drizzle-kit 0.31, PostgreSQL 18, Vitest. Dùng `npm`.

**Spec:** `docs/superpowers/specs/2026-11-15-238-that-lac-chia-lai-kien-design.md`: mục 2 (đoạn "`main` eb49bba"), D7 đến D9, D20, D22 đến D29, mục 5.1 (PR 3), 5.2 (`replaced`), 5.6, 5.8, 5.9, 5.10; AC 11c, 12 đến 19b; mục 10.

## Global Constraints

- D22 đến D29 Khang duyệt 18/11/2026. Code lệch spec thì hỏi trước, không tự chọn.
- Đọc trước khi sửa: `CLAUDE.md` gốc, `src/modules/CLAUDE.md`, `src/modules/order/fulfillment/CLAUDE.md`, `db/CLAUDE.md`, `test/CLAUDE.md`; spec 199b §5.2 đến §5.5, §5.10; spec 205 §5.10 (huỷ dòng, `openPackage`).
- Nền: worktree `.claude/worktrees/238-chia-lai-kien`, nhánh `feature/238-chia-lai-kien` tách từ `origin/main` eb49bba. Không đặt upstream là `main`.
- Thứ tự khoá: gian hàng → đơn → advisory `fulfillment.allocation:<công ty>` → kiện → dòng tồn → `doc_counters`. **Không bao giờ lấy advisory sau khi đã khoá kiện.**
- Mọi câu ghi dòng kiện, `pending_drop_qty`, hay huỷ kiện chạy sau khi đã khoá kiện (trigger kiểm bằng, `db/CLAUDE.md`). Tổng `quantity − pending_drop_qty` theo dòng đơn trên kiện chưa huỷ không đổi lúc commit.
- CHECK `packages_open`: `needs_open` và `open_purpose` ghi cùng nhau. CHECK mới `packages_waybill_kept`: `not waybill_kept or (platform_package_code is not null and tracking_code is not null)`.
- Unique `packages_platform_code_order_uq` không lọc trạng thái: đổi mã kiện phải gỡ mã cũ trước (hai pha).
- Không tăng `version` của kiện khi lượt kéo không đổi gì (gọi lặp). Không bật lại cờ đã có.
- Không thêm loại sự kiện. Không gọi sàn trong giao dịch.
- Định danh tiếng Anh; comment, thông báo, tên test tiếng Việt. Import tương đối có đuôi `.ts`; test import `#src/...ts`. Lỗi nghiệp vụ ném `AppError`. Chỉ cú pháp TypeScript xoá được.
- Test "không gọi sàn": dùng `packingApp(fake)` (`test/integration/order/fulfillment/helpers.ts`), hàm sàn không truyền sẽ ném `unexpectedMarketplace`.
- Migration chỉ sinh ở Task 6. Task 2 đến Task 5 dùng migration **tạm** để chạy test integration, không commit.
- Không push, không mở PR. `graphify` chỉ chạy ở bản checkout chính sau khi merge.

## Sáu câu hỏi thiết kế (backend-design)

1. **Loại thành phần.** Đồng bộ trong giao dịch kéo đơn (worker, 5 phút một lượt mỗi gian hàng); ba route đồng bộ (`open`, `pack`, `ready`) và lô `hand-over`; việc nền `fulfillment.allocation`. Tải nhỏ (đồ án), chia lại kiện hiếm.
2. **Dữ liệu và bất biến.** Kiểm bằng theo dòng đơn (trigger); một mã kiện sàn một kiện mỗi đơn (unique); `needs_open` ↔ `open_purpose`; `waybill_kept` cần mã kiện sàn và vận đơn; `replaces_package_id` khoá ngoại về `packages`. Kiện chờ thay suy ra, không lưu (D9).
3. **Lỗi.** Đường sàn không ném lỗi nghiệp vụ: phần không tự xử lý thì Cần xử lý (D29). Route: `awaiting_open` 409 (D28), lỗi cũ giữ nguyên. Lỗi cổng tồn, `40P01`, CHECK: ném, lượt kéo rollback và chạy lại ở nhịp sau.
4. **Phân quyền.** Không đổi: `fulfillment.order.process` cho `open`, `pack`, `ready`, `hand-over`; đồng bộ là hệ thống trong `withCompany`.
5. **Gọi lặp và đồng thời.** Lượt kéo lặp: mọi nhóm khớp theo tập, không bước nào. Đồng thời với phân hàng: advisory. Đồng thời với mở kiện: khoá kiện, `version`. Dữ liệu đổi giữa lần đọc không khoá và lần khoá: để lượt sau.
6. **Quan sát.** `logger.info({ orderId, steps })` khi thi hành kế hoạch; `logger.warn` khi không lập được (D22 bước 0, 2.2), khi để lượt sau, khi kiện thay được lấy trước. Không thêm metric (đi qua số liệu lượt kéo đơn).

## Review Focus

1. Hai đơn khác nhau chung một mã kiện sàn (TikTok gộp gói): kế hoạch của đơn này không đụng kiện của đơn kia (Task 2, ca `combine`).
2. Gian hàng đang chờ kiểm kê đầu kỳ (`holdStock = false`) bị sàn chia lại: kiện mới không giữ hàng, ở `backordered` (Task 2).
3. Nhóm gồm món của kiện đã đóng và kiện chưa đóng: kiện thay không giữ lúc lập; khi được lấy thì dòng từ kiện đã đóng nhận phần giữ, dòng kia thử giữ rồi mới bắt buộc (Task 3).
4. Kiện chờ thay chỉ có dòng "không quản tồn": không thành `reserved` lúc lập (Task 3).
5. Kéo lại ngay sau khi kho mở kiện cũ (kiện cũ đã `cancelled`, vẫn mang mã cũ): không bước nào, không `clear_code` nhầm (Task 4).

## Bản đồ file

| File (dưới `src/modules/order/fulfillment/` trừ khi ghi khác) | Việc |
|---|---|
| `domain/resplit.ts` (mới) | `planResplit`, `replacementPairs`, kiểu |
| `domain/package.ts` | Mũi tên `replaced`, `PackageAction` |
| `repository/schema.ts` | `replacesPackageId`, `waybillKept`, CHECK, index |
| `repository/packages.ts` | `readOrderPackages`, `PackageRow` thêm cột, `insertPackage`, `moveReservations`, `openFlagRules`, luật `waybill_kept`, `attachViewLines` gắn `replaces` |
| `repository/allocation.ts` | `candidateWhere` loại kiện chờ thay; `lockAllocationCandidates` lọc theo đơn |
| `repository/packing.ts` | `packingColumns` thêm `needsOpen`, `waybillKept` |
| `service/resplit.ts` (mới) | `applyResplit`, `takeOverReplaced` |
| `service/platform-packages.ts` | Xem trước kế hoạch, advisory, `createPackage` nhánh chia lại, vòng áp trạng thái theo `targets`, `markWholePendingDrop` |
| `service/allocation.ts` | Tách `holdCandidates`, thêm `holdOrderReplacements` |
| `service/packing.ts` | `openPackage`, `packPackage`, `markReady` |
| `service/handover.ts`, `service/lost.ts` | `awaiting_open`; xếp lượt cho kiện thay sau `lose_on_unload` |
| `api/schemas.ts`, `service/views.ts` | `PackageSummary.replaces` |
| `src/modules/order/sales/service/ingest.ts` | Note D29 |
| `db/migrations/*` | Task 6 |
| `src/modules/order/fulfillment/CLAUDE.md` | Task 6 |

---

### Task 0: Nhánh, môi trường, tài liệu

- [ ] **Step 1:** Trong worktree: `npm ci`. Thiếu `drizzle-kit` thì tạo junction như `local-env-quirks` (PowerShell `New-Item -ItemType Junction -Path <worktree>\node_modules\drizzle-kit -Target D:\DA-TMDT\commerio-backend\node_modules\drizzle-kit`). Docker Desktop bật.
- [ ] **Step 2:** `npx vitest run --project unit` xanh trên nền trước khi sửa.
- [ ] **Step 3:** `git add docs/superpowers && git commit -m "#238: spec mục 5.6 viết lại cho PR 3, kế hoạch PR 3 (chia lại kiện)"`.

### Task 1: Luật thuần lập kế hoạch chia lại, mũi tên `replaced`

**Files:**
- Create: `domain/resplit.ts`
- Modify: `domain/package.ts`
- Test: `test/unit/modules/order/fulfillment/domain/resplit.test.ts` (mới), `test/unit/modules/order/fulfillment/domain/package.test.ts`

**Interfaces (Produces):**

```ts
// domain/resplit.ts (chỉ import ./package.ts)
export interface ResplitLine { id: string; orderLineId: string; quantity: number; pendingDropQty: number }
export interface ResplitPackage { id: string; code: string; status: PackageStatus; platformPackageCode: string | null; lines: readonly ResplitLine[] }
/** Nhóm xét chia lại: có mã sàn, trạng thái biết và khác `cancelled` (bên gọi lọc). */
export interface ResplitGroup { code: string; lines: readonly { orderLineId: string; quantity: number }[] }
export type ResplitStep =
  | { kind: 'clear_code'; packageId: string }
  | { kind: 'relabel'; packageId: string; code: string }
  | { kind: 'flag'; packageId: string }
  | { kind: 'cancel_open'; packageId: string }
  | { kind: 'move_out'; packageId: string; orderLineIds: string[] }
  | { kind: 'mark_drop'; packageId: string; orderLineIds: string[] }
  | { kind: 'create'; code: string; replacesPackageId: string; awaitingOpen: boolean };
export interface ResplitPlan {
  /** Mã nhóm → id kiện đã có nhận nhóm (khớp theo tập, hoặc giữ mã cũ). Nhóm `create` không có ở đây. */
  targets: Map<string, string>;
  steps: ResplitStep[];
  /** Có phần app không tự xử lý (D29): bên gọi bật Cần xử lý trên đơn. */
  resplit: boolean;
}
export function planResplit(packages: readonly ResplitPackage[], groups: readonly ResplitGroup[]): ResplitPlan;
export interface ReplacementPair { newLineId: string; oldLineId: string; oldPackageId: string }
/** Dòng sống của kiện ghép với dòng chờ bỏ cùng dòng đơn ở kiện khác đang đóng (D9). Rỗng: không phải kiện chờ thay. */
export function replacementPairs(packages: readonly ResplitPackage[], packageId: string): ReplacementPair[];

// domain/package.ts
export type PackageAction = /* cũ */ | 'replaced';
// mũi tên mới, đặt NGAY SAU `open_cancel`: { from: SEALED, to: 'cancelled', action: 'replaced', system: true }
```

Điểm chốt: thuật toán đúng spec mục 5.6 "Luật thuần" (bước 0 đến 4) và D22. Chi tiết dễ sai:
- So tập bằng khoá chuẩn hoá (cặp `orderLineId:quantity` sắp xếp). Kiện sống = `status !== 'cancelled'`; dòng sống = `pendingDropQty === 0`.
- Bước 1 không gắn lại mã cho kiện `isHandedOver`. Kiện khớp ở bước 1 mà sẽ đổi mã thì mã cũ của nó coi như trống ở bước 2.2.
- Bước 2 duyệt nhóm theo `code` tăng dần; `flag` mỗi kiện một lần.
- `replacesPackageId`: kiện chứa nhiều món của nhóm nhất, hoà thì `code` (mã app) nhỏ hơn. `awaitingOpen`: có món mà chủ `isSealed`.
- Bước 3 chỉ xét kiện sống chưa bàn giao; `cancel_open` khi mọi dòng sống của kiện chuyển đi, không thì `move_out`; kiện đã đóng luôn `mark_drop`. `orderLineIds` theo thứ tự dòng của kiện.
- Không lập (bước 0, 2.2): trả `{ targets: new Map(), steps: [], resplit: true }`.

- [ ] **Step 1: Viết test** (`resplit.test.ts`; dựng kiện, nhóm bằng hàm nhỏ trong file test):

```ts
it('nhóm trùng tập dòng của kiện chưa bàn giao, mã khác: chỉ relabel, targets trỏ kiện đó')
it('kiện tạm (mã null) khớp tập: relabel')
it('hai kiện đổi mã cho nhau: hai relabel, không create')
it('kiện đã bàn giao khớp tập mà mã khác: nhận nhóm, không relabel')
it('kiện reserved 2 món chia thành 2 mã mới: cancel_open kiện cũ, 2 create replaces kiện cũ, awaitingOpen false')
it('sàn giữ mã cũ cho món 1, món 2 sang mã mới: targets[mã cũ] = kiện cũ, move_out món 2, 1 create')
it('kiện packed chia thành 2 mã mới: mark_drop mọi dòng, 2 create awaitingOpen true')
it('hai kiện chưa đóng về chung một mã mới: hai cancel_open, một create replaces kiện có nhiều món hơn (hoà thì mã nhỏ)')
it('sàn gộp món của kiện B vào mã của kiện A: không lập, resplit true')
it('một dòng đơn nằm ở hai nhóm: không lập, resplit true')
it('nhóm có món của kiện in_transit: flag kiện đó một lần, nhóm không create, resplit true')
it('mã nhóm đang nằm ở kiện đã huỷ: clear_code kiện huỷ rồi create')
it('món chưa có mã sàn (không trong nhóm nào) ở lại kiện: kiện cũ move_out phần chuyển đi, không cancel_open')
it('dòng chờ bỏ không tính vào tập: kiện packed có một dòng chờ bỏ vẫn khớp nhóm gồm các dòng còn lại')
it('thứ tự bước: clear_code, relabel, flag, cancel_open, move_out, mark_drop, create')
it('áp kế hoạch bằng tay rồi lập lại: steps rỗng (gọi lặp)')
it('replacementPairs: kiện mới ghép với dòng chờ bỏ ở kiện packed; kiện cũ đã cancelled hay reserved thì rỗng')
```

`package.test.ts`: `replaced` đi `packed`, `awaiting_pickup` → `cancelled`, chỉ hệ thống; `arrowAction('packed', 'cancelled')` vẫn ra `open_cancel`.

- [ ] **Step 2:** `npx vitest run --project unit test/unit/modules/order/fulfillment/domain` → FAIL.
- [ ] **Step 3:** Cài theo Interfaces và điểm chốt.
- [ ] **Step 4:** Chạy lại → PASS. `npx tsc --noEmit -p .` sạch.
- [ ] **Step 5:** `git commit -m "#238: luật thuần lập kế hoạch sàn chia lại kiện, mũi tên replaced"`.

### Task 2: Cột mới, đồng bộ sàn chia lại kiện chưa đóng

**Files:**
- Modify: `repository/schema.ts`, `repository/packages.ts`, `service/platform-packages.ts`, `api/schemas.ts`, `service/views.ts`, `src/modules/order/sales/service/ingest.ts`
- Create: `service/resplit.ts`
- Test: `test/integration/order/fulfillment/resplit-sync.test.ts` (mới); sửa `split-sync.test.ts`, `test/integration/order/sales/ingest.test.ts`, `test/integration/channel/channel/tiktok-order-pull.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:

```ts
// repository/schema.ts, bảng packages
replacesPackageId: uuid('replaces_package_id').references((): AnyPgColumn => packages.id),
waybillKept: boolean('waybill_kept').notNull().default(false),
// extra: index().on(t.replacesPackageId).where(sql`${t.replacesPackageId} is not null`),
//        check('packages_waybill_kept', sql`not ${t.waybillKept} or (${t.platformPackageCode} is not null and ${t.trackingCode} is not null)`)

// repository/packages.ts
export interface PackageRow extends HandoverPackage { /* cũ */ replacesPackageId: string | null; waybillKept: boolean }
export function readOrderPackages(orderId: string): Promise<PackageRow[]>;     // như lockOrderPackages, không FOR UPDATE
export function lockOrderPackages(orderId: string): Promise<PackageRow[]>;     // giữ chữ ký, thêm hai cột
// insertPackage input thêm: replacesPackageId?: string
// updatePackage patch thêm: waybillKept?: boolean
export function moveReservations(pairs: readonly { fromLineId: string; toLineId: string }[]): Promise<void>; // dòng đích nhận reserved_qty của dòng nguồn, rồi xoá dòng nguồn; một câu update + một câu delete
export type PackageViewRow = typeof packages.$inferSelect & { lines: /* cũ */; replaces: { id: string; code: string; status: PackageStatus } | null };

// service/platform-packages.ts
async function createPackage(order, code, status, lines, journey,
  resplit?: { replacesPackageId: string; replacesCode: string; hold: boolean }): Promise<PackageRow>;

// service/resplit.ts
export const RESPLIT_HANDED_OVER_NOTE = 'Sàn chia lại kiện đã bàn giao';
export async function applyResplit(
  order: PlatformPackageOrder,
  plan: ResplitPlan,
  packages: PackageRow[],                                   // đã khoá; hàm sửa tại chỗ (lines, mã, trạng thái) và push kiện mới
  create: (code: string, replacesPackageId: string, awaitingOpen: boolean) => Promise<PackageRow>,
): Promise<{ created: Map<string, PackageRow>; releasedVariantIds: string[] }>;
// api/schemas.ts PackageSummary thêm
replaces: z.object({ id: z.uuid(), code: z.string(), status: z.enum(PACKAGE_STATUS) }).nullable()
// sales/service/ingest.ts
const RESPLIT_NOTE = 'Sàn chia lại kiện, app chưa tự xử lý được';
```

Điểm chốt:
- **Gom nhóm**: tách phần gom nhóm hiện có của `syncPlatformPackages` thành hàm thuần trong file `groupsOf(packages, lines): Map<key, { code: string; lines: PlatformPackageLine[] }>` (khoá: mã sàn, không mã thì `\u0000<id kiện app>` như cũ), tự tính tập món bị xử lý bằng huỷ dòng qua `planLineCancel` (không ghi). Nhóm xét chia lại = nhóm có mã, `groupStatus` khác null và `'cancelled'`, có món mà chủ là kiện sống (dòng sống). Đổi sang `ResplitPackage`/`ResplitGroup` bằng một hàm nhỏ.
- **Xem trước và khoá**: đầu `syncPlatformPackages`: `readOrderPackages` → kế hoạch (bỏ món `isLineCancel` khỏi dòng sống của kiện và khỏi nhóm) → có bước thì `takeAllocationLock(requireCompanyId(...))` → `lockOrderPackages` → vòng huỷ dòng như cũ → lập lại kế hoạch trên kiện đã khoá (sau huỷ dòng). Kế hoạch có bước mà chưa lấy advisory: không thi hành, coi như `targets` chỉ gồm nhóm khớp ở bước 1, nhóm còn lại bỏ qua, log `warn` "chia lại kiện để lượt sau".
- **`applyResplit`** thi hành theo spec mục 5.6 "Thi hành": hai pha mã; `flag` chỉ khi kiện chưa `needsAttention`; `cancel_open` nhả `reserved_qty` thật qua `stockPort().release`, `setReserved(false)`, `updatePackage({ status: 'cancelled' })`, `recordTransition({ action: 'cancel', source: 'marketplace', reason: 'Sàn chia lại kiện' })`, `package_status_changed`; `move_out` giống `dropLines` hiện có nhưng lý do "Sàn chia lại kiện: chuyển <n> món" và không ghi `cancelledLines`; `create` gọi callback; trả SKU đã nhả.
- **`mark_drop` thuộc Task 3.** Trong Task 2, kế hoạch có bước `mark_drop` thì không thi hành cả kế hoạch (như "để lượt sau", log `warn`); Task 3 bỏ chốt chặn này.
- **`owner`** của đường cũ chỉ gồm dòng sống của kiện sống (trước đây gồm cả dòng của kiện đã huỷ, nên sau khi chia lại thì món có hai "chủ"). Hành vi đường cũ không đổi với các test hiện có (món đã huỷ đủ vẫn bỏ qua theo `alreadyCancelled`).
- **`createPackage` nhánh chia lại**: `initial = 'backordered'`; `wantsStock = resplit.hold && order.holdStock`; lối "toàn dòng không quản tồn coi như giữ được" chỉ khi `resplit.hold`; ghi `replacesPackageId`; lịch sử `create` lý do `Sàn chia lại kiện ${replacesCode}`. Không đi nhánh `store_only`, `settleHandover`, `reportDelivered` của kiện lần đầu thấy.
- **Vòng áp trạng thái**: nhóm xét chia lại lấy kiện từ `plan.targets` hoặc `created`; nhóm xét chia lại không có đích (bị `flag` hay để lượt sau) thì `continue`. Nhóm khác (không mã, `cancelled`, trạng thái lạ, không món nào có chủ) giữ cách tìm cũ, kể cả nhánh `if (!pkg) { … result.resplit = true; continue }` (chỉ còn tới được với nhóm `cancelled`/lạ). Bỏ dòng đặt `result.resplit = true` khi món của nhóm thuộc kiện khác (`platform-packages.ts:565`); `result.resplit ||= plan.resplit`; có bước thì `result.changed = true`. Dòng gắn mã khi đang null (`:537`) giữ nguyên (kiện đích đã `relabel` thì mã trong bộ nhớ khác null, không ghi lại).
- **Cuối lượt**: `requestAllocation(releasedVariantIds)`; `logger.info({ orderId, steps: plan.steps.map((s) => s.kind) }, 'áp kế hoạch sàn chia lại kiện')`.
- **View**: `attachViewLines` thêm một câu đọc `{ id, code, status }` của các `replacesPackageId` khác null (bỏ qua khi không có); `toPackageSummary` trả `replaces: p.replaces`.
- **Sales**: note `RESPLIT_NOTE` thay "Sàn chia lại kiện khác lần trước".

- [ ] **Step 1: Viết test** `resplit-sync.test.ts` (dựng bằng `setup`, `remote`, `ingest` của `platform-fixtures.ts`; đổi `packageCode` của món giữa hai lần `ingest`):

```ts
it('AC12: sàn đổi mã gói, tập món không đổi: chỉ platform_package_code đổi, không kiện huỷ hay lập, đơn không cờ')
it('AC12: hai kiện của đơn đổi mã cho nhau: cả hai nhận mã mới, không vi phạm unique')
it('AC13: kiện reserved 2 món chia thành 2 mã mới: kiện cũ cancelled (lịch sử cancel, lý do Sàn chia lại kiện), 2 kiện mới reserved có replaces, available trước và sau bằng nhau, đơn không cờ')
it('AC13a: sàn giữ mã cũ cho món 1: kiện cũ reserved 1 món (lịch sử drop_lines), kiện mới reserved 1 món')
it('AC14: kiện backordered của đơn khác chờ cùng SKU: kiện mới của đơn này giữ được, kiện kia vẫn backordered')
it('AC14a: hai kiện app chưa đóng về chung một mã mới: hai kiện cũ cancelled, một kiện mới reserved, đơn không cờ')
it('AC14a: sàn gộp món của kiện B vào mã kiện A: không đổi kiện nào, đơn needs_attention với note Sàn chia lại kiện, app chưa tự xử lý được')
it('AC17: kiện in_transit, sàn báo chia khác: kiện và đơn bật Cần xử lý, không lập kiện')
it('AC18: kéo lại sau mỗi ca trên: version các kiện không đổi, không kiện mới, không lịch sử mới')
it('Review 1: hai đơn chung một mã kiện sàn, đơn A chia lại: kiện của đơn B không đổi')
it('Review 2: gian hàng chờ kiểm kê đầu kỳ (holdStock false) bị chia lại: kiện mới backordered, không gọi reserve')
it('GET /packages/:id của kiện mới trả replaces { id, code, status: cancelled }')
```

Sửa test cũ:
- `tiktok-order-pull.test.ts`: bỏ `it.skip` và comment lý do; `packagesOf` thêm `and p.status <> 'cancelled'`; thêm khẳng định kiện mã `PK-1` của đơn là `cancelled` (AC13b).
- `split-sync.test.ts` ca "món của hai kiện app về chung một mã sàn vẫn bật Sàn chia lại kiện" → "…về chung một mã sàn mới: hai kiện cũ huỷ, một kiện mới theo sàn, đơn không cờ".
- `ingest.test.ts` ca "cùng lượt sàn chia lại kiện" → dựng đơn 2 món 2 mã (`remote(v, { lines: 2, packages: 2 })`), lượt sau đưa cả hai món vào mã của món đầu (gộp vào mã kiện cũ); note mới.

- [ ] **Step 2:** Sinh migration **tạm** sau khi sửa `schema.ts`: `npm run db:generate -- --name tam-chia-lai-kien` (không commit). Chạy `npx vitest run --project integration test/integration/order/fulfillment/resplit-sync.test.ts` → FAIL.
- [ ] **Step 3:** Cài theo Interfaces và điểm chốt.
- [ ] **Step 4:** `npx vitest run --project integration test/integration/order test/integration/channel` → PASS (kể cả `split-sync`, `ingest`, `tiktok-order-pull`, `platform-*`).
- [ ] **Step 5:** `git add src test && git commit -m "#238: đồng bộ sàn chia lại kiện chưa đóng: khớp theo tập, huỷ hoặc bớt dòng, lập kiện mới giữ hàng trước"` (không add `db/migrations`).

### Task 3: Kiện cũ đã đóng, kiện chờ thay, kiện thay được lấy trước

**Files:**
- Modify: `service/resplit.ts`, `service/platform-packages.ts`, `repository/allocation.ts`
- Test: `test/integration/order/fulfillment/resplit-sync.test.ts` (thêm)

**Interfaces:**
- Consumes: `replacementPairs` (Task 1), `moveReservations`, `PackageRow.waybillKept` (Task 2).
- Produces:

```ts
// service/resplit.ts
/** Kiện chờ thay mà sàn báo rời kho (spec 5.6): chuyển phần giữ từ dòng chờ bỏ của kiện cũ, kiện cũ hết dòng thì `replaced`. */
export async function takeOverReplaced(order: PlatformPackageOrder, pkg: PackageRow, packages: PackageRow[]): Promise<boolean>; // true khi có ghi
// repository/allocation.ts: hằng SQL dùng trong candidateWhere
const awaitingReplacement = sql`exists (select 1 from ${packageLines} nl
  join ${packageLines} ol on ol.order_line_id = nl.order_line_id and ol.package_id <> nl.package_id and ol.pending_drop_qty > 0
  join ${packages} op on op.id = ol.package_id and op.status in ('packed', 'awaiting_pickup')
  where nl.package_id = ${packages.id})`;   // candidateWhere thêm `not ${awaitingReplacement}`
```

Điểm chốt:
- Bỏ chốt chặn "kế hoạch có `mark_drop` thì để lượt sau" của Task 2.
- `mark_drop`: `setPendingDrop(lineIds)`; mục đích theo D24 (`!needsOpen` → `{ needsOpen: true, openPurpose: 'resplit' }`; `edit`, `stocktake` → `{ openPurpose: 'resplit' }`; `cancel`, `resplit` giữ, chỉ tăng `version` bằng `updatePackage(id, {})`); cập nhật `pkg` trong bộ nhớ.
- `create` với `awaitingOpen` → `hold: false`.
- `markWholePendingDrop`: điều kiện nâng lên `cancel` thêm `'resplit'`.
- Vòng áp trạng thái: trước `applyStatus` của kiện mà `isHandedOver(deliveryTarget(status, { firstSeen: false, storeOnly: false }))` và `replacementPairs(...)` khác rỗng → `takeOverReplaced`. Bên trong: `moveReservations`; cập nhật dòng trong bộ nhớ của cả hai kiện; kiện cũ hết dòng → `assertTransition(packageMachine, from, 'replaced', { actor: null })`, `updatePackage({ status: 'cancelled', needsOpen: false, openPurpose: null, packedBy: null, packedAt: null, labelError: false })`, `recordTransition({ action: 'replaced', source: 'marketplace', reason: \`Kiện thay ${pkg.code} đã được lấy\` })`, `package_status_changed`; còn dòng, hết dòng chờ bỏ, mục đích `resplit` → gỡ cờ. `logger.warn` "kiện thay được lấy trước khi dỡ kiện cũ".
- `variantsInPlay` dùng `candidateWhere` nên tự loại kiện chờ thay; không sửa thêm.

- [ ] **Step 1: Viết test** (thêm vào `resplit-sync.test.ts`; kiện `packed` dựng bằng `remote(v, { status: 'packed' })`):

```ts
it('AC15: kiện packed chia thành 2 mã: kiện cũ packed, vẫn giữ, needs_open resplit, dòng chờ bỏ; 2 kiện mới backordered có replaces')
it('AC15: chạy lượt phân hàng khi kho còn hàng: hai kiện chờ thay vẫn backordered')
it('AC15a: kiện packed đang chờ mở vì edit bị chia lại: open_purpose thành resplit; đang cancel thì giữ cancel')
it('AC15a: sàn huỷ cả kiện đang chờ mở vì resplit: open_purpose thành cancel, đơn cancelling')
it('AC16: sàn báo một kiện chờ thay đã in_transit: kiện mới in_transit, handover_source marketplace, tồn trừ đúng một lần, kiện cũ mất dòng đó')
it('AC16: kiện cũ hết dòng sau khi kiện thay được lấy: kiện cũ cancelled, lịch sử replaced, needs_open false')
it('AC18: kéo lại sau AC15, AC16: không đổi gì')
it('Review 3: nhóm gồm món của kiện packed và kiện reserved: kiện thay không giữ lúc lập; khi được lấy, dòng từ kiện packed nhận phần giữ, dòng kia giữ lại được thì không forced')
it('Review 4: kiện chờ thay chỉ có dòng không quản tồn: backordered lúc lập, không reserved')
```

- [ ] **Step 2:** Chạy file test → FAIL ở các ca mới.
- [ ] **Step 3:** Cài.
- [ ] **Step 4:** `npx vitest run --project integration test/integration/order` → PASS.
- [ ] **Step 5:** `git commit -m "#238: kiện cũ đã đóng chờ dỡ để chia lại, kiện chờ thay, kiện thay được lấy trước"`.

### Task 4: Mở kiện cũ, giữ vận đơn, kiện thay giữ hàng trước

**Files:**
- Modify: `service/packing.ts`, `repository/packing.ts`, `service/allocation.ts`, `repository/allocation.ts`, `service/lost.ts`, `repository/packages.ts`
- Test: `test/integration/order/fulfillment/resplit-open.test.ts` (mới); `packing-actions.test.ts` (sửa ca `awaiting_pickup` 409)

**Interfaces:**
- Consumes: Task 2, Task 3.
- Produces:

```ts
// service/allocation.ts
/** Bước giữ hàng của một lượt, tách từ runAllocation; bên gọi đã giữ advisory. */
async function holdCandidates(candidates: LockedAllocationCandidate[]): Promise<{ held: string[]; touched: string[] }>;
/** Giữ ngay cho kiện của một đơn vừa hết chờ thay (D26); trong advisory của bên gọi; bỏ gian hàng chờ kiểm kê. */
export async function holdOrderReplacements(ctx: AllocationContext, orderId: string, variantIds: readonly string[]): Promise<string[]>;
// repository/allocation.ts
export function lockAllocationCandidates(variantIds: readonly string[], excludeShopIds?: readonly string[], opts?: { orderId?: string }): Promise<LockedAllocationCandidate[]>;
// repository/packing.ts: packingColumns thêm needsOpen, waybillKept
// repository/packages.ts, updatePackage: patch.status ngoài ('backordered','reserved','packed') và patch.waybillKept === undefined → waybillKept: false
```

Điểm chốt (spec mục 5.6 "Mở kiện", D24 đến D26):
- `openPackage` bước kiểm: `awaiting_pickup` mà `!pkg.needsOpen` → 409 `invalid_transition` như cũ; có cờ thì đi tiếp. `keepWaybill = pkg.status === 'awaiting_pickup' || pkg.waybillKept`. `noRepack = keepWaybill || pkg.openPurpose === 'resplit'`. Trả thêm `purpose`, `keepWaybill`, `noRepack`.
- Gọi `repack` chỉ khi `!target.cancel && !target.noRepack && shopId && code`.
- Bước ghi: `target.purpose === 'resplit'` → `takeAllocationLock(companyId)` **trước** `readPackage(id, true)`. `open_cancel`: như cũ; `resplit` thì không trả `cancelledOrderId` (không khép đơn). `open`: gỡ cờ khi `stocktake || resplit || dropped.length > 0`; `keepWaybill` và kiện có cả mã kiện sàn lẫn vận đơn → không xoá mã, ghi `waybillKept: true`. `kept` (xếp lượt cho dòng còn lại) khi `stocktake || resplit`.
- Sau khi nhả dòng chờ bỏ của kiện `resplit` (cả `open` lẫn `open_cancel`): `holdOrderReplacements(ctx, pkg.orderId, released)`, rồi `requestAllocation([...released, ...kept])` như cũ.
- `holdCandidates` giữ đúng hành vi bước 3 của `runAllocation` (gỡ cờ `stocktake` và cờ dạng cũ khi giữ được, `movePackage` `hold`, `reserved_at` giờ DB); test phân hàng hiện có phải xanh nguyên.
- `packPackage`: `pkg.waybillKept` → không gọi `pack` của sàn (`target = null`), bước ghi không ghi đè `platformPackageCode`, `trackingCode`, `carrierCode`, `carrierName`.
- `markReady`: `pkg.waybillKept` → không gọi `readyToShip`; bước ghi chuyển `packed → awaiting_pickup` như cũ (luật `updatePackage` tự tắt `waybill_kept`).
- `lost.ts`, nhánh `lose_on_unload`: sau `settleHandover`, `requestAllocation` cho SKU của các dòng `pendingDropQty > 0` của kiện (D20, AC 11c).

- [ ] **Step 1: Viết test** `resplit-open.test.ts` (dựng chia lại như Task 3 rồi gọi route bằng `packingApp({...})`; chỉ truyền hàm sàn được phép gọi):

```ts
it('AC15: kho mở kiện cũ resplit (mọi dòng chờ bỏ): kiện cũ cancelled, không gọi repack, đơn không khép, 2 kiện thay reserved')
it('AC15: kiện thay của đơn giữ hàng trước kiện backordered của đơn khác cùng SKU')
it('AC15: mở kiện cũ resplit còn dòng (sàn giữ mã cũ): về reserved, không gọi repack, dòng chờ bỏ xoá, kiện thay reserved')
it('AC19: kiện awaiting_pickup chờ mở vì edit, mở còn món: reserved, giữ mã kiện sàn, vận đơn, ĐVVC, waybill_kept true, không gọi repack')
it('AC19: đóng gói lại rồi báo sẵn sàng kiện waybill_kept: không gọi pack, readyToShip; kiện awaiting_pickup với vận đơn cũ, waybill_kept false')
it('AC19: kiện awaiting_pickup không có cờ Cần mở: open 409 invalid_transition')
it('AC11c: kiện cũ packed chờ mở resplit bị xác nhận mất (lose_on_unload): tồn trừ mọi món trong hộp một lần, xếp lượt cho SKU dòng chờ bỏ, chạy lượt thì kiện thay reserved khi đủ hàng, kiểm bằng không vỡ')
it('Review 5: kéo lại ngay sau khi kho mở kiện cũ: không đổi kiện nào, không clear_code')
```

"Chạy lượt": gọi `runAllocation` trong `withCompany` như các test phân hàng hiện có.

- [ ] **Step 2:** Chạy file test → FAIL.
- [ ] **Step 3:** Cài.
- [ ] **Step 4:** `npx vitest run --project integration test/integration/order` → PASS (kể cả `packing-actions`, `stocktake-open`, `allocation*`, `lost`).
- [ ] **Step 5:** `git commit -m "#238: mở kiện awaiting_pickup giữ vận đơn, mở kiện cũ resplit thì kiện thay giữ hàng trước"`.

### Task 5: Kiện đang chờ mở: chặn báo sẵn sàng và quét bàn giao, sàn báo rời kho

**Files:**
- Modify: `repository/packages.ts`, `service/packing.ts`, `service/handover.ts`
- Test: `test/integration/order/fulfillment/resplit-open.test.ts` (thêm), `hand-over.test.ts`, `stocktake-open.test.ts` (ca rời kho của `stocktake` giữ nguyên hành vi)

**Interfaces (Produces):**

```ts
// repository/packages.ts: thay stocktakeFlagRules
export const LEFT_WHILE_AWAITING_OPEN_NOTE = 'Sàn báo kiện rời kho khi còn chờ dỡ kiện về kệ';
function openFlagRules(patch: { status?: PackageStatus; needsOpen?: boolean; openPurpose?: unknown; needsAttention?: boolean; flagNote?: unknown }): Record<string, SQL>;
```

Điểm chốt (D27, D28):
- `openFlagRules`: chỉ khi `patch.status` ngoài `SEALED` và bên gọi không ghi `needsOpen`/`openPurpose`: `needs_open = false`, `open_purpose = null` (mọi giá trị cũ); `needs_attention = case when open_purpose in ('cancel','edit','resplit') then true else needs_attention end`; `flag_note = case when open_purpose in ('cancel','edit','resplit') and not needs_attention then '<note>' else flag_note end` (bên gọi ghi `needsAttention`/`flagNote` tường minh thì thắng). Luật xoá báo cáo thất lạc D21 không đổi.
- `markReady` bước kiểm: `pkg.needsOpen` → `AppError(409, 'awaiting_open', 'Kiện đang chờ dỡ kiện về kệ, mở kiện trước')`, kiểm sau `version` và máy trạng thái.
- `handOverOne`: sau `assertTransition`, `pkg.needsOpen` → cùng lỗi (vào `failed[].code`).

- [ ] **Step 1: Viết test:**

```ts
it('AC19a: ready kiện packed có cờ Cần mở: 409 awaiting_open, không gọi readyToShip')
it('AC19a: quét bàn giao kiện awaiting_pickup có cờ Cần mở: failed[].code awaiting_open, kiện không đổi, tồn không đổi')
it('AC19b: sàn báo kiện packed chờ mở resplit đã in_transit: in_transit, trừ mọi dòng một lần, needs_open false, needs_attention với note rời kho; kiện thay thành ứng viên')
it('kiện chờ mở vì stocktake rời kho: gỡ cờ, không bật Cần xử lý (như PR 2)')
```

- [ ] **Step 2:** Chạy → FAIL. **Step 3:** Cài. **Step 4:** `npx vitest run --project integration test/integration/order` → PASS.
- [ ] **Step 5:** `git commit -m "#238: chặn báo sẵn sàng, quét bàn giao kiện đang chờ mở; sàn báo rời kho thì gỡ cờ, bật Cần xử lý"`.

### Task 6: Migration, tài liệu module, kiểm toàn bộ

- [ ] **Step 1:** Xoá migration tạm (`git checkout -- db/migrations && git clean -fd db/migrations`). `git fetch origin`; `main` có migration mới thì `git merge origin/main` rồi `npm run db:regen` theo `db/CLAUDE.md`.
- [ ] **Step 2:** `npm run db:generate -- --name chia-lai-kien`. File chỉ được có: hai `ADD COLUMN` (`replaces_package_id`, `waybill_kept`), `ADD CONSTRAINT … FOREIGN KEY` tự tham chiếu, `CREATE INDEX … WHERE replaces_package_id IS NOT NULL`, `ADD CONSTRAINT packages_waybill_kept CHECK`. Có câu khác thì `schema.ts` lệch: dừng, tìm nguyên nhân, không sửa tay SQL.
- [ ] **Step 3:** `npm run db:ci-check -- --base origin/main` → xanh.
- [ ] **Step 4:** Cập nhật `src/modules/order/fulfillment/CLAUDE.md`: mục mới "Sàn chia lại kiện (#238 PR 3)" (kế hoạch, thi hành, kiện chờ thay, khoá); sửa mục Đóng gói (`open` nhận `awaiting_pickup` có cờ, `waybill_kept`, không `repack`), bảng route (`open`, `ready`, `hand-over` thêm `awaiting_open`), mục Phân hàng (loại kiện chờ thay, `holdOrderReplacements`), mục Đồng bộ giữ cách chia của app (bỏ câu "món của hai kiện app về chung một mã vẫn là Sàn chia lại kiện"), Giới hạn đã biết (gỡ các dòng "để PR 3", "chờ dỡ kiện về kệ của #238", "chưa chặn"; thêm rủi ro D27 và kiện thay lẫn nguồn ở spec mục 10). Mô tả PR ghi lùi migration (spec mục 5.1 PR 3).
- [ ] **Step 5:** Trong worktree: `npm run check` → xanh (lint, typecheck, depcruise, test). Lỗi chỉ ở test không liên quan thì chạy riêng file đó để xác nhận.
- [ ] **Step 6:** `git add -A db/migrations src test && git commit -m "#238: migration chia-lai-kien, tài liệu module"`. Không push.

### Task 7: Documents (repo `DA-EC-System/Documents`, nhánh `docs/238-chia-lai-kien`)

- [ ] **Step 1:** Sửa theo spec mục 8 phần PR 3: `25` §8.1 (D8, D22, D24), §8.3 (D27, D28); `21` §19.2 (`open`, `pack`, `ready`, `hand-over`, `awaiting_open`, `Package.replaces`, mũi tên `replaced`); `19` mục 2 (`replaces_package_id`, `waybill_kept`).
- [ ] **Step 2:** Commit, không push; PR Documents mở cùng lúc với PR backend, base `main`.

## Việc ngoài kế hoạch này

- FE (FE#284, Khoa): máy `order.ts` thêm `replaced`, bộ tên mới; `Package.replaces`; nút mở kiện `awaiting_pickup`; tắt Báo sẵn sàng, Quét bàn giao khi kiện có cờ Cần mở; sinh lại `ca-theo-so-do.md`, rồi backend gắn mã ca mới vào tên test.
- Nguồn nhắc (PR 4): sau #209.
- #237 PR 2 sửa `openPackage` sau PR này: giữ nhánh `resplit`, `waybill_kept`.
