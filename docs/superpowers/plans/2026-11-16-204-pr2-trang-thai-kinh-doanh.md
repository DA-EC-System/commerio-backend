# #204 PR 2: trạng thái kinh doanh theo SKU — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin đổi trạng thái kinh doanh từng SKU hoặc cả sản phẩm cha (6 thao tác sơ đồ B1). Lưu trữ bị chặn khi còn tồn hoặc chứng từ mở, kèm lý do. Mỗi lần đổi có lịch sử, nhật ký, sự kiện. Hàng vào SKU đã lưu trữ thì SKU tự về `discontinued`. Inventory xét lại ngưỡng khi trạng thái đổi.

**Architecture:**
- Máy trạng thái ở `catalog/domain`.
- Bốn module tự trả câu lý do chặn lưu trữ của phần mình qua một hàm `(variantIds) => Map<variantId, string[]>`, catalog nhận qua `ctx`:
  - inventory, purchasing: `withContext` ở `product/index.ts`;
  - order, channel: `src/wiring.ts`.
- Nguồn inventory khoá dòng tồn (tạo dòng 0 nếu chưa có) trước khi đọc, nên ghi sổ kho không chen được giữa lúc kiểm và lúc lưu trữ (spec D10).
- Tự khôi phục móc vào lõi `applyChange` của inventory, phủ mọi đường cộng tồn.

**Tech Stack:** như PR 1 (Node 24, Express 5, Zod 4.6, Drizzle 0.45, PostgreSQL 18, Vitest 5).

**Spec:** `docs/superpowers/specs/2026-11-16-204-trang-thai-san-pham-design.md` mục 5.2, 6, 9 (PR 2), 10 (D6, D9, D10 Khang chốt 16/11/2026).

## Global Constraints

- Mọi ràng buộc chung của plan PR 1 (`docs/superpowers/plans/2026-11-16-204-pr0-pr1-su-kien-sua-sku.md`) vẫn áp dụng.
- **Không migration**: enum `business_status`, `core.state_transitions`, outbox đã có.
- Nhánh `feature/204-trang-thai-kinh-doanh`, chồng trên `feature/204-sua-sku` (#339).
- 6 mũi tên chép đúng `FE/src/lib/machines/product.ts`, quyền `catalog.product.manage`, không bước nào cần người thứ hai hay lý do.
- "Đơn mở" là `unpaid`, `processing` (D9). Dòng đơn đã huỷ hết (`cancelled_qty = quantity`) không tính.
- Yêu cầu trả mở là `OPEN_RETURN_STATUSES` của `sales/domain/return.ts`.
- Lịch sử: `recordTransition({ entityType: 'product_variants', … })`. Nhật ký: `entityType` là `product.product_variants`.
- Thiếu một nguồn lý do chặn khi chạy là lỗi lập trình (ném `Error`), không coi là "không chặn".
- Không bật cờ Cần xử lý khi tự khôi phục (D6).
- Tới PR 3: `products.archived_at`, `DELETE /catalog/products/:id` (lưu trữ cha) và công thức `getVariants().archived` giữ nguyên.

## Review Focus

1. **Lưu trữ đua với ghi sổ kho** trên SKU chưa có dòng tồn: không được ra SKU `archived` còn tồn. Test ở Task 2 kiểm nguồn inventory khoá dòng tồn: giao dịch khác `for update nowait` thì lỗi 55P03.
2. **Thao tác trên cha có SKU lệch trạng thái** (có SKU đã lưu trữ kiểu cũ): SKU lệch vào `skipped`, SKU khác vẫn đổi, không 409 cả lượt. Test ở Task 4.
3. **`variantIds` lặp hoặc của sản phẩm khác** trả 422, không đổi gì. Test ở Task 4.
4. **Hàng vào SKU đã lưu trữ qua đường không phải phiếu kho** (nhận hàng NCC, kiện hoàn, đảo xuất kho) phải tự khôi phục: móc chung ở `applyChange`. Test ở Task 6.
5. **Câu lý do chặn** là chữ hiện thẳng ở FE: test so đúng câu.

---

### Task 1: Máy trạng thái kinh doanh

**Files:**
- Create: `src/modules/product/catalog/domain/business-status.ts`
- Test: `test/unit/modules/product/catalog/domain/business-status.test.ts`

**Interfaces:**
- Produces:
  - `BUSINESS_STATUSES = ['selling', 'paused', 'discontinued', 'archived'] as const`, `type BusinessStatus`.
  - `BUSINESS_ACTIONS = ['pause', 'unpause', 'discontinue', 'reactivate', 'archive', 'restore'] as const`, `type BusinessAction`.
  - `interface BusinessRecord { archiveBlockers: readonly string[] }`.
  - `businessStatusMachine = defineMachine<BusinessStatus, BusinessAction, BusinessRecord>([...])`. `defineMachine` import từ `../../../core/index.ts`, như `channel/domain/listing.ts`.
    - Sáu dòng theo spec 5.2, mỗi dòng có `label` của FE và `permission: 'catalog.product.manage'`.
    - `archive` có `guard: (r) => (r.archiveBlockers.length ? 'archive_blocked' : null)`.

- [ ] **Step 1: Viết test đỏ.**
  - `actor = { accountId: 'a', permissions: ['catalog.product.manage'], enabledModules: ['catalog'] }`.
  - B1-01 đến B1-08: `it.each` mỗi mũi tên, tên có mã ca. `assertTransition(machine, from, action, { actor, record: { archiveBlockers: [] } }).to` bằng trạng thái đích.
  - B1-07g: `archive` với `archiveBlockers: ['Còn 3 tồn thực']` ném `AppError` có `code: 'archive_blocked'`, `status: 409`.
  - B1-X01 đến B1-X04: `it.each` mọi thao tác không có mũi tên từ trạng thái đó ném `code: 'invalid_transition'`.
  - Quyền: actor thiếu `catalog.product.manage` ném `code: 'forbidden'`.
- [ ] **Step 2: Chạy** `npx vitest run --project unit test/unit/modules/product/catalog/domain/business-status.test.ts`. Expected: FAIL, module chưa có.
- [ ] **Step 3: Viết `domain/business-status.ts`.**
- [ ] **Step 4: Chạy lại.** Expected: PASS.
- [ ] **Step 5: Commit** `#204: máy trạng thái kinh doanh của SKU (sơ đồ B1)`.

---

### Task 2: Lý do chặn lưu trữ của inventory và purchasing

**Files:**
- Create: `src/modules/product/inventory/service/archive-blockers.ts`, `src/modules/product/purchasing/service/archive-blockers.ts`
- Modify: `src/modules/product/inventory/index.ts`, `src/modules/product/purchasing/index.ts` (export)
- Test: `test/integration/product/inventory/archive-blockers.test.ts`, `test/integration/product/purchasing/archive-blockers.test.ts`

**Interfaces:**
- Produces: `type ArchiveBlockerSource = (variantIds: readonly string[]) => Promise<Map<string, string[]>>`.
  - Map chỉ có SKU có ít nhất một lý do. `variantIds` rỗng trả Map rỗng. Gọi trong `withCompany` của bên gọi.
  - Kiểu khai ở catalog (Task 4). Hai module ở đây chỉ cần hàm đúng chữ ký, không import kiểu.
- `stockArchiveBlockers(variantIds)`, export từ `inventory/index.ts`:
  - Khoá trước: với từng id theo thứ tự tăng, gọi `lockLevel(id)` (`repository/levels.ts`, tạo dòng 0 rồi `for update`). Không gọi `lockLevels` của service, vì nó gọi lại `getVariants`.
  - Rồi đếm số phiếu kho khác nhau ở `draft`, `pending` có dòng mang SKU ở `variant_id` hoặc `actual_variant_id`.
  - Câu lý do theo thứ tự, mỗi câu chỉ khi số khác 0:
    1. `Còn ${onHand} tồn thực`
    2. `Đang giữ ${reserved} cho đơn`
    3. `Còn ${quarantine} chờ xử lý`
    4. `Còn ${n} phiếu kho chưa ghi sổ`
- `purchaseArchiveBlockers(variantIds)`, export từ `purchasing/index.ts`. Câu lý do theo thứ tự:
  1. `Đang về ${incoming}`, lấy từ `incomingByVariant`.
  2. `Còn ${n} đề nghị nhập chưa xong`: đếm đề nghị khác nhau ở `draft`, `pending_approval`, `changes_requested`, `approved`, `ordered`, `partially_received`, dòng `excluded = false`.
  3. `Còn ${n} phiếu nhận đang kiểm`: phiếu nhận ở `counting`.
  4. `Còn ${n} phiếu trả NCC chưa có kết quả`: phiếu trả NCC ở `draft`, `pending_approval`, `sent`.

- [ ] **Step 1: Viết test đỏ, inventory.** Dùng `companyWithVariants`, `receive`, `setBuckets` của `inventory/helpers.ts`.

| `it` | Kiểm |
|---|---|
| SKU không vướng gì | Không có trong Map |
| `onHand 3, reserved 1, quarantine 2` | Đúng `['Còn 3 tồn thực', 'Đang giữ 1 cho đơn', 'Còn 2 chờ xử lý']` |
| Phiếu kiểm kê nháp có SKU | `['Còn 1 phiếu kho chưa ghi sổ']`; phiếu đã ghi sổ không tính |
| Khoá dòng tồn, kể cả SKU chưa có dòng (Review Focus 1) | Trong `withCompany` A gọi hàm. Một client `testPool()` khác chạy `select 1 from product.stock_levels where variant_id = $1 for update nowait` thì lỗi `55P03`. A kết thúc thì client kia khoá được |

- [ ] **Step 2: Viết test đỏ, purchasing.** Dùng `createSupplier`, `createRequest`, `orderedRequest`, `createReceipt`, `postedReceipt` của `purchasing/helpers.ts`.

| `it` | Kiểm |
|---|---|
| Đề nghị nháp có SKU | `['Còn 1 đề nghị nhập chưa xong']` |
| Đề nghị đã đặt NCC, chưa nhận | Có `Đang về <số>` và `Còn 1 đề nghị nhập chưa xong` |
| Phiếu nhận `counting` | Có `Còn 1 phiếu nhận đang kiểm` |
| `postedReceipt` có hàng lỗi giữ lại (sinh phiếu trả NCC nháp) | Có `Còn 1 phiếu trả NCC chưa có kết quả` |
| SKU không vướng | Không có trong Map |

- [ ] **Step 3: Chạy hai file.** Expected: FAIL, hàm chưa có.
- [ ] **Step 4: Viết hai hàm, export.** Mỗi hàm gom bằng một câu truy vấn mỗi loại cho cả lô id, không lặp theo SKU (trừ `lockLevel`).
- [ ] **Step 5: Chạy lại.** Expected: PASS.
- [ ] **Step 6: Commit** `#204: lý do chặn lưu trữ SKU của inventory, purchasing`.

---

### Task 3: Lý do chặn lưu trữ của order và channel

**Files:**
- Create: `src/modules/order/sales/service/catalog-boundary.ts`, `src/modules/channel/channel/service/catalog-boundary.ts`
- Modify: `src/modules/order/sales/index.ts`, `src/modules/channel/channel/index.ts` (export)
- Test: `test/integration/order/sales/archive-blockers.test.ts`, `test/integration/channel/channel/archive-blockers.test.ts`

**Interfaces:**
- Produces, cùng chữ ký `ArchiveBlockerSource`:
  - `orderArchiveBlockers(variantIds)`, theo thứ tự:
    1. `Còn ${n} đơn chưa xong`: đếm đơn khác nhau ở `unpaid`, `processing` có dòng mang SKU với `cancelled_qty < quantity`.
    2. `Còn ${n} yêu cầu trả đang mở`: yêu cầu ở `OPEN_RETURN_STATUSES` có dòng mang SKU.
  - `listingArchiveBlockers(variantIds)`: `Còn ${n} listing đang đẩy lên sàn` khi có listing `variant_id` của SKU ở `pushing`.

- [ ] **Step 1: Viết test đỏ, sales.** Dùng `createVariant`, `createOrder` của helper chung.

| `it` | Kiểm |
|---|---|
| Đơn `unpaid` | `['Còn 1 đơn chưa xong']` |
| Đơn `processing` | `['Còn 1 đơn chưa xong']` |
| Đơn `completed` | Không có trong Map. Đổi trạng thái bằng `testPool` |
| Đơn `cancelled` | Không có trong Map |
| Dòng đã huỷ hết (`cancelled_qty = quantity`) | Không có trong Map |
| Yêu cầu trả `requested` có dòng mang SKU | Có `Còn 1 yêu cầu trả đang mở` (đơn của nó đặt `completed`) |
| Yêu cầu trả `closed` | Không tính |

  Chèn yêu cầu trả bằng SQL vào `order.return_requests` và `order.return_request_lines`. Đọc cột NOT NULL ở `sales/repository/schema.ts:211-290`. Không có helper chung.

- [ ] **Step 2: Viết test đỏ, channel.**
  - Chèn listing bằng SQL như `background.test.ts:101`, kèm gian hàng từ `createCompany({ optionalModules: ['channel'] })` và token.
  - `pushing` → `['Còn 1 listing đang đẩy lên sàn']`.
  - `live` không tính.
- [ ] **Step 3: Chạy hai file.** Expected: FAIL.
- [ ] **Step 4: Viết hai hàm, export qua index của module con.** Index module lớn đã `export *`.
- [ ] **Step 5: Chạy lại.** Expected: PASS.
- [ ] **Step 6: Commit** `#204: lý do chặn lưu trữ SKU của order, channel`.

---

### Task 4: `POST /catalog/products/:id/business-status` và `archiveBlockers` ở chi tiết

**Files:**
- Create: `src/modules/product/catalog/service/usage.ts`, `src/modules/product/catalog/service/business-status.ts`
- Modify: `service/standard-price.ts` (`CatalogContext` chuyển sang `usage.ts`, re-export)
- Modify: `service/errors.ts`, `service/products.ts` (`productDetail`, `toVariantView`)
- Modify: `repository/variants.ts` (`setBusinessStatus`)
- Modify: `api/schemas.ts`, `api/routes.ts`, `api/openapi.ts`, `catalog/index.ts`
- Modify: `src/modules/product/index.ts`, `src/wiring.ts`
- Test: `test/integration/product/catalog/business-status.test.ts`, `test/integration/product/catalog/helpers.ts`

**Interfaces:**
- Consumes: máy trạng thái (Task 1); bốn hàm nguồn (Task 2, 3); `recordTransition`, `recordAudit`, `publishEvent` (`core/index.ts`); `getAccess` (`shared/auth/authorize.ts`).
- Produces:
  - `usage.ts`:
    - `type ArchiveBlockerSource`.
    - `interface CatalogContext extends ModuleContext` với bốn trường tuỳ chọn `stockArchiveBlockers`, `purchaseArchiveBlockers`, `orderArchiveBlockers`, `listingArchiveBlockers`.
    - `archiveBlockersOf(ctx: CatalogContext, variantIds: readonly string[]): Promise<Map<string, string[]>>`: gọi bốn nguồn theo thứ tự inventory, purchasing, order, channel, nối câu. Nguồn nào chưa nối thì `throw new Error('Chưa nối nguồn lý do chặn lưu trữ: <tên trường>')`. `variantIds` rỗng thì không gọi nguồn nào.
  - Nối nguồn:
    - `product/index.ts`: `withContext(catalogModule, (ctx) => ({ ...ctx, stockArchiveBlockers, purchaseArchiveBlockers }))`.
    - `src/wiring.ts`: `AppContext` thêm `Required<Pick<CatalogContext, 'orderArchiveBlockers' | 'listingArchiveBlockers'>>`, gán từ `order/index.ts`, `channel/index.ts`.
  - `setBusinessStatus(id: string, from: BusinessStatus, to: BusinessStatus): Promise<{ updatedAt: Date } | undefined>`:
    - Câu: `update … set business_status = to, archived_at = (to = 'archived' ? now() : null), version + 1, updated_at = now() where id and business_status = from returning updated_at`.
  - Lỗi trong `errors.ts`:
    - `archiveBlocked(sku: string, reasons: string[])`: 409 `archive_blocked`, extensions `{ reasons }`.
    - `invalidTransition(current: unknown)`: 409 `invalid_transition`, `{ current }`.
  - `interface BusinessActor { accountId: string; companyId: string; permissions: readonly string[]; enabledModules: readonly string[] }`.
  - `changeBusinessStatus(ctx: CatalogContext, actor: BusinessActor, productId: string, input: { action: BusinessAction; variantIds?: string[] | undefined }): Promise<BusinessStatusResult>`:
    - `BusinessStatusResult = { product: ProductDetail; applied: string[]; skipped: { variantId: string; sku: string; code: 'invalid_transition' | 'archive_blocked'; reasons: string[] }[] }`.
    - Trong `withCompany`, theo thứ tự:
      1. `lockVariants`, rồi `findOwnProduct`. Cha có `archivedAt` thì `productArchived()`.
      2. `findVariants({ productId })`. Có `variantIds` mà id nào không có trong đó thì `invalid({ variantIds: 'Có SKU không thuộc sản phẩm này' })`.
      3. `action = 'archive'`: gọi `archiveBlockersOf` một lần cho các SKU đích đang `discontinued`.
      4. Mỗi SKU đích: `assertTransition(businessStatusMachine, v.businessStatus, action, { actor, record: { archiveBlockers } })`.
         - Lỗi `invalid_transition` hoặc `archive_blocked`: nếu `variantIds` có đúng 1 phần tử thì ném `invalidTransition(<ProductDetail>)` hoặc `archiveBlocked(sku, reasons)`; không thì đưa vào `skipped`.
      5. Qua thì gọi `setBusinessStatus`. Không trúng dòng thì đưa vào `skipped` với `invalid_transition`.
      6. Trúng thì `recordTransition({ entityType: 'product_variants', entityId, from, to, action, actorId: actor.accountId, source: 'user' })`, `recordAudit` (`update`, `before: { businessStatus: from }`, `after: { businessStatus: to }`), `publishEvent('catalog.variant_status_changed', { variantId, productId, from, to, changedAt })`.
      7. Có SKU đổi thì `touchProduct` một lần. Trả `{ product: productDetail(...), applied, skipped }`.
  - `productDetail`: gọi `archiveBlockersOf` cho các SKU đang `discontinued`, không có thì không gọi. `toVariantView(v, standardPrice, archiveBlockers = [])` thêm `archiveBlockers`.
  - Zod:
    - `Variant` thêm `archiveBlockers: z.array(z.string())`.
    - `BusinessStatusBody = z.object({ action: z.enum(BUSINESS_ACTIONS, 'Thao tác không hợp lệ'), variantIds: z.array(z.uuid('SKU không hợp lệ')).min(1, 'Chọn ít nhất một SKU').optional() })`, kèm `superRefine` báo trùng ở `variantIds`. `.meta({ id: 'BusinessStatusRequest' })`.
    - `BusinessStatusResult` (`.meta({ id: 'BusinessStatusResult' })`).
  - Route: `router.post('/products/:id/business-status', manage, validate({ params: IdParams, body: BusinessStatusBody }), …)`. Actor lấy từ `getAuth(res)` và `getAccess(res)`. Trả 200. Khai OpenAPI đủ 200, 409, 404, 422.
  - `catalog/index.ts` export `type CatalogContext`, `type ArchiveBlockerSource`.
  - Helper test `catalog/helpers.ts`: `businessStatus(token, productId, action, variantIds?)` gọi route. `archiveSku(token, productId, variantId)` gọi `discontinue` rồi `archive`, kỳ vọng 200.

- [ ] **Step 1: Viết test đỏ** `business-status.test.ts`. Tên `it` mang mã ca. CEO làm, Sale và Kho từ `addMember`. SKU vào trạng thái nguồn bằng chuỗi thao tác qua route.

| `it` | Kiểm |
|---|---|
| B1-01 đến B1-08 (`it.each`) | 200, `applied: [id]`, `businessStatus` ở chi tiết đúng đích; `archivedAt` có giá trị chỉ khi `archived` |
| Một lần đổi ghi đủ dấu vết | Đúng một dòng `core.state_transitions` (`entity_type 'product_variants'`, `from_status`, `to_status`, `action`, `actor_id` là CEO; đọc tên cột ở `core/platform/repository/schema.ts`), một dòng nhật ký, một dòng outbox `catalog.variant_status_changed` đúng payload |
| B1-01q đến B1-08q (`it.each` Sale, Kho × 6 thao tác) | 403 `forbidden` |
| B1-07g | `receive(companyId, variantId, 3, …)` cho SKU, `discontinue`, `archive` → 409 `archive_blocked`, `reasons` chứa `'Còn 3 tồn thực'`, trạng thái vẫn `discontinued` |
| B1-X01 đến B1-X04 (`it.each`) | 409 `invalid_transition` kèm `current`, trạng thái không đổi |
| Cả cha (Review Focus 2) | Cha 3 SKU, 1 SKU đã `paused`; `pause` không `variantIds` → `applied` 2, `skipped` 1 (`invalid_transition`, `reasons: []`) |
| Cả cha có SKU bị chặn | `archive` không `variantIds`: SKU có tồn vào `skipped` với `archive_blocked` và lý do, SKU khác `archived` |
| `variantIds` sai (Review Focus 3) | Lặp → 422 `errors.variantIds`; SKU của sản phẩm khác → 422 `errors.variantIds`; không đổi gì |
| Cha đã lưu trữ | `DELETE /products/:id?version=1` → 409 `product_archived` |
| Chi tiết có lý do chặn | SKU `discontinued` còn tồn có `archiveBlockers: ['Còn 3 tồn thực']`; SKU `selling` có `[]`. `ProductDetail.parse(body)` bằng `body` |
| Body trả về đúng schema | `BusinessStatusResult.parse(body)` bằng `body` |

- [ ] **Step 2: Chạy.** Expected: FAIL, route chưa có (404).
- [ ] **Step 3: Viết theo Interfaces.** Đọc thứ tự trong `changeBusinessStatus` ở trên; giữ đúng thứ tự khoá: `lockVariants` → dòng tồn (trong nguồn inventory) → dòng SKU.
- [ ] **Step 4: Chạy file mới và cả `test/integration/product/catalog`.** Expected: PASS.
  - `variant-edit.test.ts` và các test khác còn dùng `DELETE …/variants/:variantId` vẫn chạy, vì route cũ tới Task 5 mới bỏ.
  - `test/unit/wiring.test.ts` phải xanh.
- [ ] **Step 5: Commit** `#204: route đổi trạng thái kinh doanh SKU, lý do chặn lưu trữ ở chi tiết`.

---

### Task 5: Bỏ ngừng bán kiểu cũ, `variant_archived`

**Files:**
- Modify: `service/variants.ts` (`addVariant`; xoá `archiveVariant`), `service/errors.ts` (xoá `lastVariant`, thêm `variantArchived`)
- Modify: `repository/variants.ts` (xoá `setVariantArchived`), `api/routes.ts`, `api/openapi.ts`
- Test: `variants.test.ts`, `access.test.ts`, `get-variants.test.ts`, `products.test.ts`, `attributes.test.ts`, `variant-edit.test.ts`

**Interfaces:**
- Produces: `variantArchived(variantId: string)`: 409 `variant_archived`, câu "Tổ hợp này thuộc SKU đã lưu trữ, dùng Khôi phục", extensions `{ variantId }`. `addVariant` chỉ còn trả 201; route `POST …/variants` luôn `status(201)`.

- [ ] **Step 1: Sửa test thành đỏ.**
  - `variants.test.ts`: ca "tổ hợp từng ngừng bán → 200" đổi thành: `archiveSku`, rồi thêm lại tổ hợp → 409 `variant_archived`, `body.variantId` là id cũ, không có SKU mới.
  - Thêm ca `DELETE /products/:id/variants/:variantId` → 404.
  - Mọi chỗ khác gọi `DELETE …/variants/` (8 chỗ, `grep -rn "variants/\${" test/integration/product/catalog`) đổi sang `archiveSku`. SKU bị lưu trữ sẽ có `version` khác: `archiveSku` qua hai bước nên `version` tăng 2. Sửa số `version` kỳ vọng theo đó.
  - Ca `last_variant` bỏ, vì lưu trữ SKU cuối nay hợp lệ.
  - `access.test.ts`: dòng `DELETE …/variants/:variantId` trong `writes` và trong nhóm 404 đổi sang `POST /products/:id/business-status` (`{ action: 'pause' }`).
- [ ] **Step 2: Chạy `test/integration/product/catalog`.** Expected: FAIL ở ca `variant_archived` và ca route cũ 404.
- [ ] **Step 3: Sửa code.**
  - `addVariant`: tổ hợp trùng SKU `archived` thì `variantArchived(same.id)`; trùng SKU chưa lưu trữ thì `variantExists`.
  - Xoá route `DELETE` biến thể và khai OpenAPI của nó; xoá `archiveVariant`, `setVariantArchived`, `lastVariant`.
- [ ] **Step 4: Chạy lại cả `test/integration/product`, `test/integration/channel`.** Expected: PASS.
- [ ] **Step 5: Commit** `#204: bỏ ngừng bán biến thể kiểu cũ; thêm biến thể trùng SKU lưu trữ trả variant_archived`.

---

### Task 6: Tự khôi phục khi có hàng vào; inventory nghe đổi trạng thái

**Files:**
- Modify: `src/modules/product/catalog/repository/variants.ts` (`restoreArchivedRows`)
- Modify: `src/modules/product/catalog/service/business-status.ts` (`restoreArchivedBySystem`), `catalog/index.ts` (export)
- Modify: `src/modules/product/inventory/service/posting.ts` (`applyChange`)
- Create: `src/modules/product/inventory/service/background.ts`
- Modify: `src/modules/product/inventory/index.ts` (`startBackground`)
- Test: `test/integration/product/inventory/auto-restore.test.ts`

**Interfaces:**
- Produces:
  - `restoreArchivedRows(ids: readonly string[]): Promise<{ id: string; productId: string; updatedAt: Date }[]>`: một câu `update … set business_status = 'discontinued', archived_at = null, version + 1, updated_at = now() where id = any(ids) and business_status = 'archived' returning …`.
  - `restoreArchivedBySystem(variantIds: readonly string[]): Promise<void>`, export từ `catalog/index.ts`:
    - Không lấy `lockVariants` (spec 5.2: chạy khi dòng tồn đã khoá, lấy khoá công ty sẽ ngược thứ tự).
    - Mỗi dòng trả về: `recordTransition({ entityType: 'product_variants', entityId, from: 'archived', to: 'discontinued', action: 'restore', actorId: null, source: 'system' })` và `publishEvent('catalog.variant_status_changed', …)`.
    - Không ghi nhật ký thao tác, không bật cờ (D6).
  - Trong `applyChange`: sau `insertMoves`, trước vòng `publishEvent` của `stock_changed`, gọi `restoreArchivedBySystem([...new Set(moves.filter((m) => m.qty > 0).map((m) => m.variantId))])` khi tập không rỗng. Nhờ vậy `recheckThresholds` ở cuối tính theo trạng thái mới.
  - `onVariantStatusChanged(event: { payload: EventPayload<'catalog.variant_status_changed'> }): Promise<void>` gọi `recheckThresholds([payload.variantId])`. Bên consumer đã bọc `withCompany`.
  - `inventoryModule.startBackground` gọi `registerConsumer('catalog.variant_status_changed', onVariantStatusChanged, { consumer: 'inventory-variant-status' })`, trả `async () => {}`, theo mẫu `order/fulfillment/index.ts:14-23`.

- [ ] **Step 1: Viết test đỏ** `auto-restore.test.ts`.

| `it` | Kiểm |
|---|---|
| SKU lưu trữ (`archiveVariant` raw SQL của helper) nhận hàng qua `receive` | `business_status = 'discontinued'`, `archived_at` null; một dòng `state_transitions` (`action 'restore'`, `actor_id` null, `source 'system'`); một dòng outbox `catalog.variant_status_changed` (`from 'archived'`, `to 'discontinued'`) |
| Hàng vào chờ xử lý qua `receiveBack` | Tự khôi phục (Review Focus 4). Dựng như `test/integration/product/inventory/return.test.ts` |
| SKU `selling` nhận hàng | Không có dòng `state_transitions` nào |
| Xuất kho (`qty` âm) cho SKU lưu trữ | Không tự khôi phục. Dựng bằng phiếu xuất huỷ hoặc `ship` như test có sẵn; không dựng được gọn thì bỏ ca này và ghi Ruling |
| `onVariantStatusChanged` | SKU có `minQty` 5, tồn 1, `alert_active` true. Đặt `discontinued` bằng SQL, gọi handler trong `withCompany` → `alert_active` false. Đặt lại `selling`, gọi handler → có outbox `inventory.below_threshold`. Theo cách dựng của `thresholds.test.ts` |

- [ ] **Step 2: Chạy.** Expected: FAIL.
- [ ] **Step 3: Viết code theo Interfaces.**
- [ ] **Step 4: Chạy file mới và cả `test/integration/product`.** Expected: PASS. Test cũ của inventory dùng `archiveVariant` rồi cộng tồn mà kỳ vọng SKU vẫn lưu trữ thì sửa kỳ vọng theo luật mới, ghi Ruling.
- [ ] **Step 5: Commit** `#204: hàng vào SKU lưu trữ thì tự về Ngừng nhập; inventory xét lại ngưỡng khi trạng thái đổi`.

---

### Task 7: Tài liệu, kiểm toàn repo, PR

- [ ] **Step 1: Sửa tài liệu.**
  - `catalog/CLAUDE.md`:
    - Bỏ ý "Ngừng bán biến thể", `last_variant` ở mục Bất biến.
    - Thêm máy trạng thái, khoá, bốn nguồn lý do chặn, tự khôi phục, sự kiện `variant_status_changed`.
  - `inventory/CLAUDE.md`: nguồn `stockArchiveBlockers`, `applyChange` gọi `restoreArchivedBySystem`, consumer mới.
  - `purchasing`, `sales`, `channel`: thêm một dòng "Gọi vào" cho hàm nguồn nếu module có `CLAUDE.md`.
- [ ] **Step 2: Kiểm toàn repo.** Lint (bỏ qua `.claude/**`, `.superpowers/**`, `.agents/**`, `.codex/**`), typecheck, depcruise, `npm test`. Expected: xanh.
- [ ] **Step 3: `graphify update .`**, rồi commit tài liệu.
- [ ] **Step 4: Documents.** Thêm commit vào nhánh `docs/204-sua-sku` (Documents#124):
  - `21` §17.3: "đơn mở" là `unpaid`, `processing` (D9).
  - `21` §17.3: mức chặn khi ghi song song (D10).
  - `21` §17.3: tự khôi phục chưa bật cờ Cần xử lý (D6).
  - Sửa tiêu đề PR thành "… (D1 đến D3, D6, D9, D10)".
- [ ] **Step 5: Push, mở PR draft vào `main`.** Ghi: chồng trên #339; việc cho Thành (channel nghe `variant_status_changed`, ẩn, hiện, gỡ listing); việc cho Khoa (bỏ gọi `DELETE …/variants/:variantId`; `POST …/variants` chỉ còn 201; dùng `archiveBlockers`).
