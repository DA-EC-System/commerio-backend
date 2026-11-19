# #236 PR 2: TikTok báo hết quyền trả (`COMPLETED`, `CANCELLED`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đơn của sàn `returnWindow = 'platform_status'` (TikTok) chỉ tự hoàn tất sau khi sàn báo đơn hết quyền trả (`COMPLETED`, hoặc `CANCELLED` theo D14), thay cho 7 ngày tạm của PR 1; đơn đã kết thúc trên sàn trước PR 2 được bù bằng một migration dữ liệu.

**Architecture:** Adapter TikTok điền `RemoteOrder.returnWindowEndedAt = update_time` khi `status` là `COMPLETED`/`CANCELLED` (Lazada không điền). Giá trị đi xuống `PlatformOrder` nhờ `...remote` ở `order-pull.ts:92`; `ingestMarketplaceOrder` ghi `orders.return_window_ends_at` **một lần** (cột còn null). Luật thuần `returnWindowEndsAt` bật nhánh `platform_status`: trả cột đã lưu, không có hạn dự phòng theo ngày (D8). Job, chi tiết đơn không đổi code: cả hai đã truyền cột vào `returnWindowEndsAt` từ PR 1.

**Tech Stack:** Node 24 (chạy thẳng `.ts`), TypeScript 6, Drizzle ORM 0.45 + PostgreSQL 18 (staging PG17), Vitest. Migration viết tay: `npm run db:generate -- --name tiktok-han-tra --custom` (drizzle-kit `generate --custom`, context7 `/drizzle-team/drizzle-orm-docs`, mục custom migrations).

**Spec:** `docs/superpowers/specs/2026-11-18-236-hoan-tat-huy-theo-kien-design.md` mục 5.1 (nhánh `platform_status`), 5.3, 6 (dòng PR 2), 8 (Documents "Cùng PR 2"), 9 (AC 12–17), 10. Đọc kèm plan PR 1 `docs/superpowers/plans/2026-11-18-236-pr1-han-tra-theo-gian-hang.md` (PR #418).

## Tiền đề đã kiểm

- **TikTok có tăng `update_time` khi đơn sang `COMPLETED`** (spec mục 10, điều kiện trước khi làm PR 2): gọi thật 19/11/2026, `npm run smoke:tiktok -- orders 1` (request_id `202611190418006BC7E952AF7AC30C913D`), đơn `586945714962334730` giao `2026-11-03T09:16Z` (`delivery_time`), đang `COMPLETED`, `update_time` `2026-11-18T17:31:25Z` (sau mốc giao 15 ngày). Đơn `586932266789143562` của spec không có `delivery_time` nên không dùng được. Kết luận: lượt kéo theo cửa sổ `update_time` thấy đơn sang `COMPLETED`; **không** cần issue kéo lại đơn `DELIVERED`.
- Nhánh: tạo `feature/236-tiktok-het-quyen-tra` từ `feature/236-hoan-tat-huy-theo-kien` (PR 1 chưa merge). #418 merge rồi thì `git fetch origin && git merge origin/main` trước Task 4; PR mở vào `main` sau khi #418 merge (trước đó mở draft, base là nhánh PR 1).

## Global Constraints

- Định danh tiếng Anh; comment, log, tên `describe`/`it` tiếng Việt. Import tương đối có đuôi `.ts`; không `enum`, `namespace`, parameter property.
- Code ngoài adapter **không** so chuỗi trạng thái sàn (`COMPLETED`, `CANCELLED`): chỉ `tiktok-orders.ts` và migration chạy một lần có chuỗi này (`channel/channel/CLAUDE.md`, spec 2 "Ràng buộc").
- `order` (lớp 3) không import `channel` (lớp 5); `returnWindowEndedAt` đi qua kiểu `PlatformOrder` của sales, không import kiểu của channel.
- Ghi một lần (D7): `return_window_ends_at` đã có giá trị thì lượt kéo không đè, kể cả đơn đã `completed` (hạn đã lưu lúc hoàn tất theo luật PR 1).
- Sàn `platform_status` không có hạn dự phòng theo ngày (D8): sàn chưa báo thì đơn có kiện đã giao **không** hoàn tất.
- Không đổi schema. Migration duy nhất là migration dữ liệu viết tay, **sinh ở bước cuối** (Task 4, sau khi gộp `main`), chạy lại được (CLAUDE.md mục Migration, `db/CLAUDE.md`).
- Test chỉ ở `test/`; integration không giả định bảng trống. Việc hoàn tất quét mọi công ty và nhiều file chạy nó theo giờ thật: dựng đơn theo mẫu PR 1 (`now` giờ thật, điều kiện chặn ghi trước khi lùi mốc giao, `delivered(…, { prepare })` của `complete.test.ts`).
- Commit theo task, tiêu đề `feat(channel|sales): … (#236)`, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Trước khi mở PR: `npm run check` (lint thêm `--ignore-pattern '.claude/**'` nếu vướng worktree), `graphify update .`.

## Thiết kế theo 6 bước (backend-design `think-before-coding`, `migration-safety`, `idempotency-and-side-effects`; `supabase-postgres-best-practices`; 19/11/2026)

1. **Loại và tải:** sửa luồng kéo đơn có sẵn (`channel.order_pull` 5 phút) và luật của job hoàn tất (mỗi giờ). Không thêm lời gọi sàn: mốc lấy từ chính `update_time` đã có trong chi tiết đơn.
2. **Dữ liệu và bất biến:** dùng lại cột `order.orders.return_window_ends_at`. Với đơn `processing` của sàn `platform_status`, cột nghĩa là "lúc app thấy sàn báo hết quyền trả"; null là sàn chưa báo. Đơn `completed` giữ hạn đã lưu (PR 1, D12).
3. **Lỗi:** không có đường lỗi mới. `update_time` thiếu thì `toTiktokOrder` đã ném (`unixRequired`), cả đơn không ingest như hiện tại.
4. **Quyền:** không đổi (job hệ thống, kéo đơn trong `withCompany`).
5. **Idempotence, đồng thời:** ghi một lần dưới khoá đơn của lượt kéo (`lockMarketplaceOrder` `FOR UPDATE`); kéo lại cùng đơn không đổi gì. Job đọc không khoá, ghi theo `version`. Migration tăng `version` để lần ghi theo `version` cũ của worker đang chạy bị lệch và xét lại ở lượt sau.
6. **Quan sát:** không thêm số liệu. Đơn TikTok chờ sàn hiện ở chi tiết đơn `completionBlocker = return_window`, `returnWindowEndsAt = null`.

**Migration (migration-safety):** một câu `UPDATE … FROM channel.raw_orders` chỉ chạm đơn TikTok `processing` đã kết thúc trên sàn mà cột còn null (vài chục dòng ở staging), join theo unique `raw_orders (shop_id, external_order_id)`, khoá dòng trong lúc chạy, không quét bảng lớn. Không đổi schema nên không cần `CONCURRENTLY`/`NOT VALID`. Rollback: không cần (cột chỉ được điền cho đơn đã kết thúc trên sàn, bản cũ của app bỏ qua cột này với TikTok); nếu buộc phải hoàn, `update … set return_window_ends_at = null` cho đúng tập dòng đó.

**Rollout:** Job migrate chạy trước khi đổi image. Worker cũ (PR 1) còn chạy trong khe đó có thể kéo một đơn vừa sang `COMPLETED`, lưu `raw_orders.external_update_time` mới mà không ghi cột; worker mới sẽ không kéo lại đơn đó (`order-pull.ts:161`, `update_time` không mới hơn). Vì vậy **sau rollout chạy lại file migration** (chạy lại được, như `*_keo-lai-don-trang-thai-moi`), ghi vào `db/CLAUDE.md`.

## Review Focus

1. **Dấu `epoch` trong `raw_orders.external_update_time`** (migration `*_huy-dong-du-lieu`, `*_keo-lai-don-trang-thai-moi` đặt để ép kéo lại): migration bù **bỏ** dòng `epoch` (đơn đó sẽ được kéo lại và ingest ghi mốc thật), không ghi hạn trả năm 1970. Test ở Task 4.
2. **Đơn đã `completed` (luật 7 ngày của PR 1) rồi sàn mới báo `COMPLETED`:** cột giữ hạn đã lưu, đơn không đổi, không phát sự kiện thừa. Test ở Task 3.
3. **TikTok `CANCELLED` sau khi kiện đã giao (D14):** đơn mang cờ Sàn đã huỷ, giữ `processing`, có hạn trả = `update_time`, rồi hoàn tất. Test ở Task 3.
4. **Đơn TikTok mọi kiện không huỷ đã hoàn về (`returned`), sàn chưa `COMPLETED`:** vẫn hoàn tất ngay vì không có kiện đã giao (AC 16, D1-R). Test ở Task 1.
5. **Lượt kéo chỉ có cột này đổi:** không thực tế (đi kèm `raw_marketplace_status` đổi), nhưng nếu xảy ra thì vẫn ghi cột mà không phát `sales.order_status_changed`. Test ở Task 3.

---

### Task 1: Luật `platform_status` đọc hạn sàn báo

**Files:**
- Modify: `src/modules/order/sales/domain/order.ts` (`returnWindowEndsAt`, comment PR 1 về D13)
- Test: `test/unit/modules/order/sales/domain/order.test.ts`
- Test: `test/integration/order/sales/complete.test.ts` (đổi AC11a thành AC 12a, thêm AC 16)
- Test: `test/integration/order/sales/orders-api.test.ts` (AC 13)

**Interfaces:**
- Produces: `returnWindowEndsAt(policy, lastDelivered, stored)` không đổi chữ ký. `platform_status`: `lastDelivered` null → null; còn lại → `stored` (có thể null). `days`: như PR 1.

- [ ] **Step 1: Unit đỏ** trong `describe('returnWindowEndsAt')`:
  - `it('platform_status: trả mốc sàn báo đã lưu, không cộng ngày')`: `returnWindowEndsAt({ returnWindow: 'platform_status', returnWindowDays: null }, delivered, stored)` `toEqual(stored)`.
  - `it('platform_status: sàn chưa báo thì null, không rơi về 7 ngày (D8)')`: `stored = null` → `toBeNull()`.
  - `it('platform_status: chưa kiện nào giao thì null dù sàn đã báo')`: `lastDelivered = null`, `stored` có giá trị → `toBeNull()`.
  - Xoá ca PR 1 "platform_status tạm 7 ngày" (nếu có).
- [ ] **Step 2: Integration đỏ** trong `complete.test.ts`, khối `hạn trả theo gian hàng (#236)`:
  - Đổi `AC11a` thành `it('AC12a: gian hàng TikTok, giao 8 ngày trước, sàn chưa báo COMPLETED → chưa hoàn tất (D8)')`: `status` `processing`. Đơn này an toàn với lượt giờ thật của file khác vì sàn chưa báo thì không lượt nào chốt được.
  - Thêm `id.ac16 = await delivered(['returned'], 0, { shop: tiktok })` vào `beforeAll`; `it('AC16: gian hàng TikTok, mọi kiện không huỷ đã hoàn về → completed không chờ sàn')`: `{ status: 'completed', outcome: 'none' }`.
  - `it('AC14 (luật job): gian hàng TikTok, sàn đã báo (cột có mốc) → completed, hạn = mốc sàn báo')`: đơn TikTok giao 30 ngày trước, `prepare` ghi `return_window_ends_at = now − 1 ngày` trước khi lùi mốc giao; sau lượt: `completed`, `return_window_ends_at` bằng mốc đã ghi.
  - `tiktokWaiting` của AC11 giữ nguyên (vẫn còn chờ).
- [ ] **Step 3: API đỏ** trong `orders-api.test.ts`, khối `#236`: thêm gian hàng TikTok (`platform 'tiktok'`, `return_window_days` null) và `it('AC13: gian hàng TikTok, giao 30 ngày trước, sàn còn DELIVERED → return_window, returnWindowEndsAt null')`: `completionBlocker` `'return_window'`, `returnWindowEndsAt` `null`.
- [ ] **Step 4:** Chạy `npx vitest run --project unit test/unit/modules/order/sales/domain/order.test.ts` và hai file integration: các ca mới đỏ vì `returnWindowEndsAt` còn cộng 7 ngày.
- [ ] **Step 5:** Sửa `returnWindowEndsAt`: nhánh `platform_status` trả `stored` (sau kiểm `lastDelivered`); bỏ `void stored` và câu "PR 1 tạm tính" ở JSDoc.
- [ ] **Step 6:** Chạy lại ba file trên: xanh; chạy `cancelling-handed-over.test.ts`, `lost.test.ts`: xanh.
- [ ] **Step 7:** Commit `feat(sales): sàn platform_status hoàn tất theo mốc sàn báo hết quyền trả (#236)`.

### Task 2: Adapter TikTok điền `returnWindowEndedAt`

**Files:**
- Modify: `src/modules/channel/channel/service/marketplaces/common.ts` (`RemoteOrder`)
- Modify: `src/modules/channel/channel/service/marketplaces/tiktok-orders.ts` (`toTiktokOrder`, comment dòng 40)
- Modify: `src/modules/channel/channel/CLAUDE.md` (bảng trạng thái TikTok dòng `COMPLETED`, thêm `CANCELLED`; ghi bằng chứng gọi thật 19/11/2026 ở mục "Đơn và kiện")
- Test: `test/unit/modules/channel/channel/service/marketplaces/tiktok-orders.test.ts`

**Interfaces:**
- Produces: `RemoteOrder.returnWindowEndedAt?: Date | null`, JSDoc: "Mốc sàn báo đơn hết quyền trả; chỉ sàn `returnWindow = 'platform_status'` điền (TikTok: `update_time` khi `status` là `COMPLETED` hoặc `CANCELLED`, D14). Lazada không điền."

- [ ] **Step 1: Unit đỏ** trong `describe('toTiktokOrder …')`: `it('AC12: DELIVERED → returnWindowEndedAt null; COMPLETED, CANCELLED → bằng update_time')`: dựng ba đơn từ `deliveredOrder()` với `status` khác nhau, `update_time` cố định; kỳ vọng `null`, `new Date(update_time * 1000)`, `new Date(update_time * 1000)`.
- [ ] **Step 2:** Chạy `npx vitest run --project unit test/unit/modules/channel/channel/service/marketplaces/tiktok-orders.test.ts`: đỏ.
- [ ] **Step 3:** Thêm trường vào `RemoteOrder`; `toTiktokOrder` điền theo `status` của đơn (không theo `display_status` của món). Sửa comment dòng 40 ("app đọc `rawStatus` = COMPLETED") thành "adapter báo `returnWindowEndedAt`".
- [ ] **Step 4:** Chạy lại file test và `contract-tiktok.test.ts`: xanh. Sửa `channel/channel/CLAUDE.md` như mục Files.
- [ ] **Step 5:** Commit `feat(channel): TikTok báo mốc hết quyền trả khi đơn COMPLETED, CANCELLED (#236)`.

### Task 3: Nhận đơn ghi mốc một lần

**Files:**
- Modify: `src/modules/order/sales/service/ingest.ts` (`PlatformOrder`, `ingestMarketplaceOrder`)
- Modify: `src/modules/order/sales/repository/orders.ts` (`rowColumns` thêm `returnWindowEndsAt`; `MarketplaceOrderRow` theo)
- Test: `test/integration/order/sales/ingest.test.ts` (AC 15, Review Focus 2, 5)
- Test: `test/integration/channel/channel/tiktok-order-pull.test.ts` (AC 14, Review Focus 3)
- Test: `test/integration/channel/channel/order-pull.test.ts` (AC 17)

**Interfaces:**
- Consumes: `RemoteOrder.returnWindowEndedAt` (Task 2), đi xuống nhờ `...remote` ở `order-pull.ts:92`.
- Produces: `PlatformOrder.returnWindowEndedAt?: Date | null` (JSDoc như Task 2, phía sales). Ingest: `o.returnWindowEndedAt` có và `row.returnWindowEndsAt` null → ghi cột cùng lần cập nhật đơn; cột đã có → giữ.

- [ ] **Step 1: Integration đỏ** ở `ingest.test.ts`, `describe('mốc sàn báo hết quyền trả (#236 PR 2)')`:
  - `it('AC15: ghi lần đầu, lần kéo sau với mốc mới hơn giữ mốc đầu')`: ingest đơn `delivered` với `returnWindowEndedAt = t1` → cột `t1`; ingest lại với `rawStatus` khác, `returnWindowEndedAt = t2 > t1` → cột vẫn `t1`.
  - `it('đơn đã hoàn tất giữ hạn đã lưu khi sàn mới báo')`: đơn `completed` có `return_window_ends_at = s` (ghi qua `testPool()`), ingest với `returnWindowEndedAt = t1` → cột `s`.
  - `it('chỉ mốc đổi: ghi cột, không phát sales.order_status_changed')`: ingest hai lần cùng mọi trường, lần hai thêm `returnWindowEndedAt`; cột có giá trị; đếm `core.outbox_messages` `sales.order_status_changed` của đơn không tăng.
  - `it('không có returnWindowEndedAt (Lazada) thì cột giữ null')` (phần AC 17 ở mức ingest).
- [ ] **Step 2: Integration đỏ** ở `tiktok-order-pull.test.ts`, `describe('hết quyền trả TikTok (#236 PR 2)')`, dùng fake server sẵn có (đơn `status` `DELIVERED` → `COMPLETED`, `display_status` món theo đơn):
  - `it('AC14: lượt kéo thấy COMPLETED ghi mốc = update_time; job chạy thì completed, outcome full')`: kéo `DELIVERED` (`update_time` u1) → cột null; đổi đơn sang `COMPLETED` (`update_time` u2) và kéo lại → cột `new Date(u2 * 1000)`; lùi `delivered_at` của kiện về 30 ngày trước; `completeDueOrdersOnce(new Date(), createModuleContext())` → `{ status: 'completed', outcome: 'full' }`, `return_window_ends_at` = u2.
  - `it('D14: đơn CANCELLED trên sàn mà kiện đã giao → mốc = update_time, job hoàn tất (không kẹt return_window)')`: đơn `DELIVERED` rồi `status` `CANCELLED`, món giữ `display_status` `DELIVERED` (kiện đã giao); sau kéo: `status` `processing`, cột = `update_time`; lùi `delivered_at`, job chạy → `completed`. Cờ của đơn theo luật huỷ theo món sẵn có, ca này không kiểm cờ.
  - Kéo bằng route `POST /api/v1/channel/shops/:id/orders/pull` như ca đầu file (không gọi `pullOpenOrders`: lượt đơn mở không lấy `DELIVERED`).
- [ ] **Step 3: Integration đỏ** ở `order-pull.test.ts` (Lazada): trong ca đầu `kéo từ mốc thiết lập …`, thêm kiểm `select return_window_ends_at` của đơn vừa kéo là `null` (AC 17).
- [ ] **Step 4:** Chạy ba file: các ca mới đỏ (AC 17 có thể xanh sẵn; giữ làm ca chặn hồi quy).
- [ ] **Step 5:** Sửa code: `rowColumns` thêm `returnWindowEndsAt: orders.returnWindowEndsAt`; `PlatformOrder` thêm trường; trong `ingestMarketplaceOrder` tính `const endedAt = !row.returnWindowEndsAt && o.returnWindowEndedAt ? o.returnWindowEndedAt : undefined`, ghi kèm trong `updateOrder` của nhánh `dirty`, và ở nhánh không `dirty` ghi cùng `info` (gộp vào câu `infoDirty`: điều kiện thành `(infoDirty || endedAt) && !dirty`). Không đưa `endedAt` vào `dirty`, `changed`.
- [ ] **Step 6:** Chạy lại ba file, cộng `complete.test.ts`, `cancelling-handed-over.test.ts`, `return-ingest.test.ts`: xanh.
- [ ] **Step 7:** Commit `feat(sales): nhận đơn ghi mốc sàn báo hết quyền trả một lần (#236)`.

### Task 4: Migration bù đơn đã kết thúc trên sàn

**Files:**
- Create: `db/migrations/<thời điểm>_tiktok-han-tra.sql` (sinh bằng `npm run db:generate -- --name tiktok-han-tra --custom`, **sau** `git merge origin/main`), kèm `meta/_journal.json`, snapshot do drizzle-kit sinh.
- Modify: `db/CLAUDE.md` (một gạch đầu dòng như `*_keo-lai-don-trang-thai-moi`)
- Test: `test/integration/order/sales/tiktok-han-tra-migration.test.ts` (mẫu `test/integration/order/fulfillment/lost-migration.test.ts`: đọc file theo slug, cắt câu `update`)

**Interfaces:**
- Produces: một câu SQL, chạy lại được:

```sql
-- #236 PR 2 (spec 5.3, D13): đơn TikTok đã COMPLETED/CANCELLED trên sàn trước PR 2 không được kéo lại
-- (order-pull bỏ đơn có update_time không mới hơn raw_orders), nên ghi mốc hết quyền trả từ lần kéo đã lưu.
-- Bỏ dòng 'epoch' (dấu ép kéo lại của migration trước): lượt kéo sau ghi mốc thật. Chạy lại được.
update "order".orders o
   set return_window_ends_at = r.external_update_time,
       version = o.version + 1,
       updated_at = now()
  from channel.raw_orders r
  join channel.shops s on s.id = r.shop_id
 where r.shop_id = o.shop_id
   and r.external_order_id = o.external_order_id
   and s.platform = 'tiktok'
   and o.status = 'processing'
   and o.raw_marketplace_status in ('COMPLETED', 'CANCELLED')
   and o.return_window_ends_at is null
   and r.external_update_time > 'epoch';
```

  (Kiểm tên cột `updated_at`, `version` của `order.orders` trong `schema.ts`; bỏ cột nào không có.)

- [ ] **Step 1: Test đỏ** (file chưa có thì `migration()` ném "Không thấy migration"): `describe('migration tiktok-han-tra (#236 PR 2, AC 12b)')`, một `it` dựng trong giao dịch rồi rollback (như `lost-migration.test.ts`): công ty, gian hàng `tiktok` và `lazada` (`insert into channel.shops`), đơn qua `seedPackage` hoặc `createOrder` của helper rồi `update` thẳng `shop_id`, `external_order_id`, `raw_marketplace_status`, `status`; `insert into channel.raw_orders (company_id, shop_id, external_order_id, payload, external_update_time)`. Sáu đơn:
  - TikTok `processing` `COMPLETED`, cột null, `external_update_time = T` → cột `T`, `version` tăng 1.
  - TikTok `processing` `CANCELLED`, cột null → cột `T`.
  - TikTok `processing` `DELIVERED` → null.
  - TikTok `processing` `COMPLETED`, cột đã có `S` → giữ `S`.
  - TikTok `completed` `COMPLETED`, cột `S` → giữ `S`.
  - TikTok `processing` `COMPLETED`, `external_update_time = 'epoch'` → null (Review Focus 1).
  - Lazada `processing` `raw_marketplace_status = 'COMPLETED'` → null.
  - Chạy câu lần hai: không dòng nào đổi (`rowCount` 0).
- [ ] **Step 2:** `git fetch origin && git merge origin/main` (PR 1 đã merge thì nhánh này về thẳng `main`); chạy `npm run db:generate -- --name tiktok-han-tra --custom`, dán câu SQL ở trên vào file sinh ra.
- [ ] **Step 3:** Chạy `npx vitest run --project integration test/integration/order/sales/tiktok-han-tra-migration.test.ts`: xanh. Chạy `npm run db:migrate:check` trên DB dev và `npm run db:ci-check`: migration của nhánh đứng sau mọi migration của `main`, snapshot không đứt.
- [ ] **Step 4:** Thêm vào `db/CLAUDE.md`: `*_tiktok-han-tra` (viết tay, chỉ dữ liệu, chạy lại được; #236 PR 2): điều kiện như câu SQL; **chạy lại cả file sau rollout** vì worker cũ có thể lưu `raw_orders` của đơn vừa sang `COMPLETED` mà không ghi cột, và worker mới không kéo lại đơn đó.
- [ ] **Step 5:** Commit `feat(sales): migration bù mốc hết quyền trả cho đơn TikTok đã kết thúc (#236)`.

### Task 5: Tài liệu, kiểm toàn nhánh, PR

**Files:**
- Modify: `src/modules/order/sales/CLAUDE.md` (mục Tự hoàn tất: bỏ "Sàn `platform_status` (TikTok) tạm 7 ngày tới PR 2 #236", thay bằng luật Task 1 và ghi một lần Task 3; mục Nhận đơn sàn: `PlatformOrder.returnWindowEndedAt`)
- Modify: `src/modules/order/sales/api/schemas.ts` (mô tả `returnWindowEndsAt`: thêm "sàn báo hết quyền trả (TikTok): lúc app thấy sàn báo; null tới lúc đó")
- Documents (worktree mới `D:\DA-TMDT\Documents-236-pr2`, nhánh `docs/236-tiktok-het-quyen-tra` từ `origin/main` của Documents): `21-hop-dong-api-fe-be.md` §19.1 "Hoàn tất" câu `platform_status` (spec mục 8 "Cùng PR 2"); `tich-hop-san/tiktok.md` ghi bằng chứng gọi thật 19/11/2026 ở "Tiền đề đã kiểm".

- [ ] **Step 1:** Sửa tài liệu như mục Files; `npm run check` (lint thêm `--ignore-pattern '.claude/**'` nếu cần); chạy cùng lúc `complete.test.ts`, `orders-api.test.ts`, `ingest.test.ts`, `tiktok-order-pull.test.ts`, `order-pull.test.ts`, `tiktok-han-tra-migration.test.ts`, `lost.test.ts`, `cancelling-handed-over.test.ts` hai lần.
- [ ] **Step 2:** `graphify update .`; commit `docs(sales): hạn trả TikTok theo mốc sàn báo (#236)`; commit Documents.
- [ ] **Step 3:** Mở PR backend (base `main` khi #418 đã merge, không thì draft base nhánh PR 1) với "Phần 2/3 của #236", bằng chứng smoke, bước chạy lại migration sau rollout; mở PR Documents.
