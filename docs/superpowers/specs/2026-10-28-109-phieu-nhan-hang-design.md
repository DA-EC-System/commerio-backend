# Spec: Phiếu nhận hàng (#109, A2)

- **Ngày:** 28/10/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#109, `Documents/25` §4.1, §4.2, §11, §12 (E5–E7, E154–E173), `Documents/21` §16, FE#71
- **Trạng thái:** nháp, chờ Khang duyệt
- **Phụ thuộc:** spec #111 (`receiveGoods`, `nextDocNumber`), spec #108 (đề nghị đã `ordered`, PR sự kiện), #114 cho phần đính kèm

---

## 1. Mục tiêu và tiêu chí thành công

1. **Lập phiếu:** kho lập phiếu nhận khi hàng tới, gắn với một đề nghị đang `ordered` hoặc `partially_received`, và chọn cách giao: người giao đứng chờ, hoặc đã đi và kho phải kiểm trong 24 giờ.
2. **Kiểm từng dòng:** ghi số NCC báo giao, số nhận đạt, số lỗi giữ lại, số trả tại chỗ và lý do. Số thiếu tự tính.
3. **Ghi sổ** chạy trong một giao dịch:
   - tồn thực tăng theo số đạt, giá vốn bình quân tính lại theo giá đề nghị;
   - số lỗi vào chờ xử lý, và hệ thống tự lập phiếu trả NCC nháp;
   - còn chờ của dòng đề nghị giảm, rồi đề nghị tự sang nhận một phần hoặc nhận xong.

   Người ghi sổ phải khác người lập đề nghị, trừ CEO và công ty một người.
4. **Giao thiếu:** phiếu có thiếu thì vào `short`. Mua hàng ghi kết quả (giao bù, đóng thiếu, NCC nhận sai) thì phiếu sang `resolved`. Đề nghị nhận đủ hoặc bị đóng thiếu thì phiếu tự sang `resolved`.
5. **Báo cáo theo NCC:** số phiếu, số lần giao thiếu, tỉ lệ lỗi.
6. Phát `purchasing.goods_receipt_posted`.
7. **Đính kèm** ảnh phiếu giao, biên bản, ảnh và video mở thùng, sau khi #114 có upload.

Đo bằng: acceptance criteria ở mục 11 đều qua, `npm run check` xanh, `pnpm e2e:be` của FE đạt cho màn phiếu nhận.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `develop` (đã kiểm):**
- Bảng `goods_receipts` đã có: `delivery_mode` (`driver_waiting` / `driver_left`), `status` (`counting`, `matched`, `short`, `resolved`, `cancelled`), `check_deadline`, `short_resolution`, `follow_up_receipt_id`, `resolution_note`, `resolved_by/at`, `created_by`, `posted_by/at`. Các CHECK:
  - `resolved ⇔ có short_resolution`;
  - `follow_up ⇔ có follow_up_receipt_id`;
  - `đã ghi sổ ⇔ có posted_at`.
- Bảng `goods_receipt_lines` đã có: `declared_qty`, `accepted_qty`, `defective_qty`, `returned_on_spot_qty`, `shortage_qty` (cột tự tính), `reason`. CHECK `đạt + lỗi + trả ≤ báo giao`. Unique `(receipt_id, request_line_id)`.
- Bảng `supplier_returns` và `supplier_return_lines` đã có (source `receipt_defect`), nhưng máy trạng thái phiếu trả thuộc B4.
- Bảng `core.attachments` đã có (`entity_type`, `entity_id`, `file_id`), nhưng module `files` chưa có upload và chưa có hàm nào (#114).
- Có sẵn khung máy trạng thái, các quyền, và vai Nhân viên kho có `purchasing.receipt.manage`.

**Chỗ lệch và cách chọn:**

| Chỗ | Nguồn | Chọn |
|---|---|---|
| Giá trị `deliveryMode` | `Documents/19` và DB: `driver_waiting` / `driver_left`. FE: `waiting` / `left` | API dùng giá trị của FE, DB giữ của `Documents/19`, đổi qua lại ở lớp `api`. Ghi rõ giá trị vào §16.2 |
| Ghi kết quả giao thiếu | §16.3 và CHECK DB: `short → resolved`. Mock FE chỉ lưu kết quả, phiếu vẫn `short` | Theo §16.3 và DB. Mock FE cần sửa |
| Video đính kèm | §14.3: chỉ JPG/PNG/WebP/PDF. `Documents/25` §4.1: có video | Cho phép video (Khang chốt 28/10). Làm xong thì sửa §14.3 |
| `box_count` | `Documents/25`: số thùng khi người giao đi. FE không gửi | Bỏ trống, chưa làm |
| Kỳ báo cáo NCC sai | Mock trả 400 `invalid_period` | 422 `validation_failed` với `errors.from`, theo hợp đồng lỗi chung |

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| Q1 | Thêm cột `goods_receipts.self_approved`. Bước `post` và `post_short` bật `allowSelfApproval` | Khang chốt 28/10. Nếu không, công ty một người không bao giờ ghi sổ được (`Documents/25` §11) |
| Q2 | Chưa bắt buộc bằng chứng. Khi #114 có upload thì thêm 422 `evidence_required` lúc ghi sổ, áp cho phiếu "người giao đã đi" có lỗi hoặc thiếu mà không có tệp | Khang chốt 28/10 |
| Q3 | Đính kèm nhận cả video. Yêu cầu gửi #114: cho `video/mp4`, `video/webm`, `video/quicktime`; đề xuất tối đa 100 MB cho video, 10 MB cho ảnh và PDF, tối đa 10 tệp một phiếu | Khang chốt 28/10. Giới hạn cụ thể do #114 chốt |
| Q4 | Dòng phiếu sinh lúc lập: mỗi dòng đề nghị không bị loại, có `variant_id` và còn chờ > 0 thành một dòng với mọi số bằng 0. `PUT` chỉ sửa số trên các dòng đó (theo `lineId`) | Giống mock FE. Unique `(receipt_id, request_line_id)` đã có |
| Q5 | Ghi sổ chạy một giao dịch, khoá theo thứ tự của spec #108 (Q10): đề nghị → dòng đề nghị → phiếu nhận → dòng tồn. Kiểm lại "đạt + lỗi ≤ còn chờ" sau khi khoá | `Documents/25` §4.1: hai phiếu đang kiểm song song không được cùng vượt còn chờ (E172) |
| Q6 | Tự sang Đã xử lý: đề nghị nhận đủ thì mọi phiếu `short` của đề nghị sang `resolved` với kết quả `follow_up`, trỏ tới phiếu vừa ghi sổ. Đề nghị bị đóng thiếu thì kết quả là `close_short`, `resolution_note` là lý do. `resolved_by` là người gây ra (người ghi sổ hoặc CEO). Lịch sử ghi `auto_resolve`, nguồn hệ thống | `Documents/25` §4.1, E165, E166. CHECK DB buộc `follow_up` phải có phiếu trỏ tới |
| Q7 | Ghi kết quả giao thiếu bằng tay là bước `resolve` (`short → resolved`, quyền `request.manage`). Bước này thêm vào bảng chuyển BE; FE không có vì dùng route riêng `/short-resolution` | §16.3 |
| Q8 | Phiếu trả NCC nháp do hệ thống lập: `created_by = null`, số `TN-…`, nguồn `receipt_defect`, mỗi dòng lỗi một dòng kèm giá đề nghị. Lịch sử `null → draft` nguồn hệ thống | `Documents/25` §4.2. Máy trạng thái phiếu trả để B4 |
| Q9 | Số phiếu nhận dạng `NH-000001` (`nextDocNumber('goods_receipt')`), phiếu trả NCC dạng `TN-000001` | Theo mock FE |
| Q10 | Trước khi #114 xong, `attachmentIds` khác `[]` trả 422 `errors.attachments` | Không nhận rồi bỏ đi trong im lặng |

## 4. Phạm vi

**Trong spec:**
- Phiếu nhận: danh sách, chi tiết, lập, sửa số, `post`, `post_short`, `cancel`, ghi kết quả giao thiếu.
- Tác động lên đề nghị: nhận một phần, nhận xong, đóng thiếu qua đường giao thiếu.
- Lập phiếu trả NCC nháp.
- Sự kiện `goods_receipt_posted`.
- Báo cáo theo NCC.
- Đính kèm và `evidence_required` (PR cuối, sau #114).

**Ngoài spec:**
- Máy trạng thái phiếu trả NCC (B4).
- Nhắc việc "đang kiểm quá 24 giờ", "giao thiếu quá 7 ngày" (#114).
- Chia hàng cho kiện thiếu sau khi nhập (#111 phần sau, nghe `stock_changed`).
- Sửa ghi sổ nhầm bằng phiếu kiểm kê (E11, B3).
- Thông báo realtime khi phiếu vào `short`.
- `box_count`.

## 5. Luồng người dùng

1. Hàng tới. **Kho** mở đề nghị `DN-000123`, bấm "Lập phiếu nhận", chọn "Người giao đứng chờ" hoặc "Người giao đã đi". Hệ thống tạo `NH-000045` ở Đang kiểm với các dòng còn chờ.
2. Kho nhập từng dòng: báo giao 60, đạt 55, lỗi giữ 0, trả tại chỗ 0, lý do "thiếu 5". Lưu nhiều lần được.
3. Kho (không phải người lập đề nghị) bấm:
   - **Ghi sổ** nếu không thiếu: phiếu sang Khớp;
   - **Ghi sổ, báo giao thiếu** nếu có thiếu: phiếu sang Giao thiếu.

   Tồn thực tăng 55 ngay, sàn được đẩy tồn qua `stock_changed`.
4. Nếu có lỗi giữ lại, phiếu hiện "Phiếu trả NCC TN-000012 (nháp)" ở mục phiếu sinh tiếp.
5. **Mua hàng** làm việc với NCC rồi ghi kết quả:
   - giao bù (chọn số phiếu nhận bù);
   - NCC nhận sai (kèm ghi chú);
   - hoặc CEO đóng thiếu cả đề nghị.

   Phiếu sang Đã xử lý.

## 6. Thiết kế backend

### 6.1 Phân loại và tải (bước 1)

REST đồng bộ: đọc theo trang và các lệnh ghi theo máy trạng thái. Ghi sổ đụng nhiều bảng nhưng nhỏ: tối đa 100 dòng, một giao dịch, dưới 200 ms. Tải vài chục phiếu mỗi ngày.

### 6.2 Bố cục và ranh giới

```
product/purchasing/
├─ domain/receipt-machine.ts     goodsReceiptMachine (bảng FE + resolve), GoodsReceiptRecord
├─ domain/receipt.ts             shortOf, kiểm số một dòng, đổi deliveryMode qua lại, formatNumber('NH'|'TN', n)
├─ repository/receipts.ts        list, findById, lockById, insert + lines, updateLines, updateStatus…, countByRequest
├─ repository/returns.ts         insertDraftReturn + lines, findByReceipt (followUps)
├─ repository/report.ts          supplierReport(from, to)
├─ service/receipts.ts           create, update
├─ service/receipt-actions.ts    post, postShort, cancel, resolveShort
├─ service/request-receiving.ts  applyReceiving(request, …), closeShortRequest(…) (dùng chung với #108)
└─ service/receipt-views.ts      toSummary, toDetail
```

**Gọi ra:**
- `inventory`: `receiveGoods`, `nextDocNumber`.
- `catalog`: `getVariants` để dựng nhãn dòng.
- `core`: `recordTransition`, `assertTransition`, `getStatusHistory`, `canSelfApprove`, `publishEvent`, `recordAudit`.
- `files` (sau #114): `setAttachments`, `listAttachments`.

**Dùng chung với #108:** `closeShortRequest` được gọi từ thao tác `close_short` của đề nghị và từ `/short-resolution` loại `close_short`, để chỉ có một cách đóng thiếu.

### 6.3 Dữ liệu (bước 2)

**Migration `00xx_phieu-nhan.sql`:**

```sql
ALTER TABLE product.goods_receipts ADD COLUMN self_approved boolean NOT NULL DEFAULT false;
```

Thêm cột có hằng mặc định chỉ đổi metadata (PG ≥ 11), không ghi lại bảng.

**Bất biến:**

| Bất biến | Ai giữ |
|---|---|
| Đạt + lỗi + trả tại chỗ ≤ báo giao, mọi số ≥ 0 | CHECK (đã có) |
| Đạt + lỗi ≤ còn chờ của dòng đề nghị lúc ghi sổ | Service, sau khi khoá bản ghi đề nghị và các dòng của nó (Q5). CHECK `purchase_request_lines_outstanding` là lưới cuối |
| Ghi sổ đúng một lần | Cập nhật có điều kiện `WHERE status = 'counting' AND version = …`; CHECK `đã ghi sổ ⇔ có posted_at` |
| Người ghi sổ khác người lập đề nghị, trừ khi `self_approved` | `assertTransition` (khác bảng nên không có CHECK) |
| `resolved ⇔ có kết quả`, `follow_up ⇔ có phiếu bù` | CHECK (đã có) |
| Chỉ sửa số khi `counting` | Service (409 `not_draft`) |
| `check_deadline = created_at + 24h` khi người giao đã đi, ngược lại null | Service; đổi cách giao thì tính lại |

### 6.4 Máy trạng thái

| Từ | Thao tác | Đến | Quyền | Điều kiện, mã lỗi |
|---|---|---|---|---|
| (lập) | — | `counting` | `receipt.manage` | Đề nghị `ordered` hoặc `partially_received`, nếu không → 409 `invalid_transition` (`current` = trạng thái đề nghị). Không còn dòng chờ → 409 `empty_document` |
| `counting` | `post` | `matched` | `receipt.manage` | Người thứ hai so với người lập đề nghị, tự duyệt được; `has_shortage`; không dòng nào có báo giao > 0 → 409 `empty_document`; 422 `over_outstanding` |
| `counting` | `post_short` | `short` | `receipt.manage` | Như `post`; `no_shortage` |
| `counting` | `cancel` | `cancelled` | `receipt.manage` | Có lý do |
| `short` | `resolve` | `resolved` | `request.manage` | Chỉ qua `/short-resolution`. Phiếu đã `resolved` → 409 `resolution_recorded` |
| `short` | `auto_resolve` | `resolved` | hệ thống | Q6 |

### 6.5 Ghi sổ (`post`, `post_short`)

Một giao dịch `withCompany`:

1. Đọc `request_id` của phiếu (404 nếu không thấy). **Khoá** bản ghi đề nghị (`FOR UPDATE`), rồi các dòng của đề nghị, rồi phiếu.
2. So `version` của phiếu: lệch → 409 `version_conflict` kèm `current`.
3. `assertTransition(goodsReceiptMachine, 'counting', action, { actor, record: { createdBy: request.createdBy, short }, canSelfApprove })`.
4. Kiểm: có dòng báo giao > 0; với mỗi dòng, `đạt + lỗi ≤ outstanding(dòng đề nghị)`. Vi phạm → 422 `over_outstanding` với `errors["lines.i.accepted"] = "Còn chờ N…"`.
5. Dòng đề nghị: `received_qty += đạt`, `defective_qty += lỗi`.
6. `receiveGoods(receiptId, lines có đạt hoặc lỗi > 0, actorId)`: `lineId` là id **dòng phiếu nhận** (`goods_receipt_lines.id`, thành `source_line_id` của thẻ kho), `unitCost` là `unit_price` của dòng đề nghị.
7. Có dòng lỗi: lập phiếu trả NCC nháp (Q8).
8. Phiếu: `status = matched | short`, `posted_by`, `posted_at`, `self_approved`, `version + 1`; ghi lịch sử.
9. Đề nghị (cùng hàm `applyReceiving`):
   - Tổng còn chờ của dòng không bị loại bằng 0 → `receive_all` (hệ thống) sang `received`, rồi Q6 cho mọi phiếu `short` của đề nghị, kể cả phiếu vừa ghi nếu nó `short`.
   - Ngược lại → `receive_partial`. Chỉ ghi lịch sử khi trạng thái đổi từ `ordered`.
   - Đề nghị `version + 1`.
10. `publishEvent('purchasing.goods_receipt_posted', { receiptId, requestId, lines: [{ variantId, accepted, defective }] })`.
11. Trả `GoodsReceipt` mới nhất.

### 6.6 Ghi kết quả giao thiếu (`POST /goods-receipts/:id/short-resolution`)

Khoá theo thứ tự đề nghị → phiếu, rồi so `version` của phiếu.

| `kind` | Kiểm | Tác động |
|---|---|---|
| `follow_up` | `followUpNumber` (trim, chữ hoa) là phiếu khác của cùng đề nghị và chưa huỷ, nếu không → 422 `follow_up_invalid` với `errors.followUpNumber` | `short → resolved` (`resolve`), `follow_up_receipt_id`, `resolution_note`, `resolved_by`, `resolved_at` |
| `supplier_wrong` | `note` bắt buộc (422 `errors.note`) | `short → resolved` (`resolve`) |
| `close_short` | Cần `request.approve` (403 `forbidden`); `note` bắt buộc (422 `reason_required`) | Gọi `closeShortRequest(request, actor, note)`: đề nghị sang `closed_short` theo máy của #108 (`receipt_counting` vẫn chặn); mọi phiếu `short` của đề nghị, kể cả phiếu này, sang `resolved` theo Q6 |

Phiếu không ở `short` → 409 `resolution_recorded` nếu đã `resolved`, các trạng thái khác → 409 `invalid_transition`.

### 6.7 Hợp đồng API

Gắn dưới `/api/v1/purchasing`. Kiểu dữ liệu đúng như `FE/src/types/purchasing.ts`.

| Method | Đường dẫn | Quyền route | Vào | Ra |
|---|---|---|---|---|
| GET | `/goods-receipts` | xem | `page, pageSize, search, status, requestId` | `Page<GoodsReceiptSummary>`, mới nhất trước. `search` khớp số phiếu, số đề nghị |
| GET | `/goods-receipts/:id` | xem | — | `GoodsReceipt` |
| POST | `/goods-receipts` | `receipt.manage` | `{ requestId, deliveryMode, note }` | 201 `GoodsReceipt` đang kiểm |
| PUT | `/goods-receipts/:id` | `receipt.manage` | `GoodsReceiptUpdateInput` | `GoodsReceipt` |
| POST | `/goods-receipts/:id/short-resolution` | `request.manage` | `{ kind, followUpNumber?, note, version }` | `GoodsReceipt` |
| POST | `/goods-receipts/:id/:action` | xem (máy kiểm quyền bước) | `{ version, reason? }`, `action ∈ post, post_short, cancel` | `GoodsReceipt` |
| GET | `/suppliers/report` | xem | `from?, to?` (`yyyy-mm-dd` giờ Việt Nam, tính cả hai đầu) | `SupplierReport[]` |

"Xem" là có ít nhất một quyền `purchasing.*` (như #108).

**Kiểm `PUT`:**
- `deliveryMode ∈ waiting | left`; `note` tối đa 500 ký tự.
- `attachmentIds`: tối đa 10, và trước #114 phải rỗng.
- `lines[]` theo `lineId` thuộc phiếu:
  - `announced`, `accepted`, `defectKept`, `returnedOnSpot` là số nguyên 0–1.000.000;
  - `đạt + lỗi + trả ≤ báo giao` (`errors["lines.i.accepted"]`);
  - có thiếu, lỗi hoặc trả tại chỗ thì `reason` bắt buộc, tối đa 300 ký tự;
  - `đạt + lỗi ≤ còn chờ` hiện tại → 422 `over_outstanding`. Đây là kiểm sớm; kiểm chắc chắn nằm ở bước ghi sổ.

**Dựng response:**
- `deliveryMode` đổi ngược về `waiting` / `left`.
- `lines[].lineId` là id **dòng đề nghị**; `outstanding` là còn chờ hiện tại của dòng đề nghị.
- `short = shortage_qty`, `shortQty` là tổng `short`.
- `totalAnnounced`.
- `requestCreatedById`.
- `shortResolution = { kind, followUp: DocRef | null, note, by: tên, at } | null`.
- `followUps` là các phiếu trả NCC có `source = 'receipt_defect'` và `source_id` là phiếu này.
- `attachments = []` cho tới #114.
- `statusHistory = getStatusHistory('goods_receipts', id)`.
- `note`, `reason` trống trả `''` (như spec #108, chờ chốt R4).

**Báo cáo NCC** (một câu SQL gom theo NCC, `LEFT JOIN` để NCC chưa có phiếu vẫn hiện số 0). Chỉ tính phiếu đã ghi sổ có `posted_at` (đổi sang giờ Việt Nam) nằm trong kỳ:
- `receiptCount`: số phiếu.
- `shortReceiptCount`: số phiếu ở `short` hoặc `resolved`.
- `deliveredQty`: tổng `đạt + lỗi + trả`.
- `defectQty`: tổng `lỗi + trả`.
- `defectRate`: `defectQty / deliveredQty`, hoặc `null` khi bằng 0.

### 6.8 Chống trùng và chạy đồng thời (bước 5)

- **Bấm ghi sổ hai lần:** lần hai xếp hàng sau khoá đề nghị, thấy `version` của phiếu đã tăng, nhận 409. `receiveGoods` không bao giờ chạy hai lần cho một phiếu.
- **Hai phiếu đang kiểm cùng đề nghị ghi sổ cùng lúc (E172):** cùng khoá bản ghi đề nghị nên chạy tuần tự. Phiếu sau đọc còn chờ mới, vượt thì 422 `over_outstanding`.
- **Lập phiếu chạy đua với huỷ hoặc đóng thiếu đề nghị:** lập phiếu cũng khoá bản ghi đề nghị trước khi kiểm trạng thái. Người sau thấy trạng thái mới.
- **Ghi kết quả giao thiếu chạy đua với ghi sổ phiếu bù làm đề nghị nhận đủ:** cùng khoá đề nghị trước. Nếu phiếu đã tự sang `resolved` thì người ghi tay nhận 409 `resolution_recorded`.
- **Dòng tồn:** `receiveGoods` khoá theo `variantId` tăng dần (spec #111, Q8).

### 6.9 Lỗi và bảo mật (bước 3)

| Mã | HTTP | Khi nào |
|---|---|---|
| `validation_failed` | 422 | Đầu vào sai, lỗi theo ô |
| `not_found` | 404 | Phiếu, đề nghị của công ty khác hoặc không tồn tại; thao tác lạ |
| `version_conflict` | 409 | Lệch `version`, kèm `current` |
| `not_draft` | 409 | `PUT` khi phiếu không còn đang kiểm |
| `invalid_transition` | 409 | Lập phiếu khi đề nghị không `ordered`/`partially_received`; thao tác sai trạng thái |
| `empty_document` | 409 | Đề nghị không còn dòng chờ; ghi sổ khi chưa có số báo giao |
| `over_outstanding` | 422 | Đạt + lỗi vượt còn chờ, `errors` theo dòng |
| `has_shortage` / `no_shortage` | 409 | Chọn sai nút ghi sổ |
| `second_person_required` | 409 | Người ghi sổ là người lập đề nghị và không được tự duyệt |
| `forbidden` | 403 | Thiếu quyền của bước; đóng thiếu khi không có `request.approve` |
| `reason_required` | 422 | Huỷ phiếu, đóng thiếu mà không có lý do |
| `resolution_recorded` | 409 | Ghi kết quả lần hai |
| `follow_up_invalid` | 422 | Số phiếu bù sai |
| `evidence_required` | 422 | (PR D, sau #114) Người giao đã đi, có lỗi hoặc thiếu, không có tệp |

**Bảo mật:**
- RLS và `withCompany` cho mọi truy vấn. `followUpNumber` chỉ tìm trong cùng đề nghị của cùng công ty.
- `attachmentIds` (sau #114) phải là tệp của công ty, đã tải xong.
- Schema Zod `strict`, không nhận `status`, `postedBy`, `variantId` từ client.
- Phiếu nhận không trả giá (FE không có trường giá ở dòng phiếu), nên không lộ giá vốn cho kho.

### 6.10 Phân quyền (bước 4)

| Việc | Ai |
|---|---|
| Lập, kiểm, ghi sổ, huỷ phiếu | `purchasing.receipt.manage` (Nhân viên kho, CEO) |
| Ghi sổ | Thêm luật người thứ hai so với người lập đề nghị. CEO và công ty một người tự ghi được, có `self_approved` trên phiếu |
| Ghi kết quả giao thiếu | `purchasing.request.manage`; riêng đóng thiếu cần `purchasing.request.approve` |
| Xem phiếu, báo cáo NCC | Một quyền `purchasing.*` bất kỳ |

### 6.11 Quan sát (bước 6)

- RED của route có sẵn.
- Vết nghiệp vụ gồm: thẻ kho (từng biến động có số phiếu), `state_transitions` của phiếu nhận, đề nghị và phiếu trả, nhật ký audit cho lập và sửa số.
- `goods_receipt_posted` qua outbox, cho báo cáo dùng sau.
- Không thêm metric riêng.

### 6.12 Test

| File | Kiểm |
|---|---|
| `test/unit/modules/product/purchasing/domain/receipt-machine.test.ts` | Từng mũi tên; `has_shortage` / `no_shortage`; người thứ hai và tự duyệt; `cancel` cần lý do |
| `test/unit/modules/product/purchasing/domain/receipt.test.ts` | `shortOf`; kiểm số một dòng (vượt báo giao, thiếu lý do); đổi `deliveryMode` qua lại |
| `test/integration/product/purchasing/goods-receipts.test.ts` | Lập (đề nghị sai trạng thái, không còn dòng), sửa số, `not_draft`, huỷ; parse body bằng schema OpenAPI; công ty khác 404 |
| `test/integration/product/purchasing/receipt-posting.test.ts` | Ghi sổ đủ: tồn, giá vốn, chờ xử lý, phiếu trả nháp, đề nghị sang nhận một phần rồi nhận xong, tự `resolved`, outbox; người lập đề nghị bị chặn; CEO tự ghi được; hai phiếu đua (`raceBehindLock`) → phiếu sau 422 `over_outstanding` |
| `test/integration/product/purchasing/short-resolution.test.ts` | Ba loại kết quả; `follow_up_invalid`; `resolution_recorded`; đóng thiếu khi còn phiếu đang kiểm → `receipt_counting` |
| `test/integration/product/purchasing/supplier-report.test.ts` | Số liệu theo kỳ giờ Việt Nam; NCC chưa có phiếu trả 0 và `defectRate: null`; kỳ ngược → 422 |

## 7. Thứ tự giao

| PR | Nội dung | Phụ thuộc |
|---|---|---|
| A. `feature/109-phieu-nhan` | Migration `self_approved`; máy trạng thái; lập, sửa số, huỷ, danh sách, chi tiết | #111, #108 (C) |
| B. `feature/109-ghi-so` | `post`, `post_short`, phiếu trả nháp, tác động lên đề nghị, tự `resolved`, sự kiện | A |
| C. `feature/109-giao-thieu-bao-cao` | `/short-resolution`, `closeShortRequest` dùng chung, báo cáo NCC; `purchasing/CLAUDE.md` thêm phần phiếu nhận | B |
| D. `feature/109-dinh-kem` | `attachmentIds` qua `files`, `attachments` trong response, `evidence_required`; sửa `Documents/21` §14.3 (video) | C, #114 |

## 8. Ảnh hưởng tới FE (Khoa)

- Mock `/short-resolution` phải chuyển phiếu sang `resolved` và ghi lịch sử (BE làm vậy theo §16.3). Lịch sử có thêm thao tác `resolve`.
- Báo cáo NCC với kỳ ngược trả 422 `validation_failed`, không phải 400 `invalid_period`.
- Trước #114, gửi `attachmentIds` khác rỗng sẽ bị 422. FE nên ẩn ô đính kèm, hoặc gửi `[]`.
- Thêm câu báo trong `problemMessages.ts` cho `over_outstanding`, `has_shortage`, `no_shortage`, `resolution_recorded`, `follow_up_invalid`, `not_draft`, `empty_document` và sau này `evidence_required`.
- Ô tải tệp nhận thêm video khi #114 xong.

## 9. Ảnh hưởng tới Documents

- `Documents/21` §14.3: thêm video và giới hạn mới. Sửa sau khi làm xong, theo chốt của Khang ngày 28/10.
- `Documents/21` §16.2: ghi giá trị `deliveryMode` (`waiting` / `left`); `/suppliers/report` nhận `from`, `to`.
- `Documents/21` §16.3: ghi rõ bước `resolve` và cách tự điền kết quả ở Q6.
- `Documents/21` §16.4: thêm `empty_document`, `not_draft`, `no_shortage`, và `evidence_required` khi làm PR D.
- `Documents/19`: thêm `goods_receipts.self_approved`.

## 10. Điểm còn mở

- Giới hạn dung lượng video, và cách upload (qua API hay URL ký sẵn tải thẳng lên kho đối tượng) do #114 chốt. Video 100 MB đi qua Express sẽ tốn bộ nhớ, nên nghiêng về URL ký sẵn.
- Khi một phiếu vừa `short` vừa làm đề nghị nhận đủ (báo giao lớn hơn số còn chờ), Q6 cho nó tự `resolved` với `follow_up` trỏ vào chính nó. Đúng CHECK, nhưng nhãn hơi lạ. Nếu FE muốn hiện khác thì thêm loại kết quả mới.
- `defectRate` là tỉ lệ (0–1) theo kiểu FE, trong khi R2 nói phần trăm tính theo đơn vị %. Cần Khoa xác nhận.

## 11. Acceptance criteria

1. Lập phiếu cho đề nghị `approved` (chưa đặt) → 409 `invalid_transition` với `current = 'approved'`. Lập cho đề nghị `ordered` → 201, số `NH-…`, các dòng bằng các dòng còn chờ, mọi số bằng 0. Người giao đã đi thì `check_deadline` = lúc lập + 24 giờ.
2. `PUT` có đạt + lỗi + trả > báo giao, hoặc có thiếu mà không có lý do → 422 với `errors` đúng ô. Đạt + lỗi > còn chờ → 422 `over_outstanding`.
3. Người lập đề nghị (không phải CEO, công ty có hơn một thành viên) bấm ghi sổ → 409 `second_person_required`. CEO đã lập đề nghị tự ghi sổ được, phiếu có `self_approved = true`.
4. Bấm `post` khi có thiếu → 409 `has_shortage`; bấm `post_short` khi không thiếu → 409 `no_shortage`.
5. Ghi sổ dòng có đạt 55 và lỗi 2, giá 100.000:
   - `GET /inventory/stock/:variantId` có `onHand` +55, `quarantine` +2, giá vốn tính lại;
   - thẻ kho có hai dòng trỏ phiếu nhận;
   - có phiếu trả NCC nháp `TN-…` 2 cái trong `followUps`;
   - outbox có `goods_receipt_posted` và `stock_changed`.
6. Ghi sổ làm mọi dòng hết chờ → đề nghị `received`, các phiếu `short` trước đó sang `resolved` (kết quả `follow_up` trỏ phiếu vừa ghi). Chưa hết → đề nghị `partially_received`.
7. Hai phiếu đang kiểm cùng đề nghị, mỗi phiếu nhận đủ toàn bộ còn chờ, ghi sổ cùng lúc → một phiếu 200, phiếu kia 422 `over_outstanding`. Tồn chỉ tăng một lần.
8. Ghi kết quả `follow_up` với số phiếu của đề nghị khác → 422 `follow_up_invalid`. Ghi đúng → phiếu `resolved`; ghi lần hai → 409 `resolution_recorded`.
9. Mua hàng (không có `request.approve`) chọn `close_short` → 403. CEO chọn `close_short` khi còn phiếu đang kiểm → 409 `receipt_counting`. Khi không còn phiếu đang kiểm → đề nghị `closed_short`, `incoming` của SKU về 0, mọi phiếu `short` sang `resolved` với kết quả `close_short`.
10. Báo cáo NCC trong kỳ có đúng số phiếu, số lần giao thiếu, `defectRate`; NCC chưa có phiếu có `defectRate: null`.
11. Trước #114, `PUT` với `attachmentIds: ['…']` → 422 `errors.attachments`.
12. `npm run check` xanh; mọi response trong test parse được bằng schema OpenAPI cùng tên kiểu FE.
