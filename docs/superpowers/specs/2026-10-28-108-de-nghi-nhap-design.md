# Spec: Đề nghị nhập (#108, A1)

- **Ngày:** 28/10/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#108, `Documents/25` §3, §11, `Documents/21` §16, FE#71 (`src/types/purchasing.ts`, `src/lib/machines/purchasing.ts`, mock `src/mocks/handlers/purchasing.ts`)
- **Trạng thái:** nháp, chờ Khang duyệt
- **Phụ thuộc:** không. Khang chốt 29/10 làm #108 trước #111, nên hai hàm nhỏ của inventory mà #108 cần (`nextDocNumber`, `stockOf`, spec #111 mục 5.5) làm luôn trong PR của #108

---

## 1. Mục tiêu và tiêu chí thành công

1. Mua hàng lập đề nghị nhập cho **một** nhà cung cấp, nhiều dòng. Mỗi dòng là một SKU có sẵn hoặc một sản phẩm mới, kèm số lượng và giá nhập. Mua hàng được sửa nháp, gửi duyệt, rút lại, gửi lại, huỷ.
2. CEO (khác người lập, trừ ngoại lệ tự duyệt) duyệt, trả về kèm lý do, từ chối, và loại từng dòng nhưng phải còn ít nhất một dòng.
3. Duyệt xong thì giá bị chốt và mỗi dòng sản phẩm mới sinh một sản phẩm kèm SKU theo quy tắc của danh mục.
4. Đánh dấu đã đặt NCC thì số "đang về" của SKU tăng; huỷ hoặc đóng thiếu thì giảm. Số này luôn tính lại từ dòng, không cộng trừ tay.
5. Còn chờ của mỗi dòng = đặt − nhận − lỗi giữ − đóng thiếu (dòng bị loại tính là 0). Cờ "NCC giao thiếu" suy ra từ phiếu nhận ở `short`.
6. Mọi chuyển trạng thái đi qua `assertTransition` và có lịch sử. Trang FE#71 chạy với BE thật, không cần mock.

Đo bằng: acceptance criteria ở mục 11 đều qua, `npm run check` xanh, integration test parse response bằng đúng schema OpenAPI, `pnpm e2e:be` của FE đạt cho màn đề nghị nhập.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `develop` (đã kiểm):**
- Bảng đã đủ (`product/purchasing/repository/schema.ts`): `suppliers`, `purchase_requests` (enum đủ 10 trạng thái, `approval` có `self_approved`, `expected_delivery_date`, `ordered_by`, `closed_by`), `purchase_request_lines` (`variant_id` cho null, `new_product_name`, `new_category_id`, `excluded`, `received_qty`, `defective_qty`, `closed_short_qty`, CHECK còn chờ ≥ 0).
- Quyền và vai trò: `purchasing.request.manage` (Mua hàng, CEO), `purchasing.request.approve` (CEO), `purchasing.receipt.manage` (Nhân viên kho, CEO), `purchasing.return.manage` (Mua hàng, CEO). `purchasing` là phân hệ tuỳ chọn; tắt phân hệ thì mọi quyền này mất hiệu lực.
- Khung máy trạng thái: `defineMachine`, `assertTransition`, `availableActions`, `recordTransition` (`core`); `getStatusHistory`, `canSelfApprove` (`staff`). Chưa module nào dùng khung này.
- `catalog` export `getVariants`, nhưng `VariantSummary` chưa có `businessStatus`, và chưa có hàm tạo sản phẩm chạy trong giao dịch của module khác (`createProduct` tự mở `withCompany`, không lồng được).
- Module `purchasing` chưa có code: `api/`, `service/`, `domain/` trống, `index.ts` chưa có router.

**Chỗ lệch giữa các nguồn và cách chọn:**

| Chỗ | `Documents/25` | `Documents/21` / FE | Chọn trong spec này |
|---|---|---|---|
| Ngày giao dự kiến khi đặt NCC | Bắt buộc | Body thao tác chỉ có `{ version, reason? }` | Nhận thêm `expectedDeliveryDate?` (tuỳ chọn) ở thao tác `order`. Sửa §16.2 |
| Mã đơn NCC | "nếu có" | Không có | Không làm |
| Lý do khi loại dòng | Có | Không có | Không lưu lý do |
| Giá nhập | > 0 khi gửi duyệt | Mock cho phép 0 | Nháp được để 0 (`add-line` lấy giá vốn, có thể là 0). Gửi duyệt thì mọi dòng còn hiệu lực phải > 0, nếu không trả 422 `validation_failed` với `errors["lines.i.unitCost"]` |
| NCC ngừng giao dịch khi gửi duyệt | — | §16.4 ghi 422, mock trả 409 | 422 `supplier_inactive` theo §16.4 |
| Trường `note` của NCC | — | FE có | Thêm cột (migration) |
| Ai rút, gửi lại, huỷ nháp | "Người lập" | Máy FE chỉ kiểm quyền | Theo FE: ai có `request.manage` cũng làm được |
| Sản phẩm mới | Tên, giá trị phân loại, sản phẩm cha | `{ name, categoryId }` | Mỗi dòng sinh một sản phẩm với một biến thể không có thuộc tính. Bỏ trống `new_variant_attrs` |
| "Xoá nháp" (#108) | N8: không xoá chứng từ | Không có `DELETE` | Dùng thao tác `cancel` |
| Chuỗi trống (`note`, `phone`…) | — | R4 ghi `null`, kiểu FE là `string` | Trả `''` theo kiểu FE. Ghi vào điểm mở để Thành và Khoa chốt R4 |

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| Q1 | Đổi sự kiện `purchasing.order_submitted` thành `purchasing.request_submitted` với payload `{ requestId, number }`. Cùng PR thêm `purchasing.goods_receipt_posted` cho #109 | Khang chốt 28/10. Theo quy ước `<module>.<việc>`, tên khớp đối tượng "đề nghị" |
| Q2 | Bảng chuyển BE chép từ `FE/src/lib/machines/purchasing.ts`, thêm `allowSelfApproval` cho `approve`, `request_changes`, `reject` | Bảng `purchase_requests` có cột `self_approved`. CEO và khách thuê một người được tự duyệt (`Documents/25` §11) |
| Q3 | Xem danh sách, chi tiết, NCC: có ít nhất một quyền `purchasing.*` (`anyOf`). Thấy giá: có `inventory.cost.view`, `purchasing.request.manage` hoặc `purchasing.request.approve`; không có thì `unitCost`, `totalCost` là `null` | Giống mock FE (`requireViewer`, `canSeeCost`) |
| Q4 | Số đề nghị dạng `DN-000001`, lấy số bằng `nextDocNumber('purchase_request')` của inventory | Theo mock FE. Bộ đếm dùng chung cho cả module lớn `product` (`Documents/19`) |
| Q5 | `PUT` thay toàn bộ dòng: xoá dòng cũ, chèn dòng mới | Dòng ở nháp hoặc ở "cần sửa" chưa bị gì trỏ tới, vì phiếu nhận chỉ có từ `ordered` |
| Q6 | Sản phẩm mới tạo lúc duyệt, qua hàm mới của catalog chạy trong giao dịch của bên gọi | `createProduct` hiện có tự mở `withCompany`, không gọi lồng được |
| Q7 | "Đang về" do purchasing tính và export `incomingOf(variantIds)`. Inventory nhận hàm này qua `ModuleContext`, tiêm bằng `withContext` trong `product/index.ts` | Purchasing đã import inventory (cấp số, ghi sổ). Inventory import ngược lại sẽ thành vòng |
| Q8 | Chưa làm đề nghị bù hàng (`sourceReturnId`). Gửi giá trị khác `null` thì trả 422 `errors.sourceReturnId` | Cần phiếu trả NCC ở trạng thái `replaced`, thuộc issue B4 |
| Q9 | `add-line` lấy giá theo `avgCost` hiện tại (`stockOf`). Nháp lập mới từ `add-line` có `source = 'reorder'` | Giống mock FE. Enum `source` đã có giá trị này |
| Q10 | Mọi thao tác ghi khoá bản ghi `purchase_requests` trước (`FOR UPDATE`) rồi mới so `version` | Một luật khoá cho cả #108 và #109: đề nghị → dòng đề nghị → phiếu nhận → khoá công ty của catalog → dòng tồn |

## 4. Phạm vi

**Trong spec:**
- Nhà cung cấp: xem danh sách, thêm, sửa.
- Đề nghị nhập: danh sách, chi tiết, lập, sửa, `add-line`, loại dòng, chín thao tác của máy trạng thái.
- `incomingOf` và nối vào `StockLevel.incoming` của inventory.
- PR sự kiện (Q1).
- Ba hàm mới của catalog.
- `purchasing/CLAUDE.md`.

**Ngoài spec:** báo cáo theo NCC và phiếu nhận (#109); phiếu trả NCC và đề nghị bù hàng (B4); nhắc việc §16.5 (#114); gợi ý nhập lại tự động (#111 phần sau); mã đơn NCC.

## 5. Luồng người dùng

1. **Mua hàng** mở "Đề nghị nhập", lập mới: chọn NCC, thêm dòng (SKU có sẵn, hoặc sản phẩm mới gồm tên và danh mục), nhập số lượng và giá. Lưu thì có nháp `DN-000123`.
2. Bấm **Gửi duyệt**. CEO nhận thông báo realtime (`purchasing.request_submitted`).
3. **CEO** mở đề nghị, có thể loại vài dòng, rồi:
   - **Duyệt**: dòng sản phẩm mới sinh SKU ngay.
   - **Trả về** kèm lý do: mua hàng sửa rồi gửi lại.
   - **Từ chối** kèm lý do: đề nghị kết thúc.
4. Mua hàng đặt hàng với NCC, bấm **Đã đặt NCC** (nhập ngày giao dự kiến nếu có). Trang tồn kho hiện "Đang về N".
5. Hàng về thì làm theo #109. Mỗi lần ghi sổ phiếu nhận, đề nghị tự sang "Nhận một phần" hoặc "Nhận xong".
6. NCC không giao nốt phần còn lại: CEO bấm **Đóng thiếu** kèm lý do (bị chặn khi còn phiếu đang kiểm).

## 6. Thiết kế backend

### 6.1 Phân loại và tải (bước 1)

REST đồng bộ: đọc theo trang, và các lệnh ghi theo máy trạng thái. Tải nhỏ: vài chục đề nghị mỗi tháng, tối đa 100 dòng mỗi đề nghị. Danh sách phân trang bằng SQL (`limit`/`offset`), không lọc trong bộ nhớ.

### 6.2 Bố cục và ranh giới

```
product/purchasing/
├─ index.ts                 purchasingModule (router, openapi), incomingOf
├─ CLAUDE.md
├─ domain/
│  ├─ request-machine.ts    purchaseRequestMachine, PurchaseRequestRecord
│  └─ request.ts            outstanding(line), canSeeCost(permissions), formatNumber('DN', n)
├─ repository/
│  ├─ schema.ts             (đã có)
│  ├─ suppliers.ts
│  └─ requests.ts           list (SQL phân trang), findById, lockById, insert, replaceLines, updateLine, update…, incoming
├─ service/
│  ├─ suppliers.ts
│  ├─ requests.ts           create, update, addLine, excludeLine
│  ├─ request-actions.ts    runRequestAction(action, …)
│  └─ request-views.ts      toSummary, toDetail (tên người, nhãn biến thể, ẩn giá)
└─ api/
   ├─ schemas.ts            Zod request và response, .meta({ id }) trùng tên kiểu FE
   ├─ routes.ts
   └─ openapi.ts
```

**Gọi ra:**
- `inventory` (cùng module lớn, import thẳng `index.ts`): `nextDocNumber`, `stockOf`.
- `catalog`: `getVariants` (đã có) và ba hàm mới:
  - `validateNewProducts(items)`: danh mục có thật, tên chưa dùng (chữ thường), các mục không trùng tên nhau. Trả lỗi theo chỉ số mục.
  - `createPurchaseProducts(items, description)`: khoá công ty, kiểm lại, mỗi mục tạo một sản phẩm với một biến thể không thuộc tính, cấp SKU, ghi audit. Trả `variantId` theo đúng thứ tự mục. Chạy trong giao dịch của bên gọi.
  - `categoryNames(ids)`.
- `VariantSummary` thêm `businessStatus`. Mua được = `selling` hoặc `paused` (FE `purchasable`).
- `core`: `recordAudit`, `recordTransition`, `assertTransition`, `getStatusHistory`, `canSelfApprove`, `publishEvent`, `findAccountById` (tên người).

**Gọi vào:** `inventory` nhận `incomingOf` qua `ctx`. `product/index.ts` bọc `withContext(inventoryModule, (ctx) => ({ ...ctx, incomingOf }))`; `listStock` và `getStock` truyền số đang về vào `toStockLevel`.

### 6.3 Dữ liệu (bước 2)

**Migration `00xx_de-nghi-nhap.sql`:**

```sql
ALTER TABLE product.suppliers ADD COLUMN note text;
CREATE UNIQUE INDEX suppliers_company_name_key ON product.suppliers (company_id, lower(name));
CREATE UNIQUE INDEX purchase_request_lines_request_variant_key ON product.purchase_request_lines (request_id, variant_id);
```

- Cả ba câu an toàn: thêm cột cho phép null không ghi lại bảng; hai bảng còn trống nên tạo index không khoá lâu.
- Index thứ hai giữ luật "một SKU một dòng". Dòng sản phẩm mới có `variant_id` null nên không bị chặn (NULL khác nhau).
- `add-line` nhờ index này mà cộng dồn chắc chắn.

**Bất biến:**

| Bất biến | Ai giữ |
|---|---|
| Còn chờ = đặt − nhận − lỗi − đóng thiếu ≥ 0 | CHECK `purchase_request_lines_outstanding` |
| Dòng bị loại có còn chờ = 0 khi tính đang về, nhận xong, đóng thiếu | Hàm thuần `outstanding(line)` trong domain, dùng ở mọi chỗ |
| Người duyệt khác người lập, trừ khi `self_approved` | CHECK `approvalCheck` cộng với `assertTransition` |
| Đề nghị ngoài `draft`, `cancelled` phải có NCC | CHECK `purchase_requests_supplier` |
| Một SKU một dòng trong một đề nghị | Index mới |
| Tên NCC không trùng (chữ thường) trong công ty | Index mới. Service bắt lỗi unique và trả 422 `errors.name` |
| Giá và số dòng chỉ sửa được ở `draft`, `changes_requested` | Service (409 `not_draft`) |
| Đang về của SKU = tổng còn chờ của dòng không bị loại, thuộc đề nghị `ordered` hoặc `partially_received` | Tính khi đọc (`incomingOf`), không lưu |

### 6.4 Máy trạng thái

`domain/request-machine.ts` chép bảng FE. Record có `createdBy`, `lineCount` (dòng không bị loại), `activeLines`, `receiptCount` (phiếu nhận chưa huỷ), `countingReceipts`.

| Từ | Thao tác | Đến | Quyền | Điều kiện, mã lỗi | Tác động thêm |
|---|---|---|---|---|---|
| `draft` | `submit` | `pending_approval` | `request.manage` | `empty_document`; NCC ngừng → 422 `supplier_inactive`; giá ≤ 0 → 422 `errors.lines.i.unitCost` | Phát `request_submitted` |
| `pending_approval` | `withdraw` | `draft` | `request.manage` | | |
| `changes_requested` | `resubmit` | `pending_approval` | `request.manage` | Như `submit` | Phát `request_submitted` |
| `pending_approval` | `approve` | `approved` | `request.approve` | Người thứ hai, tự duyệt được; `all_lines_excluded`; tên sản phẩm mới đã có người dùng → 422 `errors.lines.i.newProduct.name` | Tạo sản phẩm, điền `variant_id`; lưu `approved_by`, `approved_at`, `self_approved` |
| `pending_approval` | `request_changes` | `changes_requested` | `request.approve` | Người thứ hai (tự duyệt được), có lý do | `status_reason` |
| `pending_approval` | `reject` | `rejected` | `request.approve` | Người thứ hai (tự duyệt được), có lý do | `status_reason` |
| `approved` | `order` | `ordered` | `request.manage` | | `ordered_by`, `ordered_at`, `expected_delivery_date` nếu gửi |
| `ordered`, `partially_received` | `receive_partial` | `partially_received` | hệ thống | Gọi từ #109 | Chỉ ghi lịch sử khi trạng thái thực sự đổi |
| `ordered`, `partially_received` | `receive_all` | `received` | hệ thống | Gọi từ #109 | Xem spec #109 |
| `ordered`, `partially_received` | `close_short` | `closed_short` | `request.approve` | Có lý do; `receipt_counting` | Mỗi dòng không bị loại: `closed_short_qty += còn chờ`; `closed_by`, `closed_at`; phiếu nhận `short` tự sang `resolved` (spec #109 mục 6.5) |
| `draft`, `changes_requested`, `pending_approval` | `cancel` | `cancelled` | `request.manage` | | |
| `approved`, `ordered` | `cancel` | `cancelled` | `request.approve` | Có lý do; `has_receipts` | |

Lưu ý: `Documents/25` ghi đóng thiếu từ `partially_received`, còn FE và §16.3 cho cả từ `ordered`. Spec theo FE và §16.3.

### 6.5 Hợp đồng API

Mọi route gắn dưới `/api/v1/purchasing`. Kiểu dữ liệu đúng như `FE/src/types/purchasing.ts`. Tiền là số nguyên đồng (R2), thời điểm là ISO UTC (R3).

| Method | Đường dẫn | Quyền route | Vào | Ra |
|---|---|---|---|---|
| GET | `/suppliers` | xem | `search?`, `active?` | `Supplier[]`, sắp theo tên |
| POST | `/suppliers` | `request.manage` | `SupplierInput` | 201 `Supplier` |
| PUT | `/suppliers/:id` | `request.manage` | `SupplierInput` + `version` | `Supplier` |
| GET | `/requests` | xem | `page, pageSize, search, status, supplierId` | `Page<PurchaseRequestSummary>`, mới nhất trước. `search` khớp số đề nghị, ghi chú, tên NCC (`ILIKE`) |
| GET | `/requests/:id` | xem | — | `PurchaseRequest` |
| POST | `/requests` | `request.manage` | `PurchaseRequestInput` | 201 `PurchaseRequest` nháp |
| PUT | `/requests/:id` | `request.manage` | `PurchaseRequestInput` + `version` | `PurchaseRequest` |
| POST | `/requests/add-line` | `request.manage` | `AddRequestLineInput` | `PurchaseRequest` (201 khi lập nháp mới) |
| POST | `/requests/:id/lines/:lineId/exclude` | `request.approve` | `{ excluded, version }` | `PurchaseRequest` |
| POST | `/requests/:id/:action` | xem (máy kiểm quyền bước) | `{ version, reason?, expectedDeliveryDate? }` | `PurchaseRequest` |

**Kiểm đầu vào (Zod cộng với service):**

| Trường | Luật |
|---|---|
| `SupplierInput.name` | 1–150 ký tự sau khi trim |
| `SupplierInput.phone` | `^[0-9 +().-]{8,20}$` hoặc trống |
| `SupplierInput.email` | email hoặc trống |
| `SupplierInput.address`, `note` | Tối đa 300 và 500 ký tự |
| `SupplierInput.active` | Mặc định `true` |
| `PurchaseRequestInput.supplierId` | Uuid, NCC của công ty và đang giao dịch (`errors.supplierId`) |
| `PurchaseRequestInput.note` | Tối đa 500 ký tự |
| `lines` | 1–100 dòng. Mỗi dòng có **đúng một** trong hai: `variantId` (biến thể của công ty, mua được, không trùng trong đề nghị) hoặc `newProduct` (`name` 1–120 ký tự; `categoryId` có thật; tên chưa dùng và không trùng dòng khác, qua `validateNewProducts`) |
| `lines[i].quantity` | Nguyên, 1–1.000.000 |
| `lines[i].unitCost` | Nguyên, 0–1.000.000.000 |
| `AddRequestLineInput` | `requestId` là nháp của công ty, hoặc `null` kèm `supplierId` hợp lệ. Trùng biến thể thì cộng dồn số lượng, giới hạn ở mức tối đa |
| `version` | Số nguyên ≥ 0 |
| `expectedDeliveryDate` | `yyyy-mm-dd` |

Lỗi kiểm đầu vào trả 422 `validation_failed` với `errors` theo ô (`lines.3.unitCost`, `lines.0.newProduct.name`).

**Dựng response:**
- `lineCount`, `totalQty`, `totalCost` chỉ tính dòng không bị loại.
- `outstanding` là tổng `outstanding(line)`.
- `supplierShort` = có phiếu nhận ở `short`.
- `createdBy` là tên, `createdById` là id.
- Dòng dùng `getVariants` cho `sku`, `productName`, `attributesLabel`. Dòng sản phẩm mới chưa duyệt có `sku = null`, `productName` là tên mới, `attributesLabel = ''`, `newProduct.categoryName` lấy qua `categoryNames`.
- `receipts` là phiếu nhận của đề nghị (trước #109 luôn là `[]`).
- `sourceReturn = null`.
- `countingReceipts`.
- `statusHistory = getStatusHistory('purchase_requests', id)`.

### 6.6 Luồng ghi và chạy đồng thời (bước 5)

Khung chung của mọi lệnh ghi đề nghị:

```
withCompany(companyId, async () => {
  row = lockRequest(id)                         // FOR UPDATE; không thấy (RLS) → 404
  if (row.version !== input.version) → 409 version_conflict { current: toDetail(row) }
  record = loadRecord(row)                      // đếm dòng, phiếu nhận
  { to, selfApproved } = assertTransition(machine, row.status, action, { actor, record, reason, canSelfApprove, view })
  … tác động của bước (tạo sản phẩm, đóng thiếu dòng…)
  updateRequest(id, { status: to, version: version + 1, … })
  recordTransition({ entityType: 'purchase_requests', entityId: id, from, to, action, actorId, reason })
  publishEvent(...) nếu là submit, resubmit
  return toDetail(...)
})
```

- **Bấm hai lần hoặc hai người cùng bấm:** người sau xếp hàng sau `FOR UPDATE`, thấy `version` đã tăng nên nhận 409 `version_conflict` kèm bản mới. Không cần khoá idempotency riêng: một dòng, một lần so `version` (N5, N7).
- **Duyệt khi có người đang loại dòng:** cả hai đều khoá bản ghi đề nghị trước, nên chạy tuần tự.
- **Duyệt chạy đua với tạo sản phẩm cùng tên ở catalog:** `createPurchaseProducts` lấy khoá công ty (`lockVariants`) rồi kiểm lại tên. Nếu trùng thì 422, cả giao dịch duyệt rollback.
- **Đóng thiếu chạy đua với ghi sổ phiếu nhận (#109):** cả hai khoá bản ghi đề nghị trước. Người sau thấy trạng thái hoặc còn chờ mới.
- **Thứ tự khoá:** bản ghi đề nghị → các dòng của đề nghị → phiếu nhận → khoá công ty của catalog → dòng tồn. #109 dùng đúng thứ tự này.

### 6.7 Lỗi và bảo mật (bước 3)

| Mã | HTTP | Khi nào |
|---|---|---|
| `validation_failed` | 422 | Đầu vào sai, lỗi theo ô |
| `not_found` | 404 | Id không thuộc công ty, không phải uuid, dòng không thuộc đề nghị, thao tác không có trong danh sách |
| `version_conflict` | 409 | Lệch `version`, kèm `current` |
| `not_draft` | 409 | `PUT` khi không ở `draft` hoặc `changes_requested`; `add-line` vào đề nghị không còn là nháp trả 422 `errors.requestId` như mock |
| `invalid_transition` | 409 | Thao tác không đi ra từ trạng thái hiện tại; loại dòng khi không chờ duyệt |
| `forbidden` | 403 | Thiếu quyền của bước |
| `second_person_required` | 409 | Người duyệt trùng người lập và không được tự duyệt |
| `reason_required` | 422 | Bước bắt buộc lý do |
| `empty_document` | 409 | Gửi duyệt khi không có dòng |
| `all_lines_excluded` | 409 | Loại dòng cuối cùng, hoặc duyệt khi mọi dòng đã bị loại |
| `has_receipts` | 409 | Huỷ đề nghị đã có phiếu nhận chưa huỷ |
| `receipt_counting` | 409 | Đóng thiếu khi còn phiếu đang kiểm |
| `supplier_inactive` | 422 | Gửi duyệt với NCC đã ngừng |

**Bảo mật:**
- IDOR: mọi truy vấn chạy trong `withCompany`, RLS chặn bản ghi của công ty khác (trả 404).
- Mass assignment: schema Zod `strict`, không nhận `status`, `approvedBy`, `received`…
- Ẩn giá theo quyền (Q3).
- Tắt phân hệ `purchasing` thì quyền mất hiệu lực (`authorize`, `assertTransition`).
- Ghi audit cho lập, sửa đề nghị, sửa NCC.

### 6.8 Phân quyền (bước 4)

- **Ai làm:** thành viên đang hoạt động của công ty, phân hệ `purchasing` đang bật.
- **Đọc:** `anyOf(ctx.authorize('purchasing.request.manage'), …approve, …receipt.manage, …return.manage)`.
- **Ghi:** quyền cụ thể theo bảng 6.5. Thao tác máy trạng thái thì route chỉ kiểm "xem", quyền của bước do `assertTransition` kiểm theo `actor = getAccess(res)`.
- **Người thứ hai:** `record.createdBy` là người lập đề nghị. `canSelfApprove(accountId)` chỉ được gọi khi người làm trùng người lập.

### 6.9 Quan sát (bước 6)

- RED của mọi route có sẵn qua `http_request_duration_seconds`, nhãn theo mẫu route.
- Vết nghiệp vụ: `core.state_transitions` (ai, lúc nào, từ, sang, lý do) và nhật ký audit.
- Sự kiện `request_submitted` đi qua outbox, độ trễ xem ở outbox.
- Không thêm metric riêng.

### 6.10 Test

| File | Kiểm |
|---|---|
| `test/unit/modules/product/purchasing/domain/request-machine.test.ts` | Từng mũi tên của bảng 6.4; người thứ hai và tự duyệt; các guard (`empty_document`, `all_lines_excluded`, `receipt_counting`, `has_receipts`) |
| `test/unit/modules/product/purchasing/domain/request.test.ts` | `outstanding` (dòng bị loại bằng 0); `canSeeCost`; định dạng số `DN-000001` |
| `test/integration/product/purchasing/suppliers.test.ts` | Thêm, sửa, trùng tên, `version_conflict`, lọc `active` |
| `test/integration/product/purchasing/requests.test.ts` | Lập, sửa, `add-line` cộng dồn, loại dòng, đủ luồng thao tác qua HTTP; parse body bằng schema OpenAPI; giá bị ẩn khi thiếu quyền; công ty khác nhận 404 |
| `test/integration/product/purchasing/request-approve.test.ts` | Duyệt sinh sản phẩm và SKU; tên trùng → 422 và rollback; hai người duyệt song song (`raceBehindLock`) → một người nhận 409 |
| `test/integration/product/purchasing/incoming.test.ts` | Đặt NCC làm `incoming` tăng, huỷ và đóng thiếu làm giảm, dòng bị loại không tính; `GET /inventory/stock/:id` trả đúng `incoming` |

Người dùng test: `createCompany` (CEO), `addMember(companyId, '00000000-0000-4000-8000-000000000005')` cho vai Mua hàng.

## 7. Thứ tự giao

| PR | Nội dung | Phụ thuộc |
|---|---|---|
| A. `feature/108a-su-kien-nhap-hang` | `events.ts`: đổi `order_submitted` thành `request_submitted`, thêm `goods_receipt_posted` (§11.2); `notification/domain/rules.ts`, `notification/CLAUDE.md`; sửa các test đang dùng tên cũ (`rules.test.ts`, `stream.test.ts`, `kafka.test.ts`, `events.test.ts`). Báo bên nghe | Không |
| B. `feature/108-de-nghi-nhap` | `nextDocNumber`, `stockOf` của inventory; migration; NCC; đề nghị: lập, sửa, `add-line`, loại dòng, danh sách, chi tiết; `submit`, `withdraw`, `resubmit`, `cancel` (từ nháp) | A |
| C. `feature/108-duyet-dat-ncc` | `approve` cùng ba hàm catalog, `request_changes`, `reject`, `order`, `cancel` (từ đã duyệt), `close_short` (phần đề nghị); `incomingOf` nối vào inventory; `purchasing/CLAUDE.md` | B |

PR B và C có thể gộp nếu review kịp. Tách ra để mỗi PR dưới khoảng 800 dòng.

## 8. Ảnh hưởng tới FE (Khoa)

- Thao tác `order` nhận thêm `expectedDeliveryDate` (tuỳ chọn), FE nên có ô ngày.
- `supplier_inactive` khi gửi duyệt là 422, không phải 409 như mock.
- Gửi duyệt với dòng giá 0 trả 422 `errors["lines.i.unitCost"]`. Mock nên làm giống.
- Kiểm `FE/src/api/problemMessages.ts` có câu báo cho `supplier_inactive`, `all_lines_excluded`, `receipt_counting`, `has_receipts`, `not_draft`.
- Nếu FE có xử lý theo tên sự kiện `purchasing.order_submitted` thì đổi sang `purchasing.request_submitted`.

## 9. Ảnh hưởng tới Documents

- `Documents/21` §16.2: thao tác `order` nhận `expectedDeliveryDate?`; `sourceReturnId` chưa hỗ trợ tới B4.
- `Documents/21` §16.4: thêm `not_draft`; ghi `supplier_inactive` dùng cả khi gửi duyệt.
- `Documents/21` §11.2: tên sự kiện `purchasing.request_submitted` và payload.
- `Documents/19`: thêm `suppliers.note` và hai index unique.

## 10. Điểm còn mở

- R4 (`null` hay `''` cho chuỗi trống) đang chờ Thành và Khoa chốt. Spec trả `''` theo kiểu FE hiện tại.
- Sản phẩm mới chỉ có tên và danh mục, không có phân loại. Nếu muốn nhiều biến thể cho một sản phẩm mới thì cần đổi hợp đồng `NewProductInput`.
- ~~Quy tắc SKU có `{VAL}` mà biến thể không có thuộc tính sinh dấu `-` thừa~~: đã kiểm, `renderSku` tự bỏ dấu nối thừa quanh `{VAL}` (29/10).

## 11. Acceptance criteria

1. Mua hàng lập đề nghị với hai dòng (một SKU có sẵn, một sản phẩm mới) → 201, số `DN-000001`, trạng thái `draft`, `statusHistory` có một dòng `null → draft`.
2. Lập với NCC đã ngừng, SKU `discontinued`, hai dòng trùng SKU, hoặc tên sản phẩm mới trùng sản phẩm đã có → 422 với `errors` đúng ô.
3. `PUT` một đề nghị đang `pending_approval` → 409 `not_draft`; `PUT` với `version` cũ → 409 `version_conflict` kèm `current`.
4. Gửi duyệt khi có dòng giá 0 → 422 `errors["lines.i.unitCost"]`. Gửi duyệt thành công → outbox có `purchasing.request_submitted { requestId, number }`.
5. Người lập (không phải CEO, công ty có hơn một thành viên) bấm duyệt → 409 `second_person_required`. CEO duyệt đề nghị do chính mình lập → 200, `self_approved = true`.
6. CEO loại dòng cuối cùng còn lại → 409 `all_lines_excluded`.
7. Duyệt xong: dòng sản phẩm mới có `variantId` và `sku` theo quy tắc danh mục; catalog có sản phẩm mới với mô tả "Tạo từ đề nghị nhập DN-…".
8. Đặt NCC → `GET /inventory/stock/:variantId` trả `incoming` bằng số đặt của dòng đó (dòng bị loại không tính). Huỷ đề nghị đã đặt (CEO, có lý do, chưa có phiếu nhận) → `incoming` về 0.
9. Kho (chỉ có `purchasing.receipt.manage`) xem chi tiết → `unitCost`, `totalCost` là `null`.
10. Người của công ty khác `GET /requests/:id` → 404.
11. Hai CEO cùng duyệt một đề nghị → một người 200, người kia 409 `version_conflict`.
12. `npm run check` xanh; mọi response trong test parse được bằng schema OpenAPI cùng tên kiểu FE.
