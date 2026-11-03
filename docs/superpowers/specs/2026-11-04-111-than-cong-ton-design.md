# Spec: Thân năm hàm cổng tồn theo kiện (#111, phần 2)

- **Ngày:** 04/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#111 (comment của Thành ngày 30/10/2026), `Documents/21` §11.1 (bản sửa ở Documents#61), §15, `Documents/25` §7, §8.3, §8.4, §9
- **Trạng thái:** nháp, chờ Khang duyệt
- **Phạm vi:** thân `reserve`, `release`, `ship`, `reverseShipment`, `receiveBack`, gỡ chặn cho #106, #107 (Thành). Tiếp nối spec phần 1 (`2026-10-28-111-cong-ton-ghi-so-design.md`); quyết định Q1–Q9 ở đó giữ nguyên, trừ Q6 (thay bằng Q11) và Q7 (mở rộng ở Q13)

Spec này vẫn là **thư viện nội bộ của `inventory`**, không có endpoint HTTP mới. Fulfillment gọi năm hàm trong giao dịch của mình.

---

## 1. Mục tiêu và tiêu chí thành công

1. Năm hàm cổng chạy thật theo chữ ký `Documents/21` §11.1, không còn trả 501. Thành nối #106, #107 vào `product/index.ts`.
2. Số đang giữ, tồn thực, giá vốn bình quân đúng khi worker kéo đơn và người dùng thao tác kiện cùng lúc trên một SKU.
3. Vẫn chỉ có **một lõi** ghi `stock_levels` (Q1, Q10).

Đo bằng: acceptance criteria ở mục 9 đều qua, `npm run check` xanh, integration test chạy trên PostgreSQL thật.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (4af073d, đã kiểm):**
- `service/port.ts` có `availableOf`, `stockOf` bản thật; năm hàm cổng ném `notImplemented` (501).
- Lõi `applyMoves` (`service/posting.ts`) đổi tồn thực và chờ xử lý, ghi thẻ kho, phát `stock_changed` khi tồn thực đổi. Chưa đổi được đang giữ, chưa có tham số cho bàn giao bắt buộc. Bất biến kiểm theo Q6: chặn khi tồn thực giảm mà kết quả vỡ.
- Bảng `stock_documents`, `stock_document_lines` đã có (CHECK `stock_documents_shipment_source`, `stock_documents_posted`, `approvalCheck`) nhưng **chưa có code nào ghi**. `stock_document_lines` chưa có `source_line_id`; `stock_documents` chưa có `order_id`, `shop_id`.
- Fulfillment gọi `reserve`, `release` qua `order/fulfillment/service/stock-port.ts` (bản giả: luôn "chưa giữ được"). `package_lines` có `reserved_qty` (0 hoặc đủ), `unit_cost`, `stock_deducted`, CHECK `package_lines_deducted_cost`.
- Hàm ghép số phiếu `docNumber(prefix, n)` nằm ở `purchasing/domain/request.ts`; inventory không import được purchasing (purchasing import inventory).

**Ràng buộc:**
- `inventory` ở lớp 2, không đọc được `order` (lớp 3). Mọi thông tin về kiện do bên gọi truyền vào; inventory không có bảng giữ hàng riêng (§11.1).
- Chạy trong giao dịch và ngữ cảnh công ty của bên gọi (`getDb()`, `requireCompanyId`).
- Chống gọi lặp do fulfillment giữ bằng cập nhật có điều kiện trên `package_lines` (§11.1, chốt 30/10). Inventory chỉ cộng trừ đúng các dòng được truyền.
- Thẻ kho chỉ thêm. Đang giữ không ghi thẻ kho.

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| Q10 | Lõi `applyMoves` mở rộng thành `applyChange`: một lõi cho mọi lần ghi `stock_levels`, kể cả đang giữ. `applyMoves`, `receiveGoods` giữ chữ ký, gọi qua lõi mới | Một chỗ khoá, kiểm bất biến, tăng `version`, phát sự kiện. `ship` đổi cả tồn thực và đang giữ trong một lần ghi. Tách lõi riêng cho đang giữ thì một lần `ship` tăng `version` hai lần, phát hai sự kiện, và bất biến `đang giữ ≤ tồn thực` phải kiểm sau cả hai lõi |
| Q11 | "Không làm tệ hơn" đo bằng **phần hụt** `đang giữ − tồn thực`: chặn khi sau khi ghi bất biến vỡ **và** phần hụt tăng. Thay Q6 | Q6 chặn nhầm bàn giao bình thường khi SKU đang Tồn âm (tồn 3, giữ 5; kiện đã giữ 2 bàn giao → tồn 1, giữ 3: tồn giảm, vẫn vỡ, nhưng hàng đã nằm trong kiện). Đo phần hụt: bàn giao đủ phần đã giữ và đảo bàn giao không đổi hụt; kiểm kê giảm, xuất huỷ, bàn giao phần chưa giữ làm hụt tăng; nhập hàng làm hụt giảm. `receiveGoods` chạy như cũ |
| Q12 | `receiveBack` tính giá vốn hàng trả **lúc lập phiếu**, ghi vào `unit_cost` của dòng phiếu kiểm hàng hoàn. `unit_cost = null` nghĩa là ghi sổ theo giá vốn bình quân lúc đó | Giá trên dòng phiếu xuất không đổi về sau, và kiện hoàn hay đã giao không còn đảo bàn giao được (đảo chỉ khi `in_transit` do kho quét, hàng còn ở kho; `25` §8.3), nên tính lúc lập và lúc ghi sổ (#112) ra cùng số. Không phải lưu danh sách `packageLineIds`, không cần cột "nguồn giá" |
| Q13 | Phát `inventory.stock_changed` cho mỗi SKU có tồn thực **hoặc** đang giữ đổi, một lần mỗi lần gọi lõi. Payload giữ nguyên | Khả dụng đổi khi giữ, nhả. Không phát thì: SKU bán ở hai gian hàng, kiện gian A giữ hàng mà gian B không được cập nhật tồn lên sàn; kiện huỷ nhả hàng mà fulfillment không biết để chia cho kiện Thiếu hàng (`25` §7.4). Sửa câu "Chiều ngược" ở §11.1 |
| Q14 | `forced` chỉ bỏ bước kiểm Q11. `invariant_broken` luôn bằng "bất biến đang vỡ" sau khi ghi, kể cả khi `forced` | Khớp định nghĩa nhãn Tồn âm ở §15.1 và cách lõi tính cờ hiện nay. Việc nhắc kiểm kê sau bàn giao bắt buộc là cờ Cần xử lý của kiện (`25` §8.4) và việc cần làm (#179), không phải cờ tồn |
| Q15 | `ship` khoá dòng tồn **trước** để đọc giá vốn bình quân, lập phiếu, rồi mới gọi `applyChange` (khoá lại trong cùng giao dịch, không tốn thêm) | Giá không đổi được giữa lúc đọc và lúc trừ. Lõi không phải nhận callback dựng move |
| Q16 | Ba loại phiếu do hệ thống lập, mỗi loại một bộ đếm trong `doc_counters`: `shipment` → `XK-000001`, `shipment_reversal` → `DX-000001`, `return_inspection` → `KT-000001`. Inventory có `docNumber` riêng ở `domain/` (một dòng, chép của purchasing) | Inventory không import được purchasing. `KH-` đã dùng cho mã kiện |

## 4. Phạm vi

**Trong spec:** migration `0016`; lõi `applyChange`; `worsens` theo Q11; thân năm hàm cổng; sửa kiểu export trong `inventory/index.ts` theo §11.1 mới; cập nhật `inventory/CLAUDE.md`; sửa Documents#61 theo Q12–Q14.

**Ngoài spec:** lấy lại phần giữ khi tồn thực tụt dưới đang giữ (fulfillment chọn kiện, cần chốt thêm với Thành); số đang thiếu và các nhãn §15.1; gợi ý nhập lại; tạm khoá thật (B3, `lockedOf` vẫn bằng 0); kiểm đếm và ghi sổ phiếu kiểm hàng hoàn, phát `inventory.return_inspected` (#112); phía fulfillment (#106): cập nhật có điều kiện, job đối soát.

## 5. Thiết kế

### 5.1 Phân loại và tải (bước 1)

Thư viện đồng bộ trong giao dịch của bên gọi. Hai nguồn gọi chạy song song và có thể cùng đụng một SKU:
- worker: việc `channel.order_pull` kéo đơn, lập kiện, gọi `reserve`, `release`;
- api: kho quét bàn giao, CEO duyệt huỷ bàn giao nhầm (#106), gọi `ship`, `reverseShipment`.

Tải nhỏ: vài trăm kiện mỗi ngày, mỗi kiện dưới 10 dòng. Không cần cache, không cần hàng đợi riêng.

### 5.2 Bố cục file

```
product/inventory/
├─ index.ts                    sửa kiểu export: ShipLine, ShipResult, ReversalLine, ReturnLine, ReturnSource
├─ domain/stock.ts             worsens theo phần hụt (Q11); returnUnitCost() (bình quân gia quyền giá hàng trả)
├─ domain/documents.ts         mới: DOC_PREFIX theo loại phiếu, docNumber(prefix, n)
├─ repository/levels.ts        saveLevel nhận thêm reserved
├─ repository/documents.ts     mới: insertDocument, insertDocumentLines, shipmentLinesOf(packageLineIds)
├─ repository/schema.ts        cột mới (5.3)
├─ service/posting.ts          lockLevels (riêng), applyChange (riêng), applyMoves và receiveGoods gọi qua nó
└─ service/port.ts             thân năm hàm; availableOf, stockOf, nextDocNumber giữ nguyên
```

`service/port.ts` dài thêm khoảng 200 dòng. Nếu quá 300 dòng thì tách `service/shipment.ts` (ship, reverseShipment) và `service/returns.ts` (receiveBack), `port.ts` chỉ re-export.

### 5.3 Dữ liệu (bước 2)

Migration `0016` do `npm run db:generate -- --name than-cong-ton` sinh:

| Thay đổi | Lý do | Ràng buộc |
|---|---|---|
| `stock_document_lines.source_line_id uuid` (được trống) | Dòng kiện (`"order".package_lines.id`) của dòng phiếu `shipment`, `shipment_reversal`; dòng phiếu `return_inspection` khi chỉ có một dòng kiện | Không FK (khác module lớn). Index `stock_document_lines_source_line_idx (source_line_id) WHERE source_line_id IS NOT NULL` |
| `stock_documents.order_id uuid`, `shop_id uuid` (được trống) | Phiếu kiểm hàng hoàn cần hai id này để #112 phát `inventory.return_inspected` | Không FK. CHECK `stock_documents_return_order`: `kind <> 'return_inspection' OR source_type NOT IN ('package', 'return_request') OR (order_id IS NOT NULL AND shop_id IS NOT NULL)` |

**Không đổi:** enum `stock_source_type` (thẻ kho của phiếu xuất dùng `stock_document`); RLS (không có bảng mới, policy `company_isolation` đã phủ hai bảng).

**An toàn migration:** hai bảng chưa có dòng nào, nên thêm cột được trống, CHECK, index là tức thì, không cần `NOT VALID` hay `CONCURRENTLY`. Huỷ được: drop ba cột cùng CHECK, index. Nhánh khác merge migration trước thì xoá `0016` của nhánh này và sinh lại (`db/CLAUDE.md`).

**Phiếu do hệ thống lập:**

| Loại | Trạng thái khi lập | Cột | Dòng |
|---|---|---|---|
| `shipment` | `posted` | `source_type = 'package'`, `source_id = packageId`, `created_by = posted_by = actorId`, `posted_at = now()`, `note = reason` khi `forced` | `variant_id`, `quantity`, `unit_cost` (bình quân lúc khoá), `source_line_id = packageLineId` |
| `shipment_reversal` | `posted` | như trên, `note = reason` | `unit_cost` = giá dòng xuất được đảo, `source_line_id = packageLineId` |
| `return_inspection` | `draft` | `source_type`, `source_id` theo `source`; `order_id`, `shop_id`; `created_by` trống (hệ thống) | `variant_id`, `expected_qty`, `unit_cost` (Q12, có thể trống), `source_line_id` khi `packageLineIds` có đúng một phần tử |

Mỗi phiếu ghi `recordTransition({ entityType: 'stock_documents', from: null, to, action: 'create', actorId })`, như phiếu nhận ở #109.

**Bất biến:**

| Bất biến | Ai giữ |
|---|---|
| `reserved ≥ 0`, `quarantine ≥ 0` | CHECK đã có; lõi kiểm trước để báo lỗi rõ |
| `on_hand ≥ 0` và `reserved ≤ on_hand`, trừ khi `invariant_broken` | CHECK `stock_levels_invariant`; lõi theo Q11, Q14 |
| Phiếu `shipment`, `shipment_reversal` có `source_type = 'package'`; phiếu `posted` có `posted_at` | CHECK đã có |
| Phiếu kiểm hàng hoàn từ kiện hoặc yêu cầu trả có `order_id`, `shop_id` | CHECK mới |
| Dòng phiếu xuất và phiếu đảo có `source_line_id`, `unit_cost` | Service (CHECK không với tới loại phiếu ở bảng cha) |
| Dòng xuất của một dòng kiện bị đảo nhiều nhất một lần | Service (`reverseShipment` kiểm số dòng xuất > số dòng đảo) cộng chống lặp của fulfillment |

Kiểu export (theo §11.1):

```ts
interface StockLine { variantId: string; quantity: number }                                  // reserve, release
interface ShipLine { packageLineId: string; variantId: string; quantity: number; reserved?: number }
interface ShipResult { documentId: string; number: string; lines: { packageLineId: string; variantId: string; quantity: number; unitCost: string }[] }
interface ReversalLine { packageLineId: string; variantId: string; quantity: number }
interface ReturnSource { type: 'package' | 'return_request'; id: string; orderId: string; shopId: string }
interface ReturnLine { variantId: string; quantity: number; packageLineIds: readonly string[] }
```

### 5.4 Lõi `applyChange`

```ts
interface StockChange {
  source: { type: StockSourceType; id: string } | null; // null khi chỉ đổi đang giữ (không có move)
  moves: readonly Move[];
  reserved?: ReadonlyMap<string, number>; // delta đang giữ theo variantId
  forced?: boolean;
  actorId: string | null;
}
applyChange(change: StockChange, precheck?: (locked: ReadonlyMap<string, LevelRow>) => boolean): Promise<boolean>
```

1. `companyOfTransaction()`. Bỏ move có `qty = 0` và delta bằng 0; không còn gì thì trả `true`. Có move mà `source` trống là lỗi lập trình.
2. `lockLevels(SKU của move và delta)`: sắp tăng dần, `getVariants` (SKU không thuộc công ty thì `Error`, 500), rồi `lockLevel` từng SKU (Q8). `lockLevel` tạo dòng tồn 0 khi chưa có, nên luôn phải kiểm `getVariants` trước (A17); `ship`, `reverseShipment` khoá trước lõi cũng đi qua hàm này, không gọi thẳng `lockLevel`.
3. `precheck` trả `false` thì trả `false`, không ghi gì.
4. Tính số mới: move như `applyMoves` hiện nay (giá vốn chỉ tính lại với move `on_hand` dương có giá; tồn trước ≤ 0 thì giá vốn = giá lần nhập, Q5); cộng delta vào `reserved`.
5. Kiểm từng SKU, theo thứ tự:
   - `reserved < 0`: `Error` "nhả quá số đang giữ" kèm SKU (500);
   - `quarantine < 0`: `InsufficientStock`;
   - không `forced` và `worsens(trước, sau)`: `InsufficientStock`.
6. `saveLevel` (`on_hand`, `reserved`, `quarantine`, `avg_cost`, `invariant_broken = breaksInvariant(sau)`, `version + 1`), `insertMoves`.
7. Với mỗi SKU có `on_hand` hoặc `reserved` đổi, theo thứ tự `variantId`: `publishEvent('inventory.stock_changed', { variantId, onHand, reserved, available })`, số sau khi ghi (Q13).
8. Trả `true`.

`worsens` (Q11):

```ts
worsens(before, after) = breaksInvariant(after.onHand, after.reserved)
                      && after.reserved - after.onHand > before.reserved - before.onHand
```

`applyMoves(source, moves, actorId)` = `applyChange({ source, moves, actorId })`, bỏ qua kết quả.

### 5.5 Năm hàm cổng

| Hàm | Các bước |
|---|---|
| `reserve(packageId, lines: StockLine[])` → `{ reserved }` | Kiểm `quantity` nguyên dương. Gộp số lượng theo SKU. `applyChange({ source: null, moves: [], reserved: +q, actorId: null }, precheck)`, với `precheck`: mọi SKU có `availableQty(onHand, reserved, lockedOf) ≥ q`. Trả `{ reserved: kết quả }`. `lines` rỗng thì `{ reserved: true }` |
| `release(packageId, lines: StockLine[])` | Gộp theo SKU, `applyChange({ reserved: −q })`. `lines` rỗng thì không làm gì |
| `ship(packageId, lines: ShipLine[], { actorId, forced?, reason? })` → `ShipResult` | 1) Kiểm: `lines` không rỗng, `quantity` nguyên dương, `reserved ∈ {0, quantity}` (mặc định `quantity`); `forced` thì `reason` sau khi trim khác rỗng, ≤ 500 ký tự. 2) `lockLevels` các SKU, đọc `avgCost` (Q15). 3) `nextDocNumber('shipment')`, lập phiếu `XK` `posted` và dòng phiếu. 4) `applyChange({ source: stock_document, moves: on_hand −quantity, unitCost = avgCost, sourceLineId = id dòng phiếu; reserved: −reserved; forced; actorId })`. `InsufficientStock` đổi thành 422 `stock_insufficient`, `errors["lines.<i>.quantity"]` cho mọi dòng thuộc SKU thiếu. 5) `recordTransition`. 6) Trả phiếu và `lines[].unitCost` (chuỗi 2 chữ số) |
| `reverseShipment(packageId, lines: ReversalLine[], { actorId, reason })` → `{ documentId, number }` | 1) Kiểm như `ship`; `reason` bắt buộc. 2) `shipmentLinesOf(packageLineIds)`: với mỗi dòng kiện, dòng xuất mới nhất của phiếu `shipment` có `source_id = packageId`, và số dòng xuất > số dòng đảo của dòng kiện đó. Không có, hoặc `quantity` khác số đã xuất: `Error` (500). 3) `lockLevels` các SKU. 4) Lập phiếu `DX` `posted`, dòng phiếu giá = giá dòng xuất. 5) `applyChange({ moves: on_hand +quantity theo giá đó; reserved: +quantity; actorId })`: giá vốn bình quân tính lại với giá xuất cũ. 6) `recordTransition` |
| `receiveBack(source: ReturnSource, lines: ReturnLine[])` → `{ documentId, number }` | 1) Kiểm `quantity` nguyên dương, `lines` không rỗng. 2) `shipmentLinesOf(tất cả packageLineIds)` (dòng xuất chưa đảo). 3) Mỗi dòng: `returnUnitCost(các dòng xuất của packageLineIds)` = Σ(số lượng × giá) / Σ số lượng, làm tròn nửa lên 2 chữ số; không có dòng xuất thì `null`. 4) `nextDocNumber('return_inspection')`, lập phiếu `KT` `draft` với `order_id`, `shop_id`, dòng `expected_qty = quantity`. 5) `recordTransition` (`actorId: null`). Không đổi tồn, không phát sự kiện |

Thứ tự khoá trong một giao dịch: dòng tồn (theo `variantId`) trước, dòng đếm `doc_counters` sau cùng.

### 5.6 Lỗi và bảo mật (bước 3)

| Tình huống | Hàm | Xử lý |
|---|---|---|
| Gọi ngoài `withCompany` | tất cả | `requireCompanyId` ném lỗi lập trình (500); không chạy dưới role chủ bảng |
| SKU không thuộc công ty; `quantity` không nguyên dương; `reserved ∉ {0, quantity}`; `lines` rỗng ở `ship`, `reverseShipment`, `receiveBack` | tất cả | `Error` (500): vi phạm hợp đồng giữa module |
| Không đủ khả dụng | `reserve` | `{ reserved: false }`, không ghi gì |
| Nhả quá số đang giữ | `release` | `Error` (500), message có `packageId`, SKU. Dấu hiệu hai bên lệch sổ |
| Không `forced` mà làm tệ hơn | `ship` | 422 `stock_insufficient` kèm `errors` theo dòng (§15.4); giao dịch rollback cả phiếu và số phiếu |
| Thiếu `reason`, rỗng hoặc > 500 ký tự | `ship` (`forced`), `reverseShipment` | 422 `validation_failed`, `errors.reason` |
| Không có dòng xuất chưa đảo | `reverseShipment` | `Error` (500) |
| Không có dòng xuất nào | `receiveBack` | Không lỗi: `unit_cost = null` (đơn trước mốc bắt đầu lấy đơn) |
| CHECK của DB chặn | tất cả | 500, là bug của lõi; giao dịch rollback |
| Ghi outbox lỗi | tất cả | Cùng giao dịch, rollback |
| Deadlock | tất cả | Tránh bằng thứ tự khoá ở 5.5; nếu vẫn xảy ra thì 500, bên gọi chạy lại |

Bảo mật: không có đường mới từ ngoài vào; tách công ty bằng RLS và ngữ cảnh của bên gọi. Cổng không nhận giá, nên bên gọi không đẩy được giá vốn tuỳ ý. `reason` là chữ người dùng nhập: giới hạn 500 ký tự, lưu nguyên văn, FE escape khi hiển thị. `actorId` ghi lên phiếu và thẻ kho để truy vết.

### 5.7 Phân quyền (bước 4)

Không có route mới. Quyền do route của bên gọi kiểm: kho quét bàn giao và CEO duyệt huỷ bàn giao nhầm qua máy trạng thái kiện ở #106. Inventory không kiểm quyền, chỉ chạy được trong ngữ cảnh công ty.

### 5.8 Chống trùng và chạy đồng thời (bước 5)

- **Gọi lặp:** inventory không tự chống (§11.1). Fulfillment gọi cổng sau `UPDATE package_lines … WHERE reserved_qty = 0` (giữ) / `WHERE stock_deducted = false` (bàn giao) / ngược lại (nhả, đảo), đổi được dòng nào mới truyền dòng đó, trong cùng giao dịch. Thiếu chốt này thì `ship` hai lần trừ tồn hai lần; job đối soát `reserved_qty` với `stock_levels.reserved` (Thành) bắt lệch đang giữ, kiểm kê bắt lệch tồn thực. `reverseShipment` có thêm lưới: dòng xuất đã đảo thì 500.
- **Đồng thời:** `FOR UPDATE` từng dòng tồn theo `variantId` tăng dần. Hai `reserve` tranh món cuối: giao dịch sau chờ, đọc lại thấy khả dụng 0, trả `false`.
- **Bộ đếm số phiếu:** khoá sau cùng, nên mọi `ship` trong một công ty xếp hàng ở dòng đếm tới khi commit. Chấp nhận ở tải hiện tại.
- **Sai thứ tự sự kiện:** payload là số tuyệt đối; bên nghe đọc lại `availableOf`.

### 5.9 Quan sát (bước 6)

Không thêm metric hay log mới:
- Thẻ kho và phiếu `XK`, `DX`, `KT` cùng `state_transitions` là vết đầy đủ: ai, lúc nào, chứng từ nào, số dư sau biến động. Bàn giao bắt buộc tra bằng phiếu `XK` có `note`.
- Lỗi 500 có log ở middleware HTTP; lỗi trong việc nền `order_pull` hiện ở API việc lỗi (§14.5).
- Độ trễ sự kiện xem ở outbox.

### 5.10 Test

| File | Kiểm |
|---|---|
| `test/unit/modules/product/inventory/domain/stock.test.ts` | `worsens` theo phần hụt: bàn giao đủ phần giữ khi đang vỡ thì qua, giảm làm hụt tăng thì chặn, nhập luôn qua; `returnUnitCost`: một dòng, nhiều dòng, làm tròn, rỗng |
| `test/unit/modules/product/inventory/domain/documents.test.ts` | `docNumber` ghép tiền tố, đệm 6 chữ số |
| `test/integration/product/inventory/reservation.test.ts` | AC 1, 2, 3, 10a |
| `test/integration/product/inventory/shipment.test.ts` | AC 4–8, 10b |
| `test/integration/product/inventory/return.test.ts` | AC 9 |
| `test/integration/product/inventory/port.test.ts` | Bỏ test năm hàm trả 501 |
| `test/integration/product/inventory/posting.test.ts` | Test cũ của `receiveGoods`, `applyMoves` vẫn xanh (AC 11) |
| `test/integration/product/inventory/constraints.test.ts` | CHECK `stock_documents_return_order` |

Id dòng kiện trong test là `randomUUID()`: inventory không đọc bảng `order`. Tạo biến thể bằng `createVariant`, đua bằng `raceBehindLock` (`test/integration/helpers/`).

## 6. Thứ tự giao

1. Sửa Documents#61 theo Q12, Q13, Q14 và cột mới ở `19` (mục 8). Merge trước hoặc cùng lúc PR backend.
2. Một PR `feature/111-than-cong-ton` vào `main`: spec này, migration `0016`, lõi, năm hàm, test, `inventory/CLAUDE.md`.
3. Merge xong thì báo Thành: #106 trỏ `stock-port.ts` sang `product/index.ts`, thêm cập nhật có điều kiện trên `package_lines`, job đối soát.

## 7. Ảnh hưởng tới FE

Không có API mới, không đổi hợp đồng HTTP. Thẻ kho hiện thêm dòng nguồn `stock_document` cho phiếu `XK`, `DX`; kiểu `document.type` đã có giá trị này.

## 8. Ảnh hưởng tới Documents

- `21` §11.1 (Documents#61):
  - câu "Chiều ngược": phát `stock_changed` khi tồn thực hoặc đang giữ đổi (Q13);
  - `ship` `forced`: bỏ "bật `invariant_broken`", thay bằng "được vỡ bất biến; cờ Tồn âm bật khi bất biến thật sự vỡ" (Q14);
  - `receiveBack`: giá tính lúc lập phiếu, ghi vào `unit_cost` của dòng phiếu, `null` là lấy giá bình quân lúc ghi sổ (Q12).
- `19`: `stock_documents` thêm `order_id`, `shop_id` và CHECK; `stock_document_lines.source_line_id` thêm index.

## 9. Acceptance criteria

Giá trị tiền là `numeric(18,2)`.

1. **Giữ nguyên kiện:** A tồn 5, B tồn 1. `reserve(k1, [A×3, B×2])` → `{ reserved: false }`; `stock_levels` không đổi, outbox không có sự kiện. Nhập thêm 1 B rồi gọi lại → `{ reserved: true }`; A đang giữ 3, B đang giữ 2; outbox có hai `stock_changed` (A: `available` 2; B: `available` 0).
2. **Gộp dòng cùng SKU:** A tồn 4. `reserve(k2, [A×2, A×3])` → `false`.
3. **Nhả:** sau AC 1, `release(k1, [A×3, B×2])` → đang giữ về 0, hai `stock_changed`. `release` thêm A×1 → lỗi, DB không đổi.
4. **Bàn giao:** A tồn 10, đang giữ 3, giá vốn 80.000. `ship(k3, [{ packageLineId: p1, A, 3, reserved 3 }], { actorId })` → tồn 7, đang giữ 0; phiếu `XK-000001` `posted`, dòng phiếu `unit_cost` 80.000, `source_line_id = p1`; thẻ kho −3, `balance_after` 7, nguồn `stock_document`; trả `lines: [{ packageLineId: p1, unitCost: '80000.00', … }]`; một `stock_changed`.
5. **Q11:** A tồn 3, đang giữ 5, `invariant_broken`. `ship` 2 với `reserved` 2 → qua; tồn 1, đang giữ 3, `invariant_broken` vẫn true.
6. **422:** A tồn 2, đang giữ 2. `ship` 1 với `reserved: 0`, không `forced` → 422 `stock_insufficient`, `errors["lines.0.quantity"]`; không có phiếu, `stock_levels` và `doc_counters` không đổi.
7. **Bàn giao bắt buộc:** A tồn 1, đang giữ 0. `ship` 3, `reserved: 0`, `forced`, `reason: 'Sàn báo đã lấy hàng'` → tồn −2, `invariant_broken` true, phiếu có `note`. A tồn 5: `ship` 3 `forced` → tồn 2, `invariant_broken` false. `forced` thiếu `reason` → 422 `validation_failed`.
8. **Đảo bàn giao:** sau AC 4, `receiveGoods` 10 cái giá 100.000 → giá vốn 91.764,71 (tồn 17). `reverseShipment(k3, [{ p1, A, 3 }], { actorId, reason })` → tồn 20, đang giữ 3, giá vốn **90.000,00**, phiếu `DX-000001`, dòng phiếu giá 80.000. Gọi lại cho `p1` → lỗi. `ship` lại `p1` (giá vốn lúc này 90.000) rồi đảo lần nữa → lần này đảo theo 90.000.
9. **Hàng trả:**
   - dòng đơn chia hai kiện: `p2` xuất 1 cái giá 80.000, `p3` xuất 3 cái giá 100.000. `receiveBack({ type: 'return_request', id, orderId, shopId }, [{ A, 2, packageLineIds: [p2, p3] }])` → phiếu `KT-000001` `draft`, `order_id`, `shop_id` đúng, dòng `expected_qty` 2, `unit_cost` 95.000,00, `source_line_id` trống; `stock_levels` không đổi, không có sự kiện;
   - `packageLineIds: [p4]` với `p4` chưa từng xuất → `unit_cost` trống; `[p2]` → `unit_cost` 80.000, `source_line_id = p2`;
   - dòng kiện đã xuất rồi đảo rồi xuất lại ở giá khác → lấy giá lần xuất sau.
10. **Đồng thời:**
    - (a) A tồn 1. Hai `reserve` mỗi kiện A×1 chạy song song (`raceBehindLock`) → đúng một `true`; đang giữ 1;
    - (b) A tồn 5, đang giữ 2. `reserve` A×3 và `ship` A×2 (`reserved` 2) song song → cả hai qua, tồn 3, đang giữ 3, không deadlock.
11. Test cũ của `receiveGoods`, `availableOf`, `stockOf`, `nextDocNumber` vẫn xanh. `npm run check` xanh, depcruise không báo vi phạm.

## 10. Rủi ro và điểm còn mở

- Fulfillment quên chốt cập nhật có điều kiện thì trừ tồn hai lần. Ghi rõ ở §11.1 và trong PR báo Thành; job đối soát chỉ bắt được lệch đang giữ.
- `reverseShipment` đảo nguyên dòng. Đảo một phần dòng kiện chưa có nhu cầu (`25` §8.3 đảo cả kiện).
- `lockedOf` vẫn bằng 0 tới B3, nên `reserve` có thể giữ phần đang tạm khoá cho phiếu kho chờ duyệt. Hiện chưa có phiếu kho chờ duyệt nên chưa xảy ra.
- Bộ đếm số phiếu khoá tới khi commit làm các `ship` trong một công ty xếp hàng. Nếu thành nút thắt thì cấp số bằng sequence riêng (chấp nhận nhảy số).
- Lấy lại phần giữ (`25` §7.4) chưa làm: sau bàn giao bắt buộc, kiện khác vẫn giữ phần hàng không còn. Cờ Tồn âm hiện trên SKU tới khi kiểm kê hoặc hàng về.
