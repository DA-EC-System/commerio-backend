# src/modules/product/inventory/

Các con số tồn, thẻ kho, phiếu kho, giá vốn bình quân, ngưỡng tồn. **Nơi duy nhất đổi số tồn.** Bảng nằm trong schema `product` (`Documents/19` mục 3.2). Hợp đồng API: `Documents/21` mục 15.

Hiện có: xem tồn, thẻ kho, đặt ngưỡng, lõi ghi sổ và ghi sổ theo phiếu nhận (#111), cổng tồn theo kiện: giữ, nhả, bàn giao, đảo bàn giao, hàng quay về (#206, spec `docs/superpowers/specs/2026-11-06-206-cong-ton-theo-kien-design.md`). Phiếu kho có duyệt (kiểm kê, xuất huỷ, chuyển chờ xử lý, kiểm hàng về) làm ở các issue vòng đời B2, B3 (`Documents/21` mục 15–19). Phiếu nhập/xuất tay và giữ hàng theo đơn của mô hình cũ đã bỏ cùng bảng của chúng (28/10/2026).

## Con số và bất biến

| Số | Lưu ở | Ghi chú |
|---|---|---|
| Tồn thực `on_hand`, đang giữ `reserved`, chờ xử lý `quarantine` | `stock_levels` | Đang giữ có nguồn là dòng kiện (`order.package_lines.reserved_qty`) |
| Đang về | Tính khi đọc | Còn chờ của đề nghị nhập đã đặt NCC; `incomingOf` của purchasing tiêm qua `ctx` (`product/index.ts`), vì purchasing import inventory |
| Tạm khoá, đang thiếu | Tính khi đọc | Từ phiếu kho chờ duyệt, kiện thiếu hàng; tới khi có các nguồn đó thì bằng 0 (`service/views.ts`, `service/locked.ts`) |
| Khả dụng | Tính | `max(0, tồn thực − đang giữ − tạm khoá)`, là số đẩy lên sàn |
| Ngưỡng `min_qty` | `stock_levels` | `null` = chưa đặt; `reorderVersion` là `version` của dòng tồn |

- CHECK `stock_levels_invariant`: tồn thực ≥ 0 và đang giữ ≤ tồn thực, trừ khi bật `invariant_broken` (cờ Tồn âm: bàn giao bắt buộc theo sàn, kiểm kê CEO đã duyệt; `25` §7.1). Chờ xử lý, đang giữ không bao giờ âm.
- Thẻ kho `stock_moves` chỉ thêm (role ứng dụng không UPDATE/DELETE). Mỗi dòng có ngăn (`on_hand`/`quarantine`), số dư sau biến động và chứng từ gốc (`source_type`, `source_id`, `source_line_id`).
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

## Phiếu do hệ thống lập (`service/documents.ts`, `service/shipment.ts`, `service/returns.ts`)

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
  - `reverseShipment(packageId, lines, { actorId, reason })` → `{ documentId, number }`: đảo lượt đang xuất, cộng lại tồn thực và đang giữ; mỗi SKU không quá số của lượt; không còn lượt thì 500; `reason` sau khi trim khác rỗng, ≤ 500 ký tự.
  - `receiveBack({ type: 'package' | 'return_request', id }, lines)` → `{ documentId, number }`: phiếu `KT` nháp, không đổi tồn; nguồn đã có phiếu thì trả phiếu đó.

## Bên gọi cổng theo kiện phải làm

- Khoá kiện (`FOR UPDATE`) trước khi gọi. Thứ tự khoá: kiện → dòng tồn theo `variantId` → `doc_counters`.
- Chống gọi lặp `reserve`, `release` (Q11): chỉ gọi `reserve` cho dòng có `reserved_qty = 0`, đặt `reserved_qty = quantity` khi nhận `true`; `release` ngược lại. Inventory cộng trừ đúng số được truyền, không có sổ giữ hàng riêng.
- `ship` gọi đúng một lần theo `stock_deducted` (Q12); giá vốn dòng kiện đọc `stockOf(...).avgCost` ngay sau `ship` trong cùng giao dịch (Q16).
- Mỗi dòng của `ship` mang đúng id dòng kiện (`package_lines.id`); dòng ghép SKU sau (`25` §8.4 quy tắc 3) trừ bằng một lần `ship` riêng chỉ gồm các dòng đó.
- Sau `reverseShipment`, đặt lại `reserved_qty = quantity`, `stock_deducted = false` cho dòng được đảo: inventory đã cộng lại đang giữ, kể cả khi lượt đó là bàn giao bắt buộc (Q17). Quên thì đang giữ kẹt mãi, khả dụng thấp hơn thật.
- Chuyển trạng thái kiện, yêu cầu trả có điều kiện trước `receiveBack`: hàm này không khoá gì, hai lần gọi song song cùng nguồn sẽ lập hai phiếu.

## Quyền ở API (`api/routes.ts`)

`inventory.stock.view` xem tồn; `inventory.reorder.manage` đặt ngưỡng. `inventory.cost.view` thấy giá vốn, giá trị tồn, giá trên thẻ kho (đọc từ DB mỗi request, `getAccess(res)`). `inventory.receipt.create`, `inventory.document.approve` dành cho phiếu kho (mục 15.3).

## Giới hạn đã biết

- Danh sách tồn lọc và phân trang trong bộ nhớ sau `getVariants()` (D10): ổn tới khoảng 2000 biến thể.
- `stockValue` ra JSON là `number`: trên ~9×10^15 đồng thì mất chính xác.
- Thứ tự khoá chỉ đúng **trong một lần gọi** cổng. Bên gọi gọi cổng nhiều lần trong một giao dịch (một đơn nhiều kiện) có thể deadlock với giao dịch khác: đã giữ `doc_counters` sau `ship` kiện 1 rồi mới khoá SKU của kiện 2. PostgreSQL huỷ một bên (`40P01`, 500), việc nền chạy lại; nếu hay gặp thì bên gọi khoá đủ SKU của mọi kiện trước.
- Dòng `doc_counters` loại `shipment` khoá tới khi giao dịch commit: mọi `ship` trong một công ty xếp hàng ở đó (chấp nhận ở tải vài trăm kiện mỗi ngày). Nếu thành nút thắt thì cấp số bằng sequence riêng (chấp nhận nhảy số). Xem phiên đang chờ khoá: `select pid, wait_event_type, wait_event, now() - xact_start as age, left(query, 80) from pg_stat_activity where wait_event_type = 'Lock';` (chỉ đọc).
- `lockedOf` vẫn bằng 0 tới B3, nên `reserve` có thể giữ cả phần lẽ ra đang tạm khoá cho phiếu kho chờ duyệt.
- `reverseShipment` đảo theo lượt; đảo một phần rồi đảo tiếp phần còn lại chưa hỗ trợ (`25` §8.3 đảo cả kiện).
