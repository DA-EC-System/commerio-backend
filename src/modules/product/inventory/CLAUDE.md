# src/modules/product/inventory/

Các con số tồn, thẻ kho, phiếu kho, giá vốn bình quân, ngưỡng tồn. **Nơi duy nhất đổi số tồn.** Bảng nằm trong schema `product` (`Documents/19` mục 3.2). Hợp đồng API: `Documents/21` mục 15.

Hiện có: xem tồn, thẻ kho, đặt ngưỡng, lõi ghi sổ và ghi sổ theo phiếu nhận (#111), phiếu kho có duyệt (kiểm kê, xuất huỷ, chuyển chờ xử lý, kiểm hàng về; #208). Ghi sổ theo kiện làm ở issue vòng đời B2 (`Documents/21` mục 15–19). Phiếu nhập/xuất tay và giữ hàng theo đơn của mô hình cũ đã bỏ cùng bảng của chúng (28/10/2026).

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
- `receiveBack(source, lines, meta?)` (Documents/21 mục 11.1, #208): lập phiếu kiểm hàng về nháp, gọi lại cùng nguồn trả phiếu cũ; `meta` mang mã chứng từ nguồn, đơn, gian hàng, giá vốn dòng kiện gốc cho `inventory.return_inspected`. `createQuarantineWriteOff(source, lines, note, actorId)`: xuất huỷ nháp từ chờ xử lý (phiếu trả NCC bị huỷ, #210).
- `createOpeningStocktake(shopId, { actorId })` (Documents/21 mục 11.3, #245): kiểm kê đầu kỳ nháp nguồn `shop_setup` cho channel (#198); gọi lại hoặc gọi đua trả phiếu đang mở (`created: false`, unique `stock_documents_opening_uq`).
- `reserve`, `release`, `ship`, `reverseShipment` (Documents/21 mục 11.1): chữ ký đã chốt, hiện trả 501 `not_implemented` tới PR sau của #111.

## Phiếu kho có duyệt (`service/documents.ts`, #208)

- Bảng chuyển ở `domain/stock-document.ts` (chép FE `src/lib/machines/stockDocument.ts`): duyệt, từ chối cần người khác người lập (kiểm hàng về: khác người gửi duyệt phần thiếu, cột `created_by` đổi sang người gửi), CEO hoặc công ty một người tự duyệt được (`self_approved`, nhãn trong lịch sử, nhật ký, báo cáo CEO).
- Kiểm kê chụp tồn sổ của ngăn (`book_qty`) mỗi lần lưu; Δ = đếm − sổ. Duyệt kiểm kê được làm tồn âm (`applyMoves` `allowBreak`, 25 §7.1) và phát `inventory.stocktake_posted`.
- Gửi duyệt xuất huỷ, chuyển chờ xử lý: thiếu khả dụng (hoặc chờ xử lý) thì 422 `stock_insufficient` theo dòng. Xuất huỷ chờ xử lý bị từ chối thì `needsDecision` tới khi `/decide` (nhập lại tồn, hoặc lập phiếu trả NCC nháp).
- Kiểm hàng về ghi sổ: bán lại vào tồn thực (giá vốn bình quân không đổi), hỏng và trả NCC vào chờ xử lý; hỏng sinh xuất huỷ nháp (nguồn là phiếu này), trả NCC sinh phiếu trả NCC nháp qua `setSupplierReturnPort` (purchasing import inventory nên nối ở `product/index.ts`); nguồn `return_request` thì phát `inventory.return_inspected`.
- Dòng phiếu chèn với `created_at` lệch từng mili giây để đọc đúng thứ tự nhập.

## Quyền ở API (`api/routes.ts`)

`inventory.stock.view` xem tồn (lọc `belowMin`, `quarantine`, `negative` gộp AND; `summary` không theo lọc) và thẻ kho; `inventory.reorder.manage` đặt ngưỡng. `inventory.cost.view` thấy giá vốn, giá trị tồn, giá trên thẻ kho (đọc từ DB mỗi request, `getAccess(res)`). `inventory.receipt.create`, `inventory.document.approve` dành cho phiếu kho (mục 15.3).

## Giới hạn đã biết

- Danh sách tồn lọc và phân trang trong bộ nhớ sau `getVariants()` (D10): ổn tới khoảng 2000 biến thể.
- `stockValue` ra JSON là `number`: trên ~9×10^15 đồng thì mất chính xác.
