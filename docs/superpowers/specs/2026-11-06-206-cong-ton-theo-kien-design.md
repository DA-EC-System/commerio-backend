# Spec: Cổng tồn theo kiện, bản giả và thân năm hàm (#206, phần cổng)

- **Ngày:** 06/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#206 (cập nhật 05/11/2026), `Documents/21` §11.1 (chữ ký chốt 29/10/2026, câu `stock_changed` chốt 04/11/2026), `Documents/25` §7, §8.3, §8.4
- **Trạng thái:** nháp, chờ Khang duyệt
- **Phạm vi:** phần cổng của #206: bản giả trước, rồi thân `reserve`, `release`, `ship`, `reverseShipment`, `receiveBack`. Gỡ chặn cho #199, #237, #238, #239 (Khang) và #202 (Bình). Tiếp nối spec phần 1 (`2026-10-28-111-cong-ton-ghi-so-design.md`): Q1–Q9 ở đó giữ nguyên, trừ Q6 (thay bằng Q14)
- **Thay cho:** `2026-11-04-111-than-cong-ton-design.md` (viết theo Documents#61; PR đó đóng, không merge ngày 05/11/2026)

Spec này vẫn là **thư viện nội bộ của `inventory`**, không có endpoint HTTP mới. Fulfillment và yêu cầu trả gọi năm hàm trong giao dịch của mình.

Phần còn lại của #206 viết spec riêng: (2) số liệu và API §15 (đang thiếu, `drift`, trường thẻ kho, lọc Tồn âm); (3) gợi ý nhập lại; (4) FE và E2E.

---

## 1. Mục tiêu và tiêu chí thành công

1. Có bản giả của năm hàm trả thành công (không ném 501), để #199 và #202 code ngay.
2. Năm hàm chạy thật theo chữ ký `Documents/21` §11.1, chỉ thêm `forced` cho `ship` (Q10). Khang trỏ `order/fulfillment/service/stock-port.ts` sang `product/index.ts` mà không phải đổi cách gọi.
3. Số đang giữ, tồn thực, giá vốn bình quân đúng khi worker kéo đơn và người dùng thao tác kiện cùng lúc trên một SKU.
4. Vẫn chỉ có **một lõi** ghi `stock_levels` (Q1, Q13).

Đo bằng: acceptance criteria ở mục 9 đều qua, `npm run check` xanh, integration test chạy trên PostgreSQL thật.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (3a3e405, đã kiểm 06/11/2026):**
- `service/port.ts` có `availableOf`, `stockOf`, `nextDocNumber` bản thật. Năm hàm cổng ném `notImplemented` (501) ở dòng 67–96. `test/integration/product/inventory/port.test.ts:35` kiểm 501.
- Lõi `applyMoves` (`service/posting.ts`) đổi tồn thực và chờ xử lý, ghi thẻ kho, phát `stock_changed` khi tồn thực đổi, gọi `recheckThresholds` (#255). Chưa đổi được đang giữ. `worsens` chặn khi tồn thực giảm mà kết quả vỡ bất biến (Q6).
- `posting.ts` và `thresholds.ts` import `lockedOf` từ `port.ts`.
- Bảng `stock_documents`, `stock_document_lines` đã có, gồm kind `shipment`, `shipment_reversal`, `return_inspection`, CHECK `stock_documents_shipment_source`, `stock_documents_posted`, index `(source_type, source_id)`. **Chưa có code nào ghi.**
- `order/fulfillment/service/stock-port.ts` có bản riêng "chưa giữ được" (`reserve` trả `false`). `package_lines` có `reserved_qty` (0 hoặc đủ, CHECK `package_lines_reserved_whole`), `unit_cost`, `stock_deducted` (CHECK `package_lines_deducted_cost`).
- Hàm ghép số phiếu `docNumber(prefix, n)` nằm ở `purchasing/domain/request.ts`. Inventory không import được purchasing (purchasing import inventory).

**Ràng buộc:**
- `inventory` ở lớp 2, không đọc được `order` (lớp 3). Mọi thông tin về kiện do bên gọi truyền vào. Inventory không có bảng giữ hàng riêng; đang giữ của từng kiện nằm ở `"order".package_lines.reserved_qty` (§11.1).
- Chạy trong giao dịch và ngữ cảnh công ty của bên gọi (`getDb()`, `requireCompanyId`).
- Thẻ kho chỉ thêm. Đang giữ không ghi thẻ kho.
- Luật `khong-vong-tron` của dependency-cruiser: không import vòng tròn giữa các file.
- Đổi chữ ký thì sửa `Documents/21` §11.1 trước (#206, mục Việc).

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| Q10 | Chữ ký theo §11.1 bản 29/10. Chỉ đổi `ship`: `opts` thành `{ actorId: string \| null; forced?: boolean }`. `forced: true` là bàn giao bắt buộc theo sàn: trừ đủ tồn thực, không trừ đang giữ, được vỡ bất biến | `25` §8.4 quy tắc 3. Giữ nguyên kiện nên kiện bàn giao bắt buộc không có phần đang giữ. Chữ ký 29/10 không báo được trường hợp này. Thêm trường tuỳ chọn thì bên gọi theo 29/10 không phải sửa. `actorId` trống khi sàn báo bàn giao (bên gọi ghi `actorId: null`, `source: 'marketplace'`) |
| Q11 | Chống gọi lặp `reserve`, `release` ở fulfillment: khoá kiện, đổi `reserved_qty` có điều kiện trong cùng giao dịch. Inventory cộng trừ đúng số được truyền | Một nguồn sự thật cho đang giữ (`package_lines.reserved_qty`). Sổ giữ hàng riêng ở inventory là hai nguồn phải luôn khớp, trái câu đầu §11.1 |
| Q12 | Chống gọi lặp `ship` chính ở fulfillment theo cờ `stock_deducted` (#199). Inventory thêm lưới: trong lượt đang xuất của kiện (Q17) có phiếu xuất cùng dòng thì trả phiếu đó, không trừ tồn | Ghi chú §11.1 "gọi lại cùng kiện trả phiếu cũ". So theo dòng chứ không theo kiện, vì một kiện có thể có hai phiếu xuất: phiếu lúc bàn giao bắt buộc và phiếu cho dòng ghép SKU sau (`25` §8.4 quy tắc 3) |
| Q13 | Lõi `applyMoves` mở rộng thành `applyChange`: một lõi cho mọi lần ghi `stock_levels`, kể cả đang giữ. `applyMoves`, `receiveGoods` giữ chữ ký, gọi qua lõi mới | Một chỗ khoá, kiểm bất biến, tăng `version`, phát sự kiện, xét ngưỡng. `ship` đổi tồn thực và đang giữ trong một lần ghi; tách hai lõi thì bất biến bị kiểm ở trạng thái nửa chừng (trừ tồn thực trước khi trừ đang giữ) |
| Q14 | "Không làm tệ hơn" đo bằng **phần hụt** `đang giữ − tồn thực`: chặn khi sau khi ghi bất biến vỡ **và** phần hụt tăng. `forced` chỉ bỏ bước kiểm này; `invariant_broken` luôn bằng "bất biến đang vỡ sau khi ghi". Thay Q6 | Q6 chặn nhầm bàn giao thường khi SKU đang Tồn âm (tồn 3, giữ 5; bàn giao 2 → tồn 1, giữ 3: tồn giảm, vẫn vỡ, nhưng hàng đã nằm trong kiện). Mọi ca Q6 chặn thì Q14 vẫn chặn |
| Q15 | `stock_changed` phát cho SKU có **tồn thực** đổi, một lần mỗi lần gọi lõi; `reserve`, `release` không phát. `recheckThresholds` chạy cho SKU có tồn thực **hoặc** đang giữ đổi | §11.1 chốt 04/11/2026: phát khi tồn thực hoặc tạm khoá đổi. Tạm khoá chưa có nguồn (`lockedOf` = 0 tới B3). #206: `reserve`, `release` gọi `recheckThresholds` vì số có thể bán đổi |
| Q16 | Giá vốn của dòng kiện: bên gọi đọc `stockOf(variantIds)` sau `ship`, trong cùng giao dịch, lấy `avgCost` | `ship` khoá dòng tồn tới khi commit, trừ tồn không đổi giá vốn bình quân, nên số đọc được đúng bằng giá ghi trên phiếu xuất. Không phải đổi kiểu trả của `ship` |
| Q17 | **Lượt đang xuất** của một kiện là các phiếu `shipment` của kiện lập sau phiếu `shipment_reversal` gần nhất của kiện đó. `reverseShipment` đảo trong lượt đang xuất; mỗi SKU đảo không quá số của lượt; giá đảo = bình quân giá của lượt. Đảo luôn cộng lại cả tồn thực lẫn đang giữ | `25` §8.3: đảo cả kiện, hàng còn ở kho, nên sau khi đảo hàng nằm trong kiện, đúng là đang giữ cho kiện, kể cả khi lần bàn giao trước là bắt buộc (phần hụt không đổi). Mỗi lượt bàn giao đảo một lần. Không cần cột đánh dấu phiếu xuất bắt buộc |
| Q18 | Ba loại phiếu do hệ thống lập, mỗi loại một bộ đếm trong `doc_counters`: `shipment` → `XK-000001`, `shipment_reversal` → `DX-000001`, `return_inspection` → `KT-000001`. Inventory có `docNumber` riêng ở `domain/documents.ts` | Inventory không import được purchasing. `KH-` đã dùng cho mã kiện, `KK-` cho kiểm kê, `PX-` cho phiếu xuất của mô hình cũ |
| Q19 | `receiveBack` lập phiếu kiểm hàng hoàn `draft`, `expected_qty = quantity`, `unit_cost` trống. Đã có phiếu kiểm hàng hoàn cùng nguồn thì trả phiếu đó | §11.1: tồn chưa đổi tới khi phiếu ghi sổ. Giá vốn hàng trả và `orderId`, `shopId` cho `inventory.return_inspected` thuộc #112, quyết lúc ghi sổ |
| Q20 | Không có migration | Chữ ký 29/10 không mang id dòng kiện, nên không cần `source_line_id` hay `order_id`, `shop_id` như spec cũ. Tra phiếu theo kiện dùng index `(source_type, source_id)` đã có |
| Q21 | `ship` không `forced` không trả 422 | Bàn giao thường trừ tồn thực và đang giữ cùng một số nên phần hụt không tăng, `worsens` không bao giờ đúng. Trừ đang giữ xuống âm nghĩa là kiện chưa giữ hàng: lỗi lập trình của bên gọi (500) |
| Q22 | Phiếu do hệ thống lập ghi `created_at = clock_timestamp()` | `now()` là giờ đầu giao dịch. Giao dịch bắt đầu trước mà chờ khoá rồi chèn sau sẽ có `created_at` nhỏ hơn phiếu đã chèn trước nó, làm sai thứ tự lượt (Q17). `clock_timestamp()` lấy giờ lúc chèn, sau khi đã khoá dòng tồn |
| Q23 | Bản giả làm trước, PR riêng, không chờ Documents | #206 mục "Làm trước"; #199 và #202 ghi "dùng bản giả trả thành công" |

## 4. Phạm vi

**Trong spec:** bản giả năm hàm; sửa `Documents/21` §11.1 theo Q10, Q11, Q12, Q16, Q17; lõi `applyChange`; `worsens` theo Q14; thân năm hàm; chuyển `lockedOf` sang file riêng; cập nhật `inventory/CLAUDE.md`.

**Ngoài spec:**
- Fulfillment (#199, #238): khoá kiện và đổi `reserved_qty`, `stock_deducted` có điều kiện; chia hàng và lấy lại phần giữ (`25` §7.4); job đối soát `reserved_qty` với `stock_levels.reserved`; bật cờ Cần xử lý và việc kiểm kê sau bàn giao bắt buộc.
- #112: kiểm đếm và ghi sổ phiếu kiểm hàng hoàn, giá vốn hàng trả, phát `inventory.return_inspected`.
- B3: tạm khoá thật (`lockedOf` vẫn bằng 0), phiếu kho có duyệt.
- Spec số liệu §15: đang thiếu, `drift`, `onHandAfter`, `document.number`, `kind` trên thẻ kho, lọc Tồn âm. Gợi ý nhập lại. FE, E2E.

## 5. Thiết kế

### 5.1 Phân loại và tải (bước 1)

Thư viện đồng bộ trong giao dịch của bên gọi. Hai nguồn gọi chạy song song và có thể cùng đụng một SKU:
- worker: việc `channel.order_pull` kéo đơn, lập kiện, áp trạng thái sàn: gọi `reserve`, `release`, `ship` (sàn báo bàn giao, có thể `forced`);
- api: kho quét bàn giao, CEO duyệt huỷ bàn giao nhầm, yêu cầu trả tới kho: gọi `ship`, `reverseShipment`, `receiveBack`.

Tải nhỏ: vài trăm kiện mỗi ngày, mỗi kiện dưới 10 dòng. Không cần cache, không cần hàng đợi riêng.

### 5.2 Bố cục file

```
product/inventory/
├─ index.ts                 thêm kiểu ShipOptions; vẫn export năm hàm từ service/port.ts
├─ domain/stock.ts          worsens theo phần hụt (Q14), shortfall(); averageCost() cho giá đảo
├─ domain/documents.ts      mới: DOC_PREFIX theo loại phiếu, docNumber(prefix, n)
├─ repository/levels.ts     saveLevel nhận thêm reserved
├─ repository/documents.ts  mới: insertDocument, insertDocumentLines, packageShipments(packageId),
│                           returnInspectionOf(sourceType, sourceId)
├─ service/locked.ts        mới: lockedOf (chuyển từ port.ts, cắt vòng port ↔ posting)
├─ service/posting.ts       lockLevels, applyChange (riêng); applyMoves, receiveGoods gọi qua applyChange
├─ service/reservation.ts   mới: reserve, release
├─ service/shipment.ts      mới: ship, reverseShipment
├─ service/returns.ts       mới: receiveBack
└─ service/port.ts          availableOf, stockOf, nextDocNumber; re-export năm hàm
```

`port.ts`, `posting.ts`, `thresholds.ts` import `lockedOf` từ `service/locked.ts`. Chiều import: `port` → `reservation`, `shipment`, `returns` → `posting` → `locked`, `thresholds`; không file nào ở dưới import ngược `port`.

### 5.3 Dữ liệu (bước 2)

Không có migration (Q20).

**Phiếu do hệ thống lập** (`created_at = clock_timestamp()`, Q22; mỗi phiếu ghi `recordTransition({ entityType: 'stock_documents', from: null, to, action: 'create', actorId })`, như phiếu nhận):

| Loại | Trạng thái khi lập | Cột | Dòng (gộp theo SKU) |
|---|---|---|---|
| `shipment` | `posted` | `source_type = 'package'`, `source_id = packageId`, `created_by = posted_by = actorId`, `posted_at = now()`, `note = 'Bàn giao bắt buộc theo sàn'` khi `forced` | `variant_id`, `quantity`, `unit_cost` = giá vốn bình quân lúc khoá |
| `shipment_reversal` | `posted` | như trên, `note = reason` | `variant_id`, `quantity`, `unit_cost` = bình quân giá của lượt đang xuất (Q17) |
| `return_inspection` | `draft` | `source_type`, `source_id` theo `source`; `created_by` trống (hệ thống lập) | `variant_id`, `expected_qty = quantity`, `unit_cost` trống (Q19) |

Thẻ kho của phiếu xuất, phiếu đảo: `source_type = 'stock_document'`, `source_id` = id phiếu, `source_line_id` = id dòng phiếu.

**Bất biến:**

| Bất biến | Ai giữ |
|---|---|
| `reserved ≥ 0`, `quarantine ≥ 0` | CHECK đã có; lõi kiểm trước để báo lỗi rõ |
| `on_hand ≥ 0` và `reserved ≤ on_hand`, trừ khi `invariant_broken` | CHECK `stock_levels_invariant`; lõi theo Q14 |
| Phiếu `shipment`, `shipment_reversal` có `source_type = 'package'`; phiếu `posted` có `posted_at` | CHECK đã có |
| Mỗi SKU: tổng đảo của một lượt ≤ tổng xuất của lượt đó; mỗi lượt đảo một lần | Service (`reverseShipment`, Q17) cộng chống lặp của fulfillment |
| Một nguồn (kiện hoặc yêu cầu trả) có nhiều nhất một phiếu kiểm hàng hoàn | Service (`receiveBack`, Q19) cộng chuyển trạng thái có điều kiện của bên gọi |

**Kiểu export:**

```ts
interface StockLine { variantId: string; quantity: number }           // không đổi
interface ShipOptions { actorId: string | null; forced?: boolean }      // Q10
interface DocumentRef { documentId: string; number: string }
```

### 5.4 Lõi `applyChange`

```ts
interface StockChange {
  source: { type: StockSourceType; id: string } | null; // null chỉ khi không có move (reserve, release)
  moves: readonly Move[];
  reserved?: ReadonlyMap<string, number>;                // phần cộng trừ đang giữ theo variantId
  forced?: boolean;
  actorId: string | null;
}
lockLevels(variantIds): Promise<Map<string, LevelRow>>
applyChange(change: StockChange, precheck?: (locked: ReadonlyMap<string, LevelRow>) => boolean): Promise<boolean>
```

`lockLevels`: sắp `variantId` tăng dần, `getVariants` (SKU không thuộc công ty thì `Error`, 500), rồi `lockLevel` từng SKU (Q8). `lockLevel` tạo dòng tồn 0 khi chưa có, nên luôn kiểm `getVariants` trước (A17). `ship`, `reverseShipment` khoá trước lõi cũng đi qua hàm này; lõi khoá lại trong cùng giao dịch, không tốn thêm.

`applyChange`:
1. `companyOfTransaction()`. Bỏ move có `qty = 0` và phần đang giữ bằng 0; không còn gì thì trả `true`. Có move mà `source` trống là lỗi lập trình.
2. `lockLevels(SKU của move và phần đang giữ)`.
3. Có `precheck` mà nó trả `false`: trả `false`, không ghi gì.
4. Tính số mới. Move như `applyMoves` hiện nay: giá vốn chỉ tính lại với move `on_hand` dương có giá; tồn trước ≤ 0 thì giá vốn bằng giá lần đó (Q5). Cộng phần đang giữ vào `reserved`.
5. Kiểm từng SKU, theo thứ tự:
   - `reserved < 0`: `Error` "nhả quá số đang giữ" kèm SKU (500);
   - `quarantine < 0`: `InsufficientStock`;
   - không `forced` và `worsens(trước, sau)`: `InsufficientStock`.
6. `saveLevel` (`on_hand`, `reserved`, `quarantine`, `avg_cost`, `invariant_broken = breaksInvariant(sau)`, `version + 1`), `insertMoves`.
7. Với mỗi SKU có `on_hand` đổi, theo thứ tự `variantId`: `publishEvent('inventory.stock_changed', { variantId, onHand, reserved, available })`, số sau khi ghi (Q15).
8. `recheckThresholds(SKU có on_hand hoặc reserved đổi)` (Q15).
9. Trả `true`.

```ts
shortfall(level) = level.reserved - level.onHand
worsens(before, after) = breaksInvariant(after.onHand, after.reserved) && shortfall(after) > shortfall(before)
```

`applyMoves(source, moves, actorId)` = `applyChange({ source, moves, actorId })`, bỏ qua kết quả. `receiveGoods` không đổi.

### 5.5 Năm hàm cổng

**Bản giả (PR đầu, Q23).** Thân tạm, đánh dấu `shortcut:` trỏ về spec này:
- `reserve` → `{ reserved: true }`, không ghi gì; `release` không làm gì;
- `ship` → `{ documentId: randomUUID(), number: 'XK-000000' }`; `reverseShipment` → `DX-000000`; `receiveBack` → `KT-000000`.

`port.test.ts` đổi ca "trả 501" thành ca "bản giả trả thành công". Chữ ký giữ bản 29/10 (chưa có `forced`), bản thật thêm sau khi PR Documents merge.

**Bản thật:**

| Hàm | Các bước |
|---|---|
| `reserve(packageId, lines)` → `{ reserved }` | Kiểm `quantity` nguyên dương. `lines` rỗng thì `{ reserved: true }`. Gộp số lượng theo SKU. `applyChange({ source: null, moves: [], reserved: +q, actorId: null }, precheck)`, `precheck`: mọi SKU có `availableQty(onHand, reserved, lockedOf) ≥ q`. Trả `{ reserved: kết quả }` |
| `release(packageId, lines)` | Kiểm `quantity` nguyên dương. `lines` rỗng thì không làm gì. Gộp theo SKU, `applyChange({ reserved: −q })`. Nhả quá số đang giữ: 500, message có `packageId`, SKU |
| `ship(packageId, lines, { actorId, forced })` → `DocumentRef` | 1) Kiểm `lines` không rỗng, `quantity` nguyên dương; gộp theo SKU. 2) `lockLevels`. 3) Lưới (Q12): `packageShipments(packageId)`, trong lượt đang xuất có phiếu mà dòng gộp theo SKU bằng đúng dòng của lần gọi thì trả phiếu đó. 4) `nextDocNumber('shipment')`, lập phiếu `XK` `posted` và dòng phiếu với `avgCost` của dòng tồn đã khoá. 5) `applyChange({ source: stock_document, moves: on_hand −q, unitCost = avgCost, sourceLineId = id dòng phiếu; reserved: forced ? không có : −q; forced; actorId })`. Trừ đang giữ xuống âm: 500 "kiện chưa giữ hàng; bàn giao bắt buộc thì truyền `forced`" (Q21). 6) `recordTransition` |
| `reverseShipment(packageId, lines, { actorId, reason })` → `DocumentRef` | 1) Kiểm như `ship`; `reason` sau khi trim khác rỗng, ≤ 500 ký tự. 2) `lockLevels`. 3) `packageShipments(packageId)` lấy lượt đang xuất; rỗng, hoặc có SKU đảo nhiều hơn số của lượt: 500. 4) `nextDocNumber('shipment_reversal')`, lập phiếu `DX` `posted`, giá dòng = `averageCost` các dòng xuất của SKU trong lượt (làm tròn nửa lên 2 chữ số). 5) `applyChange({ moves: on_hand +q theo giá đó; reserved: +q; actorId })`: giá vốn bình quân tính lại. 6) `recordTransition` |
| `receiveBack(source, lines)` → `DocumentRef` | 1) Kiểm `lines` không rỗng, `quantity` nguyên dương, `source.type ∈ { package, return_request }`. 2) `returnInspectionOf(source.type, source.id)` có phiếu thì trả phiếu đó. 3) `nextDocNumber('return_inspection')`, lập phiếu `KT` `draft`, dòng gộp theo SKU với `expected_qty`. 4) `recordTransition` (`actorId: null`). Không đổi tồn, không phát sự kiện, không xét ngưỡng |

`packageShipments(packageId)` đọc mọi phiếu `shipment`, `shipment_reversal` có `source_type = 'package'`, `source_id = packageId` kèm dòng, sắp theo `created_at`. Lượt đang xuất = các phiếu `shipment` sau phiếu `shipment_reversal` cuối cùng.

Thứ tự khoá trong một giao dịch: kiện (fulfillment, trước khi gọi cổng) → dòng tồn theo `variantId` → dòng đếm `doc_counters` sau cùng.

### 5.6 Lỗi và bảo mật (bước 3)

| Tình huống | Hàm | Xử lý |
|---|---|---|
| Gọi ngoài `withCompany` | tất cả | `requireCompanyId` ném lỗi lập trình (500); không chạy dưới role chủ bảng |
| SKU không thuộc công ty; `quantity` không nguyên dương; `lines` rỗng ở `ship`, `reverseShipment`, `receiveBack`; `reason` rỗng hoặc > 500 ký tự | tất cả | `Error` (500): vi phạm hợp đồng giữa module. Route của bên gọi đã kiểm dữ liệu người dùng bằng Zod |
| Không đủ có thể bán | `reserve` | `{ reserved: false }`, không ghi gì |
| Nhả quá số đang giữ | `release` | `Error` (500), message có `packageId`, SKU: hai bên lệch sổ |
| Kiện chưa giữ hàng mà `ship` không `forced` | `ship` | `Error` (500), Q21 |
| Không có lượt đang xuất, hoặc đảo nhiều hơn số đã xuất | `reverseShipment` | `Error` (500) |
| Gọi lặp | `ship`, `receiveBack` | Trả phiếu cũ, không ghi gì |
| CHECK của DB chặn | tất cả | 500, là bug của lõi; giao dịch rollback |
| Ghi outbox lỗi | tất cả | Cùng giao dịch, rollback |
| Deadlock | tất cả | Tránh bằng thứ tự khoá ở 5.5; nếu vẫn xảy ra thì 500, bên gọi chạy lại |

Bảo mật: không có đường mới từ ngoài vào; tách công ty bằng RLS và ngữ cảnh của bên gọi. Cổng không nhận giá, nên bên gọi không đẩy được giá vốn tuỳ ý. `reason` là chữ người dùng nhập: giới hạn 500 ký tự, lưu nguyên văn, FE escape khi hiển thị. `actorId` ghi lên phiếu và thẻ kho để truy vết.

### 5.7 Phân quyền (bước 4)

Không có route mới. Quyền do route của bên gọi kiểm: kho quét bàn giao, CEO duyệt huỷ bàn giao nhầm (#199). Inventory không kiểm quyền, chỉ chạy được trong ngữ cảnh công ty.

### 5.8 Chống trùng và chạy đồng thời (bước 5)

- **Gọi lặp `reserve`, `release`:** inventory không tự chống (Q11). Fulfillment khoá kiện (`FOR UPDATE`), chỉ gọi `reserve` cho dòng có `reserved_qty = 0` và chỉ đặt `reserved_qty = quantity` khi được `{ reserved: true }`; `release` ngược lại. Thiếu chốt này thì lệch đang giữ; job đối soát của #199 bắt được.
- **Gọi lặp `ship`:** fulfillment chặn bằng `stock_deducted`; inventory trả phiếu cũ (Q12). Lưới chạy sau `lockLevels`, nên lần gọi trùng chạy song song chờ khoá rồi đọc thấy phiếu đã commit.
- **Đồng thời:** `FOR UPDATE` từng dòng tồn theo `variantId` tăng dần. Hai `reserve` tranh món cuối: giao dịch sau chờ, đọc lại thấy có thể bán 0, trả `false`.
- **Bộ đếm số phiếu:** khoá sau cùng, nên mọi `ship` trong một công ty xếp hàng ở dòng đếm tới khi commit. Chấp nhận ở tải hiện tại.
- **Sai thứ tự sự kiện:** payload là số tuyệt đối; bên nghe đọc lại `availableOf`.

### 5.9 Quan sát (bước 6)

Không thêm metric hay log mới:
- Thẻ kho, phiếu `XK`, `DX`, `KT` cùng `state_transitions` là vết đầy đủ: ai, lúc nào, chứng từ nào, số dư sau biến động. Bàn giao bắt buộc tra bằng phiếu `XK` có `note`.
- Lỗi 500 có log ở middleware HTTP; lỗi trong việc nền `order_pull` hiện ở API việc lỗi (§14.5).
- Độ trễ sự kiện xem ở outbox.

### 5.10 Test

| File | Kiểm |
|---|---|
| `test/unit/modules/product/inventory/domain/stock.test.ts` | `worsens` theo phần hụt: bàn giao thường khi đang vỡ thì qua, giảm làm hụt tăng thì chặn, nhập luôn qua, mọi ca cũ vẫn đúng; `averageCost`: một dòng, nhiều dòng, làm tròn |
| `test/unit/modules/product/inventory/domain/documents.test.ts` | `docNumber` ghép tiền tố, đệm 6 chữ số; `DOC_PREFIX` đủ ba loại |
| `test/integration/product/inventory/port.test.ts` | PR bản giả: năm hàm trả thành công. PR bản thật: bỏ ca bản giả |
| `test/integration/product/inventory/reservation.test.ts` | AC 1, 2, 3, 10a |
| `test/integration/product/inventory/shipment.test.ts` | AC 4–8, 10b, 10c |
| `test/integration/product/inventory/return.test.ts` | AC 9 |
| `test/integration/product/inventory/posting.test.ts`, `thresholds.test.ts` | Test cũ vẫn xanh (AC 11) |

Id kiện, id yêu cầu trả trong test là `randomUUID()`: inventory không đọc bảng `order`. Tạo biến thể bằng `companyWithVariants`, nhập hàng bằng `receive` (`test/integration/product/inventory/helpers.ts`), đua bằng `raceBehindLock` (`test/integration/helpers/locks.ts`). Ca có ngưỡng import qua `#src/modules/product/index.ts` để `setIncomingSource` đã được nối.

## 6. Thứ tự giao

1. **PR bản giả** (`feature/206-cong-ton-theo-kien`, làm ngay): spec này, thân tạm ở 5.5, sửa `port.test.ts`, một dòng ở `inventory/CLAUDE.md`. Báo #199, #202 dùng được.
2. **PR Documents** sửa `21` §11.1 theo mục 8. Thành, Khoa duyệt; merge trước PR bản thật.
3. **PR bản thật** (nhánh mới từ `main`): `lockedOf` sang `service/locked.ts`, lõi, năm hàm, test, `inventory/CLAUDE.md`. Trước khi merge: dọn kiện "đã giữ" bằng bản giả trên staging (mục 10).
4. Merge xong thì #199 trỏ `stock-port.ts` sang `product/index.ts`, thêm khoá kiện và cập nhật có điều kiện (5.8), đọc `stockOf` sau `ship` để ghi `unit_cost` dòng kiện (Q16).

## 7. Ảnh hưởng tới FE

Không có API mới, không đổi hợp đồng HTTP. Thẻ kho hiện thêm dòng nguồn `stock_document` cho phiếu `XK`, `DX`; `document.type` đã có giá trị này. Số phiếu, loại phiếu trên thẻ kho làm ở spec số liệu §15.

## 8. Ảnh hưởng tới Documents

`21` §11.1:
- Bảng: `ship(packageId, lines, { actorId, forced? })`; `actorId` trống khi sàn báo bàn giao. `forced: true` là bàn giao bắt buộc (`25` §8.4 quy tắc 3): trừ đủ tồn thực, không trừ đang giữ, được vỡ bất biến, bật Tồn âm (Q10).
- Ghi chú `reserve`, `release`: thay "(#111 chốt cách chống lặp)" bằng "chống lặp ở `fulfillment`: khoá kiện, đổi `reserved_qty` có điều kiện trong cùng giao dịch; `inventory` cộng trừ đúng số được truyền" (Q11).
- Ghi chú `ship`: "`fulfillment` gọi đúng một lần theo `stock_deducted`; gọi lại cùng dòng trong lượt bàn giao chưa đảo thì `inventory` trả phiếu cũ. Giá vốn dòng kiện: đọc `stockOf(...).avgCost` sau `ship` trong cùng giao dịch" (Q12, Q16).
- Ghi chú `reverseShipment`: "đảo lượt bàn giao gần nhất chưa đảo; mỗi SKU không quá số đã xuất trong lượt; cộng lại tồn thực và đang giữ" (Q17).
- Ghi chú `receiveBack`: "gọi lại cùng nguồn trả phiếu cũ" (Q19).

## 9. Acceptance criteria

Giá trị tiền là `numeric(18,2)`.

1. **Giữ nguyên kiện:** A tồn 5 (ngưỡng 2, chưa báo), B tồn 1. `reserve(k1, [A×3, B×2])` → `{ reserved: false }`; `stock_levels` không đổi, outbox không có sự kiện. Nhập thêm 1 B rồi gọi lại → `{ reserved: true }`; A đang giữ 3, B đang giữ 2; outbox **không** có `stock_changed` của lần giữ; có một `inventory.below_threshold` của A (có thể bán 2 ≤ ngưỡng 2).
2. **Gộp dòng cùng SKU:** A tồn 4. `reserve(k2, [A×2, A×3])` → `false`.
3. **Nhả:** sau AC 1, `release(k1, [A×3, B×2])` → đang giữ về 0, không có `stock_changed`. `release` thêm A×1 → lỗi 500, DB không đổi.
4. **Bàn giao:** A tồn 10, đang giữ 3, giá vốn 80.000. `ship(k3, [A×3], { actorId })` → tồn 7, đang giữ 0; phiếu `XK-000001` `posted`, dòng phiếu `unit_cost` 80.000; thẻ kho −3, `balance_after` 7, nguồn `stock_document`; một `stock_changed` (`onHand` 7, `reserved` 0, `available` 7). `stockOf([A])` ngay sau trong cùng giao dịch trả `avgCost` 80.000.
5. **Gọi lặp `ship`:** sau AC 4, gọi lại `ship(k3, [A×3])` → trả `XK-000001`; tồn vẫn 7, không có phiếu, thẻ kho, sự kiện mới.
6. **Bàn giao khi đang Tồn âm (Q14):** A tồn 3, đang giữ 5, `invariant_broken`. `ship` 2 → qua; tồn 1, đang giữ 3, `invariant_broken` vẫn true.
7. **Bàn giao bắt buộc:** A tồn 1, đang giữ 0. `ship(k4, [A×3], { actorId: null, forced: true })` → tồn −2, đang giữ 0, `invariant_broken` true, phiếu có `note`, `created_by` trống. A tồn 5: `forced` 3 → tồn 2, `invariant_broken` false. A tồn 5, đang giữ 0: `ship` 2 **không** `forced` → lỗi 500, DB và `doc_counters` không đổi.
8. **Đảo bàn giao:** sau AC 4, `receiveGoods` 10 cái giá 100.000 → giá vốn 91.764,71 (tồn 17). `reverseShipment(k3, [A×3], { actorId, reason })` → tồn 20, đang giữ 3, giá vốn **90.000,00**, phiếu `DX-000001`, dòng phiếu giá 80.000. Gọi lại → lỗi 500. `ship` lại k3 (giá vốn 90.000, phiếu `XK-000002`, không bị lưới trả phiếu cũ) rồi đảo lần nữa → lần này giá dòng đảo 90.000.
9. **Hàng quay về:** `receiveBack({ type: 'package', id: k5 }, [A×2, A×1])` → phiếu `KT-000001` `draft`, một dòng A `expected_qty` 3, `unit_cost` trống; `stock_levels` không đổi, outbox không có sự kiện. Gọi lại → trả `KT-000001`. Nguồn `return_request` khác id → `KT-000002`.
10. **Đồng thời:**
    - (a) A tồn 1. Hai `reserve` mỗi kiện A×1 chạy song song (`raceBehindLock`) → đúng một `true`; đang giữ 1;
    - (b) A tồn 5, đang giữ 2. `reserve` A×3 và `ship` A×2 song song → cả hai qua, tồn 3, đang giữ 3, không deadlock;
    - (c) A tồn 5, đang giữ 2. Hai `ship(k6, [A×2])` song song → cùng một phiếu, tồn 3, một dòng thẻ kho.
11. Test cũ của `receiveGoods`, `applyMoves`, `availableOf`, `stockOf`, `nextDocNumber`, ngưỡng vẫn xanh. `npm run check` xanh, depcruise không báo vi phạm (kể cả `khong-vong-tron`).

## 10. Rủi ro và điểm còn mở

- **Bản giả trên staging:** kiện "đã giữ" bằng bản giả không cộng `stock_levels.reserved`. Lên bản thật mà nhả các kiện đó thì đang giữ xuống âm (500). Trước khi merge bản thật: xoá kiện demo, hoặc chạy một lần script đặt `stock_levels.reserved` bằng tổng `reserved_qty` của kiện còn mở.
- Fulfillment quên khoá kiện hay quên cập nhật có điều kiện thì lệch đang giữ hoặc trừ tồn hai lần ở phiếu khác dòng. Ghi ở §11.1 và trong PR báo #199; job đối soát chỉ bắt được lệch đang giữ.
- Lưới của `ship` so theo dòng gộp SKU: hai lần bàn giao hợp lệ của cùng một kiện trong cùng lượt mà trùng hệt dòng (không xảy ra theo `25` §8.4) sẽ bị coi là gọi lặp.
- `reverseShipment` đảo theo lượt; đảo một phần rồi đảo tiếp phần còn lại chưa hỗ trợ (`25` §8.3 đảo cả kiện).
- `lockedOf` vẫn bằng 0 tới B3, nên `reserve` có thể giữ phần đang tạm khoá cho phiếu kho chờ duyệt. Hiện chưa có phiếu kho chờ duyệt nên chưa xảy ra.
- Bộ đếm số phiếu khoá tới khi commit làm các `ship` trong một công ty xếp hàng. Nếu thành nút thắt thì cấp số bằng sequence riêng (chấp nhận nhảy số).
- Lấy lại phần giữ (`25` §7.4) sau bàn giao bắt buộc thuộc fulfillment: tới lúc đó kiện khác vẫn giữ phần hàng không còn; cờ Tồn âm hiện trên SKU tới khi kiểm kê hoặc hàng về.
