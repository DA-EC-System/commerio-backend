# src/modules/product/inventory/

Các con số tồn, thẻ kho, phiếu kho, giá vốn bình quân, ngưỡng tồn. **Nơi duy nhất đổi số tồn.** Bảng nằm trong schema `product` (`Documents/19` mục 3.2). Hợp đồng API: `Documents/21` mục 15.

Hiện có: xem tồn, thẻ kho, đặt ngưỡng, lõi ghi sổ và ghi sổ theo phiếu nhận (#111), cổng tồn theo kiện: giữ, nhả, bàn giao, đảo bàn giao, hàng quay về (#206, spec `docs/superpowers/specs/2026-11-06-206-cong-ton-theo-kien-design.md`). Phiếu kho có duyệt (kiểm kê, xuất huỷ, chuyển chờ xử lý, kiểm hàng về; #208). Phiếu nhập/xuất tay và giữ hàng theo đơn của mô hình cũ đã bỏ cùng bảng của chúng (28/10/2026).

## Con số và bất biến

| Số | Lưu ở | Ghi chú |
|---|---|---|
| Tồn thực `on_hand`, đang giữ `reserved`, chờ xử lý `quarantine` | `stock_levels` | Đang giữ có nguồn là dòng kiện (`order.package_lines.reserved_qty`) |
| Đang về | Tính khi đọc | Còn chờ của đề nghị nhập đã đặt NCC; `incomingOf` của purchasing tiêm qua `ctx` (`product/index.ts`), vì purchasing import inventory |
| Tạm khoá | Tính khi đọc | Phần giảm tồn thực của phiếu kho `pending` (`repository/documents.ts` `pendingLocks`, `lockedOf`): xuất huỷ từ tồn thực, chuyển chờ xử lý lấy số lượng, kiểm kê lấy phần đếm thiếu; phiếu lấy từ chờ xử lý không khoá (#208) |
| Đang thiếu | Tính khi đọc | Từ kiện thiếu hàng; tới khi có nguồn đó thì bằng 0 |
| Khả dụng | Tính | `max(0, tồn thực − đang giữ − tạm khoá)`, là số đẩy lên sàn |
| Ngưỡng `min_qty` | `stock_levels` | `null` = chưa đặt; `reorderVersion` là `version` của dòng tồn |
| Lệch tồn `drift` | Chưa có | Luôn `false` tới #206 phần 2b (cần dữ liệu đẩy tồn của `channel`) |

- CHECK `stock_levels_invariant`: tồn thực ≥ 0 và đang giữ ≤ tồn thực, trừ khi bật `invariant_broken` (cờ Tồn âm: bàn giao bắt buộc theo sàn, kiểm kê CEO đã duyệt; `25` §7.1). Chờ xử lý, đang giữ không bao giờ âm.
- Thẻ kho `stock_moves` chỉ thêm (role ứng dụng không UPDATE/DELETE). Mỗi dòng có ngăn (`on_hand`/`quarantine`), số dư sau biến động và chứng từ gốc (`source_type`, `source_id`, `source_line_id`).
- API thẻ kho (`getStock`) đổi tên theo FE: ngăn `on_hand` ra `area: 'stock'`, `balance_after` ra `onHandAfter`. `document.type` là loại phiếu kho hoặc `goods_receipt`/`supplier_return`; `document.kind` suy ra, không lưu (`domain/moves.ts`). Số phiếu tra theo lô: phiếu kho đọc `stock_documents` (`repository/move-sources.ts`), phiếu nhận và phiếu trả NCC qua `purchaseDocumentNumbers` của purchasing (id tách theo `source_type`), tiêm vào `ctx` cạnh `incomingOf`. Mỗi loại chứng từ tối đa một câu, chỉ khi thẻ kho có dòng loại đó. Dòng trỏ chứng từ không tồn tại hoặc sai loại thì ghi log (`moveId`, `sourceType`, `sourceId`) rồi trả 500.
- Giá vốn bình quân gia quyền (`domain/stock.ts`); DB lưu `numeric(18,2)`, API trả số nguyên đồng; `stockValue = round(onHand × avg_cost)` (V29, V30).
- Chỉ tạo dòng `stock_levels` cho biến thể đã qua `catalog.getVariants` của công ty. Khoá chính `(company_id, variant_id)`.

## Ghi sổ (`service/posting.ts`)

Mọi thay đổi `stock_levels` (tồn thực, đang giữ, chờ xử lý, giá vốn) đi qua lõi `applyChange`; `applyMoves` (chỉ move) gọi qua nó. Lõi không export ra `index.ts`, module khác gọi hàm theo nghiệp vụ. Lõi:
- khoá dòng tồn theo `variantId` tăng dần (`lockLevels`), chỉ nhận biến thể thuộc công ty (`getVariants`; sai thì lỗi lập trình 500);
- `precheck` tuỳ chọn chạy sau khi khoá, trên số trước khi ghi; trả false thì không ghi gì (`reserve` nguyên kiện, `release`);
- ghi một dòng thẻ kho cho mỗi move, `balance_after` là số của ngăn đó sau move. Đang giữ không ghi thẻ kho;
- `version + 1` cho dòng tồn có move; SKU chỉ đổi đang giữ thì không tăng, vì `version` là `reorderVersion` của ngưỡng (Q24);
- tính lại giá vốn khi nhập `on_hand` có giá; tồn trước khi nhập ≤ 0 thì giá vốn bằng giá nhập;
- kiểm theo thứ tự: đang giữ âm (lỗi lập trình 500) → chờ xử lý âm → "không làm tệ hơn" (`domain/stock.ts` `worsens`: chặn khi sau khi ghi bất biến vỡ **và** phần hụt `đang giữ − tồn thực` tăng; Q14). Hai lỗi sau là `InsufficientStock`. `forced` (bàn giao bắt buộc) bỏ bước cuối. `invariant_broken` luôn bằng "bất biến đang vỡ sau khi ghi";
- phát `inventory.stock_changed { variantId, onHand, reserved, available }` một lần cho mỗi SKU có move `on_hand` (giữ, nhả không phát). Payload là số tuyệt đối sau khi ghi: bên nghe đọc lại `availableOf`, không cộng dồn;
- xét lại ngưỡng các SKU có tồn thực hoặc đang giữ đổi (`recheckThresholds`, Q15).

**Cảnh báo dưới ngưỡng** (V31, Documents/25 mục 7.5, `service/thresholds.ts`): dưới ngưỡng khi `có thể bán + đang về − còn thiếu cho đơn ≤ ngưỡng`, trừ SKU ngừng bán, lưu trữ. Chạm ngưỡng thì bật `alert_active` và phát `inventory.below_threshold` một lần; lên trên ngưỡng mới tắt. Xét lại khi ghi sổ, khi đặt ngưỡng, và khi purchasing đổi đang về (đề nghị vào/ra Đã đặt, Nhận một phần; ghi sổ phiếu nhận; đóng thiếu). Đang về lấy qua `setIncomingSource` do `product/index.ts` nối. Giữ, nhả hàng cho kiện cũng xét lại (qua lõi). Chưa xét lại khi catalog đổi trạng thái kinh doanh của SKU.

Lõi không tự chống gọi lặp: bên gọi chặn bằng chuyển trạng thái chứng từ có điều kiện trong cùng giao dịch. Cổng theo kiện có thêm lưới riêng (mục dưới).

## Phiếu do hệ thống lập (`service/system-documents.ts`, `service/shipment.ts`, `service/returns.ts`)

| Loại | Số | Lập khi | Trạng thái |
|---|---|---|---|
| `shipment` | `XK-000001` | `ship` | `posted`; mỗi dòng kiện một dòng phiếu, `source_line_id` = id dòng kiện, giá = giá vốn bình quân lúc khoá; `note` "Bàn giao bắt buộc theo sàn" khi `forced` |
| `shipment_reversal` | `DX-000001` | `reverseShipment` | `posted`; dòng giá = bình quân giá các dòng xuất của SKU trong lượt; `note` = lý do |
| `return_inspection` | `KT-000001` | `receiveBack` | `draft`; dòng có `expected_qty`, chưa có giá (ghi sổ ở #112) |

Mỗi loại một bộ đếm `doc_counters` (`docType` = tên loại). `created_at = clock_timestamp()` (giờ lúc chèn, sau khi khoá dòng tồn) vì **lượt đang xuất** của kiện (các phiếu `shipment` sau phiếu `shipment_reversal` gần nhất) sắp theo cột này. Mỗi phiếu ghi `state_transitions` (`stock_documents`, `null → posted|draft`). Thẻ kho của `XK`, `DX` trỏ `stock_document` + id dòng phiếu (`XK`: một dòng thẻ kho cho mỗi dòng kiện).

## Gọi vào

Mọi hàm chạy trong `withCompany` của bên gọi (`docs/superpowers/specs/2026-10-28-111-cong-ton-ghi-so-design.md`).
- `receiveGoods(receiptId, lines, actorId)`: phiếu nhận ghi sổ (#109); đạt vào tồn thực theo giá nhập, lỗi vào chờ xử lý (giá lưu trên thẻ kho, không vào giá vốn).
- `availableOf(variantIds)`: khả dụng của biến thể thuộc công ty; id lạ không có trong Map. Channel đẩy số này lên sàn.
- `recheckThresholds(variantIds)`: purchasing gọi sau khi đang về đổi.
- `stockOf(variantIds)`: các con số và giá vốn (chưa có dòng tồn thì 0); purchasing lấy giá cho `add-line`.
- `nextDocNumber(docType)`: số kế tiếp từ `doc_counters` dùng chung cả module lớn `product`; bên gọi ghép tiền tố (`DN-000001`).
- Cổng tồn theo kiện (Documents/21 mục 11.1; `lines` là `{ variantId, quantity }[]` (`ship` thêm `packageLineId`), gộp theo SKU khi kiểm và đổi đang giữ; `quantity` không nguyên dương, SKU công ty khác là lỗi lập trình 500):
  - `reserve(packageId, lines)` → `{ reserved }`: nguyên kiện, mọi SKU đủ khả dụng thì giữ hết, thiếu một SKU thì không giữ gì. `lines` rỗng trả `true`.
  - `release(packageId, lines)`: trừ đang giữ; nhả quá số đang giữ thì 500 kèm mã kiện, không ghi gì.
  - `ship(packageId, lines: { variantId, quantity, packageLineId }[], { actorId, forced? })` → `{ documentId, number }`: phiếu `XK`, trừ tồn thực và đang giữ. Kiện chưa giữ đủ mà không `forced` thì 500 trước khi lấy số phiếu. `forced`: trừ tồn thực, không trừ đang giữ, được vỡ bất biến. Lưới gọi lặp theo `packageLineId` (Q12): trong lượt đang xuất, đúng tập dòng kiện của một phiếu thì trả phiếu đó; không dòng nào đã trừ thì lập phiếu mới (dòng ghép SKU sau trùng SKU, số với lần trước vẫn được trừ); lẫn dòng đã trừ với dòng mới, hoặc `packageLineId` lặp trong một lần gọi, thì 500.
  - `reverseShipment(packageId, lines, { actorId, reason })` → `{ documentId, number }`: đảo cả lượt đang xuất, cộng lại tồn thực và đang giữ; `lines` phải gồm đúng mọi SKU của lượt với đúng tổng đã xuất (`25` §8.3 không đảo một phần), lệch hay không còn lượt thì 500; `reason` sau khi trim khác rỗng, ≤ 500 ký tự.
  - `receiveBack({ type: 'package' | 'return_request', id }, lines, meta?)` → `{ documentId, number }`: phiếu `KT` nháp, không đổi tồn; `meta` (#208) mang mã chứng từ nguồn, đơn, gian hàng, giá vốn dòng kiện gốc cho `inventory.return_inspected`; nguồn đã có phiếu thì trả phiếu đó. Mỗi nguồn tối đa một phiếu (unique một phần `stock_documents_return_inspection_source_uq`): lần gọi song song đụng unique thì lùi savepoint (không nhảy số), trả phiếu của bên commit trước; giao dịch bên gọi vẫn dùng tiếp được.
- `createQuarantineWriteOff(source, lines, note, actorId)`: xuất huỷ nháp từ chờ xử lý (phiếu trả NCC bị huỷ, #210).
- `createOpeningStocktake(shopId, { actorId })` (Documents/21 mục 11.3, #245): kiểm kê đầu kỳ nháp nguồn `shop_setup` cho channel (#198); gọi lại hoặc gọi đua trả phiếu đang mở (`created: false`, unique `stock_documents_opening_uq`). Phiếu do hệ thống lập (`created_by` null, `actorId` ghi ở lịch sử); người gửi duyệt thành người lập. Không giới hạn số dòng khi sửa.

## Bên gọi cổng theo kiện phải làm

- Khoá kiện (`FOR UPDATE`) trước khi gọi. Thứ tự khoá: kiện → dòng tồn theo `variantId` → `doc_counters`.
- Chống gọi lặp `reserve`, `release` (Q11): chỉ gọi `reserve` cho dòng có `reserved_qty = 0`, đặt `reserved_qty = quantity` khi nhận `true`; `release` ngược lại. Inventory cộng trừ đúng số được truyền, không có sổ giữ hàng riêng.
- `ship` gọi đúng một lần theo `stock_deducted` (Q12); giá vốn dòng kiện đọc `stockOf(...).avgCost` ngay sau `ship` trong cùng giao dịch (Q16).
- Mỗi dòng của `ship` mang đúng id dòng kiện (`package_lines.id`); dòng ghép SKU sau (`25` §8.4 quy tắc 3) trừ bằng một lần `ship` riêng chỉ gồm các dòng đó.
- Sau `reverseShipment`, đặt lại `reserved_qty = quantity`, `stock_deducted = false` cho dòng được đảo: inventory đã cộng lại đang giữ, kể cả khi lượt đó là bàn giao bắt buộc (Q17). Quên thì đang giữ kẹt mãi, khả dụng thấp hơn thật.

## Phiếu kho có duyệt (`service/documents.ts`, #208)

- Bảng chuyển ở `domain/stock-document.ts` (chép FE `src/lib/machines/stockDocument.ts`): duyệt, từ chối cần người khác người lập (kiểm hàng về và kiểm kê đầu kỳ: cột `created_by` đổi sang người gửi duyệt), CEO hoặc công ty một người tự duyệt được (`self_approved`, nhãn trong lịch sử, nhật ký, báo cáo CEO).
- Kiểm kê chụp tồn sổ của ngăn (`book_qty`) mỗi lần lưu; Δ = đếm − sổ. Duyệt kiểm kê được làm tồn âm (`applyMoves` `allowBreak`, 25 §7.1) và phát `inventory.stocktake_posted` (có `countedAt` là lúc lưu số đếm, `postedAt` trùng `posted_at`).
- Gửi duyệt xuất huỷ, chuyển chờ xử lý: thiếu khả dụng (hoặc chờ xử lý) thì 422 `stock_insufficient` theo dòng. Xuất huỷ chờ xử lý bị từ chối thì `needsDecision` tới khi `/decide` (nhập lại tồn, hoặc lập phiếu trả NCC nháp).
- Kiểm hàng về ghi sổ: bán lại vào tồn thực (giá vốn bình quân không đổi), hỏng và trả NCC vào chờ xử lý; hỏng sinh xuất huỷ nháp (nguồn là phiếu này), trả NCC sinh phiếu trả NCC nháp qua `setSupplierReturnPort` (purchasing import inventory nên nối ở `product/index.ts`); nguồn `return_request` thì phát `inventory.return_inspected`.
- Dòng phiếu chèn với `created_at` lệch từng mili giây để đọc đúng thứ tự nhập.

## Quyền ở API (`api/routes.ts`)

`inventory.stock.view` xem tồn (lọc `belowMin`, `quarantine`, `negative` gộp AND; `summary` không theo lọc) và thẻ kho; `inventory.reorder.manage` đặt ngưỡng. `inventory.cost.view` thấy giá vốn, giá trị tồn, giá trên thẻ kho (đọc từ DB mỗi request, `getAccess(res)`). `inventory.receipt.create`, `inventory.document.approve` dành cho phiếu kho (mục 15.3).

## Giới hạn đã biết

- Danh sách tồn lọc và phân trang trong bộ nhớ sau `getVariants()` (D10): ổn tới khoảng 2000 biến thể.
- `stockValue` ra JSON là `number`: trên ~9×10^15 đồng thì mất chính xác.
- Thứ tự khoá chỉ đúng **trong một lần gọi** cổng. Bên gọi gọi cổng nhiều lần trong một giao dịch (một đơn nhiều kiện) có thể deadlock với giao dịch khác: đã giữ `doc_counters` sau `ship` kiện 1 rồi mới khoá SKU của kiện 2. PostgreSQL huỷ một bên (`40P01`, 500), việc nền chạy lại; nếu hay gặp thì bên gọi khoá đủ SKU của mọi kiện trước.
- Dòng `doc_counters` loại `shipment` khoá tới khi giao dịch commit: mọi `ship` trong một công ty xếp hàng ở đó (chấp nhận ở tải vài trăm kiện mỗi ngày). Nếu thành nút thắt thì cấp số bằng sequence riêng (chấp nhận nhảy số). Xem phiên đang chờ khoá: `select pid, wait_event_type, wait_event, now() - xact_start as age, left(query, 80) from pg_stat_activity where wait_event_type = 'Lock';` (chỉ đọc).
- `lockedOf` vẫn bằng 0 tới B3, nên `reserve` có thể giữ cả phần lẽ ra đang tạm khoá cho phiếu kho chờ duyệt.
