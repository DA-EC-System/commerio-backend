# #204 PR 3: nhãn, độ hoàn thiện, mã cha, bỏ lưu trữ cha, xoá hẳn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Danh sách và chi tiết sản phẩm trả đủ ba lớp nhãn theo SKU (độ hoàn thiện, trạng thái kinh doanh, hiện diện trên sàn) và nhãn cha suy từ con. Sản phẩm cha có mã `code`, không còn trạng thái lưu riêng. `DELETE /catalog/products/:id` thành xoá hẳn. Tạo sản phẩm quá 2 trục trả `too_many_axes`.

**Architecture:**
- Luật thuần (độ hoàn thiện, nhãn chính, đếm nhãn) ở `catalog/domain/labels.ts`. Luật hiện diện ở `channel/domain`.
- Catalog nhận qua `ctx`, cùng cách nguồn lý do chặn của PR 2:
  - ngưỡng tồn của inventory, nối ở `product/index.ts`;
  - hiện diện listing của channel, nối ở `src/wiring.ts`;
  - bốn nguồn "SKU đã dùng" (`inUse`) từ inventory, purchasing, order, channel.
- Một migration sinh từ `schema.ts` (thêm `code`, đổi index tên, bỏ `archived_at`), sửa tay để chạy phần dữ liệu đúng thứ tự trong cùng file.
- Trang danh sách dùng số câu truy vấn cố định, không theo số dòng.

**Tech Stack:** như PR 1, PR 2.

**Spec:** `docs/superpowers/specs/2026-11-16-204-trang-thai-san-pham-design.md` mục 5.3, 6, 9 (PR 3), 10 (D4, D5, D7, D8, D11 Khang chốt 16/11/2026).

## Global Constraints

- Mọi ràng buộc chung của plan PR 1, PR 2 vẫn áp dụng.
- Nhánh `feature/204-nhan-ma-cha` chồng trên `feature/204-trang-thai-kinh-doanh` (PR 2).
- Migration sinh ở **bước cuối** của Task 3, sau khi `schema.ts` đã chốt: `npm run db:generate -- --name bo-luu-tru-san-pham-ma-cha`. Đọc kỹ file sinh ra rồi sửa tay thứ tự câu (mục Task 3). Câu viết tay thêm vào file sinh: `db:regen` báo khi bị mất, ghi rõ trong mô tả PR.
- Thứ tự câu trong migration:
  1. Dữ liệu: SKU của cha đang lưu trữ, ở trạng thái chưa `archived`: còn tồn thì `discontinued`, còn lại `archived` (D11). Chỉ đọc `product.stock_levels`.
  2. Đổi tên sản phẩm lưu trữ trùng tên (chữ thường) với sản phẩm khác cùng công ty: thêm hậu tố ` (<mã cha>)` (D4).
  3. Thêm `code` (cho phép null), điền theo D5 (SKU của biến thể tạo sớm nhất, bỏ phần mã giá trị thuộc tính; trùng thì thêm `-2`, `-3`…), rồi `SET NOT NULL`.
  4. Đổi index tên; unique `(company_id, code)`; bỏ `archived_at`.
- Mã cha lúc tạo mới (D5): `renderSku(quy tắc, số {SEQ} của SKU đầu tiên, [])`; trùng mã đã có thì thêm `-2`, `-3`… Cấp trong cùng giao dịch, sau `lockVariants`. Không route nào sửa `code`.
- `missing` theo thứ tự cố định `name, category, image, price, minQty, weight, dimensions`; `price` là `target_net_price` (D7).
- Hiện diện (D8, Thành sửa 16/11/2026 theo `Documents/25` §5.1):
  - `live` nếu có listing `live`;
  - không thì `error` nếu có `push_failed`, `rejected`, `platform_hold`;
  - không thì `pending` nếu có `pushing`, `under_review`;
  - còn lại `not_listed`. `hidden` không tính là `live`.
  - `hasListingError` = có listing `push_failed`, `rejected`, `platform_hold`, kể cả khi đã `live` (nhãn phụ "Có lỗi").
  - `listingCount` = số listing chưa `delisted` có `variant_id` là SKU.
- Nhãn chính: trạng thái khác `selling` thì lấy trạng thái; `selling` thì lấy hiện diện. 7 giá trị, có `error` (khác FE hiện tại: FE đổi `error` thành `live`, phải sửa theo).

## Review Focus

1. **Migration trên DB có dữ liệu** (staging): sản phẩm lưu trữ có SKU còn tồn, sản phẩm trùng tên, hai danh mục cùng quy tắc ra trùng mã. Không được lỗi giữa chừng. Task 3 có bước chạy thử trên DB dựng từ PR 2 kèm dữ liệu seed.
2. **Trang danh sách nhiều sản phẩm**: số câu truy vấn không tăng theo số dòng. Test ở Task 4 đếm câu truy vấn của một trang 2 dòng và một trang 20 dòng phải bằng nhau.
3. **Xoá hẳn sản phẩm đã dùng ở bất kỳ module nào**, kể cả chỉ có listing chờ duyệt ghép hay chỉ có thẻ kho, phải 409 `product_in_use`, không xoá gì. Test ở Task 6 mỗi nguồn một ca.
4. **Tên sản phẩm trùng sau khi bỏ `archived_at`**: tạo sản phẩm trùng tên sản phẩm mọi SKU đã lưu trữ thì 409 `name_taken`. Test ở Task 3.
5. **SKU mới thêm vào cha mà mọi SKU cũ đã lưu trữ**: sản phẩm hiện lại ở danh sách mặc định. Test ở Task 4.

---

### Task 1: Luật nhãn và độ hoàn thiện (thuần)

**Files:**
- Create: `src/modules/product/catalog/domain/labels.ts`
- Test: `test/unit/modules/product/catalog/domain/labels.test.ts`

**Interfaces:**
- Produces:
  - `MISSING_FIELDS = ['name', 'category', 'image', 'price', 'minQty', 'weight', 'dimensions'] as const`, `type MissingField`.
  - `PRESENCES = ['live', 'pending', 'error', 'not_listed'] as const`, `type Presence`.
  - `MAIN_LABELS = ['archived', 'discontinued', 'paused', 'live', 'error', 'pending', 'not_listed'] as const`, `type MainLabel`.
  - `readinessOf(parent: { name: string; categoryId: string | null; imageCount: number }, sku: { targetNetPrice: string | null; minQty: number | null; weightG: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null }): { readiness: 'ready' | 'incomplete'; missing: MissingField[] }`.
  - `mainLabel(status: BusinessStatus, presence: Presence): MainLabel`.
  - `countLabels(skus: { businessStatus: BusinessStatus; presence: Presence; hasListingError: boolean; readiness: 'ready' | 'incomplete' }[]): { variantCount: number; variantTotal: number; labelCounts: Record<MainLabel, number>; incompleteCount: number; errorCount: number }`.
    - `variantCount`, `incompleteCount`, `errorCount` chỉ tính SKU chưa `archived`; `errorCount` đếm `hasListingError`.
    - `labelCounts` đủ 7 khoá, tính mọi SKU.

- [ ] **Step 1: Viết test đỏ.**
  - Mỗi trường thiếu ra đúng phần tử, đúng thứ tự.
  - Đủ hết thì `ready`, `missing: []`.
  - Một kích thước null là `dimensions`.
  - `mainLabel`: `paused` + `live` → `paused`; `selling` + `error` → `error`; `selling` + `not_listed` → `not_listed`.
  - `countLabels`: 6 SKU (4 `live` trong đó 1 có `hasListingError`, 1 `archived` có lỗi, 1 `selling` + `error`) → `variantCount 5`, `variantTotal 6`, `labelCounts.live 4`, `labelCounts.error 1`, `labelCounts.archived 1`, `errorCount 2` (SKU lưu trữ không tính).
- [ ] **Step 2: Chạy.** `npx vitest run --project unit test/unit/modules/product/catalog/domain/labels.test.ts`. Expected: FAIL.
- [ ] **Step 3: Viết `labels.ts`.**
- [ ] **Step 4: Chạy lại.** Expected: PASS.
- [ ] **Step 5: Commit** `#204: luật độ hoàn thiện, nhãn chính, đếm nhãn của SKU`.

---

### Task 2: Cổng ngưỡng tồn và hiện diện listing

**Files:**
- Create: `src/modules/channel/channel/domain/presence.ts`
- Modify: `src/modules/channel/channel/service/catalog-boundary.ts`, `repository/archive-blockers.ts` (đổi tên thành `repository/catalog-boundary.ts`), `channel/index.ts`
- Create: `src/modules/product/inventory/service/catalog-boundary.ts` (gom cả `stockArchiveBlockers` cũ)
- Modify: `inventory/index.ts`, `src/modules/product/index.ts`, `src/wiring.ts`, `catalog/service/usage.ts`
- Test: `test/unit/modules/channel/channel/domain/presence.test.ts`, `test/integration/channel/channel/archive-blockers.test.ts` (thêm), `test/integration/product/inventory/archive-blockers.test.ts` (thêm)

**Interfaces:**
- Produces:
  - `presenceOf(statuses: readonly ListingStatus[]): { presence: Presence; hasListingError: boolean }` (luật D8 đã sửa), ở `channel/domain/presence.ts`.
  - `listingPresenceOf(variantIds): Promise<Map<string, { presence: Presence; hasListingError: boolean; listingCount: number }>>`: SKU không có listing chưa gỡ thì `{ presence: 'not_listed', hasListingError: false, listingCount: 0 }`, Map đủ mọi id. Một câu cho cả lô.
  - `minQtyOf(variantIds): Promise<Map<string, number | null>>`: `stock_levels.min_qty`, chưa có dòng thì `null`, Map đủ mọi id, không khoá, không tạo dòng.
  - `CatalogContext` thêm `minQtyOf?`, `listingPresenceOf?`, nối như nguồn lý do chặn. Thiếu thì `throw`.

- [ ] **Step 1: Viết test đỏ.**
  - Unit `presenceOf`: mỗi nhánh của D8; `live` + `rejected` → `live` kèm `hasListingError`; chỉ `hidden` → `not_listed`; `delisted` không tính.
  - Integration `listingPresenceOf`: SKU có `live` và `rejected` → `live`, `hasListingError: true`, `listingCount 2`; SKU chỉ có `rejected` → `error`; SKU chỉ có `delisted` → `not_listed`, `0`.
  - Integration `minQtyOf`: đã đặt → số; chưa có dòng → `null`.
- [ ] **Step 2: Chạy.** Expected: FAIL.
- [ ] **Step 3: Viết code, export, nối `ctx`.**
- [ ] **Step 4: Chạy lại, cả `test/unit/wiring.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `#204: cổng ngưỡng tồn và hiện diện listing cho catalog`.

---

### Task 3: Mã cha `code`, bỏ `products.archived_at`, migration

**Files:**
- Modify: `catalog/repository/schema.ts` (`products`):
  - thêm `code: text('code').notNull()`;
  - bỏ `archivedAt`;
  - `uniqueIndex('products_company_lower_name_uq')` trên `(companyId, lower(name))`, bỏ `.where`;
  - `uniqueIndex('products_company_code_uq')` trên `(companyId, code)`.
- Modify: `catalog/repository/products.ts`, `repository/variants.ts` (`findVariants` bỏ `productArchivedAt`), `service/products.ts`, `service/variants.ts`, `service/business-status.ts`, `service/purchase-products.ts`, `service/sku-allocation.ts`, `service/errors.ts` (bỏ `productArchived`), `api/schemas.ts`, `api/openapi.ts`, `api/routes.ts` (`DELETE` tạm trả 501 tới Task 6)
- Modify (sửa hàng loạt của #242, đã merge vào `main` 17/11/2026): `catalog/repository/bulk.ts` bỏ điều kiện `products.archivedAt`; `service/bulk-edit.ts` bỏ lỗi dòng `product_archived` (giữ giá trị trong enum `BulkSaveResult.failed[].code` để không đổi hợp đồng, chỉ không còn sinh ra)
- Create: `db/migrations/<sinh>_bo-luu-tru-san-pham-ma-cha.sql` (+ snapshot, journal)
- Test: `products.test.ts`, `variant-edit.test.ts`, `business-status.test.ts`, `get-variants.test.ts`, `variants.test.ts` và mọi ca dùng `DELETE /products/:id` để lưu trữ

**Interfaces:**
- Produces:
  - `allocateSkus(category, combos): Promise<{ sku: string; seq: number }[]>` (trước trả `string[]`; sửa ba chỗ gọi).
  - `productCodeFor(pattern: string, firstSeq: number): Promise<string>` ở `service/sku-allocation.ts`: `renderSku(pattern, firstSeq, [])`; mã đã có thì thử `-2`, `-3`…
  - `insertProduct(companyId, categoryId, name, description, code)`.
  - `ProductListItem` thêm `code: string`; `status` suy từ SKU (Task 4 làm đầy đủ; Task 3 tạm `'active'`).
  - `getVariants().archived` = `businessStatus === 'archived'`.
  - Bỏ mọi chỗ kiểm `product_archived` (sửa sản phẩm, thêm biến thể, PATCH SKU, `business-status`). `productNameExists` xét mọi sản phẩm.

- [ ] **Step 1: Sửa test thành đỏ.**
  - Tạo sản phẩm có `code` theo D5. Quy tắc `AO-{SEQ:4}-{VAL}`, SKU đầu `AO-0001-DEN-XL` → `code` `AO-0001`. Sản phẩm không thuộc tính `PK-{SEQ}` → `code` bằng SKU.
  - Hai danh mục cùng quy tắc, hai sản phẩm cùng số đầu → mã sau có `-2`.
  - Sản phẩm từ đề nghị nhập (`createPurchaseProducts`) có `code`.
  - Tạo sản phẩm trùng tên sản phẩm đã lưu trữ mọi SKU → 409 `name_taken` (Review Focus 4).
  - Các ca đang dùng `DELETE /products/:id` để lưu trữ cha, và mọi ca `product_archived`: bỏ, hoặc đổi sang lưu trữ từng SKU (`archiveSku`). Ghi Ruling cho từng ca bỏ.
- [ ] **Step 2: Chạy `test/integration/product/catalog`.** Expected: FAIL ở các ca mới.
- [ ] **Step 3: Sửa code theo Interfaces.** Chưa sinh migration.
- [ ] **Step 4: Sinh migration rồi sửa tay theo thứ tự ở Global Constraints.**
  - Câu điền `code` cho dòng cũ (D5, viết bằng SQL):
    - SKU của biến thể có `created_at`, `sku` nhỏ nhất của mỗi sản phẩm.
    - `val` là `string_agg(av.code, '-' order by vav.position)`.
    - `code = trim(both '-_' from regexp_replace(replace(sku, val, ''), '([-_]){2,}', '\1', 'g'))` khi `val` khác rỗng, không thì `sku`.
    - Rỗng sau khi cắt thì lấy `sku`.
    - Trùng trong công ty: `row_number() over (partition by company_id, code order by created_at, id)`, từ dòng thứ 2 thêm `'-' || rn`.
- [ ] **Step 5: Chạy `npm run db:ci-check -- --base origin/main` và test catalog.** Expected: PASS.
- [ ] **Step 6: Chạy thử migration trên DB có dữ liệu (Review Focus 1).**
  - Container `pgvector/pgvector:pg17` riêng, cổng trống.
  - Từ worktree tạm của PR 2: `npm run db:migrate` rồi `npm run db:seed`.
  - Thêm bằng SQL: một sản phẩm lưu trữ có SKU còn tồn, một sản phẩm lưu trữ trùng tên sản phẩm khác, hai danh mục cùng quy tắc.
  - Ở nhánh PR 3: `npm run db:migrate`.
  - Kiểm: không lỗi; `code` không null, không trùng; SKU còn tồn là `discontinued`; tên đã thêm hậu tố.
  - Xoá container và worktree.
- [ ] **Step 7: Commit** `#204: mã cha code, bỏ lưu trữ sản phẩm cha, migration`.

---

### Task 4: Ba lớp nhãn ở chi tiết và danh sách; lọc

**Files:**
- Modify: `catalog/service/products.ts`, `repository/products.ts`, `repository/variants.ts`, `api/schemas.ts`, `api/openapi.ts`, `catalog/index.ts`, `src/modules/product/index.ts`
- Test: `test/integration/product/catalog/labels.test.ts` (mới), `products.test.ts`

**Interfaces:**
- Produces:
  - Biến thể trong `ProductDetail` thêm `readiness`, `missing`, `minQty`, `presence`, `hasListingError`, `listingCount`.
  - `ProductListItem` thêm `variantTotal`, `labelCounts`, `incompleteCount`, `errorCount`; `variantCount` là SKU chưa lưu trữ; `status` là `'archived'` khi mọi SKU `archived`.
  - `ProductListQuery`:
    - `status`: `active` là có SKU chưa lưu trữ; `archived` là mọi SKU đã lưu trữ.
    - `businessStatus`: `selling`, `paused`, `discontinued`; `archived` thì 422.
    - Lọc bằng `exists` trên `product_variants` trong cùng câu phân trang.
  - Trang danh sách gọi đúng một lần mỗi loại: SKU của các sản phẩm trong trang (`findVariants({ productIds })`), `minQtyOf`, `listingPresenceOf`, ảnh đại diện (sẵn có).
  - `variantReadiness(variantIds): Promise<Map<string, { readiness, missing }>>`, export ở `product/index.ts`: ghép catalog và `minQtyOf` của inventory, cho channel thay `paused → sku_not_ready`. Channel đổi là việc của Thành.

- [ ] **Step 1: Viết test đỏ** `labels.test.ts`.

| `it` | Kiểm |
|---|---|
| US-SP-03 dòng 1 | SKU thiếu cân nặng có `missing` chứa `weight`, `readiness: 'incomplete'` |
| US-SP-03 dòng 2 | Điền đủ (ảnh, giá muốn bán, `minQty` qua route ngưỡng của inventory, số đo) → `ready` |
| US-SP-03 dòng 3 | Cha không ảnh → mọi SKU có `image` |
| US-SP-08 dòng 1 | SKU có listing `live` → `presence: 'live'` |
| US-SP-08 dòng 2 | `live` và `rejected` → `presence: 'live'`, `hasListingError: true`, danh sách `errorCount: 1`, `labelCounts.live 1` |
| D8 | SKU đang bán chỉ có listing `rejected` → `presence: 'error'`, `labelCounts.error 1`; chỉ có `hidden` → `not_listed` |
| US-SP-08 dòng 3 | Cha 6 SKU, 4 có listing `live` → `labelCounts.live 4` |
| US-SP-08 dòng 4 | Mọi SKU lưu trữ → không có ở danh sách mặc định; có ở `status=archived` với `status: 'archived'` |
| Review Focus 5 | Sau đó thêm SKU mới → sản phẩm hiện lại ở danh sách mặc định |
| Lọc | `businessStatus=paused` chỉ trả sản phẩm có SKU tạm ngừng; `businessStatus=archived` → 422 |
| Review Focus 2 | Đếm câu truy vấn của trang 2 dòng và trang 20 dòng bằng nhau. Bật `log_statement` cho phiên, hoặc đếm qua `pg_stat_statements` nếu có; không làm được gọn thì so thời gian, ghi Ruling |
| Schema | `ProductPage.parse(body)` bằng `body` |

- [ ] **Step 2: Chạy.** Expected: FAIL.
- [ ] **Step 3: Viết code.**
- [ ] **Step 4: Chạy `test/integration/product`, `test/integration/channel`.** Expected: PASS.
- [ ] **Step 5: Commit** `#204: ba lớp nhãn ở chi tiết, danh sách; lọc theo trạng thái kinh doanh`.

---

### Task 5: Nguồn "SKU đã dùng" của bốn module

**Files:**
- Modify: `catalog-boundary.ts`, `archive-blockers.ts` của inventory, purchasing, sales, channel (thêm hàm `inUse`), các `index.ts`, `product/index.ts`, `src/wiring.ts`, `catalog/service/usage.ts`
- Test: bốn file `archive-blockers.test.ts` (thêm ca)

**Interfaces:**
- Produces, mỗi hàm `(variantIds) => Promise<Set<string>>`, gọi trong `withCompany`, một câu mỗi bảng:
  - `stockInUse`: `stock_moves.variant_id`; `stock_document_lines.variant_id` hoặc `actual_variant_id`.
  - `purchaseInUse`: dòng đề nghị, dòng phiếu nhận, dòng phiếu trả NCC.
  - `orderInUse`: `order_lines`, `return_request_lines`, `package_lines`, `unmatched_return_parcel_lines`. Đọc bảng fulfillment từ repository của sales là được, vì cùng module lớn.
  - `listingInUse`: `listings.variant_id`, `listings.pending_variant_id`, `price_calculations.variant_id`.
  - `CatalogContext` thêm `stockInUse?`, `purchaseInUse?`, `orderInUse?`, `listingInUse?`; `inUseOf(ctx, ids): Promise<Set<string>>` ở `usage.ts`, thiếu nguồn thì `throw`.

- [ ] **Step 1: Viết test đỏ.** Mỗi nguồn: SKU mới → không có; SKU có một chứng từ (mọi trạng thái, kể cả đã huỷ) → có.
- [ ] **Step 2: Chạy.** Expected: FAIL.
- [ ] **Step 3: Viết.**
- [ ] **Step 4: Chạy lại.** Expected: PASS.
- [ ] **Step 5: Commit** `#204: nguồn SKU đã dùng của inventory, purchasing, order, channel`.

---

### Task 6: Xoá hẳn sản phẩm, `too_many_axes`

**Files:**
- Modify: `catalog/service/products.ts` (`deleteProduct`), `repository/products.ts` (xoá theo bảng), `service/errors.ts` (`productInUse`, `tooManyAxes`), `api/routes.ts`, `api/openapi.ts`
- Modify: `inventory` (`deleteStockLevels(variantIds)`, export, nối `ctx` `deleteStockLevels`)
- Test: `test/integration/product/catalog/delete-product.test.ts` (mới), `products.test.ts`

**Interfaces:**
- Produces:
  - `deleteProduct(ctx, caller, id, version): Promise<void>`. Trong `withCompany`:
    1. `lockVariants`, `findOwnProduct`; sai `version` → 409 `version_conflict` kèm `current`.
    2. Kiểm lần lượt: mọi SKU `incomplete`; `inUseOf` rỗng; không SKU nào có `source_request_line_id`. Sai một điều → 409 `product_in_use`.
    3. Xoá theo thứ tự: `variant_attribute_values`, `product_images` (không xoá tệp), `product_channel_specs`, `product_variants`, `products`. `ctx.deleteStockLevels(ids)` xoá dòng tồn (chỉ mang ngưỡng).
    4. `recordAudit` `delete`.
  - `createProduct`: biến thể nào nhiều hơn 2 giá trị thuộc tính → 422 `too_many_axes`, kiểm trước `resolveCombos`.

- [ ] **Step 1: Viết test đỏ** `delete-product.test.ts`.
  - Sản phẩm mới chờ hoàn thiện → 204, hết dòng ở mọi bảng catalog và `stock_levels`, có dòng nhật ký `delete`.
  - Sản phẩm đã `ready` → 409.
  - Sản phẩm có SKU dính một chứng từ → 409 và không xoá gì (Review Focus 3). Bốn ca, mỗi nguồn một ca, kể cả chỉ có listing chờ duyệt ghép (`pending_variant_id`).
  - Sản phẩm sinh từ đề nghị nhập → 409.
  - Sai `version` → 409 `version_conflict`.
  - Thêm ở `products.test.ts`: tạo sản phẩm 3 trục → 422 `too_many_axes`.
- [ ] **Step 2: Chạy.** Expected: FAIL (route đang 501).
- [ ] **Step 3: Viết.**
- [ ] **Step 4: Chạy `test/integration/product`.** Expected: PASS.
- [ ] **Step 5: Commit** `#204: xoá hẳn sản phẩm chờ hoàn thiện chưa dùng; too_many_axes`.

---

### Task 7: Tài liệu, kiểm toàn repo

- [ ] **Step 1: Sửa tài liệu.**
  - `catalog/CLAUDE.md`: bỏ mục lưu trữ cha; thêm mã cha, ba lớp nhãn, xoá hẳn, nguồn `inUse`, cổng `minQtyOf`, `listingPresenceOf`; tên không trùng trên mọi sản phẩm.
  - `CLAUDE.md` của inventory, purchasing, sales, channel: một dòng "gọi vào" cho mỗi hàm cổng mới.
- [ ] **Step 2: Kiểm toàn repo** như PR 2 (lint bỏ qua thư mục cục bộ, typecheck, depcruise, `npm test`), thêm `npm run db:ci-check -- --base origin/main`. Expected: xanh.
- [ ] **Step 3: `graphify update .`**, commit tài liệu.
