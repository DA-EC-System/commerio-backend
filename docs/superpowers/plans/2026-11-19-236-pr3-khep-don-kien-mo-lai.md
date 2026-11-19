# #236 PR 3: khép đơn mọi kiện đã huỷ (`auto_cancel`, lưới đỡ), kiện mở lại sau hoàn tất — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đơn `processing` có mọi kiện `cancelled` không còn bị `completed` với `outcome = none`. Việc nền khép đơn đó sang `cancelled`: đơn sàn đi `platform_cancel`, đơn khác đi `auto_cancel`. Đơn còn món sống nằm ngoài mọi kiện thì giữ `processing`. Đơn `completed` có kiện đổi trạng thái vẫn giữ `completed`, `outcome` được tính lại, và bật Cần xử lý khi kiện thật sự mở lại.

**Architecture:**
- Luật thuần ở `sales/domain/order.ts`: máy trạng thái thêm `auto_cancel`, `complete` thêm guard, `completionBlocker` thêm giá trị `all_packages_cancelled`. Ba chỗ này khớp FE `src/lib/machines/order.ts`.
- Một hàm khép duy nhất `settleCancelledOrder(orderId): Promise<boolean>` (`sales/service/ingest.ts`), dùng cho cả lần mở kiện `open_cancel` của fulfillment lẫn việc nền.
- Việc nền (`sales/service/complete.ts`) đọc `all_packages_cancelled` thành bước khép.
- Consumer mới `sales-package-reopened` nghe `fulfillment.package_status_changed`.
- Không có migration, không có route mới.

**Tech Stack:** Node 24 chạy thẳng `.ts`, TypeScript 6, Drizzle ORM + PostgreSQL 18, Vitest. Khung sự kiện: `registerConsumer` (`core/index.ts`). Handler chạy trong `withCompany` của sự kiện, chống trùng theo `(consumer, eventId)`, thử lại sau 1 s, 5 s, 30 s rồi vào DLQ.

**Spec:** `docs/superpowers/specs/2026-11-18-236-hoan-tat-huy-theo-kien-design.md`.
- Các mục cần đọc: 5.1, 5.4, 5.5, 5.7, 5.8, 6 (dòng PR 3), 9 (AC 18–29), 10.
- Các quyết định: D2, D3, D4, D9, D15, D16.
- Plan cũ viết trước #417 nằm ở nhánh local `feature/236-tu-huy-kien-mo-lai-cu`, không dùng nữa.

## Nền: `main` sau #417 (đọc trước khi làm)

#417 (`2f9c3680`) merge sau khi spec viết xong. Nó đổi những chỗ PR 3 dựa vào:

- **Cờ Đang huỷ:** giờ suy ra lúc đọc (`cancellingSql`, `isCancelling`), không còn là cột. Cột `cancel_pending` nghĩa là "lệnh huỷ cả đơn đang chờ sàn". `OrderViewRow.cancelling` là cờ suy ra, nên không dùng nó để chia nhánh khép đơn.
- **`settleCancelledOrder`** không đòi cờ nữa. Đơn còn mở, mọi dòng đã huỷ đủ, không còn kiện chưa huỷ thì đi `platform_cancel`, lý do lấy từ dòng (`platformCancelReason`). Hàm chép cứng `source: 'marketplace'` vào sự kiện.
- **Việc nền:** đơn mọi kiện huỷ có (`cancel_pending` hoặc mọi dòng đã huỷ) thì gọi `settleCancelledOrder`. Đây đã là lưới đỡ của AC23, có ca AC11b. Mọi trường hợp khác của đơn mọi kiện huỷ vẫn `completed` với `outcome = none`.
- **Cờ của sự kiện:** `storedFlags` đã thay bằng `eventFlags(orderId, row)` (bất đồng bộ, gồm `cancelling` và `unmapped_sku`).
- **Trigger `package_lines_line_total`** (`db/CLAUDE.md`): kiện sang `cancelled` thì dòng đơn của nó phải có `cancelled_qty = quantity`, trừ phần đang nằm ở kiện chưa huỷ khác. Hệ quả: đơn có mọi kiện huỷ thì mọi dòng có dòng kiện đều đã huỷ đủ. Dòng còn chưa huỷ chỉ có thể là dòng không nằm trong kiện nào, tức món mang trạng thái lạ (#358) hoặc nhóm bị bỏ qua vì chia lại (#238). Những đơn đó đã mang cờ Cần xử lý.
- **Nguồn ghi `cancelled_qty`:** hiện chỉ lượt kéo đơn sàn. Repo chưa có luồng tạo đơn tay, nhưng trigger buộc luồng huỷ đơn tay sau này cũng phải ghi `cancelled_qty`.

## Quyết định của plan (Khang xem khi duyệt)

- **P1.** Giữ tên `completionBlocker`. Thêm giá trị `'all_packages_cancelled'`, kiểm ngay sau `packages_open`, như FE. Việc nền coi `null` là bước hoàn tất và `'all_packages_cancelled'` là bước khép. Không tạo hàm `closingStep` (spec mục 11 để người làm chọn).
- **P2.** Chỉ khép khi mọi dòng đã huỷ đủ (`allLinesCancelled`), với mọi nguồn đơn.
  - Không đủ thì đơn giữ `processing`, chi tiết đơn báo `all_packages_cancelled`, việc nền chỉ đếm `cancelSkipped`.
  - Lý do: theo trigger, dòng chưa huỷ là món ngoài kiện mà sàn còn bán. Huỷ đơn lúc đó sẽ phát `sales.order_cancelled` sai cho finance.
  - Hành vi khác hiện tại: đơn này trước đây `completed` với `none`, giờ không còn (D16).
- **P3.** Một hàm khép `settleCancelledOrder(orderId): Promise<boolean>`, giữ tên và export. Kiểu `settleCancelledOrder?: (orderId) => Promise<void>` ở `fulfillment/service/packages.ts:32` giữ nguyên; typecheck báo lỗi thì đổi thành `Promise<unknown>`.
  - **Đơn sàn:** `platform_cancel` như hiện tại (D3).
  - **Đơn khác:** `auto_cancel`, lý do "Mọi kiện đã huỷ", lịch sử ghi `source = 'system'`, sự kiện `by: 'seller'`, `source` theo đơn.
  - **Lệch spec, cần Khang chốt:** spec 5.4 và D4 cho đơn sàn không cờ Đang huỷ đi `auto_cancel` với `by: 'platform'`. Sau #417 và trigger, đơn sàn có mọi kiện huỷ, mọi dòng huỷ luôn là do sàn huỷ hết món, nên theo D3 là `platform_cancel`; nhánh "đơn sàn không cờ" của spec không còn đơn nào. Task 4 sửa spec 5.4, D4, AC18 cho khớp.
  - Một hàm cho hai nguồn còn chặn một lỗi: `open_cancel` của đơn tay sau này không phát nhầm `source: 'marketplace'`.
- **P4.** `auto_cancel` gọi `assertTransition(orderMachine, 'processing', 'auto_cancel', { actor: null, record })`, để máy trạng thái là nơi duy nhất giữ guard `packages_not_cancelled`. Đơn `unpaid`, hoặc đơn không có kiện, thì hàm trả `false` trước khi gọi `assertTransition`.
- **P5.** `findCompletionCandidates` bỏ điều kiện `cancel_pending` (spec 5.4). `completeOne` bỏ nhánh "mọi kiện huỷ", vì nhánh đó giờ là blocker; vẫn giữ `allLinesCancelled` để bật `platform_cancelled` (#238).
- **P6.** Consumer làm theo thứ tự: `lockOrderRow` (khoá đơn) → `findOrder` (lấy `completedAt`, `outcome`) → `findPackagesOfOrders` → `updateOrder`. Đã khoá đơn nên không ghi theo `version`. Cờ của sự kiện dùng `eventFlags`.
- **P7.** Câu ghi chú: `` `Kiện ${code} đổi ${from ?? 'mới'} → ${to} sau khi đơn hoàn tất` ``, với `code` là mã kiện `KH-…`.
- **P8.** Quan sát:
  - Thêm counter `sales_orders_auto_cancelled_total` (số đơn việc nền khép).
  - Log của mỗi lượt thêm hai trường `cancelled` và `cancelSkipped`. Không log từng đơn bị bỏ qua, để không lặp mỗi giờ.
  - Consumer log `info` khi bật cờ, kèm `orderId`, `packageId`, `from`, `to`.

## Global Constraints

- **Nơi làm:** worktree `D:\DA-TMDT\commerio-backend\.claude\worktrees\236-pr3`, nhánh `feature/236-tu-huy-kien-mo-lai` tách từ `origin/main` `912a185a`; nhánh chưa đặt upstream. PR base là `main`.
- **Documents:** worktree mới `D:\DA-TMDT\Documents-236-pr3`, nhánh `docs/236-tu-huy-kien-mo-lai`, tách từ `origin/main` của repo Documents.
- **Ngôn ngữ, cú pháp:**
  - Định danh tiếng Anh. Comment, log, tên `describe`/`it`, ghi chú Cần xử lý viết tiếng Việt.
  - Import tương đối có đuôi `.ts`, test import bằng `#src/...ts`.
  - Không dùng `enum`, `namespace`, parameter property.
- **Ranh giới module:** sales chỉ gọi fulfillment và core qua `index.ts` (`findPackagesOfOrders`, `isStopped`, `publishEvent`, `recordTransition`, `registerConsumer`, `assertTransition`). Không so chuỗi trạng thái riêng của sàn.
- **Khớp FE** `src/lib/machines/order.ts`:
  - `allCancelled = packages.length > 0 && packages.every((s) => s === 'cancelled')`.
  - `complete` có guard `allCancelled ? 'all_packages_cancelled' : null`.
  - Mũi tên `{ from: 'processing', to: 'cancelled', action: 'auto_cancel', system: true, guard: allCancelled ? null : 'packages_not_cancelled' }`.
  - `completionBlocker` trả `'all_packages_cancelled'` ngay sau `'packages_open'`.
- **Consumer kiện mở lại:**
  - Không đổi trạng thái đơn, `completed_at`, `return_window_ends_at`.
  - Không đè `attention_note` của luồng khác. Ngoại lệ duy nhất: note bắt đầu bằng `UNKNOWN_STATUS_NOTE` (#358).
  - Chạy lại cùng sự kiện thì không ghi, không phát.
  - Không lọc sự kiện cũ ở lần deploy đầu (D15).
- **Test:**
  - Chỉ đặt trong `test/`, theo `test/CLAUDE.md`. Integration không giả định bảng trống.
  - Việc khép đơn quét mọi công ty, và file khác chạy nó theo giờ thật. Vì vậy chỉ kiểm trạng thái cuối mà mọi lượt đều ghi như nhau (trạng thái, lý do, lịch sử, số sự kiện). Không kiểm "lượt của chính ca này khép đơn".
  - Đơn phải đổi nhiều cột cùng lúc thì đổi trong **một** giao dịch: trigger kiểm lúc commit, và việc nền của file khác có thể chen vào giữa hai câu.
- **Chạy test:** integration cần Docker đang chạy. Worktree thiếu gói `drizzle-kit` (`db:ci-check` lỗi `MODULE_NOT_FOUND`) thì tạo junction như ghi chú máy Khang:
  `New-Item -ItemType Junction -Path <worktree>\node_modules\drizzle-kit -Target D:\DA-TMDT\commerio-backend\node_modules\drizzle-kit`.
- **Commit:** mỗi task một commit, tiêu đề `feat|fix|docs(sales): … (#236)`, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git add` từng đường dẫn; không add `.agents/`, `.codex/`, `AGENTS.md`.

## Thiết kế theo 6 bước (`think-before-coding`)

1. **Loại và tải:**
   - Việc nền mỗi giờ có sẵn: thêm bước khép cho đơn có blocker `all_packages_cancelled`. Hiện chỉ đơn có lần khép sau `open_cancel` bị lỗi rơi vào bước này, nên rất ít.
   - Consumer `shared` mới chạy trong worker, mỗi lần một kiện đổi trạng thái. Key là `orderId`, nên thứ tự sự kiện trong một đơn được giữ.
2. **Bất biến:**
   - Đơn `cancelled` không có `outcome`.
   - Đơn `completed` không đổi trạng thái.
   - Sau khi consumer chạy, `outcome` của đơn `completed` bằng `outcomeOf` của trạng thái kiện hiện tại.
   - Đơn có mọi kiện huỷ không bao giờ sang `completed`.
3. **Lỗi:**
   - Việc nền: một đơn lỗi thì log `error`, đếm `failedOrders` rồi đi tiếp, như hiện tại.
   - Consumer ném lỗi thì khung thử lại rồi đưa vào DLQ.
   - Đơn không thấy (RLS, đã xoá), hoặc không `completed`: bỏ qua, không ném.
4. **Quyền:**
   - Việc nền và consumer là hệ thống: `actorId` null, `source = 'system'`. Riêng `platform_cancel` giữ `source = 'marketplace'` như hiện tại.
   - `auto_cancel` là bước `system`: người dùng gọi thì nhận 409 `invalid_transition`.
5. **Chạy lặp, đồng thời:**
   - `settleCancelledOrder` khoá đơn rồi kiểm lại. Gọi hai lần (một từ `open_cancel`, một từ việc nền) thì chỉ huỷ và phát một lần; lần sau trả `false`.
   - Consumer khoá đơn trước, chỉ đọc kiện, cùng thứ tự "đơn trước kiện" với lượt kéo. Consumer tính theo trạng thái hiện tại, nên nhận lại hay nhận lệch thứ tự thì kết quả vẫn như nhau.
6. **Quan sát:** như P8.

## Review Focus

1. **Đơn sàn có mọi kiện huỷ, còn một dòng sống ngoài mọi kiện (P2).** Mong đợi: đơn giữ `processing`, không có `sales.order_cancelled`, không bị `completed`, lượt sau cũng không lỗi; chi tiết đơn báo `all_packages_cancelled`. Test: Task 2 (ca P2, AC24a).
2. **`open_cancel` và việc nền cùng khép một đơn.** Mong đợi: lần gọi thứ hai trả `false`, không thêm dòng lịch sử, không phát thêm `sales.order_cancelled`. Test: Task 1.
3. **Sự kiện kiện của một đơn không thấy được** (công ty khác qua RLS, hoặc id không tồn tại). Mong đợi: handler trả về, không ném; nếu ném, sự kiện vào DLQ sau 3 lần thử. Test: Task 3.
4. **Kiện mới tạo (`from: null`) của đơn `completed`.** Mong đợi: theo (b) của 5.5 thì bật cờ, note dùng chữ `mới`, không ném. Test: Task 3.
5. **Đơn tạo tay đi qua `settleCancelledOrder`.** Mong đợi: `auto_cancel`, sự kiện có `source: 'manual'` và `by: 'seller'`, không phải `'marketplace'`. Test: Task 1.

---

### Task 1: Máy trạng thái `auto_cancel`, một hàm khép cho mọi nguồn đơn

**Files:**
- Modify: `src/modules/order/sales/domain/order.ts`.
  - `OrderAction` thêm `'auto_cancel'`.
  - Thêm `allCancelled` và `AUTO_CANCEL_REASON`, đặt cạnh `PLATFORM_CANCEL_REASON`.
  - Guard của `complete`, mũi tên `auto_cancel`.
- Modify: `src/modules/order/sales/service/ingest.ts:219-241`: `settleCancelledOrder` đổi kiểu trả và JSDoc.
- Test: `test/unit/modules/order/sales/domain/order.test.ts`.
- Test (mới): `test/integration/order/sales/close-cancelled.test.ts`.

**Interfaces:**
- Produces:
  - `export const allCancelled = (packages: readonly PackageStatus[]): boolean`.
  - `export const AUTO_CANCEL_REASON = 'Mọi kiện đã huỷ'`.
  - `orderMachine` có `auto_cancel`.
  - `export async function settleCancelledOrder(orderId: string): Promise<boolean>`: `true` khi hàm vừa huỷ đơn. Gọi trong `withCompany`.

Thuật toán của `settleCancelledOrder`. Phần đơn sàn giữ nguyên code hiện tại, chỉ thêm `return true`:

```ts
const row = await lockOrderRow(orderId);
if (!row || (row.status !== 'unpaid' && row.status !== 'processing')) return false;
if (!(await allLinesCancelled(orderId))) return false;
const statuses = (await findPackagesOfOrders([orderId])).map((p) => p.status);
if (statuses.some((s) => s !== 'cancelled')) return false;
const order = (await findOrder(orderId))!; // source, paymentMethod (dòng đã khoá ở trên)
if (order.source === 'marketplace') { /* platform_cancel như hiện tại */ return true; }
if (row.status !== 'processing' || !allCancelled(statuses)) return false;
assertTransition(orderMachine, 'processing', 'auto_cancel', { actor: null, record: { source: order.source, paymentMethod: order.paymentMethod, packages: statuses } });
// recordTransition: action 'auto_cancel', source 'system', actorId null, reason AUTO_CANCEL_REASON
// updateOrder: status 'cancelled', cancelReason: row.cancelReason || AUTO_CANCEL_REASON, cancelPending false, cancelRequested false
// publish sales.order_cancelled { orderId, code, source: order.source, by: 'seller' }
// publish sales.order_status_changed { from: 'processing', to: 'cancelled', flags: await eventFlags(orderId, after) }
return true;
```

- [ ] **Step 1: Unit đỏ.** Thêm vào `describe('máy trạng thái đơn')`. `lazadaOrder`, `sale` là fixture có sẵn trong file.
  - `it('AC19 (D1-03): complete khi mọi kiện đã huỷ → all_packages_cancelled; có kiện không huỷ thì hoàn tất')`:
    - `assertTransition(orderMachine, 'processing', 'complete', { actor: null, record: { ...lazadaOrder, packages: ['cancelled', 'cancelled'] } })` ném lỗi khớp `expect.objectContaining({ code: 'all_packages_cancelled' })`.
    - Với `packages: ['cancelled', 'delivered']` thì `.to` là `'completed'`.
  - `it('AC20 (D1-10): auto_cancel chỉ khi có kiện và mọi kiện đã huỷ')`:
    - `['cancelled']` cho `.to === 'cancelled'`.
    - `['cancelled', 'returned']` và `[]` đều ném `packages_not_cancelled`.
  - `it('AC21 (D1-10x, D1-03x): người dùng gọi auto_cancel, complete → invalid_transition')`: dùng `actor: sale`, `record` có mọi kiện huỷ.
  - `it.each(['unpaid', 'completed', 'cancelled'] as const)('AC22 (D1-X01, X03, X04): %s gọi auto_cancel → invalid_transition')`: `actor: null`, `record` có mọi kiện huỷ.
- [ ] **Step 2: Integration đỏ.** Tạo file `close-cancelled.test.ts`, `describe('khép đơn mọi kiện đã huỷ (#236 PR 3)')`.
  - Dựng dữ liệu: một công ty `createCompany()`, biến thể `createVariant`. Đơn dựng bằng `seedPackage(companyId, { status: 'cancelled', orderStatus: 'processing', lines: [{ variantId, quantity: 1 }] })` (`../fulfillment/helpers.ts`; helper tự ghi `cancelled_qty`). Đơn tạo tay thêm `manual: true`; đơn sàn thì bỏ trường này.
  - Gọi hàm bằng `withCompany(companyId, () => settleCancelledOrder(orderId))`, import từ `#src/modules/order/index.ts`.
  - Đọc outbox bằng `outboxOf(orderId, type)` (`../fulfillment/helpers.ts`). Đọc lịch sử đơn bằng SQL `core.state_transitions` với `entity_type = 'orders'`.
  - `it('AC18, Review Focus 5: đơn tạo tay mọi kiện, mọi dòng đã huỷ → cancelled bằng auto_cancel')`, đơn có `manual: true`. Mong đợi:
    - Đơn `{ status: 'cancelled', cancel_reason: 'Mọi kiện đã huỷ', outcome: null }`.
    - Dòng lịch sử cuối `{ action: 'auto_cancel', from_state: 'processing', to_state: 'cancelled', source: 'system', actor_id: null }`.
    - `outboxOf(orderId, 'sales.order_cancelled')` bằng đúng `[{ orderId, code, source: 'manual', by: 'seller' }]`.
    - Có `sales.order_status_changed` với `to: 'cancelled'`.
  - `it('Review Focus 2: khép lại đơn đã khép → false, không ghi lịch sử, không phát thêm')`: gọi lại trên đơn của ca trên. Kết quả `false`; số dòng lịch sử và số `sales.order_cancelled` không đổi.
  - `it('D3: đơn sàn mọi kiện, mọi dòng đã huỷ → platform_cancel, Sàn huỷ đơn, by platform')`, không `manual`. Mong đợi lịch sử cuối `{ action: 'platform_cancel', source: 'marketplace' }`, `cancel_reason: 'Sàn huỷ đơn'`, sự kiện `{ source: 'marketplace', by: 'platform' }`.
  - **Không** kiểm giá trị trả của lần gọi đầu: việc nền của file khác có thể đã khép đơn trước (xem Global Constraints).
- [ ] **Step 3:** Chạy hai lệnh dưới. Ca AC19–22 đỏ vì chưa có `auto_cancel`; AC18 và Review Focus 5 đỏ vì đơn tay chưa được khép. Ca D3 xanh sẵn, giữ làm ca chặn hồi quy.
  - `npx vitest run --project unit test/unit/modules/order/sales/domain/order.test.ts`
  - `npx vitest run --project integration test/integration/order/sales/close-cancelled.test.ts`
- [ ] **Step 4:** Sửa code theo Interfaces và thuật toán ở trên. Sửa JSDoc của `settleCancelledOrder`: hai nguồn, trả `boolean`, việc nền gọi lại hàm này.
- [ ] **Step 5:** Chạy lại hai file trên, cộng `complete.test.ts`, `cancelling-handed-over.test.ts`, `test/integration/order/fulfillment/packing-actions.test.ts`, `stocktake-open.test.ts`. Tất cả phải xanh.
- [ ] **Step 6:** Commit `feat(sales): máy trạng thái đơn thêm auto_cancel; khép đơn mọi kiện huỷ cho mọi nguồn (#236)`.

### Task 2: Việc nền khép đơn, chi tiết đơn `all_packages_cancelled`

**Files:**
- Modify: `src/modules/order/sales/domain/order.ts:118-138`: `CompletionBlocker`, `completionBlocker`.
- Modify: `src/modules/order/sales/api/schemas.ts:187-190`:
  - Enum thêm `'all_packages_cancelled'`.
  - Description thêm "đơn có kiện và mọi kiện đã huỷ: việc nền huỷ đơn khi mọi món đã huỷ".
- Modify: `src/modules/order/sales/repository/orders.ts`: `findCompletionCandidates` bỏ câu điều kiện `cancel_pending`, sửa JSDoc (P5).
- Modify: `src/modules/order/sales/service/complete.ts`:
  - `dueOrdersOfCompany` trả thêm `step: 'complete' | 'close'`.
  - Lượt chạy gọi `settleCancelledOrder` cho bước `close`.
  - `completeOne` bỏ dòng 50–56.
  - Log, số liệu theo P8, comment đầu file.
- Modify: `src/modules/order/sales/service/metrics.ts`: counter mới; `recordAutoComplete({ completed, cancelled, failedOrders, skippedCompanies })`.
- Test: `test/unit/modules/order/sales/domain/order.test.ts`, `test/integration/order/sales/complete.test.ts`, `test/integration/order/sales/orders-api.test.ts`.

**Interfaces:**
- Consumes: `allCancelled`, `settleCancelledOrder` (Task 1).
- Produces:
  - `CompletionBlocker = 'packages_open' | 'all_packages_cancelled' | 'return_window' | 'return_requested' | 'cod_unconfirmed'`.
  - `completeDueOrdersOnce` giữ chữ ký và vẫn trả số đơn đã hoàn tất.
  - Helper test `export async function allCancelledWithLiveLine(companyId: string): Promise<{ orderId: string }>` ở `test/integration/order/sales/helpers.ts`. Helper tự tạo biến thể bằng `createVariant`.

- [ ] **Step 1: Unit đỏ.** Trong `it.each` của `completionBlocker`, thêm ba dòng:
  - `[{ packages: ['cancelled', 'cancelled'] }, 'all_packages_cancelled']`.
  - `[{ packages: ['cancelled'], openReturnRequests: 1, codUnconfirmed: true }, 'all_packages_cancelled']`.
  - `[{ packages: ['cancelled', 'reserved'] }, 'packages_open']`.
- [ ] **Step 2: Integration đỏ ở `complete.test.ts`,** khối `hạn trả theo gian hàng (#236)`. Dựng hai đơn mới trong `beforeAll`, trước lượt chạy đầu:
  - `id.ac18`: `seedPackage(companyId, { status: 'cancelled', manual: true, orderStatus: 'processing', lines: [{ variantId, quantity: 1 }] })`.
  - `id.lineAlive`: đơn sàn ở trạng thái "mọi kiện huỷ, còn một dòng sống ngoài kiện", dựng bằng helper mới `allCancelledWithLiveLine(companyId)` (đặt trong `test/integration/order/sales/helpers.ts`, Step 3 cũng dùng):
    - `seedPackage(..., { status: 'reserved', orderStatus: 'processing', lines: [{ variantId, quantity: 1 }] })`.
    - Sau đó, trong **một** giao dịch (`testPool().connect()`, `begin`/`commit`):
      - huỷ kiện (`status = 'cancelled'`);
      - ghi `cancelled_qty = quantity` cho dòng đơn của kiện;
      - chèn thêm một `order_lines` không thuộc kiện nào, `cancelled_qty = 0`. Câu SQL chép từ `test/integration/order/fulfillment/packing-actions.test.ts:525`.
    - Trigger `order_lines_line_total` không gắn vào `INSERT`.
  - Ca có sẵn `it('AC11b: …')` đổi tên thành `AC11b, AC23 (lưới đỡ): đơn sàn mọi dòng, mọi kiện đã huỷ, chưa khép → cancelled bằng platform_cancel`. Đơn này giống hệt trạng thái sau `open_cancel` mà lần khép bị lỗi. Kiểm thêm:
    - `cancel_reason` là `'Sàn huỷ đơn'`;
    - lịch sử cuối `{ action: 'platform_cancel' }`;
    - có đúng một `sales.order_cancelled` với `by: 'platform'`.
  - `it('AC18 (D1-10): đơn tạo tay mọi kiện huỷ → việc nền huỷ bằng auto_cancel, không completed')`: `{ status: 'cancelled', outcome: null, completed_at: null, cancel_reason: 'Mọi kiện đã huỷ' }`. Hàm `orderOf` thêm cột `cancel_reason`, `completed_at`.
  - `it('P2, Review Focus 1: mọi kiện huỷ nhưng còn dòng sống ngoài kiện → giữ processing, không completed, không phát order_cancelled')`.
- [ ] **Step 3: Integration đỏ ở `orders-api.test.ts`.**
  - `it('AC24a: đơn processing mọi kiện cancelled → completionBlocker all_packages_cancelled')`.
  - Dựng đơn bằng `allCancelledWithLiveLine(co.companyId)`. Việc nền không bao giờ khép đơn này (P2), nên ca chạy tất định.
  - Mong đợi `detail(orderId)` khớp `{ status: 'processing', completionBlocker: 'all_packages_cancelled' }`. Schema `Order` của file đã parse giá trị mới.
- [ ] **Step 4:** Chạy `npx vitest run --project unit test/unit/modules/order/sales/domain/order.test.ts` và `npx vitest run --project integration test/integration/order/sales/complete.test.ts test/integration/order/sales/orders-api.test.ts`.
  - Phải đỏ:
    - Ba dòng mới của `completionBlocker`.
    - Ca P2: đơn bị `completed` với `none`.
    - Ca AC24a: enum chưa có giá trị mới nên `Order.parse` lỗi.
  - Xanh sẵn, giữ làm ca chặn hồi quy cho bước `close`:
    - AC18: sau Task 1, `completeOne` của `main` đã gọi `settleCancelledOrder` khi mọi dòng đã huỷ.
    - AC11b, AC23.
- [ ] **Step 5:** Sửa code theo Files và Interfaces.
  - Lượt chạy: bước `close` gọi `withCompany(companyId, () => settleCancelledOrder(orderId))`. Trả `true` thì cộng `cancelled`; trả `false` thì cộng `cancelSkipped`; lỗi thì log `error` và cộng `failedOrders`, như bước hoàn tất.
  - Log cuối lượt `'lượt tự hoàn tất đơn xong'` thêm hai trường `cancelled` và `cancelSkipped`.
- [ ] **Step 6:** Chạy lại các file trên, cộng `cancelling-handed-over.test.ts`, `close-cancelled.test.ts`, `lost.test.ts`, `ingest.test.ts`, `test/integration/order/fulfillment/packing-actions.test.ts`, `line-cancel.test.ts`. Tất cả phải xanh.
  - `packing-actions` có đơn "còn món chưa huỷ thì mở kiện huỷ không huỷ đơn". Đơn này giờ vào bước `close` của việc nền từ file khác, nên phải vẫn `processing`.
- [ ] **Step 7:** Commit `feat(sales): việc nền khép đơn mọi kiện huỷ, chi tiết đơn all_packages_cancelled (#236)`.

### Task 3: Consumer kiện mở lại sau hoàn tất

**Files:**
- Create: `src/modules/order/sales/service/package-reopened.ts`.
- Modify: `src/modules/order/sales/service/ingest.ts:146`: `export const UNKNOWN_STATUS_NOTE`.
- Modify: `src/modules/order/sales/service/complete.ts` (`startSalesBackground`): đăng ký consumer cạnh `sales-return-inspected`.
- Test (mới): `test/integration/order/sales/package-reopened.test.ts`.

**Interfaces:**
- Consumes:
  - `lockOrderRow` (`repository/orders.ts`), `findOrder` (`repository/order-views.ts`), `updateOrder`.
  - `eventFlags`, `UNKNOWN_STATUS_NOTE` (`service/ingest.ts`).
  - `outcomeOf` (`domain/order.ts`).
  - `isStopped`, `findPackagesOfOrders` (`fulfillment/index.ts`), `publishEvent`.
- Produces:
  - `export async function onPackageStatusChanged(event: { occurredAt: string; payload: { packageId: string; orderId: string; from: PackageStatus | null; to: PackageStatus } }): Promise<void>`, gọi trong `withCompany` của sự kiện.
  - Đăng ký: `registerConsumer('fulfillment.package_status_changed', onPackageStatusChanged, { consumer: 'sales-package-reopened' })`.

Luật của handler (spec 5.5, D9, P6, P7):

```ts
const row = await lockOrderRow(orderId);                 // không thấy (RLS, id lạ) → return
if (row?.status !== 'completed') return;
const order = (await findOrder(orderId))!;                // completedAt, outcome
const pkgs = await findPackagesOfOrders([orderId]);
const outcome = outcomeOf(pkgs.map((p) => p.status));
const after = !!order.completedAt && new Date(occurredAt) > order.completedAt;
const reopened = (from !== null && isStopped(from) && after) || pkgs.some((p) => !isStopped(p.status));
const ownNote = row.attentionNote?.startsWith(UNKNOWN_STATUS_NOTE) ?? false;
const patch = {
  ...(outcome !== order.outcome && { outcome }),
  ...(reopened && !row.needsAttention && { needsAttention: true }),
  ...(reopened && (!row.needsAttention || ownNote) && { attentionNote: note(P7) }),
};
// patch rỗng → return (idempotent). Có → updateOrder; log info nếu reopened; phát sales.order_status_changed
// { from: 'completed', to: 'completed', flags: await eventFlags(orderId, { ...row, ...patch }) }.
```

`code` trong note là mã của kiện `packageId`, tìm trong `pkgs`; không thấy thì dùng `packageId`.

**Dựng dữ liệu test:**
- Đơn dựng theo `test/integration/order/fulfillment/platform-lost.test.ts:29-57`: `setup`, `remote`, `ingest`, `withStatus` lấy từ `../fulfillment/platform-fixtures.ts`. Chép `loseByUsers` và `inTransitOrder` vào file mới, vì helper dùng chung đang đóng băng.
- Đơn `completed` dựng bằng SQL: `update "order".orders set status = 'completed', outcome = $2, completed_at = now() where id = $1`. Không chạy việc nền.
- Giao sự kiện thật bằng helper `deliver(companyId, orderId, afterId)`:
  - `afterId` là `max(id)` của `core.outbox_messages`, đọc ngay trước bước gây ra sự kiện.
  - Helper đọc các dòng có `type = 'fulfillment.package_status_changed'`, `key = orderId`, `id > afterId`, theo thứ tự `id`.
  - Mỗi dòng gọi `withCompany(companyId, () => onPackageStatusChanged({ payload, occurredAt: created_at.toISOString() }))`.
- Sự kiện tự dựng chỉ dùng cho các ca 27a, 28, 29, Review Focus 3, Review Focus 4.

- [ ] **Step 1: Integration đỏ,** `describe('kiện mở lại sau hoàn tất (#236 PR 3, 5.5)')`.
  - `it('AC25: đơn completed, kiện lost do người xác nhận, sàn báo đã giao → giữ completed, cờ bật, outcome none → full')`:
    - Dựng: `inTransitOrder`, `loseByUsers`, đánh dấu đơn `completed` với `outcome 'none'`.
    - Làm: `ingest(withStatus(o, 'delivered'))`, rồi `deliver`.
    - Mong đợi đơn `{ status: 'completed', needs_attention: true, outcome: 'full' }`; `attention_note` vẫn là note của lượt kéo, `'Sàn báo lại kiện đã thất lạc hoặc đang hoàn'`.
  - `it('AC25a: sàn báo in_transit rồi delivered → sau bước 1 cờ bật, outcome none; sau bước 2 outcome full')`.
  - `it('AC26: đơn completed, kiện lost, người dùng found → giữ completed, cờ bật kèm note mở lại, outcome giữ none')`:
    - Gọi `POST /api/v1/fulfillment/packages/:id/found` bằng token kho, như `receive-return.test.ts:31-35`.
    - `attention_note` bằng `` `Kiện ${code} đổi lost → returned sau khi đơn hoàn tất` ``.
  - `it('AC27: như 26, đơn đã có cờ với note của luồng khác → note giữ nguyên')`: đặt sẵn note `'Khách khiếu nại'`.
  - `it('AC27a: note UNKNOWN_STATUS_NOTE (#358) bị thay bằng note mở lại; lượt kéo sạch sau đó không gỡ cờ')`:
    - Dựng: đơn sàn một kiện `delivered`, ingest bằng mã trạng thái đã biết. Đặt đơn `completed`, `needs_attention = true`, `attention_note = UNKNOWN_STATUS_NOTE + ': x'`.
    - Gọi handler với sự kiện tự dựng `{ from: 'lost', to: 'delivered' }`, `occurredAt` sau `completed_at`. Mong đợi note thành note mở lại.
    - `ingest(o)` lại đúng đơn đó. Mong đợi `needs_attention` vẫn `true`, note không đổi.
  - `it('AC28: sự kiện từ trạng thái dừng xảy ra trước completed_at, mọi kiện hiện đã dừng → không bật cờ, outcome theo kiện hiện tại')`.
  - `it('AC29: cùng sự kiện hai lần → lần hai không ghi, không phát')`: so `version` của đơn và số `sales.order_status_changed` của đơn, trước và sau lần thứ hai.
  - `it('Review Focus 3: sự kiện của đơn không thấy được → bỏ qua, không lỗi')`: `orderId` là `randomUUID()`, mong đợi `resolves.toBeUndefined()`.
  - `it('Review Focus 4: kiện chưa dừng, sự kiện from null, đơn completed → cờ bật, note "mới"')`:
    - Kiện `in_transit` từ `inTransitOrder`; đánh dấu đơn `completed` bằng SQL.
    - Sự kiện tự dựng `{ from: null, to: 'in_transit' }`.
    - Note bằng `` `Kiện ${code} đổi mới → in_transit sau khi đơn hoàn tất` ``.
  - `it('đơn chưa hoàn tất (processing) → consumer bỏ qua')`.
- [ ] **Step 2:** Chạy `npx vitest run --project integration test/integration/order/sales/package-reopened.test.ts`. Mọi ca đỏ vì chưa có module.
- [ ] **Step 3:** Viết handler theo Interfaces, export `UNKNOWN_STATUS_NOTE`, đăng ký consumer.
- [ ] **Step 4:** Chạy lại file mới, cộng `ingest.test.ts`, `test/integration/order/fulfillment/platform-lost.test.ts`, `receive-return.test.ts`, `return-ingest.test.ts`. Tất cả phải xanh.
- [ ] **Step 5:** Commit `feat(sales): consumer kiện mở lại sau hoàn tất tính lại kết quả, bật Cần xử lý (#236)`.

### Task 4: Tài liệu, kiểm cả nhánh, review, PR

**Files:**
- Modify: `src/modules/order/sales/CLAUDE.md`:
  - Dòng 30 (`settleCancelledOrder`): hai nguồn (P3), trả `boolean`.
  - Mục "Tự hoàn tất": đổi tên thành "Khép đơn (tự hoàn tất, tự huỷ) (#105 PR 2, #236)". Thay dòng 60 bằng bước `close`, P2, quan sát P8.
  - Thêm mục "Kiện mở lại sau hoàn tất (#236 PR 3)": luật 5.5, P6, P7.
  - Dòng consumer ở mục yêu cầu trả: thêm `sales-package-reopened`.
- Modify: `src/modules/order/fulfillment/CLAUDE.md:7`: `package_status_changed` có thêm consumer `sales-package-reopened` của sales.
- Modify: spec `docs/superpowers/specs/2026-11-18-236-hoan-tat-huy-theo-kien-design.md`:
  - 5.4: nhánh khép theo P2, P3.
  - D4: đơn sàn không dùng `auto_cancel`, kèm lý do (#417, trigger).
  - AC18: đổi thành đơn tạo tay. AC23: ghi đã có từ #417.
  - Mục 10: thêm giới hạn của P2.
- Documents (`D:\DA-TMDT\Documents-236-pr3`):
  - `21-hop-dong-api-fe-be.md` §19.1:
    - Dòng `all_packages_cancelled` (khoảng dòng 1805) đổi thành `auto_cancel`, guard `packages_not_cancelled`, điều kiện "mọi kiện `cancelled` và mọi món đã huỷ, đơn không phải đơn sàn". Đơn sàn đi `platform_cancel`, lý do lấy từ dòng hoặc "Sàn huỷ đơn" (D2, D3, P2, P3).
    - Dòng `complete` thêm mã chặn `all_packages_cancelled`.
    - Enum `completionBlocker` thêm `all_packages_cancelled`.
    - Đoạn "Hoàn tất" (khoảng dòng 1832): đổi "dòng `all_packages_cancelled`" thành "việc nền khép đơn". Thêm một câu: đơn `completed` có kiện đổi trạng thái thì giữ `completed`, `outcome` tính lại, kiện mở lại thì bật Cần xử lý (5.5).
  - `25-vong-doi-ly-tuong.md` §8.2: dòng `processing → cancelled` sửa theo cùng ý.
  - `kiem-thu/ca-theo-so-do.md` không sinh lại: bộ sinh đọc máy trạng thái của FE, mà FE đã có `auto_cancel`.

- [ ] **Step 1:** Sửa tài liệu. Chạy `npm run check` trong worktree. Chạy cùng lúc **hai lần** các file:
  - `complete.test.ts`, `close-cancelled.test.ts`, `cancelling-handed-over.test.ts`, `orders-api.test.ts`, `package-reopened.test.ts`, `ingest.test.ts`, `lost.test.ts`, `packing-actions.test.ts`.
  - Ca timeout "kéo đủ 250 đơn mở" của `open-order-pull.test.ts` có sẵn trên `main`: chỉ báo, không sửa.
- [ ] **Step 2:** Commit `docs(sales): khép đơn mọi kiện huỷ, kiện mở lại sau hoàn tất (#236)`. Commit Documents riêng ở worktree Documents. Không chạy `graphify update` trong worktree; đồ thị chỉ dựng lại ở bản checkout chính sau khi merge.
- [ ] **Step 3:** Review cả nhánh bằng reviewer độc lập. Đưa reviewer diff `origin/main..HEAD` và mục Review Focus. Sửa các mục Critical, Important theo TDD; mục Minor thì ghi lại.
- [ ] **Step 4:** Chạy `git fetch` và gộp `origin/main` nếu `main` đã đi tiếp. Push nhánh với `git push -u origin feature/236-tu-huy-kien-mo-lai`. Mở hai PR draft:
  - **PR backend**, base `main`. Body gồm:
    - "Phần 3/3 của #236".
    - Các quyết định P1–P8, nêu rõ P3 lệch spec D4.
    - Ghi chú deploy: consumer mới đọc topic từ đầu, nhận lại tới 7 ngày sự kiện cũ (D15).
  - **PR Documents**, base `main`.

## Ngoài plan (Khang quyết)

- Chốt P3: đơn sàn mọi kiện huỷ đi `platform_cancel`, không đi `auto_cancel` như spec D4.
- Sửa body issue #236: dòng PR 3 ghi lại phần #417 đã làm (lưới đỡ AC23) và P3.
- FE đã có nhãn "Mọi kiện đã huỷ" cho `completionBlocker = all_packages_cancelled`, không cần PR FE.
