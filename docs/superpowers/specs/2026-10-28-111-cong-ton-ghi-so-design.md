# Spec: Cổng tồn và lõi ghi sổ kho (#111, phần gấp)

- **Ngày:** 28/10/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#111, `Documents/21` §11.1, §15.1, `Documents/25` §7
- **Trạng thái:** nháp, chờ Khang duyệt
- **Phạm vi:** phần gấp của #111, gỡ chặn cho #104, #106 (Thành) và #109. Phần còn lại của #111 viết spec sau

Spec này là **thư viện nội bộ của `inventory`**, không có endpoint HTTP mới. #108 và #109 dùng ba thứ của nó: `nextDocNumber`, `stockOf`, `receiveGoods`.

> **Sửa 29/10/2026.** Khang chốt làm #108 trước. `nextDocNumber`, `stockOf` (cùng `levelsOf`, `availableQty`, `lockedOf`) đã làm trong PR của #108; phần còn lại của spec này giữ nguyên.

---

## 1. Mục tiêu và tiêu chí thành công

1. #104 đọc được số khả dụng của SKU bằng `availableOf(variantIds)` đúng chữ ký đã ghi trong #111.
2. Thành code #106, #107 theo chữ ký cổng ở `Documents/21` §11.1. Bản này chỉ là bản tạm, ném lỗi `not_implemented`.
3. Có **một lõi duy nhất** đổi tồn thực và chờ xử lý: ghi thẻ kho, kiểm bất biến, tính giá vốn bình quân, phát `inventory.stock_changed`. #109 ghi sổ phiếu nhận qua lõi này.
4. Module lớn `product` có chỗ cấp số chứng từ dùng chung (`doc_counters`).

Đo bằng: acceptance criteria ở mục 9 đều qua, `npm run check` xanh, integration test chạy trên PostgreSQL thật.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `develop` (a85c280, đã kiểm):**
- Bảng `product.stock_levels` có các cột `on_hand`, `reserved`, `quarantine`, `avg_cost`, `min_qty`, `invariant_broken`, `version`. CHECK `stock_levels_invariant` cho phép vỡ bất biến chỉ khi bật `invariant_broken`.
- Bảng `product.stock_moves` là thẻ kho chỉ thêm, có `bucket`, `balance_after`, `unit_cost`, `source_type` (`goods_receipt` / `stock_document` / `supplier_return`), `source_id`, `source_line_id`.
- Bảng `product.doc_counters` đã có nhưng chưa có hàm cấp số. Finance có mẫu `takeNextNumber` (`finance/finance/repository/doc-counters.ts`).
- `repository/levels.ts` có `lockLevel` (tạo dòng 0 rồi `FOR UPDATE`), `findLevel`, `allLevels`, `latestMoves`. `domain/stock.ts` có `weightedAvgCost`.
- **Chưa có:** hàm nào ghi `stock_levels` (ngoài `min_qty`) hay `stock_moves`, và `inventory/index.ts` chưa export hàm nào cho module khác.
- `inventory.stock_changed` đã có schema `{ variantId, onHand, reserved, available }` nhưng chưa ai phát, chưa ai nghe.

**Ràng buộc:**
- `inventory` ở lớp 2, không gọi được `order` (lớp 3), nên cổng nhận dòng `{ variantId, quantity }[]` (§11.1).
- Mọi hàm cổng chạy trong giao dịch của bên gọi (`getDb()`, `requireCompanyId`). `withCompany` không lồng được.
- Thẻ kho chỉ thêm. Đang giữ (`reserved`) không ghi thẻ kho.
- Chỉ tạo dòng `stock_levels` cho biến thể đã qua `getVariants` của công ty (A17).

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| Q1 | Lõi `applyMoves` nằm trong `service/posting.ts` và **không** export ra `index.ts`. Module khác gọi hàm theo nghiệp vụ: `receiveGoods` bây giờ, sau này `ship`, `receiveBack`… | N2: chỉ inventory đổi tồn. Không để module khác đẩy số tuỳ ý |
| Q2 | Export đủ chữ ký §11.1. `reserve`, `release`, `ship`, `reverseShipment`, `receiveBack` là bản tạm ném `AppError(501, 'not_implemented')` | Khang chốt 28/10. Thành code và test theo chữ ký, bản thật làm ở PR sau của #111 |
| Q3 | `availableOf` trả mọi biến thể của công ty có trong `ids`, kể cả biến thể chưa có dòng tồn (giá trị 0). Id của công ty khác, id không tồn tại hoặc không phải uuid thì không có trong Map | Đúng câu trong #111 ("biến thể không có thì không có trong Map"). Bên gọi phân biệt được "hết hàng" với "không phải SKU của mình" |
| Q4 | Tạm khoá luôn bằng 0, tính ở một hàm duy nhất `lockedOf`, đánh dấu `shortcut:` | Chưa có phiếu kho chờ duyệt (B3). Khi B3 làm thì chỉ sửa hàm này |
| Q5 | Nếu tồn thực trước khi nhập ≤ 0 thì giá vốn mới = giá của lần nhập đó | `Documents/25` §7.1. `weightedAvgCost` hiện chia cho `onHand + qty`, sai khi tồn đang âm |
| Q6 | Lõi kiểm bất biến theo kiểu "không làm tệ hơn": từ chối khi tồn thực của một SKU **giảm** mà kết quả vỡ bất biến; chờ xử lý không bao giờ âm. Thao tác làm tăng thì luôn qua, và tự tắt `invariant_broken` khi bất biến đúng trở lại | `Documents/25` §7.1. Tham số cho hai ngoại lệ (bàn giao bắt buộc, kiểm kê) chỉ thêm khi có bên gọi |
| Q7 | Phát `inventory.stock_changed` mỗi lần `on_hand` của SKU đổi: một sự kiện cho mỗi SKU trong mỗi lần gọi lõi, payload là số **sau** khi ghi. Chỉ đổi chờ xử lý thì không phát | Khả dụng chỉ phụ thuộc tồn thực, đang giữ và tạm khoá. Payload là số tuyệt đối nên bên nghe không bị lệch khi nhận trùng |
| Q8 | Khoá dòng tồn theo thứ tự `variantId` tăng dần | Hai giao dịch cùng đụng nhiều SKU không khoá chéo nhau, nên không deadlock |
| Q9 | `nextDocNumber(docType)` chỉ trả số nguyên. Bên gọi tự ghép tiền tố (`DN-000001`) | Inventory không cần biết loại chứng từ của purchasing |

## 4. Phạm vi

**Trong spec:** `availableOf`, `stockOf`, lõi `applyMoves`, `receiveGoods`, `nextDocNumber`, chữ ký tạm của năm hàm cổng, phát `stock_changed`, sửa `weightedAvgCost`, cập nhật `inventory/CLAUDE.md`, ghi lại các hàm này vào `Documents/21` §11.

**Ngoài spec (phần sau của #111 hoặc issue khác):** giữ, trả, bàn giao theo kiện bản thật; chia hàng cho kiện `backordered`; lấy lại phần giữ; nhãn `state`, `drift`, `belowMin` theo §15.1; gợi ý nhập lại; phiếu kho (B3) và tạm khoá thật; số đang thiếu. Số "đang về" do #108 nối vào.

## 5. Thiết kế

### 5.1 Phân loại và tải (bước 1)

Đây là thư viện chạy trong giao dịch của module khác, đồng bộ, không có endpoint. Tải nhỏ: một kho, vài chục phiếu nhận mỗi ngày, mỗi phiếu tối đa 100 dòng. `availableOf` được #104 gọi theo lô listing, vài trăm id mỗi lần. Không cần cache.

### 5.2 Bố cục file

```
product/inventory/
├─ index.ts                export: availableOf, stockOf, receiveGoods, nextDocNumber,
│                          reserve, release, ship, reverseShipment, receiveBack, các kiểu
├─ domain/stock.ts         sửa weightedAvgCost; thêm availableQty(), worsens()
├─ repository/levels.ts    thêm levelsOf(ids), saveLevel(), insertMoves()
├─ repository/counters.ts  takeNextNumber(docType)   (chép mẫu finance)
├─ service/posting.ts      applyMoves (riêng), receiveGoods
└─ service/port.ts         availableOf, stockOf, lockedOf (shortcut), năm hàm tạm
```

`service/views.ts` bỏ phép tính khả dụng riêng của nó, dùng `availableQty` của domain để chỉ còn một công thức.

### 5.3 Dữ liệu (bước 2)

Không có migration. Các bất biến dưới đây do lõi giữ, DB có CHECK làm lưới an toàn:

| Bất biến | Ai giữ |
|---|---|
| `quarantine ≥ 0`, `reserved ≥ 0` | CHECK, cộng với lõi kiểm trước khi ghi để trả lỗi rõ ràng |
| `on_hand ≥ 0` và `reserved ≤ on_hand`, trừ khi `invariant_broken` | CHECK `stock_levels_invariant` và Q6 |
| Mỗi lần đổi `on_hand` hoặc `quarantine` có đúng một dòng thẻ kho, với `balance_after` bằng số của ngăn đó sau biến động | Lõi |
| `version` của dòng tồn tăng 1 mỗi lần lõi ghi | Lõi |

Kiểu dùng chung:

```ts
type Bucket = 'on_hand' | 'quarantine';
interface Move { variantId: string; bucket: Bucket; qty: number /* ≠ 0, nguyên */; unitCost: string | null; sourceLineId: string | null }
interface StockSnapshot { onHand: number; reserved: number; locked: number; available: number; quarantine: number; avgCost: string }
interface StockLine { variantId: string; quantity: number }
```

### 5.4 Lõi `applyMoves`

```ts
applyMoves(source: { type: StockSourceType; id: string }, moves: Move[], actorId: string | null): Promise<void>
```

1. Lấy `companyOfTransaction()`; nếu không có ngữ cảnh công ty thì ném lỗi lập trình. Bỏ các move có `qty = 0`.
2. `getVariants(ids)` của catalog. Id nào không thuộc công ty thì ném `Error`: bên gọi đã phải kiểm, nên đây là lỗi lập trình (500).
3. Gom move theo `variantId`, sắp tăng dần, rồi `lockLevel` từng SKU (Q8).
4. Duyệt move theo thứ tự bên gọi đưa vào:
   - Move `on_hand` có `qty > 0` và có `unitCost`: tính `avgCost = weightedAvgCost(onHand, avgCost, qty, unitCost)` (Q5).
   - Cộng `qty` vào ngăn, nhớ `balance_after` cho dòng thẻ kho.
5. Kiểm từng SKU (Q6). Nếu `quarantine < 0`, hoặc `on_hand` giảm mà kết quả vỡ bất biến, thì ném `InsufficientStock { variantIds }`: lỗi nội bộ, hàm cổng giảm tồn ở PR sau sẽ đổi sang 422 `stock_insufficient` kèm `errors` theo dòng (§15.4). Sau khi qua kiểm, `invariant_broken` = bất biến vẫn đang vỡ.
6. `saveLevel` (đặt số mới, `version + 1`, `updated_at`) và `insertMoves` (`done_by = actorId`, `unit_cost`, nguồn).
7. Với mỗi SKU có `on_hand` đổi: `publishEvent({ type: 'inventory.stock_changed', aggregateId: variantId, payload: { variantId, onHand, reserved, available } })`.

### 5.5 Hàm export

| Hàm | Việc |
|---|---|
| `availableOf(variantIds)` → `Map<string, number>` | Q3. `max(0, onHand − reserved − locked)` |
| `stockOf(variantIds)` → `Map<string, StockSnapshot>` | Cùng cách lọc như `availableOf`. #108 lấy `avgCost` cho `add-line`. `availableOf` dựng trên hàm này |
| `receiveGoods(receiptId, lines, actorId)` | `lines: { lineId, variantId, accepted, defective, unitCost }[]`. Số đạt thành move `on_hand +accepted` theo `unitCost`; số lỗi thành move `quarantine +defective`, có lưu `unitCost` nhưng không vào giá vốn bình quân. Nguồn là `{ type: 'goods_receipt', id: receiptId }`, `sourceLineId = lineId` |
| `nextDocNumber(docType)` → `number` | Một câu upsert vào `doc_counters` (`period = ''`), khoá dòng đếm tới hết giao dịch. Rollback thì số được dùng lại |
| `reserve(packageId, lines)` → `{ reserved: boolean }` | Bản tạm, ném 501 |
| `release(packageId, lines)` | Bản tạm, ném 501 |
| `ship(packageId, lines, { actorId })` → `{ documentId, number }` | Bản tạm, ném 501 |
| `reverseShipment(packageId, lines, { actorId, reason })` → `{ documentId, number }` | Bản tạm, ném 501 |
| `receiveBack(source: { type: 'package' \| 'return_request'; id }, lines)` → `{ documentId, number }` | Bản tạm, ném 501 |

Kiểu trả `{ documentId, number }` của ba hàm cuối là đề xuất của spec này cho cụm "→ phiếu …" ở §11.1. Chốt cùng Thành khi mở PR.

### 5.6 Lỗi và bảo mật (bước 3)

| Tình huống | Xử lý |
|---|---|
| Gọi ngoài `withCompany` | `requireCompanyId` ném lỗi lập trình (500). Nhờ vậy không bao giờ chạy dưới role chủ bảng, nơi RLS không có hiệu lực |
| Biến thể không thuộc công ty | `Error` (500), log ở middleware lỗi. Bên gọi phải kiểm trước |
| Giảm làm vỡ bất biến | `InsufficientStock`. Hàm cổng đổi sang 422 |
| CHECK của DB chặn | 500, tức là bug của lõi. Giao dịch rollback nên không ghi nửa chừng |
| Ghi outbox lỗi | Cùng giao dịch, rollback cả phiếu |
| Kafka ngừng | Relay outbox thử lại (đã có ở #38) |
| Deadlock | Tránh bằng Q8. Nếu vẫn xảy ra thì 500, người dùng bấm lại |

Bảo mật: không mở đường mới từ ngoài vào. Tách công ty bằng RLS và ngữ cảnh `withCompany` của bên gọi. `actorId` được ghi vào thẻ kho để truy vết.

### 5.7 Phân quyền (bước 4)

Không có route mới. Bên gọi đã qua `ctx.authorize` của route mình. Lõi không kiểm quyền và chỉ chạy được trong ngữ cảnh công ty.

### 5.8 Chống trùng và chạy đồng thời (bước 5)

- **Gọi lặp:** lõi không tự chống lặp. Bên gọi chống bằng chuyển trạng thái chứng từ có điều kiện trong cùng giao dịch, ví dụ phiếu nhận `counting → matched` với `WHERE status = 'counting' AND version = …`. Lần gọi thứ hai không tới được lõi.
- **Đồng thời:** `FOR UPDATE` trên từng dòng tồn theo thứ tự `variantId`. Hai phiếu cùng SKU xếp hàng, `balance_after` liên tiếp nhau.
- **Sai thứ tự sự kiện:** payload là số tuyệt đối. Bên nghe (#104) nên đọc lại `availableOf` khi nhận sự kiện, không cộng dồn theo payload. Ghi điều này vào §11.1.

### 5.9 Quan sát (bước 6)

Không thêm metric hay log mới. Lý do:
- Thẻ kho đã là vết đầy đủ: ai, lúc nào, chứng từ nào, số sau biến động.
- Lỗi đi ra HTTP qua middleware lỗi (5xx có log), RED của route bên gọi đã có (`http_request_duration_seconds`).
- Độ trễ sự kiện xem ở outbox.

### 5.10 Test

| File | Kiểm |
|---|---|
| `test/unit/modules/product/inventory/domain/stock.test.ts` | Tồn ≤ 0 thì giá vốn bằng giá nhập; `worsens`; `availableQty` không âm |
| `test/integration/product/inventory/posting.test.ts` | `receiveGoods`: tồn, chờ xử lý, giá vốn, thẻ kho, outbox; tồn âm được nhập bù thì tắt `invariant_broken`; giảm vỡ bất biến bị từ chối (gọi thẳng `applyMoves`); hai giao dịch song song cùng SKU (`raceBehindLock`) |
| `test/integration/product/inventory/port.test.ts` | `availableOf`, `stockOf` theo Q3; năm hàm tạm ném 501; `nextDocNumber` tăng theo `docType` và theo công ty |

## 6. Thứ tự giao

Một PR `feature/111-cong-ton` vào `develop`, làm trước #108 và #109. Merge xong thì báo Thành (chữ ký cổng) và người làm #104 (`availableOf`, `stock_changed`).

## 7. Ảnh hưởng tới FE

Không có API mới, không đổi hợp đồng.

## 8. Ảnh hưởng tới Documents

- `Documents/21` §11.1: chuyển trạng thái từ "chờ Khang xác nhận" sang "chốt chữ ký, bản tạm ở #111"; ghi kiểu trả `{ documentId, number }`; thêm câu "bên nghe đọc lại `availableOf`".
- `Documents/21` §11: thêm ba hàm dùng trong `product` (`receiveGoods`, `stockOf`, `nextDocNumber`).

## 9. Acceptance criteria

1. SKU đang có tồn 10, giá vốn 80.000. `receiveGoods` 5 cái đạt giá 100.000 → `on_hand` 15, `avg_cost` 86.666,67; thẻ kho có một dòng `on_hand` +5, `balance_after` 15, `unit_cost` 100.000, nguồn `goods_receipt`; outbox có một `stock_changed` với `{ onHand: 15, reserved: 0, available: 15 }`.
2. 2 cái lỗi → `quarantine` +2, giá vốn không đổi, thẻ kho có dòng `quarantine`. Phiếu chỉ có hàng lỗi thì không phát `stock_changed`.
3. SKU đang `on_hand = −3` và `invariant_broken`, nhập 5 cái giá 50.000 → `on_hand` 2, `avg_cost` 50.000, `invariant_broken` false.
4. Gọi lõi giảm `on_hand` xuống dưới 0 → `InsufficientStock`, DB không đổi gì.
5. `availableOf([a, b, x, 'abc'])`, trong đó a chưa có dòng tồn, b có tồn 7 và đang giữ 2, x thuộc công ty khác → `{ a: 0, b: 5 }`.
6. Hai `receiveGoods` song song cùng SKU → tồn cuối bằng tổng hai lần nhập, hai dòng thẻ kho có `balance_after` liên tiếp.
7. Năm hàm cổng tạm ném 501 `not_implemented`.
8. `nextDocNumber('purchase_request')` trả 1, 2, 3 trong một công ty; công ty khác bắt đầu lại từ 1.
9. `npm run check` xanh, depcruise không báo vi phạm.

## 10. Rủi ro và điểm còn mở

- `availableOf` gọi `getVariants`, câu này nạp cả thuộc tính. Nếu #104 gọi với hàng nghìn id thì đổi sang truy vấn chỉ lấy id. Đánh dấu `shortcut:` trong code.
- Tạm khoá bằng 0 tới khi có B3, nên khả dụng có thể cao hơn thực tế khi đã có phiếu kho chờ duyệt. Hiện chưa có phiếu kho nên chưa xảy ra.
- FE gọi ngăn là `StockArea = 'stock' | 'quarantine'`, BE trả `area: 'on_hand'`. Lệch này có từ trước, sửa ở phần sau của #111 cùng các nhãn của §15.1.
- `events.ts` còn `inventory.receipt_posted`, `inventory.issue_posted` của mô hình cũ. Đề xuất dọn ở PR sự kiện của #108, vì cùng sửa file đó.
