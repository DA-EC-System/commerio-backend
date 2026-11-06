# Spec: Thẻ kho đủ trường và lọc Tồn âm (#206, phần 2a)

- **Ngày:** 06/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#206, `Documents/21` §15.1, §15.2 và dòng 345 (thẻ kho), `Documents/25` §7.1, §7.2, kiểu FE `FE/src/types/inventory.ts` (c82300b)
- **Trạng thái:** nháp, chờ Khang duyệt
- **Phạm vi:** phần 2a của #206. Phần 2 tách đôi (Khang chọn 06/11/2026): 2a là thẻ kho và lọc Tồn âm, chỉ nằm trong `product`; 2b là đang thiếu (`shortage`) và Lệch tồn (`drift`), cần dữ liệu của `order` (#199) và `channel` (#223), viết spec riêng. Phần cổng ở `2026-11-06-206-cong-ton-theo-kien-design.md`.

---

## 1. Mục tiêu và tiêu chí thành công

1. `GET /inventory/stock/:variantId` trả thẻ kho đúng hình `StockMove` của FE: `onHandAfter`, `area` là `'stock' | 'quarantine'`, `document { id, number, type, kind }`, `doneBy` có thể `null`.
2. `GET /inventory/stock` lọc được SKU Tồn âm (`negative=true`).
3. `StockLevel` có đủ trường của kiểu FE, kể cả `drift` (2a luôn `false`).
4. Không migration, không đổi luồng ghi sổ. Thẻ kho 100 dòng tốn thêm tối đa 3 câu SQL.

Đo bằng: acceptance criteria ở mục 9 đều qua; body trả về parse được bằng đúng schema Zod khai trong OpenAPI; `npm run check` xanh.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (0dae258):**
- `service/stock.ts` `getStock` trả `moves` dạng `{ id, area: 'on_hand' | 'quarantine', qtyChange, balanceAfter, document: { id, type: source_type }, unitCost, doneAt, doneBy }`. `document` chưa có `number`, `kind`; tên `balanceAfter` lệch Documents/21 dòng 345 (`onHandAfter`).
- `StockLevel` (`service/views.ts` `toStockLevel`, `api/schemas.ts`) chưa có `drift`. `shortage`, `locked` luôn 0 (2b, B3).
- `StockListQuery` có `belowMin`, `quarantine`, chưa có lọc Tồn âm. `summary.negativeCount` đã có.
- Thẻ kho `stock_moves` trỏ chứng từ gốc bằng `source_type` (`goods_receipt`, `stock_document`, `supplier_return`) và `source_id`. Phiếu kho ở `stock_documents` (cùng module con). Phiếu nhận `goods_receipts`, phiếu trả NCC `supplier_returns` thuộc module con `purchasing`.

**Ràng buộc:**
- `inventory` không import được `purchasing`: purchasing đã import inventory (vòng), và luật `module-con-chi-qua-index` cấm import thẳng repository của module con khác. Cách đã dùng cho trường hợp này: purchasing đưa hàm qua `ctx`, `product/index.ts` tiêm (`incomingOf`).
- Documents/21 §15.2 chỉ định kiểu đầy đủ ở `FE/src/types/inventory.ts`. Thấy lệch thì sửa Documents trước, không tự đổi một phía.
- Bảy con số luôn có mặt, là số nguyên (R4).

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Phần 2 tách 2a (thẻ kho, lọc Tồn âm) và 2b (đang thiếu, Lệch tồn) | 2a chỉ nằm trong `product`, làm ngay được; 2b là quyết định kiến trúc (đưa dữ liệu từ lớp trên xuống inventory, cả trong lúc xét ngưỡng) và phụ thuộc #199, #223. Khang chọn 06/11/2026 |
| D2 | `document.number` tra theo lô lúc đọc. Phiếu kho: inventory tự đọc `stock_documents`. Phiếu nhận, phiếu trả NCC: purchasing thêm `purchaseDocumentNumbers(ids)`, `product/index.ts` tiêm vào `ctx` của inventory | Cùng khuôn `incomingOf`. Không migration, không đổi chữ ký ghi sổ. Đã cân nhắc lưu số phiếu trên `stock_moves` (cần migration, đổi `receiveGoods`, điền dữ liệu cũ) và join thẳng bảng purchasing bằng SQL thô (lách depcruise). Khang chọn 06/11/2026 |
| D3 | API trả `area` là `'stock'` cho ngăn `on_hand`, `'quarantine'` giữ nguyên. DB không đổi | Kiểu FE `StockArea = 'stock' \| 'quarantine'`, Documents chỉ định kiểu FE là kiểu đầy đủ |
| D4 | `document.kind` suy ra, không lưu (bảng ở 5.2) | FE `StockDocKind = 'manual' \| 'purchase' \| 'order' \| 'auto'` chỉ để hiển thị nhãn; mock FE gán đúng theo loại chứng từ |
| D5 | `doneBy` là `string \| null` (tên người ghi sổ; `null` khi hệ thống hoặc sàn ghi) | Documents/21 dòng 345 đã chốt; FE đang khai `string`, FE sửa |
| D6 | `StockLevel.drift` luôn `false` ở 2a, comment `shortcut:` trỏ #206 phần 2b | Response khớp đủ trường kiểu FE ngay; giá trị thật cần dữ liệu `channel` (2b). Khang đồng ý 06/11/2026 |
| D7 | `GET /inventory/stock` thêm `negative` (`'true' \| 'false'`), gộp AND với các lọc khác; `summary` không theo lọc | Cùng cách `belowMin`, `quarantine`; mục "lọc Tồn âm" của #206 |
| D8 | Dòng thẻ kho trỏ chứng từ không tồn tại: 500, message có id dòng thẻ kho và id chứng từ | `stock_moves.source_id` không có khoá ngoại; mồ côi là dữ liệu hỏng. Không bịa số phiếu trên sổ kiểm toán |
| D9 | Không migration | Mọi trường mới đọc từ bảng đã có hoặc suy ra |

## 4. Phạm vi

**Trong spec:**
- sửa Documents/21 §15.2 (mục 8);
- `domain`: `documentKind`, `areaOf`;
- `repository/documents.ts` `documentHeads`;
- purchasing `purchaseDocumentNumbers`, tiêm qua `ctx`;
- `getStock` trả thẻ kho mới; `listStock` lọc `negative`; `toStockLevel` thêm `drift`;
- schema Zod, OpenAPI; test; `inventory/CLAUDE.md`.

**Ngoài spec:**
- 2b: `shortage` thật, `drift` thật.
- B3: `locked` thật, phiếu kho có duyệt.
- Phân trang hoặc lọc thẻ kho: giữ 100 dòng mới nhất.
- Sửa FE: kiểu, nhãn, lọc Tồn âm trên trang (PR FE riêng, mục 7). E2E thuộc phần 4.

## 5. Thiết kế

### 5.1 Hợp đồng API

`GET /inventory/stock`: vào thêm `negative`; `StockLevel` thêm `drift: boolean`.

`GET /inventory/stock/:variantId`, mỗi dòng `moves`:

```ts
{
  id: string;
  qtyChange: number;
  area: 'stock' | 'quarantine';
  onHandAfter: number;            // số của ngăn đó sau biến động (stock_moves.balance_after)
  document: {
    id: string;
    number: string;
    type: 'stocktake' | 'write_off' | 'to_quarantine' | 'return_inspection' | 'shipment' | 'shipment_reversal'
        | 'goods_receipt' | 'supplier_return';
    kind: 'manual' | 'purchase' | 'order' | 'auto';
  };
  unitCost: number | null;        // không đổi: null khi không có quyền xem giá vốn
  doneAt: string;
  doneBy: string | null;
}
```

`document.type`: dòng gắn phiếu kho lấy `stock_documents.kind`; dòng gắn phiếu nhận, phiếu trả NCC lấy `source_type`.

### 5.2 Luật thuần

`domain/documents.ts`:

```ts
type MoveSource =
  | { type: 'goods_receipt' | 'supplier_return' }
  | { type: 'stock_document'; kind: StockDocumentKind; isOpening: boolean; sourceType: string | null };
documentKind(source: MoveSource): 'manual' | 'purchase' | 'order' | 'auto'
```

| Chứng từ | `kind` |
|---|---|
| `goods_receipt`, `supplier_return` | `purchase` |
| phiếu kho `shipment`, `shipment_reversal` | `order` |
| phiếu kho `return_inspection` | `auto` |
| phiếu kho `stocktake` có `is_opening` | `auto` |
| phiếu kho khác có `source_type` (phiếu sinh từ chứng từ khác, vd xuất huỷ sau kiểm hàng hoàn) | `auto` |
| phiếu kho còn lại (`stocktake`, `write_off`, `to_quarantine` do người lập) | `manual` |

`domain/stock.ts`: `areaOf(bucket: 'on_hand' | 'quarantine'): 'stock' | 'quarantine'`.

### 5.3 Bố cục và luồng dữ liệu

```
product/index.ts           tiêm purchaseDocumentNumbers vào ctx của inventory (cạnh incomingOf)
purchasing/
├─ repository/…            documentNumbers: goods_receipts, supplier_returns theo id (mỗi bảng một câu, bỏ qua khi rỗng)
└─ index.ts                export purchaseDocumentNumbers({ goodsReceipts, supplierReturns }):
                           Promise<{ goodsReceipts: Map<id, number>, supplierReturns: Map<id, number> }>
                           (tách theo loại sau review 06/11/2026: id sai loại thì vắng, loại không có id thì không truy vấn)
inventory/
├─ domain/documents.ts     documentKind
├─ domain/stock.ts         areaOf
├─ repository/documents.ts documentHeads(ids): Map<id, { number, kind, isOpening, sourceType }>
├─ service/views.ts        InventoryContext.purchaseDocumentNumbers?; purchaseNumbersOf(ctx) (thiếu thì 500);
│                          toStockLevel thêm drift: false
├─ service/stock.ts        getStock(lookups: { incomingOf, purchaseNumbers }, viewer, variantId); listStock lọc negative
└─ api/                    schemas: StockListQuery.negative, StockLevel.drift, StockMove mới; routes truyền hàm tra
```

`getStock`:
1. `latestMoves(variantId, 100)`, như hiện nay.
2. Gom `source_id` theo `source_type`. Có id `stock_document` thì gọi `documentHeads`. Có id `goods_receipt` hoặc `supplier_return` thì gọi `lookups.purchaseNumbers` (route lấy bằng `purchaseNumbersOf(ctx)`).
3. Dựng từng dòng: `area = areaOf(bucket)`, `onHandAfter = balanceAfter`, `document = { id, number, type, kind: documentKind(...) }`. Thiếu chứng từ thì ném lỗi 500 (D8).

Mọi truy vấn chạy trong `withCompany` của request: RLS và lọc `company_id` như các hàm đọc hiện có.

### 5.4 Lỗi

| Tình huống | Xử lý |
|---|---|
| `negative` khác `'true'`, `'false'` | 422 theo ô, như `belowMin` |
| Dòng thẻ kho trỏ chứng từ không tồn tại | 500, message có id dòng thẻ kho, id chứng từ (D8) |
| `ctx` chưa tiêm `purchaseDocumentNumbers` | 500 "Chưa nối số phiếu của purchasing", như `incomingLookupOf` |
| Biến thể của công ty khác, id sai | 404, không đổi |

### 5.5 Phân quyền, bảo mật

Không route mới, không đổi quyền: `inventory.stock.view` xem tồn và thẻ kho; `unitCost` vẫn ẩn khi thiếu `inventory.cost.view`. Số phiếu, loại phiếu không nhạy cảm. Tra số phiếu chỉ theo id lấy từ thẻ kho của chính công ty, trong `withCompany`.

### 5.6 Hiệu năng

- `getStock`: thêm tối đa 3 câu (một câu `stock_documents`, mỗi bảng purchasing một câu, chỉ khi có id loại đó), theo khoá chính `id in (…)`, tối đa 100 id. Không truy vấn theo từng dòng.
- `listStock`: lọc `negative` trong bộ nhớ như các lọc hiện có (giới hạn D10 đã ghi ở `inventory/CLAUDE.md`), không thêm câu SQL.

### 5.7 Test

| File | Kiểm |
|---|---|
| `test/unit/modules/product/inventory/domain/documents.test.ts` | `documentKind`: đủ các dòng của bảng 5.2 |
| `test/unit/modules/product/inventory/domain/stock.test.ts` | `areaOf` |
| `test/integration/product/inventory/stock.test.ts` | AC 1–8; sửa ca cũ đang kiểm `area: 'on_hand'`, `balanceAfter` |
| `test/integration/product/purchasing/document-numbers.test.ts` | AC 8 |

Phiếu `XK`, `DX` trong test chèn thẳng bằng role chủ bảng (như helper `receive`), không cần `ship` của #266. Phiếu nhận `NH-` lập qua helper của purchasing (`test/integration/product/purchasing/helpers.ts`).

## 6. Thứ tự giao

1. **PR Documents:** sửa §15.2 theo mục 8. Merge trước PR backend.
2. **PR backend:** nhánh `feature/206-the-kho` từ `main`. Không phụ thuộc #265, #266: thẻ kho chỉ đọc, enum `shipment` đã có trong DB.
3. **PR FE:** sửa kiểu, nhãn, thêm lọc Tồn âm (mục 7).

## 7. Ảnh hưởng tới FE

`src/types/inventory.ts`:
- `StockDocType` thêm `'shipment' | 'shipment_reversal'`; nhãn "Xuất theo kiện", "Đảo bàn giao" (`features/inventory/shared.ts`);
- `StockMove.doneBy: string | null`;
- `StockListParams.negative?: boolean`.

Trang Tồn kho thêm bộ lọc "Tồn âm"; thẻ kho hiện "Hệ thống" khi `doneBy` là `null`. Mock handler theo cùng hình.

## 8. Ảnh hưởng tới Documents

`21` §15.2:
- `GET /inventory/stock`, cột "Vào": thêm `negative`.
- Đoạn "Kiểu dữ liệu đầy đủ…" thêm:
  - `StockMove.area` là `'stock' | 'quarantine'`;
  - `document.type` gồm loại phiếu kho (kể cả `shipment`, `shipment_reversal`), `goods_receipt`, `supplier_return`;
  - `document.kind` suy ra theo bảng 5.2;
  - `StockLevel.drift` luôn `false` tới #206 phần 2b.

## 9. Acceptance criteria

1. **Lọc Tồn âm:** công ty có SKU A (`invariant_broken`), B (bình thường). `GET /stock?negative=true` → chỉ A, `total` 1; `summary` như khi không lọc (`negativeCount` 1). `negative=abc` → 422.
2. **Trường mới của `StockLevel`:** mọi phần tử có `drift: false`. Body parse được bằng schema `StockPage`, `StockDetail`.
3. **Ngăn và số sau biến động:** nhập 5 vào tồn thực, 2 vào chờ xử lý → hai dòng thẻ kho `area` `stock` (`onHandAfter` 5) và `quarantine` (`onHandAfter` 2).
4. **Phiếu nhận:** phiếu nhận đã ghi sổ → dòng có `document { id: receiptId, number: 'NH-000001', type: 'goods_receipt', kind: 'purchase' }`, `doneBy` là tên người ghi sổ.
5. **Phiếu xuất, phiếu đảo:** dòng gắn phiếu `XK-000001` (`shipment`) → `type: 'shipment', kind: 'order'`; `DX-000001` → `shipment_reversal`, `order`; `doneBy: null` khi `done_by` trống.
6. **Kiểm kê:** kiểm kê lập tay → `stocktake`, `manual`; kiểm kê đầu kỳ (`is_opening`) → `auto`. Xuất huỷ có `source_type` → `auto`; `return_inspection` → `auto`.
7. **Dòng mồ côi:** dòng thẻ kho có `source_id` không trỏ phiếu nào → 500.
8. **Tra số phiếu của purchasing:** `purchaseDocumentNumbers` trả số `NH-`, `TN-` của công ty; id của công ty khác không có trong Map.
9. Test cũ xanh (đã sửa các ca kiểm `balanceAfter`, `area: 'on_hand'`); `npm run check` xanh, depcruise không báo vi phạm.

## 10. Rủi ro và điểm còn mở

- **Đổi tên trường `balanceAfter` → `onHandAfter` và giá trị `area` là đổi hợp đồng hiện có.** Hiện chưa có bên nào dùng BE thật (FE còn chạy mock), nên đổi thẳng, không giữ trường cũ song song. Nếu FE đã nối API ở nhánh nào thì phải đổi cùng lúc.
- **`kind` suy từ `source_type` của phiếu kho.** Phiếu do người lập mà sau này có `source_type` (vd kiểm kê lập từ một phiếu khác) sẽ thành `auto`. Đúng với các luồng hiện có; khi B3 thêm luồng mới thì xem lại bảng 5.2.
- **`drift` luôn `false` tới 2b.** FE không được dựa vào trường này để báo Lệch tồn trước khi 2b xong.
