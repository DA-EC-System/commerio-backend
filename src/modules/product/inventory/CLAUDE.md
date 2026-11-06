# src/modules/product/inventory/

Các con số tồn, thẻ kho, phiếu kho, giá vốn bình quân, ngưỡng tồn. **Nơi duy nhất đổi số tồn.** Bảng nằm trong schema `product` (`Documents/19` mục 3.2). Hợp đồng API: `Documents/21` mục 15.

Hiện có: xem tồn, thẻ kho, đặt ngưỡng, lõi ghi sổ và ghi sổ theo phiếu nhận (#111). Phiếu kho có duyệt (kiểm kê, xuất huỷ, chuyển chờ xử lý, kiểm hàng về) và ghi sổ theo kiện làm ở các issue vòng đời B2, B3 (`Documents/21` mục 15–19). Phiếu nhập/xuất tay và giữ hàng theo đơn của mô hình cũ đã bỏ cùng bảng của chúng (28/10/2026).

## Con số và bất biến

| Số | Lưu ở | Ghi chú |
|---|---|---|
| Tồn thực `on_hand`, đang giữ `reserved`, chờ xử lý `quarantine` | `stock_levels` | Đang giữ có nguồn là dòng kiện (`order.package_lines.reserved_qty`) |
| Đang về | Tính khi đọc | Còn chờ của đề nghị nhập đã đặt NCC; `incomingOf` của purchasing tiêm qua `ctx` (`product/index.ts`), vì purchasing import inventory |
| Tạm khoá, đang thiếu | Tính khi đọc | Từ phiếu kho chờ duyệt, kiện thiếu hàng; tới khi có các nguồn đó thì bằng 0 (`service/views.ts`, `service/port.ts`) |
| Khả dụng | Tính | `max(0, tồn thực − đang giữ − tạm khoá)`, là số đẩy lên sàn |
| Ngưỡng `min_qty` | `stock_levels` | `null` = chưa đặt; `reorderVersion` là `version` của dòng tồn |
| Lệch tồn `drift` | Chưa có | Luôn `false` tới #206 phần 2b (cần dữ liệu đẩy tồn của `channel`) |

- CHECK `stock_levels_invariant`: tồn thực ≥ 0 và đang giữ ≤ tồn thực, trừ khi bật `invariant_broken` (cờ Tồn âm: bàn giao bắt buộc theo sàn, kiểm kê CEO đã duyệt; `25` §7.1). Chờ xử lý, đang giữ không bao giờ âm.
- Thẻ kho `stock_moves` chỉ thêm (role ứng dụng không UPDATE/DELETE). Mỗi dòng có ngăn (`on_hand`/`quarantine`), số dư sau biến động và chứng từ gốc (`source_type`, `source_id`, `source_line_id`).
- API thẻ kho (`getStock`) đổi tên theo FE: ngăn `on_hand` ra `area: 'stock'`, `balance_after` ra `onHandAfter`. `document.type` là loại phiếu kho hoặc `goods_receipt`/`supplier_return`; `document.kind` suy ra, không lưu (`domain/moves.ts`). Số phiếu tra theo lô: phiếu kho đọc `stock_documents` (`repository/move-sources.ts`), phiếu nhận và phiếu trả NCC qua `purchaseDocumentNumbers` của purchasing, tiêm vào `ctx` cạnh `incomingOf`. Dòng trỏ chứng từ không tồn tại thì 500.
- Giá vốn bình quân gia quyền (`domain/stock.ts`); DB lưu `numeric(18,2)`, API trả số nguyên đồng; `stockValue = round(onHand × avg_cost)` (V29, V30).
- Chỉ tạo dòng `stock_levels` cho biến thể đã qua `catalog.getVariants` của công ty. Khoá chính `(company_id, variant_id)`.

## Ghi sổ (`service/posting.ts`)

Mọi thay đổi `on_hand`, `quarantine` đi qua lõi `applyMoves`; lõi không export ra `index.ts`, module khác gọi hàm theo nghiệp vụ. Lõi:
- khoá dòng tồn theo `variantId` tăng dần (`lockLevel`), chỉ nhận biến thể thuộc công ty (`getVariants`; sai thì lỗi lập trình 500);
- ghi một dòng thẻ kho cho mỗi move, `balance_after` là số của ngăn đó sau move, `version + 1` cho dòng tồn;
- tính lại giá vốn khi nhập `on_hand` có giá; tồn trước khi nhập ≤ 0 thì giá vốn bằng giá nhập;
- bất biến "không làm tệ hơn" (`domain/stock.ts` `worsens`): chặn khi tồn thực giảm mà vỡ bất biến, hoặc chờ xử lý âm (`InsufficientStock`); tăng thì luôn qua và tự tắt `invariant_broken` khi bất biến đúng lại;
- phát `inventory.stock_changed { variantId, onHand, reserved, available }` một lần cho mỗi SKU có move `on_hand`. Payload là số tuyệt đối: bên nghe đọc lại `availableOf`, không cộng dồn.
- xét lại ngưỡng các SKU có move `on_hand` (`recheckThresholds`).

**Cảnh báo dưới ngưỡng** (V31, Documents/25 mục 7.5, `service/thresholds.ts`): dưới ngưỡng khi `có thể bán + đang về − còn thiếu cho đơn ≤ ngưỡng`, trừ SKU ngừng bán, lưu trữ. Chạm ngưỡng thì bật `alert_active` và phát `inventory.below_threshold` một lần; lên trên ngưỡng mới tắt. Xét lại khi ghi sổ, khi đặt ngưỡng, và khi purchasing đổi đang về (đề nghị vào/ra Đã đặt, Nhận một phần; ghi sổ phiếu nhận; đóng thiếu). Đang về lấy qua `setIncomingSource` do `product/index.ts` nối. Chưa xét lại khi catalog đổi trạng thái kinh doanh của SKU; `reserve`, `release` khi có thân phải gọi `recheckThresholds`.

Không tự chống gọi lặp: bên gọi chặn bằng chuyển trạng thái chứng từ có điều kiện trong cùng giao dịch.

## Gọi vào

Mọi hàm chạy trong `withCompany` của bên gọi (`docs/superpowers/specs/2026-10-28-111-cong-ton-ghi-so-design.md`).
- `receiveGoods(receiptId, lines, actorId)`: phiếu nhận ghi sổ (#109); đạt vào tồn thực theo giá nhập, lỗi vào chờ xử lý (giá lưu trên thẻ kho, không vào giá vốn).
- `availableOf(variantIds)`: khả dụng của biến thể thuộc công ty; id lạ không có trong Map. Channel đẩy số này lên sàn.
- `recheckThresholds(variantIds)`: purchasing gọi sau khi đang về đổi.
- `stockOf(variantIds)`: các con số và giá vốn (chưa có dòng tồn thì 0); purchasing lấy giá cho `add-line`.
- `nextDocNumber(docType)`: số kế tiếp từ `doc_counters` dùng chung cả module lớn `product`; bên gọi ghép tiền tố (`DN-000001`).
- `reserve`, `release`, `ship`, `reverseShipment`, `receiveBack` (Documents/21 mục 11.1): chữ ký đã chốt, hiện trả 501 `not_implemented` tới PR sau của #111.

## Quyền ở API (`api/routes.ts`)

`inventory.stock.view` xem tồn (lọc `belowMin`, `quarantine`, `negative` gộp AND; `summary` không theo lọc) và thẻ kho; `inventory.reorder.manage` đặt ngưỡng. `inventory.cost.view` thấy giá vốn, giá trị tồn, giá trên thẻ kho (đọc từ DB mỗi request, `getAccess(res)`). `inventory.receipt.create`, `inventory.document.approve` dành cho phiếu kho (mục 15.3).

## Giới hạn đã biết

- Danh sách tồn lọc và phân trang trong bộ nhớ sau `getVariants()` (D10): ổn tới khoảng 2000 biến thể.
- `stockValue` ra JSON là `number`: trên ~9×10^15 đồng thì mất chính xác.
