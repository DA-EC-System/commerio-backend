# Sự kiện realtime cho đơn, kiện, yêu cầu trả, gian hàng (#216) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FE tự làm mới màn đơn, kiện, yêu cầu trả, gian hàng, listing qua SSE: khai ba sự kiện mới, luật gửi cho bảy sự kiện của mô hình mới, bỏ hai luật cũ, phát ba sự kiện còn thiếu.

**Architecture:** Luật thuần ở `notification/domain/rules.ts` (consumer realtime tự nghe theo `NOTIFIED_TYPES`). Sales phát `sales.return_status_changed` cạnh `recordTransition` và qua một hàm ghi trường hiện trên màn. Channel phát `channel.shop_status_changed` qua một hàm chuyển trạng thái gian hàng, và `channel.listing_sync_changed` qua lớp `service/listing-writes.ts` bọc mọi hàm ghi listing (cách A), đọc bộ ba trước dưới khoá nên chạy trên PG17.

**Tech Stack:** Node 24 (chạy thẳng `.ts`), TypeScript 6, Zod 4, Drizzle 0.45.4, PostgreSQL 17 (staging) / 18 (CI), Vitest 5, dependency-cruiser.

**Spec:** `docs/superpowers/specs/2026-11-19-216-su-kien-realtime-design.md` (Khang duyệt 19/11/2026). Người làm đọc cả spec; plan trích mã quyết định (D1–D14) và tiêu chí (AC1–AC13) của spec.

## Global Constraints

- Mọi lời gọi `publishEvent` nằm trong giao dịch `withCompany` đang mở, cùng giao dịch với câu ghi nghiệp vụ.
- Payload SSE của bảy loại mới đúng các trường ở spec 5.2, không hơn.
- Không SQL nào dùng tính năng chỉ có ở PG18 (`RETURNING old.*`, `uuidv7()`, cột ảo). Staging là PG17.
- Không migration.
- Định danh tiếng Anh; comment, tên test, câu lỗi tiếng Việt. Import tương đối có đuôi `.ts`; test import bằng `#src/...ts`.
- Không `enum`/`namespace`/parameter property.
- Test đặt trong `test/`, đúng bảng của `test/CLAUDE.md`; mỗi test tự tạo công ty; công ty có quyền `channel.*` phải bật phân hệ `channel` (`createCompany({ optionalModules: ['channel'] })`).
- Đọc code: chạy `graphify query "<câu hỏi>"` trước khi grep hay đọc file nguồn (CLAUDE.local.md); sửa code xong chạy `graphify update .`.
- Commit kết thúc bằng dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Không push, không mở PR khi chưa được Khang đồng ý.

## Review Focus

1. Yêu cầu trả đang xung đột, lượt kéo 5 phút sau báo lại cùng trạng thái sàn: không được phát `from = to` mỗi lượt (chỉ phát khi giá trị trường hiện trên màn thật sự đổi). Test ở Task 3.
2. `markStockPendingRows` trên listing đang `error` hoặc đã `pending`: không phát. Test ở Task 5.
3. `updateListing` trượt `version` (người khác vừa ghi): trả `undefined`, không phát, không khoá treo. Test ở Task 5.
4. Đường ghi listing chạy ngoài `withCompany` sẽ ném sau khi có `publishEvent`: toàn bộ test integration của `channel` phải xanh sau khi đổi import. Chạy ở Task 5 bước cuối.
5. Người có `channel.shop.view` nhưng công ty tắt phân hệ `channel`: không nhận `shop_status_changed`, `listing_sync_changed`. Test ở Task 2.

---

### Task 1: Documents `21` §13, D11 (PR Documents)

**Files:**
- Modify: `D:\DA-TMDT\Documents-216\21-hop-dong-api-fe-be.md` (§13 ghi chú đầu mục ~682, §13.2 ~702–734, §13.4 ~747–749, D11 ~547)

**Interfaces:** không có code. PR BE (Task 6) trỏ tới PR này.

- [ ] **Step 1: Tạo worktree**

```bash
cd /d/DA-TMDT/Documents && git fetch origin && git worktree add -b docs/216-su-kien-realtime ../Documents-216 origin/main
```
Expected: thư mục `D:\DA-TMDT\Documents-216` trên nhánh mới.

- [ ] **Step 2: Sửa theo spec mục 6** (đủ năm gạch đầu dòng: ghi chú đầu §13; bảng đầu §13.2 bỏ dòng `fulfillment.order_status_changed` và viết lại câu "Vai trò có sẵn…" theo ma trận spec 5.2; bảng "Sự kiện của mô hình mới" đổi `#134` → `#216`, bỏ câu "bỏ khi #134 xong", thêm hai dòng kiện, sửa dòng `return_status_changed` và `listing_sync_changed`; §13.4; D11 kèm sửa `purchasing.order.approve` → `purchasing.request.approve`).

- [ ] **Step 3: Kiểm**

Run: `cd /d/DA-TMDT/Documents-216 && git grep -n -E "fulfillment\.order_status_changed|#134|purchasing\.order\.approve" -- 21-hop-dong-api-fe-be.md`
Expected: chỉ còn các dòng lịch sử (ghi chú ngày cũ), không còn dòng bảng §13.2 nào mang `fulfillment.order_status_changed`, không còn `purchasing.order.approve`.

- [ ] **Step 4: Commit**

```bash
git add 21-hop-dong-api-fe-be.md
git commit -m "docs(21): sự kiện SSE của mô hình mới, kiện giao thất bại, thất lạc; D11 (#216)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Danh mục sự kiện và luật thông báo

**Files:**
- Modify: `src/modules/core/platform/domain/events.ts` (thêm 3 schema, spec 5.1)
- Modify: `src/modules/core/notification/domain/rules.ts` (spec 5.2)
- Modify: `src/modules/core/notification/CLAUDE.md` (bảng sự kiện → quyền → trường)
- Test: `test/unit/modules/core/platform/domain/events.test.ts`
- Test: `test/unit/modules/core/notification/domain/rules.test.ts`
- Test: `test/integration/core/notification/stream.test.ts`

**Interfaces:**
- Produces: `EventType` có thêm `'sales.return_status_changed' | 'channel.shop_status_changed' | 'channel.listing_sync_changed'`; `EventPayload<…>` như spec 5.1. `NOTIFIED_TYPES` gồm đúng 11 loại.

- [ ] **Step 1: Test danh mục (đỏ)** trong `events.test.ts`:
  - Thêm ba mẫu vào `SAMPLES`:
    ```ts
    'sales.return_status_changed': { returnId: id(), orderId: id(), from: null, to: 'requested' },
    'channel.shop_status_changed': { shopId: id(), from: 'active', to: 'needs_reauth' },
    'channel.listing_sync_changed': { shopId: id(), listingId: id(), stockSync: 'pending', priceSync: 'synced', status: 'live' },
    ```
  - `it('enum của ba sự kiện mới trùng hằng của module sở hữu (AC12)')`: so `EVENT_SCHEMAS['sales.return_status_changed'].shape.to.options` với `RETURN_STATUSES` (`#src/modules/order/sales/domain/return.ts`); `channel.shop_status_changed` `.shape.to.options` với `shopStatus.enumValues`; `listing_sync_changed` `.shape.status.options` với `listingStatus.enumValues`, `.shape.stockSync.options` với `syncState.enumValues` (ba hằng ở `#src/modules/channel/channel/repository/schema.ts`). So bằng `toEqual` sau khi sắp xếp.

- [ ] **Step 2: Chạy** `npx vitest run --project unit test/unit/modules/core/platform/domain/events.test.ts` → FAIL (thiếu loại, `SAMPLES` lệch `EVENT_TYPES`).

- [ ] **Step 3: Thêm ba schema** vào `events.ts` đúng như spec 5.1, kèm comment một dòng trỏ `Documents/21 §13.2, #216`.

- [ ] **Step 4: Chạy lại** → PASS.

- [ ] **Step 5: Test luật (đỏ)** trong `rules.test.ts`:
  - `ALL_MODULES` thêm `'channel'`.
  - `ROLES` theo `catalog.ts`: `ceo` thêm `sales.return.view`, `fulfillment.order.process`, `channel.shop.view`; `admin` thêm `sales.return.view`, `channel.shop.view`; `sale` thêm `sales.return.view`, `channel.shop.view`; `warehouse` thêm `sales.return.view`, `fulfillment.order.process`.
  - Bảng `table` bỏ hai dòng cũ, thêm (AC1):
    ```ts
    ['sales.order_status_changed', ['ceo', 'admin', 'sale']],
    ['fulfillment.package_status_changed', ['ceo', 'admin', 'sale', 'warehouse']],
    ['fulfillment.package_delivery_failed', ['ceo', 'admin', 'sale', 'warehouse']],
    ['fulfillment.package_lost', ['ceo', 'admin', 'sale', 'warehouse']],
    ['sales.return_status_changed', ['ceo', 'admin', 'sale', 'warehouse']],
    ['channel.shop_status_changed', ['ceo', 'admin', 'sale']],
    ['channel.listing_sync_changed', ['ceo', 'admin', 'sale']],
    ```
  - Bỏ ca "thanh toán: chỉ finance.invoice.view…" và ca `payment.succeeded` của `toMessage`.
  - `it('hai loại cũ không tới ai, consumer không nghe (AC3)')`: `canReceive(ROLES.ceo, 'payment.succeeded')`, `canReceive(ROLES.ceo, 'fulfillment.order_status_changed')` false; `toMessage(envelope('payment.succeeded', …))` null; `NOTIFIED_TYPES` sắp xếp `toEqual` 11 loại: `sales.order_created`, `inventory.below_threshold`, `inventory.receipt_posted`, `purchasing.request_submitted` + 7 loại mới.
  - `it('bảy loại mới: payload đúng trường, sự kiện thừa trường không lọt (AC2)')`: với mỗi loại, envelope có `aggregateId` khác mọi id trong payload; `toMessage(e)!.payload` `toEqual` đúng object trường của spec 5.2 (vd `package_lost` → `{ packageId, orderId, claimCode: 'KN-1' }`; `package_delivery_failed` → `{ packageId, orderId, reason: 'Khách không nghe máy' }`), và `JSON.stringify(message)` không chứa `aggregateId`, `companyId`.
  - `it('tắt phân hệ channel thì không nhận gian hàng, listing')`: `effectivePermissions(access(['channel.shop.view', 'sales.order.view'], ALL_MODULES.filter((m) => m !== 'channel')))` → `canReceive(…, 'channel.shop_status_changed')` false, `'sales.order_status_changed'` true (Review Focus 5).

- [ ] **Step 6: Chạy** `npx vitest run --project unit test/unit/modules/core/notification` → FAIL.

- [ ] **Step 7: Sửa `RULES`** trong `rules.ts`: thêm bảy luật theo bảng spec 5.2, bỏ `fulfillment.order_status_changed`, `payment.succeeded`. Giữ `dong` (còn `sales.order_created` dùng). Sửa comment đầu file và comment "Thêm loại: … rồi thêm dòng vào test và §13" nếu cần.

- [ ] **Step 8: Chạy lại** → PASS.

- [ ] **Step 9: Test stream (đỏ)** trong `stream.test.ts`:
  - Bỏ `paymentSucceeded`; ca "đúng công ty, đúng quyền theo bảng D11" đổi `payment` thành một `packageLost` (`event('fulfillment.package_lost', …, { packageId, orderId, claimCode: null })`), `financeOnly` thành vai trò tuỳ biến chỉ `fulfillment.order.process`; kỳ vọng mới: CEO 4 loại, Admin `[order_created, package_lost, below_threshold]`, Sale `[order_created, package_lost]`, Kho `[package_lost, below_threshold]`, vai trò tuỳ biến `[package_lost]`, công ty khác `[]`. Bỏ các kiểm tiền `"amount":150000` của thanh toán (giữ kiểm không lộ `aggregateId`, `companyId`).
  - `it('bảy loại mới tới đúng vai trò, payload parse bằng schema strict (AC4)')`: công ty `createCompany({ optionalModules: ['channel'] })`, mở stream CEO, Admin, Sale, Kho; dispatch một envelope cho mỗi loại (payload lấy theo mẫu Step 1, cộng mẫu hiện có của bốn loại đơn/kiện); chờ CEO nhận đủ 7; so tập loại mỗi vai trò với ma trận Step 5; với mỗi message ở stream CEO, `JSON.parse` dòng `data:` rồi `EVENT_SCHEMAS[type].strict().parse(data.payload)` không ném.
  - `it('đổi trạng thái đơn bằng service thật thì stream của Sale nhận sales.order_status_changed (AC5)')`: `seedPackage(companyId, { status: 'cancelled', orderStatus: 'processing', manual: true, lines: [{ variantId, quantity: 1 }] })` (`test/integration/order/fulfillment/helpers.ts`), `withCompany(companyId, () => settleCancelledOrder(orderId))`; đọc dòng `core.outbox_messages` `type = 'sales.order_status_changed' and key = orderId` bằng `testPool()`, dựng `OutboxRow` (`id`, `eventId`, `companyId`, `type`, `topic`, `key`, `payload`, `createdAt`, `publishedAt`), `hub.dispatch(JSON.parse(toKafkaMessage(row).value))` (`#src/modules/core/platform/service/outbox/relay.ts`); stream Sale chứa `id: <eventId>` và payload `{ orderId, code, from: 'processing', to: 'cancelled', flags: [...] }` (kiểm `orderId`, `from`, `to`).

- [ ] **Step 10: Chạy** `npx vitest run --project integration test/integration/core/notification` → PASS (Docker đang chạy). Nếu Step 9 viết sau Step 7 thì ca AC4 đã xanh; kiểm ca đó đỏ bằng cách tạm bỏ một luật, rồi trả lại.

- [ ] **Step 11: Cập nhật** bảng trong `src/modules/core/notification/CLAUDE.md` (bỏ hai dòng cũ, thêm bảy dòng theo spec 5.2) và đường dẫn test nếu còn trỏ chỗ cũ.

- [ ] **Step 12: Commit**

```bash
git add src/modules/core/platform/domain/events.ts src/modules/core/notification test/unit/modules/core test/integration/core/notification
git commit -m "feat(notification): luật SSE cho đơn, kiện, trả, gian hàng, listing; bỏ luật cũ (#216)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Yêu cầu trả phát `sales.return_status_changed`

**Files:**
- Modify: `src/modules/order/sales/domain/return.ts` (hằng, hàm so trường)
- Modify: `src/modules/order/sales/service/returns.ts` (`applyReturnStep`, hàm mới)
- Modify: `src/modules/order/sales/service/return-ingest.ts` (`createRequest` ~134, `syncExisting` ~181, ~194; xoá `changedFields` cục bộ)
- Modify: `src/modules/order/sales/service/return-confirm.ts:40`, `src/modules/order/sales/service/return-receive.ts:99`
- Modify: `src/modules/order/sales/CLAUDE.md` (dòng sự kiện phát)
- Test: `test/integration/order/sales/return-ingest.test.ts`, `test/integration/order/sales/returns-api.test.ts`

**Interfaces:**
- Consumes: `EventPayload<'sales.return_status_changed'>` (Task 2).
- Produces (sales nội bộ):
  - `domain/return.ts`: `export const RETURN_SHOWN_FIELDS = ['needsAttention', 'attentionNote', 'rawMarketplaceStatus', 'ofcStatus', 'disputeInProgress', 'returnTo', 'returnTrackingCode', 'refundAmount'] as const;` và `export function changedFields<T extends Record<string, unknown>>(row: T, patch: Partial<T>): Partial<T>` (chuyển nguyên từ `return-ingest.ts`: so tiền theo `Decimal`, `Date` theo mốc).
  - `service/returns.ts`: `export async function publishReturnStatusChanged(row: { id: string; orderId: string }, from: ReturnStatus | null, to: ReturnStatus): Promise<void>` (`aggregateId` = `orderId`); `export async function updateReturnShown(row: ReturnRow, patch: ReturnPatch): Promise<boolean>` (gọi `updateReturnAt(row.id, row.version, row.status, patch)`; trúng dòng và `changedFields(row, patch)` có khoá trong `RETURN_SHOWN_FIELDS` thì `publishReturnStatusChanged(row, row.status, row.status)`; trả kết quả `updateReturnAt`).

- [ ] **Step 1: Test (đỏ)** thêm vào `return-ingest.test.ts`, dùng `outboxOf(orderId, 'sales.return_status_changed')` (`../fulfillment/helpers.ts`):
  - Ca tạo yêu cầu (dòng 123): yêu cầu `requested` mới → `[{ returnId, orderId, from: null, to: 'requested' }]`.
  - Ca "kéo lại không đổi gì" (148): số sự kiện không tăng.
  - Ca "sàn đồng ý trả" (159): có `{ from: 'requested', to: 'awaiting_return' }`.
  - Ca "lần đầu thấy đã hoàn tiền" (175): đúng thứ tự `[null → requested, requested → refund_only]` (AC6).
  - Ca "sàn báo trạng thái app không tới được" (217): một sự kiện `from = to`; kéo lại cùng dữ liệu thêm lần nữa → **không** thêm sự kiện (Review Focus 1).
  - `it('sàn chỉ đổi tranh chấp: một sự kiện from = to; chỉ đổi externalUpdatedAt: không phát')`.
  - Ca đóng sau kiểm hàng hoàn (369): có `{ from: 'received', to: 'closed' }`, đứng trước `sales.return_refunded` trong outbox (so `id`).

  Thêm vào `returns-api.test.ts`: thao tác người dùng `accept` → một sự kiện `requested → awaiting_return`; `accept` với `version` cũ (409) → không thêm sự kiện. Ca báo sàn đã nhận lỗi (đường `return-receive.ts`) nếu file đã có: một sự kiện `from = to = 'received'`; `markReturnConfirmed` sau đó: thêm một sự kiện `from = to`.

- [ ] **Step 2: Chạy** `npx vitest run --project integration test/integration/order/sales/return-ingest.test.ts test/integration/order/sales/returns-api.test.ts` → FAIL (không có sự kiện).

- [ ] **Step 3: Viết** `RETURN_SHOWN_FIELDS`, `changedFields` ở `domain/return.ts`; `publishReturnStatusChanged`, `updateReturnShown` ở `service/returns.ts`. `applyReturnStep`: gọi `publishReturnStatusChanged(row, row.status, step.to)` ngay sau `recordTransition`, trước khối `return_refunded`. `createRequest`: sau `insertReturn` trúng (`created` khác `undefined`), `publishReturnStatusChanged(created, null, created.status)`. Bốn chỗ `updateReturnAt` ở spec 5.3 đổi sang `updateReturnShown` (nhánh `diff` truyền `diff`, nhánh xung đột truyền patch đầy đủ). `return-ingest.ts` import `changedFields` từ domain.

- [ ] **Step 4: Chạy lại** → PASS; chạy cả `npx vitest run --project integration test/integration/order/sales` → PASS.

- [ ] **Step 5: Cập nhật** `src/modules/order/sales/CLAUDE.md` mục sự kiện phát: thêm `sales.return_status_changed` (đổi trạng thái; `from = to` khi trường hiện trên màn đổi; tạo mới `from: null`).

- [ ] **Step 6: Commit**

```bash
git add src/modules/order/sales test/integration/order/sales
git commit -m "feat(sales): phát sales.return_status_changed cho yêu cầu trả (#216)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Gian hàng phát `channel.shop_status_changed`

**Files:**
- Create: `src/modules/channel/channel/service/shop-transition.ts`
- Modify: `src/modules/channel/channel/service/shops.ts` (~616 kết nối mới, ~640 nối lại, ~705 ngắt), `service/setup.ts:334`, `service/shop-tokens.ts:51`
- Test: Create `test/integration/channel/channel/shop-status-events.test.ts`; Modify `test/integration/channel/channel/setup.test.ts` (ca dòng 116)

**Interfaces:**
- Consumes: `EventPayload<'channel.shop_status_changed'>` (Task 2).
- Produces: `export async function recordShopTransition(input: { shopId: string; from: ShopStatus | null; to: ShopStatus; action: ShopAction | 'connect'; actorId: string | null; reason?: string | null }): Promise<void>`: gọi `recordTransition({ entityType: 'shops', entityId: shopId, from, to, action, actorId, reason })` rồi `publishEvent({ type: 'channel.shop_status_changed', aggregateId: shopId, payload: { shopId, from, to } })`.

- [ ] **Step 1: Test (đỏ)** `shop-status-events.test.ts` (adapter giả như `stock-push.test.ts`: `fakeAdapter` với `getSeller` đọc mã shop từ token; `createCompany({ optionalModules: ['channel'] })`), đọc sự kiện bằng `outboxOf(shopId, 'channel.shop_status_changed')`:
  - `it('kết nối mới: một sự kiện null → connecting')` (`POST /api/v1/channel/shops/lazada/token`).
  - `it('mất uỷ quyền: active → needs_reauth; gọi lại khi đã needs_reauth không phát thêm')`: `activateShop(shopId)`, `withCompany(companyId, () => markNeedsReauth(shopId, 'thử'))` hai lần.
  - `it('nối lại gian hàng đã thiết lập: needs_reauth → active')`: nối lại bằng cùng token route; kiểm sự kiện cuối.
  - `it('nối lại gian hàng chưa thiết lập: needs_reauth → connecting (resume_setup)')`: gian hàng `connecting` chưa có `order_cutoff_at`, `markNeedsReauth`, nối lại.
  - `it('nối lại khi đang active: không phát')`.
  - `it('ngắt: active → disconnected; listing gỡ do ngắt không phát listing_sync_changed (D12)')`: gian hàng `active` có một listing `live` ghi thẳng như `liveListing` của `stock-push.test.ts`; gọi route ngắt như `disconnect.test.ts` (không đơn mở); kiểm sự kiện gian hàng cuối là `active → disconnected` và `outboxOf(shopId, 'channel.listing_sync_changed')` rỗng.

  `setup.test.ts` ca "ghép, đẩy giá, gian hàng connecting → active": thêm kiểm có `{ shopId, from: 'connecting', to: 'active' }`.

- [ ] **Step 2: Chạy** `npx vitest run --project integration test/integration/channel/channel/shop-status-events.test.ts test/integration/channel/channel/setup.test.ts` → FAIL (không có sự kiện; ca D12 chỉ đỏ sau Task 5 nếu lớp ghi phát nhầm, hiện đã xanh).

- [ ] **Step 3: Viết** `shop-transition.ts`; thay năm lời `recordTransition({ entityType: 'shops' | ENTITY, … })` của gian hàng ở bốn file bằng `recordShopTransition` (giữ nguyên `from`, `to`, `action`, `actorId`, `reason` đang truyền; nhánh nối lại vẫn chỉ gọi khi `action` khác null). Không đổi các `recordTransition` của listing.

- [ ] **Step 4: Chạy lại** → PASS; chạy `npx vitest run --project integration test/integration/channel/channel/shops.test.ts test/integration/channel/channel/token-refresh.test.ts test/integration/channel/channel/disconnect.test.ts test/integration/channel/channel/reconnect-target.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/channel/channel/service test/integration/channel/channel
git commit -m "feat(channel): phát channel.shop_status_changed khi gian hàng đổi trạng thái (#216)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Lớp ghi listing phát `channel.listing_sync_changed`

**Files:**
- Create: `src/modules/channel/channel/repository/listing-writes.ts`
- Create: `src/modules/channel/channel/service/listing-writes.ts`
- Modify: `src/modules/channel/channel/repository/listings.ts` (bỏ `insertListing`, `updateListing`, `markStockPendingIds`, `markStockPendingRows`, hàm `stockPending`), `repository/shops.ts` (bỏ `delistForDisconnect`, `failPushingForDisconnect`)
- Modify (đổi import sang `../service/listing-writes.ts` hoặc `./listing-writes.ts`): `service/listing-push.ts`, `listing-sync.ts`, `listings.ts`, `mapping.ts`, `outside-change.ts`, `pending-prices.ts`, `remote-title.ts`, `setup.ts`, `shops.ts`
- Modify: `.dependency-cruiser.cjs` (luật mới), `src/modules/channel/channel/CLAUDE.md` (mục Listing: một dòng quy ước)
- Test: Create `test/integration/channel/channel/listing-writes.test.ts`; Modify `test/integration/channel/channel/relist.test.ts`

**Interfaces:**
- Consumes: `EventPayload<'channel.listing_sync_changed'>` (Task 2).
- Produces:
  - `repository/listing-writes.ts`:
    - `export interface SyncTriple { status: ListingStatus; stockSync: 'synced' | 'pending' | 'error'; priceSync: 'synced' | 'pending' | 'error' }`
    - `export interface SyncChange { listingId: string; shopId: string; before: SyncTriple; after: SyncTriple }`
    - `insertListing(values: typeof listings.$inferInsert): Promise<ListingRow>` (như cũ)
    - `updateListing(id: string, expected: { version: number; status?: ListingStatus }, patch: ListingPatch): Promise<{ row: ListingRow; before: SyncTriple } | undefined>`
    - `markStockPendingIds(ids: readonly string[]): Promise<SyncChange[]>`
    - `markStockPendingRows(variantIds: readonly string[], statuses: readonly ListingStatus[]): Promise<SyncChange[]>` (mọi dòng đã ghi, kể cả không đổi bộ ba)
    - `delistForDisconnect`, `failPushingForDisconnect`: chữ ký, thân như cũ.
  - `service/listing-writes.ts` (chữ ký bên gọi thấy, giữ như repository cũ):
    - `insertListing(values): Promise<ListingRow>`: phát một sự kiện.
    - `updateListing(id, expected, patch): Promise<ListingRow | undefined>`: phát khi bộ ba đổi.
    - `markStockPendingIds(ids): Promise<void>`; `markStockPendingRows(variantIds, statuses): Promise<string[]>` (id gian hàng khác nhau của mọi dòng đã ghi, như cũ): phát cho dòng có bộ ba đổi.
    - `delistForDisconnect`, `failPushingForDisconnect`: chuyển tiếp, không phát (D12, comment ghi lý do).

- [ ] **Step 1: Test (đỏ)** `listing-writes.test.ts`: một công ty `channel`, một gian hàng (token route + `activateShop`), listing ghi thẳng bằng `testPool()` như `liveListing` của `stock-push.test.ts` (đặt `stock_sync`, `price_sync` theo ca). Gọi hàm của `#src/modules/channel/channel/service/listing-writes.ts` trong `withCompany`. Đọc sự kiện bằng `outboxOf(shopId, 'channel.listing_sync_changed')` lọc theo `listingId`.
  - `it('updateListing đổi priceSync: một sự kiện mang bộ ba sau')`: `synced/synced live` → patch `{ priceSync: 'pending' }` → `[{ shopId, listingId, stockSync: 'synced', priceSync: 'pending', status: 'live' }]`.
  - `it('updateListing chỉ đổi trường khác (listedPrice): không phát')`.
  - `it('updateListing trượt version: trả undefined, không phát')` (Review Focus 3).
  - `it('updateListing kèm status sai: trả undefined, không phát')`.
  - `it('markStockPendingRows: synced → pending phát; error giữ error và pending giữ pending không phát; trả đủ id gian hàng')` (Review Focus 2): ba listing ba biến thể, gọi với cả ba biến thể và `['live']`; đúng một sự kiện; giá trị trả chứa `shopId`.
  - `it('markStockPendingIds: synced → pending phát một sự kiện mỗi listing')`.
  - `it('insertListing: một sự kiện theo giá trị vừa chèn')`.
  - `it('delistForDisconnect, failPushingForDisconnect: đổi trạng thái nhưng không phát (D12)')`: listing `live` và `pushing`, gọi hai hàm của service trong `withCompany`; dòng đã `delisted`/`push_failed`, không sự kiện nào.
  - `it('hai lượt ghi đua cùng listing: mỗi lượt phát đúng phần mình đổi')`: dùng `raceBehindLock` (`../../helpers/locks.ts`) giữ `select … for update` trên dòng, lượt A `updateListing(…, { version: v }, { stockSync: 'pending' })` chờ; sau commit lượt giữ khoá đã ghi `priceSync: 'pending'` và tăng `version` → lượt A trả `undefined`, không phát.

  `relist.test.ts`: ca nối lại có N listing đưa lên → N sự kiện `listing_sync_changed` với `status` theo trạng thái sàn (D13).

- [ ] **Step 2: Chạy** `npx vitest run --project integration test/integration/channel/channel/listing-writes.test.ts` → FAIL (module chưa có).

- [ ] **Step 3: Viết repository `listing-writes.ts`.** Chuyển nguyên `insertListing`, `stockPending`, `delistForDisconnect`, `failPushingForDisconnect` (kèm comment cũ). `updateListing`, `markStockPendingIds`, `markStockPendingRows` đọc bộ ba trước dưới khoá rồi ghi, chạy trên PG17: `UPDATE … FROM (SELECT id, status, stock_sync, price_sync FROM channel.listings WHERE <cùng điều kiện> ORDER BY id FOR UPDATE) old WHERE listings.id = old.id RETURNING …` (Drizzle `update().set().from(sub).where().returning()`, hoặc `sql` thô), hoặc hai câu trong cùng hàm. `updateListing` giữ điều kiện `version` (và `status` nếu có), `version + 1`, `updatedAt = now()`.

- [ ] **Step 4: Viết service `listing-writes.ts`.** So bộ ba bằng ba trường; phát `publishEvent({ type: 'channel.listing_sync_changed', aggregateId: shopId, payload: { shopId, listingId, stockSync, priceSync, status } })` theo giá trị sau, lần lượt theo thứ tự `listingId`.

- [ ] **Step 5: Đổi import** ở chín file service; xoá hàm đã chuyển khỏi `repository/listings.ts`, `repository/shops.ts`. Chạy `npx tsc --noEmit` → không lỗi.

- [ ] **Step 6: Luật dependency-cruiser** trong `.dependency-cruiser.cjs` (cạnh `repository-khong-goi-len`):

```js
{
  name: 'ghi-listing-qua-lop-phat',
  comment: 'status, stock_sync, price_sync của listing chỉ ghi qua service/listing-writes.ts (phát channel.listing_sync_changed, #216)',
  severity: 'error',
  from: { pathNot: '^src/modules/channel/channel/service/listing-writes\\.ts$' },
  to: { path: '^src/modules/channel/channel/repository/listing-writes\\.ts$' },
},
```
  Run: `npm run depcruise` → không lỗi. Thử tạm import repository `listing-writes.ts` từ `service/listings.ts` → `npm run depcruise` báo `ghi-listing-qua-lop-phat`; bỏ import thử.

- [ ] **Step 7: Chạy** `npx vitest run --project integration test/integration/channel/channel/listing-writes.test.ts test/integration/channel/channel/relist.test.ts` → PASS.

- [ ] **Step 8: Chạy cả module trên PG18 và PG17** (AC9, AC13, Review Focus 4):

Run: `npx vitest run --project integration test/integration/channel test/integration/order`
Expected: PASS.
Run: `TEST_PG_IMAGE=pgvector/pgvector:pg17 npx vitest run --project integration test/integration/channel/channel/listing-writes.test.ts test/integration/channel/channel/stock-push.test.ts test/integration/channel/channel/listing-sync.test.ts test/integration/channel/channel/disconnect.test.ts`
Expected: PASS.

- [ ] **Step 9: CLAUDE.md** `src/modules/channel/channel/CLAUDE.md` mục Listing thêm: "`status`, `stock_sync`, `price_sync` của listing chỉ ghi qua `service/listing-writes.ts` (phát `channel.listing_sync_changed` khi bộ ba đổi; ngắt gian hàng không phát, #216); dependency-cruiser `ghi-listing-qua-lop-phat` chặn import thẳng repository." Mục Gian hàng thêm: mọi lần chuyển trạng thái đi qua `recordShopTransition` (phát `channel.shop_status_changed`).

- [ ] **Step 10: Commit**

```bash
git add src/modules/channel .dependency-cruiser.cjs test/integration/channel
git commit -m "feat(channel): lớp ghi listing phát channel.listing_sync_changed khi trạng thái, đồng bộ đổi (#216)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Kiểm toàn nhánh, cập nhật graph, chuẩn bị PR

**Files:** không thêm code; `graphify-out/` cập nhật.

- [ ] **Step 1:** `npm run check` → lint, typecheck, depcruise, test đều xanh.
- [ ] **Step 2:** `graphify update .` → graph cập nhật, commit `graphify-out/` cùng commit cuối nếu repo đang theo dõi nó (`git status graphify-out`).
- [ ] **Step 3:** Rà AC1–AC13 của spec với test đã viết; ghi ánh xạ AC → test vào mô tả PR.
- [ ] **Step 4:** Soạn mô tả PR BE (tiếng Việt): tóm tắt, ánh xạ AC, lý do giữ ba schema mới trong cùng PR (`src/modules/CLAUDE.md` đòi PR riêng; chỉ `notification` nghe), gợi ý FE gộp lượt làm mới khi nhiều message tới liền, trỏ PR Documents (Task 1), dòng `🤖 Generated with [Claude Code](https://claude.com/claude-code)` ở cuối. **Hỏi Khang trước khi push hai nhánh và mở hai PR.**
