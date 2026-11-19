# #398 phần 2: nối lại đúng gian hàng (shopId trong state, 409 shop_mismatch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bấm Kết nối lại gian hàng A thì callback chỉ ghi token cho A; sàn trả seller khác thì 409 `shop_mismatch`, không ghi gì; mọi lần nối lại để lại một dòng nhật ký.

**Architecture:** `authorize-url` nhận query `shopId`, kiểm gian hàng thuộc công ty và đúng sàn, ký vào `state` (claim `shp`). `connectByCode` đọc `shp`, nạp gian hàng đích trước khi đổi mã, so `externalShopId` sau khi đổi mã, lệch thì ném trước `attachAll`. `writeShop` ghi `core.audit_logs` ở nhánh nối lại, cùng giao dịch với lần ghi token. Không đổi schema, không migration.

**Tech Stack:** Express 5 (query parser `simple`: query lặp thành mảng), Zod 4, `jose` (claim tuỳ biến là `unknown`, phải thu hẹp kiểu), Drizzle, Vitest (unit + integration Docker).

**Spec:** `Documents/21-hop-dong-api-fe-be.md` §18.4 (dòng `authorize-url`, bảng mã lỗi `shop_mismatch`) và §18.7.4 (màn `wrong_account`), thêm từ commit Documents `768a352` (02/11/2026). Issue commerio-backend#398 mục "Phần 2". FE `main` đã gửi `shopId` (`src/api/shops.api.ts` `useConnectShop`) và đã hiện màn `wrong_account` cho `shop_mismatch`; BE bỏ qua query này nên lỗi xảy ra.

## Global Constraints

- Query `shopId` tuỳ chọn. Không gửi thì giữ nguyên hành vi cũ: gian hàng nhận ra theo mã seller sàn trả.
- Gian hàng của công ty khác: 404 (21 §18.4). Không lộ gian hàng công ty khác.
- Mã lỗi đúng tên tài liệu: **`shop_mismatch`**, không dùng `reconnect_shop_mismatch` (tên cũ trong body issue, sai).
- `shop_mismatch` 409 kèm `expected`, `actual`, mỗi cái `{ name, externalShopId }`. `actual.name` là `null` khi seller chưa có trong công ty. BE bỏ token vừa nhận, không đổi trạng thái gian hàng nào.
- Token không bao giờ có trong response, log, lỗi, nhật ký (`channel/CLAUDE.md`).
- Câu cho người đọc bằng tiếng Việt; định danh tiếng Anh; import tương đối có đuôi `.ts`; lỗi nghiệp vụ là `AppError`; đầu vào qua `validate()`.
- Không migration. `core.audit_logs.action` là enum `create | update | delete`, nên "shop.reconnected" ghi thành `update` trên `channel.shops`.

## Quyết định ngoài tài liệu (ghi vào PR Documents khi mở PR)

1. `shopId` không phải uuid, hoặc gian hàng thuộc sàn khác `:platform`: 404 như gian hàng công ty khác.
2. `state` mang `shopId` mà lúc callback gian hàng không còn (xoá ở phần 1 của #398 giữa hai bước): 404 `not_found`, kiểm trước khi đổi mã nên mã uỷ quyền chưa bị tiêu.
3. Sàn trả nhiều gian hàng cho một lần uỷ quyền mà có gian hàng đích: nối tất cả như cũ. Không có gian hàng đích: `actual` là phần tử đầu sàn trả.
4. Thứ tự lỗi của callback: 422 `oauth_state_invalid` → 409 `company_mismatch` → 404 → (đổi mã) → 409 `shop_mismatch` → 409 `shop_connected_elsewhere`. `shop_mismatch` đứng trước `shop_connected_elsewhere`, và `actual.name` đọc trong `withCompany` nên không lộ tên gian hàng của công ty khác.
5. Nhật ký nối lại ghi cho **mọi** lần ghi đè gian hàng đã có (mọi `previousStatus`), không chỉ `active`.

## Review Focus

1. Log `warn` của `shop_mismatch` và `before`/`after` của nhật ký không chứa access token, refresh token, `params` của callback (có `code`).
2. Callback gọi lại cùng `code` sau 409 `shop_mismatch`: sàn đã tiêu mã nên trả `marketplace_unauthorized`; không nhánh nào được ghi token lúc đó.
3. `state` phát trước khi deploy (không có `shp`) vẫn đi đường cũ, không 500 khi `verifyPurposeToken` gặp claim lạ.
4. Adapter TikTok thật: `externalShopId` so khớp là `shops[].id`, cùng giá trị `findShopByExternal` đã lưu (không phải `cipher`).
5. Hai callback nối lại cùng gian hàng chạy song song: lần sau 409 `version_conflict` như cũ, không ghi hai dòng nhật ký cho một lần ghi.

---

### Task 1: `authorize-url?shopId=` ký gian hàng đích vào `state`

**Files:**
- Modify: `src/shared/auth/purpose-token.ts` (`PurposeClaims`, `verifyPurposeToken`)
- Modify: `src/modules/channel/channel/api/schemas.ts` (thêm `AuthorizeUrlQuery` cạnh `PlatformParams`)
- Modify: `src/modules/channel/channel/api/routes.ts:83-85`
- Modify: `src/modules/channel/channel/api/openapi.ts:105-113`
- Modify: `src/modules/channel/channel/service/shops.ts:345-350`
- Test: `test/unit/shared/auth/purpose-token.test.ts`
- Create: `test/integration/channel/channel/reconnect-target.test.ts`

**Interfaces:**
- Produces:
  - `PurposeClaims.shp?: string`: gian hàng cần nối lại (`oauth`, #398). `verifyPurposeToken` trả `shp: text(payload.shp)`.
  - `AuthorizeUrlQuery = z.object({ shopId: z.string().max(64).optional() })`, `.meta({ id: 'ShopAuthorizeUrlQuery' })`; mô tả `shopId`: "Gian hàng đang kết nối lại; FE gửi khi bấm Kết nối lại, không gửi khi Thêm gian hàng".
  - `authorizeUrl(raw: string, actor: Actor, shopId?: string): Promise<{ url: string }>`.
  - `reconnectTarget(companyId: string, platform: Platform, shopId: string): Promise<ShopRow>` (không export ra `index.ts`): trong `withCompany(companyId)` gọi `ownShop(shopId)`; `row.platform !== platform` thì `notFound()`.
  - Helper test trong file mới: `stateFor(bearer: string, platform: string, shopId?: string): Promise<string>`, `connectOAuth(bearer: string, sellers: string[], shopId?: string)` (gọi `authorize-url` rồi `callback` với `params: { code: 'c-' + sellers.join('+') }`).

Adapter giả trong file test mới (đăng ký trong file, `afterAll(resetAdapters)`):
- `lazada`: `authorizeUrl(state)` trả `https://auth.fake/oauth/authorize?state=…`; `exchangeCode({ code })` tăng bộ đếm `sàn.exchanges`, đọc `c-<seller>[+<seller>…]`, mỗi lần đổi trả token **mới** `tok-<seller>-<n>` (n tăng mỗi lần gọi), `accessExpiresAt` = now + 10 ngày + n phút, `refreshExpiresAt` = now + 50 ngày; tên `Shop <seller 8 ký tự đầu>`.
- `tiktok`: chỉ `getSeller(accessToken)` để dựng gian hàng sàn khác qua `POST /shops/tiktok/token`.

- [ ] **Step 1: Viết test unit đỏ**

Trong `purpose-token.test.ts`, describe "token mục đích riêng":
```ts
it('state OAuth mang shp (gian hàng cần nối lại, #398)', async () => {
  const token = await signPurposeToken('oauth', { cid: CID, sub: ID, plt: 'lazada', shp: ID });
  expect(await verifyPurposeToken('oauth', token)).toMatchObject({ cid: CID, sub: ID, plt: 'lazada', shp: ID });
});
```

- [ ] **Step 2: Chạy, thấy đỏ**

Run: `npx vitest run --project unit test/unit/shared/auth/purpose-token.test.ts`
Expected: FAIL, kết quả không có `shp` (Vitest không kiểm kiểu nên claim lạ vẫn chạy được).

- [ ] **Step 3: Thêm `shp` vào `PurposeClaims` và `verifyPurposeToken`**

- [ ] **Step 4: Chạy lại, thấy xanh**

Run: như Step 2. Expected: PASS.

- [ ] **Step 5: Viết test integration đỏ** (`describe('authorize-url nhận shopId (#398, 21 §18.4)')`)

| Ca | Kiểm |
|---|---|
| `shopId` của gian hàng mình cùng sàn | 200; `verifyPurposeToken('oauth', state)` có `shp` = id. Không gửi `shopId` thì `shp` là `undefined` |
| `shopId` của gian hàng công ty khác (`createCompany` thứ hai, nối bằng `connectOAuth`) | 404 `not_found` |
| `shopId` của gian hàng TikTok, gọi `/shops/lazada/authorize-url` | 404 `not_found` |
| `shopId=abc` | 404 `not_found` |
| `?shopId=<id>&shopId=<id>` | 422 `validation_failed`, `errors.shopId` có |

- [ ] **Step 6: Chạy, thấy đỏ**

Run: `npx vitest run --project integration test/integration/channel/channel/reconnect-target.test.ts`
Expected: FAIL ở ca `shp` (claim vắng), các ca 404 nhận 200, ca mảng nhận 200.

- [ ] **Step 7: Route, schema, service, OpenAPI**

Route: `validate({ params: PlatformParams, query: AuthorizeUrlQuery })`, truyền `validated<typeof AuthorizeUrlQuery>(res, 'query').shopId`. Service theo thứ tự: `platformOf` (422 `marketplace_unsupported`) → có `shopId` thì `reconnectTarget` (404) → ký `{ cid, sub, plt, shp }` → `adapter.authorizeUrl`. JSDoc `authorizeUrl` thêm `shopId`. OpenAPI: `request.query: AuthorizeUrlQuery`, thêm `404: problemResponse('\`not_found\`: gian hàng không thuộc công ty hoặc thuộc sàn khác')`, mô tả nhắc `shopId`.

- [ ] **Step 8: Chạy lại, thấy xanh**

Run: như Step 6 và Step 2. Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/shared/auth/purpose-token.ts src/modules/channel/channel/api src/modules/channel/channel/service/shops.ts test/unit/shared/auth/purpose-token.test.ts test/integration/channel/channel/reconnect-target.test.ts
git commit -m "feat(channel): authorize-url nhận shopId, ký gian hàng cần nối lại vào state (#398)"
```

### Task 2: callback chỉ nối lại đúng gian hàng trong `state`

**Files:**
- Modify: `src/modules/channel/channel/service/shops.ts:352-390` (`connectByCode`, thêm `shopMismatch`)
- Modify: `src/modules/channel/channel/api/openapi.ts:114-130` (callback)
- Test: `test/integration/channel/channel/reconnect-target.test.ts`

**Interfaces:**
- Consumes: `PurposeClaims.shp`, `reconnectTarget` (Task 1).
- Produces: `shopMismatch(companyId: string, platform: Platform, target: ShopRow, connections: ShopConnection[]): Promise<AppError>`: 409 `shop_mismatch`, câu "Tài khoản sàn vừa uỷ quyền không phải gian hàng đang kết nối lại", `{ expected: { name: target.shopName, externalShopId: target.externalShopId }, actual: { name, externalShopId } }`; `actual` lấy `connections[0]`, `name` từ `findShopByExternal` trong `withCompany(companyId)`, không có thì `null`. Ghi `logger.warn({ companyId, shopId: target.id, expected: target.externalShopId, actual: <mọi externalShopId sàn trả> }, 'Nối lại gian hàng nhưng sàn trả seller khác')` (lỗi của người dùng, không `error`).

Trong `connectByCode`: sau `companyMismatch`, `const target = claims.shp ? await reconnectTarget(actor.companyId, platform, claims.shp) : null;` (trước `forCompany`, nên 404 không tiêu mã); trong `forCompany`, sau `exchangeCode`, `target` có mà không phần tử nào có `externalShopId === target.externalShopId` thì `throw await shopMismatch(...)`, không gọi `attachAll`.

- [ ] **Step 1: Viết test đỏ** (`describe('callback nối lại theo shopId trong state (#398)')`)

Mỗi ca chụp `select * from channel.shops where company_id = $1 order by id` và số dòng `core.audit_logs` của công ty trước khi gọi, so lại sau ở ca lỗi (`toEqual`: không dòng nào đổi, kể cả `access_token_enc`, `version`).

| Ca | Kiểm |
|---|---|
| Gian hàng A (`disconnected`), state `shopId` = A, sàn trả seller B **chưa có** trong công ty | 409 `shop_mismatch`; `expected` = `{ name: A.shopName, externalShopId: A }`, `actual` = `{ name: null, externalShopId: B }`; không tạo gian hàng B, A vẫn `disconnected` |
| Như trên nhưng B **đã có** trong công ty (`active`) | 409; `actual.name` = tên B; B giữ token cũ (snapshot bằng nhau) |
| B đang gắn **công ty khác** | 409 `shop_mismatch` (không phải `shop_connected_elsewhere`), `actual.name` `null` |
| Sàn trả `A+B` (một lần uỷ quyền nhiều gian hàng), state `shopId` = A | 201, `shops` có cả A và B |
| State `shopId` = A rồi xoá dòng A (`delete from channel.shops` bằng `testPool`) trước callback | 404 `not_found`; `sàn.exchanges` không tăng |
| State `shopId` = A, sàn trả A | 200, `shop.id` = A (đường đúng) |

- [ ] **Step 2: Chạy, thấy đỏ**

Run: `npx vitest run --project integration test/integration/channel/channel/reconnect-target.test.ts`
Expected: hai ca 409 đầu nhận 200/201 (BE nối B), ca công ty khác nhận `shop_connected_elsewhere`, ca 404 nhận 201 (tạo lại A). Ca `A+B` và ca đường đúng đã xanh.

- [ ] **Step 3: `shopMismatch`, sửa `connectByCode`, OpenAPI**

OpenAPI callback: 404 `not_found` (gian hàng trong `state` không còn); 409 thêm `` `shop_mismatch` kèm `expected`, `actual` (`{ name, externalShopId }`, `actual.name` null khi seller chưa có trong công ty) `` vào câu; mô tả thêm một câu về `shopId` trong `state`. JSDoc `connectByCode` ghi thứ tự lỗi (Quyết định 4).

- [ ] **Step 4: Chạy lại, thấy xanh, chạy cả test channel cũ của luồng nối**

Run: `npx vitest run --project integration test/integration/channel/channel/reconnect-target.test.ts test/integration/channel/channel/shops.test.ts test/integration/channel/channel/tiktok-connect.test.ts test/integration/channel/channel/shops-18-7.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/channel/channel test/integration/channel/channel/reconnect-target.test.ts
git commit -m "feat(channel): callback trả 409 shop_mismatch khi sàn trả seller khác gian hàng đang nối lại (#398)"
```

### Task 3: nhật ký mỗi lần nối lại; chứng minh đường ghi token của callback

**Files:**
- Modify: `src/modules/channel/channel/service/shops.ts` (`connectByCode`, `connectByToken`, `attachAll`, `writeShop:521-557`)
- Test: `test/integration/channel/channel/reconnect-target.test.ts`

**Interfaces:**
- Produces: `type ConnectVia = 'oauth' | 'token'`; `attachAll(platform, actor, connections, via: ConnectVia)`; `writeShop(platform, actor, c, via: ConnectVia)`. Nhánh gian hàng đã có, sau khi `updateShop` trúng dòng: `recordAudit({ companyId: actor.companyId, actorId: actor.accountId, action: 'update', entityType: 'channel.shops', entityId: existing.id, before: { status, shopName, accessExpiresAt, refreshExpiresAt } của existing, after: { status, shopName, accessExpiresAt, refreshExpiresAt } của row vừa ghi + connectedVia: via })`. Nhánh tạo mới không ghi.

- [ ] **Step 1: Viết hai ca giữ hành vi (AC 1 của issue)**

`describe('nối lại qua callback lưu token mới (#398 AC 1)')`, `it.each(['needs_reauth', 'disconnected'])`: gian hàng nối bằng `connectOAuth`, `activateShop` (helper sẵn có), rồi `needs_reauth` bằng SQL hoặc ngắt bằng `POST /shops/:id/disconnect`; ghi lại `access_expires_at`; `connectOAuth(token, [seller], shopId)` → 200, `shop.status = 'active'`, `reconnect` khác null; `withCompany(companyId, () => shopSession(shopId))` trả `accessToken` = token của lần đổi mã vừa rồi; `access_expires_at` lớn hơn bản cũ.

- [ ] **Step 2: Chạy, thấy xanh**

Run: `npx vitest run --project integration test/integration/channel/channel/reconnect-target.test.ts -t "AC 1"`
Expected: PASS ngay. Đây là ca giữ hành vi theo AC: chứng minh BE ghi đúng token khi seller đúng, lỗi staging nằm ở chỗ nối nhầm seller (Task 2). Ghi vào ledger, không phải lỗi của test.

- [ ] **Step 3: Viết test nhật ký đỏ**

`describe('nhật ký nối lại (#398 AC 4)')`:
- `it.each(['active', 'needs_reauth'])` nối lại qua callback: đúng một dòng mới `core.audit_logs` `entity_type = 'channel.shops'`, `entity_id` = gian hàng, `action = 'update'`, `actor_id` = CEO; `before.status` = trạng thái cũ, `after.status = 'active'`, `after.connectedVia = 'oauth'`, `after.accessExpiresAt` khác `before.accessExpiresAt`; `JSON.stringify(before) + JSON.stringify(after)` không chứa chuỗi `tok-`.
- Nối lại bằng `POST /shops/tiktok/token` (gian hàng TikTok giả đã có): `after.connectedVia = 'token'`.
- Tạo gian hàng mới qua callback: không có dòng `channel.shops` nào cho gian hàng đó.

Lấy `actor_id` của CEO bằng `verifyPurposeToken('oauth', state).sub` từ `stateFor`.

- [ ] **Step 4: Chạy, thấy đỏ**

Run: `npx vitest run --project integration test/integration/channel/channel/reconnect-target.test.ts -t "AC 4"`
Expected: FAIL, không có dòng nhật ký nào.

- [ ] **Step 5: Truyền `via` và ghi nhật ký trong `writeShop`**

- [ ] **Step 6: Chạy lại, thấy xanh**

Run: như Step 4, rồi như Task 2 Step 4. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/channel/channel/service/shops.ts test/integration/channel/channel/reconnect-target.test.ts
git commit -m "feat(channel): ghi nhật ký mỗi lần nối lại gian hàng, kèm cách nối (#398)"
```

### Task 4: đua giữa làm mới token và nối lại qua callback (AC 2 của issue)

**Files:**
- Modify: `test/integration/channel/channel/token-refresh.test.ts:21-60` (adapter `shopee` giả), `:290-308` (describe đua)

**Interfaces:**
- Consumes: `authorize-url?shopId=` (Task 1).
- Adapter `shopee` giả thêm `authorizeUrl(state)` và `exchangeCode({ code })`: `code` là access token muốn cấp (`<seller>:acc-x`), trả `[{ externalShopId: <seller>, shopName: 'Shop 4 giờ', region: 'VN', tokens: { accessToken: code, refreshToken: '<seller>:ref-cb', accessExpiresAt: now + 4 giờ, refreshExpiresAt: now + 30 ngày } }]`.

- [ ] **Step 1: Đổi ca "người dùng nối lại trong lúc gọi sàn làm mới" thành `it.each(['token', 'callback'] as const)`**

Helper `reconnect(via, bearer, shopId, accessToken)`: `token` giữ lời gọi cũ; `callback` lấy `state` từ `GET /shops/shopee/authorize-url?shopId=` rồi `POST /shops/shopee/callback` với `params: { code: accessToken }`. Thân ca giữ nguyên: token cuối trong DB là `${seller}:acc-x`, gian hàng `active`.

- [ ] **Step 2: Chạy, thấy xanh**

Run: `npx vitest run --project integration test/integration/channel/channel/token-refresh.test.ts`
Expected: PASS cả hai nhánh. Ca giữ hành vi theo AC: hai đường nối cùng đi `writeShop`, CAS của `saveRefreshedTokens` bỏ cặp vừa làm mới.

- [ ] **Step 3: Commit**

```bash
git add test/integration/channel/channel/token-refresh.test.ts
git commit -m "test(channel): làm mới token đua với nối lại qua callback giữ token của lần nối (#398)"
```

### Task 5: tài liệu module và kiểm toàn bộ

**Files:**
- Modify: `src/modules/channel/channel/CLAUDE.md` (mục "Gian hàng (#103)", gạch đầu dòng "Ba cách nối")

- [ ] **Step 1: Sửa `channel/CLAUDE.md`**

Thêm vào gạch "Ba cách nối", sau câu về `company_mismatch`: `authorize-url` nhận `shopId` (nút Kết nối lại), ký vào `state` (claim `shp`); gian hàng không thuộc công ty, khác sàn hay id sai: 404. Callback có `shp` thì nạp gian hàng trước khi đổi mã (không còn: 404), sàn trả không có seller đó thì 409 `shop_mismatch` kèm `expected`, `actual` `{ name, externalShopId }` (`actual.name` null khi seller chưa có trong công ty), không ghi gì, log `warn`. Thứ tự lỗi theo Quyết định 4. Mỗi lần ghi đè gian hàng đã có ghi `core.audit_logs` `update` `channel.shops` (`before`/`after`: `status`, `shopName`, hai hạn token, `after.connectedVia`), không có token.

- [ ] **Step 2: Kiểm toàn bộ**

Run: `npm run check` (trong worktree)
Expected: lint, typecheck, depcruise xanh; mọi test qua.

- [ ] **Step 3: Commit**

```bash
git add src/modules/channel/channel/CLAUDE.md docs/superpowers/plans/2026-11-18-398-noi-lai-dung-gian-hang.md
git commit -m "docs(channel): nối lại theo shopId, shop_mismatch, nhật ký nối lại (#398)"
```

## Sau khi code xong (cần Khang đồng ý từng việc)

- Push, mở PR BE tham chiếu #398 (không `Closes`, phần 1 còn mở).
- PR Documents: thêm 5 quyết định ở trên vào §18.4 (dòng `authorize-url`, `callback`) và bảng mã lỗi.
- Sửa body #398 phần 2: tên mã `shop_mismatch` theo 21 (`768a352`), FE đã gửi `shopId` từ trước; hỏi Khoa xác nhận lần nối 21:31 có bấm từ nút Kết nối lại của `SANDBOX_VN7708…` không.
- DoD trên staging sau deploy: Khoa bấm Kết nối lại gian hàng `786769e1` bằng seller sai → màn `wrong_account`, không gian hàng nào đổi; bằng seller đúng → `active`, rồi:

```sql
select id, status, access_expires_at, updated_at from channel.shops where id::text like '786769e1%';
select action, before->>'status' as truoc, after->>'status' as sau, after->>'connectedVia' as cach, created_at
from core.audit_logs where entity_type = 'channel.shops' and entity_id::text like '786769e1%' order by created_at desc limit 3;
```

Đạt khi gian hàng `active`, `access_expires_at` mới, có dòng nhật ký `connectedVia = oauth`, và lượt kéo đơn kế tiếp không lỗi token.

## Ngoài plan

- `POST /shops/:platform/token` chưa nhận `shopId`: dán token của seller khác vẫn ghi vào gian hàng của seller đó. Tài liệu chưa có, FE chưa gửi; để issue sau nếu cần.
- Phần 1 của #398 (xoá gian hàng đã ngắt): plan riêng, chờ Bình xác nhận phiếu kho và chốt quyền.
