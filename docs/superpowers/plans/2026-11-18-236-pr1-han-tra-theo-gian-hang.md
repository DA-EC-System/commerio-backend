# #236 PR 1: Hạn trả theo gian hàng, điều kiện COD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Job tự hoàn tất và chi tiết đơn tính hạn trả theo `Shop.returnWindowDays` của gian hàng (null thì 7 ngày) và chặn đơn có kiện tự giao thu COD chưa xác nhận; đóng #390.

**Architecture:** Luật thuần ở `sales/domain/order.ts` (`returnWindowEndsAt`, `codUnconfirmed`, `completionBlocker` nhận hạn đã tính). Channel thêm `returnPoliciesOf(shopIds)`, tiêm thành `ctx.returnPoliciesOf` ở `src/wiring.ts`; sales đọc qua một helper điền mặc định. Job nhận `ctx` từ `startBackground`, đọc chính sách một lần mỗi công ty mỗi lượt.

**Tech Stack:** Node 24 (chạy thẳng `.ts`), Express 5, TypeScript 6, Zod 4, Drizzle ORM + PostgreSQL 18 (staging PG17), `decimal.js`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-236-hoan-tat-huy-theo-kien-design.md` (đọc kèm; plan này chỉ làm PR 1, mục 6 của spec).

## Global Constraints

- Định danh tiếng Anh; comment, log, tên `describe`/`it` tiếng Việt. Import tương đối có đuôi `.ts`; không `enum`, `namespace`, parameter property.
- `order` (lớp 3) không import `channel` (lớp 5): chính sách gian hàng chỉ qua `ctx.returnPoliciesOf`. Không thêm trường vào `getShops`/`ShopRef` (D6).
- Tiền là `decimal.js` (so `cod_expected > 0`), không `number`.
- PR 1 **không migration**, không đổi schema, không thêm route, không thêm giá trị enum.
- Sàn `platform_status` (TikTok) vẫn tính 7 ngày ở PR 1 (D13). Đơn mọi kiện huỷ giữ hành vi hiện tại (D16).
- Hằng: `DEFAULT_RETURN_WINDOW_DAYS = 7`; một ngày = `86_400_000` ms.
- Test chỉ ở `test/`, import `#src/...ts`; integration tự tạo công ty, gian hàng riêng (`insert into channel.shops … platform, return_window_days` qua `testPool()`), không giả định bảng trống.
- Mỗi đơn của job vẫn một `withCompany` riêng; lỗi một đơn hay một công ty không chặn phần còn lại.
- Commit theo task, tiêu đề `feat(sales): … (#236)` / `feat(channel): … (#236)`. Trước khi mở PR: `npm run check` xanh, `graphify update .`.

## Thiết kế theo 6 bước (đã chạy skill `backend-design:think-before-coding`, `query-discipline`, `error-handling-as-design`, `observability-by-default`, `testing-with-discernment`, `supabase-postgres-best-practices` ngày 18/11/2026)

1. **Loại và tải:** cron (`every(3_600_000)` trong worker, không chồng lượt trong một tiến trình) và một route đọc có sẵn (`GET /sales/orders/:id`). Tải: ứng viên là mọi đơn `processing` có mọi kiện đã dừng, **kể cả đơn còn trong hạn trả** (chờ 7–60 ngày), nên mỗi lượt đọc lại hàng trăm tới vài nghìn đơn ở quy mô đồ án; số đơn thật sự hoàn tất mỗi lượt nhỏ.
2. **Dữ liệu và bất biến:** đơn chỉ hoàn tất khi đã qua `returnWindowEndsAt` tính từ kiện giao cuối theo chính sách gian hàng; đơn đã hoàn tất giữ hạn đã lưu. Không đổi schema.
3. **Lỗi:** đọc chính sách hay đọc lô của một công ty lỗi thì **bỏ** cả công ty ở lượt này, log `error` (lỗi hệ thống, không tự hết), không rơi về 7 ngày (rơi về mặc định có thể chốt sớm đơn của gian hàng đặt 15 ngày). Lỗi một đơn: log `error` (hiện là `warn`), sang đơn khác. Lỗi cả lượt (đọc ứng viên): `every` đã log `error`. Đổi `version` giữa chừng không phải lỗi: trả `false`, lượt sau xét lại.
4. **Quyền:** job chạy hệ thống. Câu ứng viên đọc mọi công ty bằng role chủ bảng (như hiện tại); mọi đọc, ghi khác trong `withCompany` nên RLS giới hạn công ty, kể cả `returnPoliciesOf`. Route chi tiết đơn giữ quyền hiện có.
5. **Idempotence, đồng thời:** ghi theo `version` (`updateOrderAt`); hai worker chạy cùng lúc thì một bên thắng, lịch sử và sự kiện chỉ ghi khi cập nhật trúng. Đơn quyết "hoàn tất được" từ lần đọc lô thì đọc lại đơn, kiện, yêu cầu trả trong giao dịch ghi (P4): kiện đổi giữa hai lần đọc thì không hoàn tất.
6. **Quan sát:** một log `info` tóm tắt mỗi lượt (`candidates`, `completed`, `failedOrders`, `skippedCompanies`, `ms`); số liệu Prometheus trên `/metrics` của worker theo mẫu `outbox/metrics.ts` (P6). Log từng đơn mang `orderId`, `companyId`.

Truy vấn (query-discipline, supabase): ứng viên lật trang theo `id` (keyset, P5), không còn danh sách không giới hạn; đọc kiện, yêu cầu trả, đơn theo lô mỗi công ty mỗi trang (P4), số câu không tỉ lệ với số đơn đang chờ. Index sẵn có: `packages(order_id)`, `return_requests(order_id)`, PK `shops(id)`. `orders` chưa có index theo `status`: câu ứng viên quét `orders` mỗi giờ; chấp nhận ở quy mô đồ án, Task 3 chạy `EXPLAIN ANALYZE` và ghi kết quả vào mô tả PR (partial index `orders (id) where status = 'processing'` là việc sau nếu cần, kèm migration riêng). Drizzle 0.45.4: lật trang bằng `gt(orders.id, cursor)` + `orderBy(asc(orders.id))` + `limit` (context7, `/drizzle-team/drizzle-orm-docs`, mục cursor-based pagination).

## Quyết định khi lập plan (Claude, Khang xem khi duyệt plan)

- **P1** Giữ tên `completionBlocker` ở PR 1 (spec cho người làm tự đặt tên; `closingStep` có nhánh `auto_cancel` để PR 3). Đầu vào đổi sang `Date`.
- **P2** `completeDueOrdersOnce(now = new Date(), ctx = {})`: `ctx` là tham số thứ hai, tuỳ chọn, như cách `factsOf` chịu thiếu `paymentStatusOf`. Bốn chỗ gọi cũ trong test (`lost.test.ts`, `cancelling-handed-over.test.ts`) giữ nguyên, tính 7 ngày. Worker luôn truyền `ctx` (`AppContext` khai Required).
- **P3** Gom một hàm `lastDeliveredAt(packages)` ở domain thay hai bản `reduce` lặp ở `complete.ts:19` và `orders.ts:248`.
- **P4** Job đọc theo lô: mỗi trang ứng viên, mỗi công ty **một** `withCompany` đọc đơn (`findOrders`), kiện (`findPackagesOfOrders`), yêu cầu trả mở (`openReturnCounts`), chính sách (`returnPoliciesFor`) của mọi đơn công ty đó trong trang, rồi `completionBlocker` để lọc. Chỉ đơn ra `null` mới vào `completeOne`, và `completeOne` đọc lại đơn đó trong giao dịch ghi như hiện tại. Hiện job đọc 3 câu cho **mọi** ứng viên mỗi giờ, kể cả đơn còn trong hạn trả.
- **P5** `findCompletionCandidates(afterId, limit)` lật trang theo `id` tăng, trang 500 (`COMPLETION_PAGE`); `completeDueOrdersOnce` nhận `pageSize` tuỳ chọn ở tham số thứ ba (test lật trang với cỡ 1).
- **P6** Số liệu (đăng ký lười trong `startSalesBackground`, chỉ worker, như `registerOutboxMetrics`): counter `sales_orders_auto_completed_total`; counter `sales_auto_complete_failures_total{scope="order"|"company"}`; gauge `sales_auto_complete_last_run_timestamp_seconds` (đặt khi lượt chạy hết, kể cả có đơn lỗi). Không nhãn theo công ty, đơn (tránh nổ số chuỗi).

## Review Focus

- **Đọc chính sách lỗi** (channel ném, DB lỗi giữa chừng) → đơn của công ty đó **không** hoàn tất ở lượt này; công ty khác vẫn chạy. Test ở Task 3 (Step 1, ca "đọc hạn trả lỗi").
- **Đơn không có `shop_id`** (đơn tay sau này) → chính sách mặc định 7 ngày, không gọi channel với `null`. Test ở Task 3.
- **Gian hàng đã ngắt** vẫn trả chính sách đã lưu (đơn còn mở của gian hàng đã ngắt vẫn đúng hạn). Test ở Task 2.
- **Gian hàng của công ty khác** không lọt vào kết quả `returnPoliciesOf`. Test ở Task 2.
- **Kiện tự giao COD hoàn về (`returned`) chưa xác nhận** → không chặn (không thu được tiền). Test ở Task 1.

---

### Task 1: Luật thuần hạn trả, COD

**Files:**
- Modify: `src/modules/order/sales/domain/order.ts:70-89`
- Test: `test/unit/modules/order/sales/domain/order.test.ts:47-73`

**Interfaces:**
- Consumes: `PackageStatus`, `isStopped` (fulfillment, đã import).
- Produces (export từ `domain/order.ts`):
  - `DEFAULT_RETURN_WINDOW_DAYS = 7` (bỏ `RETURN_WINDOW_DAYS`).
  - `interface ReturnPolicy { returnWindow: 'days' | 'platform_status'; returnWindowDays: number | null }`, `DEFAULT_RETURN_POLICY: ReturnPolicy = { returnWindow: 'days', returnWindowDays: null }`.
  - `lastDeliveredAt(packages: readonly { deliveredAt: Date | null }[]): Date | null` (lớn nhất, bỏ null).
  - `returnWindowEndsAt(policy: ReturnPolicy, lastDelivered: Date | null, stored: Date | null): Date | null`.
  - `interface CodPackage { selfDelivery: boolean; status: PackageStatus; codExpected: string | null; codConfirmedAt: Date | null }`, `codUnconfirmed(packages: readonly CodPackage[]): boolean`.
  - `type CompletionBlocker = 'packages_open' | 'return_window' | 'return_requested' | 'cod_unconfirmed'`.
  - `CompletionInput { packages: readonly PackageStatus[]; lastDeliveredAt: Date | null; returnWindowEndsAt: Date | null; openReturnRequests: number; codUnconfirmed: boolean; now: number }`; `completionBlocker(i: CompletionInput): CompletionBlocker | null`.

- [x] **Step 0: Tạo nhánh, commit spec và plan**

```bash
git checkout -b feature/236-hoan-tat-huy-theo-kien
git add docs/superpowers/specs/2026-11-18-236-hoan-tat-huy-theo-kien-design.md docs/superpowers/plans/2026-11-18-236-pr1-han-tra-theo-gian-hang.md
git commit -m "docs(sales): spec và plan PR 1 của #236"
```

- [x] **Step 1: Viết test thất bại** — trong `order.test.ts`, đổi `describe('cancelPlan, outcomeOf, completionBlocker')` sang đầu vào mới và thêm:

```ts
const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);
describe('returnWindowEndsAt', () => {
  const d = at('2026-11-01T00:00:00Z');
  it('sàn days: mốc giao + số ngày của gian hàng', () =>
    expect(returnWindowEndsAt({ returnWindow: 'days', returnWindowDays: 15 }, d, null)).toEqual(new Date(d.getTime() + 15 * DAY)));
  it('gian hàng chưa nhập số ngày: 7 ngày', () =>
    expect(returnWindowEndsAt({ returnWindow: 'days', returnWindowDays: null }, d, null)).toEqual(new Date(d.getTime() + 7 * DAY)));
  it('PR 1: sàn platform_status vẫn 7 ngày, bỏ qua cột đã lưu (D13)', () =>
    expect(returnWindowEndsAt({ returnWindow: 'platform_status', returnWindowDays: null }, d, null)).toEqual(new Date(d.getTime() + 7 * DAY)));
  it('chưa kiện nào giao: null', () => expect(returnWindowEndsAt(DEFAULT_RETURN_POLICY, null, null)).toBeNull());
});
describe('codUnconfirmed', () => {
  const p = { selfDelivery: true, status: 'delivered', codExpected: '100000.00', codConfirmedAt: null } as const;
  it.each([
    [p, true],
    [{ ...p, codConfirmedAt: at('2026-11-02T00:00:00Z') }, false],
    [{ ...p, codExpected: '0.00' }, false],
    [{ ...p, codExpected: null }, false],
    [{ ...p, status: 'returned' }, false],
    [{ ...p, selfDelivery: false }, false],
  ] as const)('%o → %s', (pkg, expected) => expect(codUnconfirmed([pkg])).toBe(expected));
});
it('lastDeliveredAt lấy mốc lớn nhất, bỏ null', () =>
  expect(lastDeliveredAt([{ deliveredAt: null }, { deliveredAt: at('2026-11-02T00:00:00Z') }, { deliveredAt: at('2026-11-01T00:00:00Z') }])).toEqual(at('2026-11-02T00:00:00Z')));
```

  Bảng `completionBlocker` đổi `lastDeliveredAt` sang `Date`, thêm `returnWindowEndsAt`: `['delivered']`, giao 25/10, hạn 01/11 (sau `now` 29/10) → `return_window`; hạn 27/10 (trước `now`) và không gì khác → `null`; có kiện giao mà hạn `null` → `return_window`; `['returned']`, cả hai mốc null → `null`; các dòng `packages_open`, `return_requested`, `cod_unconfirmed` giữ như cũ (hạn trước `now`).

- [x] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project unit test/unit/modules/order/sales/domain/order.test.ts` → FAIL (export chưa có).

- [x] **Step 3: Viết luật** trong `domain/order.ts` theo Interfaces. `returnWindowEndsAt` ở PR 1: `lastDelivered` null → null; ngược lại cộng `policy.returnWindow === 'days' ? (policy.returnWindowDays ?? 7) : 7` ngày, `stored` chưa dùng (comment: PR 2 #236 đọc cột cho `platform_status`). `codUnconfirmed` so `new Decimal(codExpected).gt(0)`. `completionBlocker` bước 2: `lastDeliveredAt && (!returnWindowEndsAt || returnWindowEndsAt.getTime() > now)` → `return_window`.

- [x] **Step 4: Chạy lại, thấy xanh** — cùng lệnh → PASS. `npx tsc --noEmit` báo lỗi ở `complete.ts`, `orders.ts` (còn dùng `RETURN_WINDOW_DAYS`): sửa tạm bằng `DEFAULT_RETURN_POLICY` và đầu vào mới, hành vi giữ 7 ngày; Task 3, 4 thay hẳn.

- [x] **Step 5: Commit** — `feat(sales): luật hạn trả theo chính sách gian hàng, điều kiện COD (#236)`.

### Task 2: Channel trả chính sách hạn trả, tiêm vào sales

**Files:**
- Modify: `src/modules/channel/channel/repository/shops-lookup.ts`
- Modify: `src/modules/channel/channel/service/shops-lookup.ts`
- Modify: `src/modules/channel/channel/index.ts:66`
- Modify: `src/modules/order/sales/service/orders.ts:45-54` (`SalesContext`)
- Modify: `src/wiring.ts:41`, `:50`
- Test: `test/integration/channel/channel/return-policies.test.ts` (mới)

**Interfaces:**
- Consumes: `ReturnPolicy` (Task 1, chỉ để khai kiểu ở sales), `capabilitiesOf` (`channel/service/marketplaces/index.ts:107`).
- Produces:
  - Channel `returnPoliciesOf(ids: readonly string[]): Promise<Map<string, { returnWindow: 'days' | 'platform_status'; returnWindowDays: number | null }>>`, gọi trong `withCompany` (`requireCompanyId('returnPoliciesOf')`), một câu cho cả lô, mọi trạng thái gian hàng; id không thấy vắng mặt. Export ở `channel/channel/index.ts`.
  - `SalesContext.returnPoliciesOf?: (shopIds: readonly string[]) => Promise<Map<string, ReturnPolicy>>`; `AppContext` thêm `'returnPoliciesOf'` vào `Required<Pick<SalesContext, …>>`; `createModuleContext()` gán `returnPoliciesOf`.

- [x] **Step 1: Viết test thất bại** — `return-policies.test.ts`: công ty A có gian hàng Lazada `return_window_days = 15`, Lazada `null`, TikTok, Lazada `disconnected` `return_window_days = 10`; công ty B có một gian hàng Lazada. `withCompany(A, () => returnPoliciesOf([4 id của A, id của B, randomUUID()]))`:
  - Lazada 15 → `{ returnWindow: 'days', returnWindowDays: 15 }`; Lazada null → `{ 'days', null }`; TikTok → `{ 'platform_status', null }`; gian hàng ngắt → `{ 'days', 10 }`.
  - Map có đúng 4 khoá (không có gian hàng của B, không có id lạ).
  - `returnPoliciesOf([])` → Map rỗng, không truy vấn lỗi.
  - Không test riêng việc nối ở `wiring.ts`: `AppContext` khai Required nên quên nối là lỗi kiểu; Task 3 chạy job với `createModuleContext()` thật.
- [x] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project integration test/integration/channel/channel/return-policies.test.ts` → FAIL.
- [x] **Step 3: Viết** `findShopReturnSettings(ids)` ở repository (chọn `id`, `platform`, `returnWindowDays`), `returnPoliciesOf` ở service (map qua `capabilitiesOf(platform).returnWindow`), export, khai `SalesContext.returnPoliciesOf`, nối ở `wiring.ts` kèm comment `// #236: sales (lớp dưới) tính hạn trả theo cấu hình gian hàng của channel.`
- [x] **Step 4: Chạy lại, thấy xanh** — cùng lệnh → PASS; `npx tsc --noEmit` sạch; `npm run depcruise` sạch.
- [x] **Step 5: Commit** — `feat(channel): returnPoliciesOf cho sales tính hạn trả (#236)`.

### Task 3: Job tự hoàn tất theo chính sách và COD

**Files:**
- Create: `src/modules/order/sales/service/return-policy.ts`
- Create: `src/modules/order/sales/service/metrics.ts`
- Modify: `src/modules/order/sales/service/complete.ts`
- Modify: `src/modules/order/sales/repository/orders.ts:258-271` (`findCompletionCandidates`)
- Test: `test/integration/order/sales/complete.test.ts`

**Interfaces:**
- Consumes: Task 1 (`DEFAULT_RETURN_POLICY`, `lastDeliveredAt`, `returnWindowEndsAt`, `codUnconfirmed`, `completionBlocker`); Task 2 (`SalesContext.returnPoliciesOf`); sẵn có `findOrders` (`repository/order-views.ts:125`), `findPackagesOfOrders`, `openReturnCounts`.
- Produces:
  - `returnPoliciesFor(ctx: Pick<SalesContext, 'returnPoliciesOf'>, shopIds: readonly (string | null)[]): Promise<Map<string, ReturnPolicy>>`: bỏ `null`, bỏ trùng; danh sách rỗng hoặc `ctx.returnPoliciesOf` vắng → Map rỗng (không gọi); lỗi của channel **ném tiếp**. `policyOf(map: Map<string, ReturnPolicy>, shopId: string | null): ReturnPolicy` trả `DEFAULT_RETURN_POLICY` khi vắng.
  - `COMPLETION_PAGE = 500`; `findCompletionCandidates(afterId: string | null, limit: number): Promise<{ id: string; companyId: string }[]>` (điều kiện giữ nguyên, `id > afterId`, `order by id`, `limit`).
  - `completeDueOrdersOnce(now = new Date(), ctx: Pick<SalesContext, 'returnPoliciesOf'> = {}, pageSize = COMPLETION_PAGE): Promise<number>`; `startSalesBackground(ctx: SalesContext)` truyền `ctx`, gọi `registerSalesMetrics()`.
  - `metrics.ts`: `registerSalesMetrics(): void` (lười, gọi nhiều lần không đăng ký lại), `recordAutoComplete(r: { completed: number; failedOrders: number; skippedCompanies: number }): void` (cộng counter, đặt gauge thời điểm; chưa đăng ký thì không làm gì, nên test và api không cần đăng ký).

- [x] **Step 1: Viết test thất bại** — trong `complete.test.ts` thêm `describe('hạn trả theo gian hàng (#236)')`. Helper `delivered` nhận thêm `shop` (mặc định `shopId` ngẫu nhiên như cũ). Tạo trong `beforeAll` các gian hàng của `companyId`: Lazada 15 ngày, Lazada null, TikTok. Truyền `ctx = createModuleContext()` (`#src/wiring.ts`). Ca (mã ca theo Task 6, chưa có thì ghi tên dòng US):
  - AC1: Lazada 15, giao 8 ngày trước → vẫn `processing`.
  - AC2 (D1-03): Lazada 15, giao 16 ngày trước → `completed`, `outcome: 'full'`, `return_window_ends_at` = mốc giao + 15 ngày.
  - AC3: Lazada null, giao 8 ngày trước → `completed`.
  - AC5: tạo đơn như AC1, `update channel.shops set return_window_days = 5`, chạy lại → `completed`.
  - AC6 (US-DH-16 1b): `['returned']` của Lazada 15 → `completed`, `outcome: 'none'`, `return_window_ends_at` null.
  - AC8: Lazada null, giao 8 ngày trước; `update "order".packages set self_delivery = true, cod_expected = 100000, delivered_by = $2` (uuid ngẫu nhiên) → vẫn `processing`; `set cod_confirmed_by = <uuid khác>, cod_confirmed_at = now()` rồi chạy lại → `completed`.
  - AC9: như AC8 nhưng `cod_expected = 0` → `completed` ngay.
  - AC11a: TikTok, giao 8 ngày trước → `completed` (D13).
  - AC4: `ctx` thật, đơn của `shopId` ngẫu nhiên (không có gian hàng), giao 8 ngày trước → `completed` (mặc định 7 ngày).
  - AC11b: đơn Lazada null giao 8 ngày trước; trong **một** giao dịch của `testPool()` đặt mọi kiện của đơn `status = 'cancelled'` và `order_lines.cancelled_qty = quantity` (trigger kiểm bằng chạy lúc commit, `db/CLAUDE.md`) → job: `completed`, `outcome: 'none'` (hành vi hiện tại, giữ ở PR 1 theo D16; PR 3 đổi thành `cancelled`).
  - AC11 (không đọc theo từng đơn): `ctx` giả `{ returnPoliciesOf: vi.fn(createModuleContext().returnPoliciesOf) }`; ba đơn ở hai gian hàng của `companyId` → các lời gọi có chứa gian hàng của `companyId` đúng **một**, chứa cả hai id.
  - Lật trang (P5): ba đơn đã tới hạn của `companyId`, `completeDueOrdersOnce(now, ctx, 1)` → cả ba `completed` trong một lượt.
  - Review Focus "đọc hạn trả lỗi": `ctx` giả ném khi danh sách chứa gian hàng Lazada 15 của `companyId`; đơn AC2 dựng mới → vẫn `processing`; đơn của một công ty thứ hai (tạo riêng, giao 8 ngày, `shopId` ngẫu nhiên) vẫn `completed` trong cùng lượt.
  - Review Focus "đơn không gian hàng": đơn tay dựng bằng `seedPackage(companyId, { status: 'delivered', deliveredAt: <8 ngày trước>, manual: true, orderStatus: 'processing', lines: [<một dòng của createVariant>] })` (`test/integration/order/fulfillment/helpers.ts`) → `completed`; không lời gọi nào của `ctx` giả chứa `null`.
  - Ca cũ (`completeDueOrdersOnce(now)` không `ctx`) giữ nguyên, phải còn xanh.
- [x] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project integration test/integration/order/sales/complete.test.ts` → FAIL (AC1, AC5, AC8, đếm lời gọi, đọc lỗi).
- [x] **Step 3: Viết** `return-policy.ts`, `metrics.ts`; `findCompletionCandidates` lật trang. `completeDueOrdersOnce` lặp trang (con trỏ = `id` cuối trang); mỗi trang gom theo `companyId`; mỗi công ty một `withCompany` đọc lô (P4) trong `try`: lỗi thì `logger.error({ err, companyId }, 'đọc lô tự hoàn tất của công ty lỗi')`, cộng `skippedCompanies`, bỏ công ty; lọc đơn có `completionBlocker(...) === null`; mỗi đơn đó `withCompany(companyId, () => completeOne(orderId, now, policy))`, lỗi thì `logger.error({ err, orderId, companyId }, 'tự hoàn tất đơn lỗi')`. `completeOne` giữ cách đọc lại và ghi theo `version` hiện tại, dùng `lastDeliveredAt`, `returnWindowEndsAt(policy, last, order.returnWindowEndsAt)`, `codUnconfirmed(packages)`, ghi `returnWindowEndsAt` vừa tính. Cuối lượt: `logger.info({ candidates, completed, failedOrders, skippedCompanies, ms }, 'lượt tự hoàn tất đơn xong')` và `recordAutoComplete(...)`. Sửa comment đầu file (bỏ "7 ngày"). `startSalesBackground(ctx)` gọi `registerSalesMetrics()` rồi `every(3_600_000, () => completeDueOrdersOnce(new Date(), ctx), …)`.
- [x] **Step 4: Chạy lại, thấy xanh** — cùng lệnh → PASS; thêm `npx vitest run --project integration test/integration/order/sales/cancelling-handed-over.test.ts test/integration/order/fulfillment/lost.test.ts` → PASS.
- [x] **Step 5: Xem kế hoạch truy vấn** — trên DB dev đã `npm run db:seed`, chạy `EXPLAIN (ANALYZE, BUFFERS)` câu SQL mà `findCompletionCandidates(null, 500)` sinh ra (bật log SQL của Drizzle hoặc chép từ `toSQL()`). Ghi vào mô tả PR: kiểu quét `orders`, số dòng, thời gian. `exists`/`not exists` trên `packages` phải dùng index `order_id`.
- [x] **Step 6: Commit** — `feat(sales): tự hoàn tất theo hạn trả của gian hàng và xác nhận COD (#236, đóng #390)`.

### Task 4: Chi tiết đơn trả hạn trả, lý do chờ đúng

**Files:**
- Modify: `src/modules/order/sales/service/orders.ts:228-305` (`getOrder`)
- Modify: `src/modules/order/sales/api/schemas.ts:172` (mô tả `returnWindowEndsAt`)
- Test: `test/integration/order/sales/orders-api.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 3 (`returnPoliciesFor`, `policyOf`).
- Produces: `Order.returnWindowEndsAt`: đơn `completed`/`cancelled` → cột đã lưu; `processing` → `returnWindowEndsAt(policy, lastDeliveredAt, cột)`; `unpaid` → `null`. `Order.completionBlocker` từ `completionBlocker` với `codUnconfirmed(f.packages)`.

- [x] **Step 1: Viết test thất bại** — trong `orders-api.test.ts` thêm `describe('hạn trả theo gian hàng (#236)')`, công ty và gian hàng Lazada `return_window_days = 15` riêng:
  - AC1: đơn giao 8 ngày trước → `GET /api/v1/sales/orders/:id`: `completionBlocker: 'return_window'`, `returnWindowEndsAt` = mốc giao + 15 ngày (ISO).
  - AC7 (US-DH-16 2): đơn giao 16 ngày trước có yêu cầu trả `requested` (chèn như `complete.test.ts`) → `completionBlocker: 'return_requested'`.
  - AC8: đơn giao 16 ngày trước, kiện tự giao COD chưa xác nhận (như Task 3) → `completionBlocker: 'cod_unconfirmed'`.
  - AC10: đơn đã `completed` với `return_window_ends_at` = X (đặt bằng `testPool()`), rồi đổi `return_window_days` sang 30 → `returnWindowEndsAt` vẫn X, `completionBlocker: null`.
  - Mọi phản hồi qua `Order.parse` / `OrderSummaryPage.parse` như các ca hiện có. AC11c (object `shop` không thêm trường) không viết test riêng: Task 2 không đổi `getShops`, và job `blackbox` của CI kiểm "không trường thừa" bằng `expectContract`.
- [x] **Step 2: Chạy, thấy đỏ** — `npx vitest run --project integration test/integration/order/sales/orders-api.test.ts` → FAIL (AC1 ra +7 ngày, AC8 ra `null`, AC10 ra hạn tính lại).
- [x] **Step 3: Viết** — `getOrder` gọi `returnPoliciesFor(ctx, [o.shopId])` song song với `shopsOf`; tính `last = lastDeliveredAt(f.packages)`; trả hạn và lý do theo Interfaces; bỏ import `RETURN_WINDOW_DAYS`. Mô tả schema: `'Hết hạn trả hàng: đơn đang xử lý tính từ kiện giao cuối theo hạn trả của gian hàng (chưa nhập: 7 ngày); đơn đã hoàn tất là hạn đã lưu'`.
- [x] **Step 4: Chạy lại, thấy xanh** — cùng lệnh → PASS.
- [x] **Step 5: Commit** — `feat(sales): chi tiết đơn trả hạn trả theo gian hàng, lý do chờ COD (#236)`.

### Task 5: CLAUDE.md, kiểm toàn bộ

**Files:**
- Modify: `src/modules/order/sales/CLAUDE.md` (mục "Tự hoàn tất", "Cho module khác": `ctx.returnPoliciesOf`)
- Modify: `src/modules/channel/channel/CLAUDE.md` (bỏ câu "Hạn trả của đơn chưa đọc cột này (`order` còn cứng 7 ngày)"; mục "Cho module khác" thêm `returnPoliciesOf`)

- [ ] **Step 1: Sửa hai CLAUDE.md** — mục Tự hoàn tất của sales: hạn = mốc giao cuối + `returnWindowDays` của gian hàng (null hoặc không thấy gian hàng: 7 ngày; sàn `platform_status` tạm 7 ngày tới PR 2); kiện tự giao thu COD chưa xác nhận chặn `cod_unconfirmed`; job nhận `ctx`, lật trang 500 theo `id`, đọc lô mỗi công ty, đọc lô lỗi thì bỏ công ty đó ở lượt; log tóm tắt mỗi lượt và ba số liệu `sales_*` trên `/metrics` của worker.
- [ ] **Step 2: Kiểm toàn bộ** — `npm run check` → xanh (lint, typecheck, depcruise, test).
- [ ] **Step 3: Cập nhật đồ thị** — `graphify update .`
- [ ] **Step 4: Commit** — `docs(sales): CLAUDE.md theo hạn trả của gian hàng (#236)`.
- [ ] **Step 5: Mở PR khi Khang bảo** — base `main`; mô tả ghi "Closes #390", "Phần 1/3 của #236", AC đã qua, D13 (TikTok tạm 7 ngày).

### Task 6: Documents (repo `D:\DA-TMDT\Documents`, PR riêng)

**Files:**
- Modify: `21-hop-dong-api-fe-be.md` §19.1 đoạn "Hoàn tất"
- Modify: `27-user-story.md` US-DH-16; `kiem-thu/ca-theo-so-do.md` mục D1

- [ ] **Step 1: Nhánh** — `git -C D:/DA-TMDT/Documents checkout -b docs/236-han-tra-gian-hang origin/main`.
- [ ] **Step 2: Sửa** — `21` "Hoàn tất": gian hàng `days` chưa nhập số ngày tính 7 ngày; đơn đã hoàn tất trả hạn đã lưu. `27` US-DH-16 dòng 1b, 2: cấp mã ca mới trong mục D1 của `ca-theo-so-do.md` (theo cách đặt mã sẵn có của mục đó), thay "(chưa có ca)".
- [ ] **Step 3: Đổi tên test** — test của Task 3 (AC6) và Task 4 (AC7) mang mã vừa cấp; commit ở nhánh backend `test(sales): mã ca US-DH-16 (#236)`.
- [ ] **Step 4: Commit Documents, mở PR khi Khang bảo** — `docs: hạn trả theo gian hàng, mã ca US-DH-16 (commerio-backend#236)`.

## Ngoài plan này

PR 2 (TikTok `COMPLETED`/`CANCELLED`, migration bù), PR 3 (`auto_cancel`, consumer kiện mở lại) có plan riêng sau khi PR 1 merge. Trước plan PR 2: chạy `npm run smoke:tiktok -- order 586932266789143562` (spec mục 10).
