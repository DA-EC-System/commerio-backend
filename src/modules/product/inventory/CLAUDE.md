# src/modules/product/inventory/

Các con số tồn, thẻ kho, phiếu kho, giá vốn bình quân, ngưỡng tồn. **Nơi duy nhất đổi số tồn.** Bảng nằm trong schema `product` (`Documents/19` mục 3.2). Hợp đồng API: `Documents/21` mục 15.

Hiện có: xem tồn, thẻ kho, đặt ngưỡng. Phiếu kho có duyệt (kiểm kê, xuất huỷ, chuyển chờ xử lý, kiểm hàng về) và ghi sổ theo phiếu nhận, kiện làm ở các issue vòng đời B2, B3 (`Documents/21` mục 15–19). Phiếu nhập/xuất tay và giữ hàng theo đơn của mô hình cũ đã bỏ cùng bảng của chúng (28/10/2026).

## Con số và bất biến

| Số | Lưu ở | Ghi chú |
|---|---|---|
| Tồn thực `on_hand`, đang giữ `reserved`, chờ xử lý `quarantine` | `stock_levels` | Đang giữ có nguồn là dòng kiện (`order.package_lines.reserved_qty`) |
| Đang về | Tính khi đọc | Còn chờ của đề nghị nhập đã đặt NCC; `incomingOf` của purchasing tiêm qua `ctx` (`product/index.ts`), vì purchasing import inventory |
| Tạm khoá, đang thiếu | Tính khi đọc | Từ phiếu kho chờ duyệt, kiện thiếu hàng; tới khi có các nguồn đó thì bằng 0 (`service/views.ts`, `service/port.ts`) |
| Khả dụng | Tính | `max(0, tồn thực − đang giữ − tạm khoá)`, là số đẩy lên sàn |
| Ngưỡng `min_qty` | `stock_levels` | `null` = chưa đặt; `reorderVersion` là `version` của dòng tồn |

- CHECK `stock_levels_invariant`: tồn thực ≥ 0 và đang giữ ≤ tồn thực, trừ khi bật `invariant_broken` (cờ Tồn âm: bàn giao bắt buộc theo sàn, kiểm kê CEO đã duyệt; `25` §7.1). Chờ xử lý, đang giữ không bao giờ âm.
- Thẻ kho `stock_moves` chỉ thêm (role ứng dụng không UPDATE/DELETE). Mỗi dòng có ngăn (`on_hand`/`quarantine`), số dư sau biến động và chứng từ gốc (`source_type`, `source_id`, `source_line_id`).
- Giá vốn bình quân gia quyền (`domain/stock.ts`); DB lưu `numeric(18,2)`, API trả số nguyên đồng; `stockValue = round(onHand × avg_cost)` (V29, V30).
- Chỉ tạo dòng `stock_levels` cho biến thể đã qua `catalog.getVariants` của công ty. Khoá chính `(company_id, variant_id)`.

## Gọi vào

- `stockOf(variantIds)`: các con số và giá vốn của biến thể thuộc công ty (chưa có dòng tồn thì 0); purchasing dùng lấy giá cho `add-line`.
- `nextDocNumber(docType)`: số kế tiếp từ `doc_counters` dùng chung cả module lớn `product`; bên gọi ghép tiền tố (`DN-000001`).
- Cả hai chạy trong `withCompany` của bên gọi. Lõi ghi sổ, `availableOf`, cổng theo kiện làm ở phần sau của #111 (`docs/superpowers/specs/2026-10-28-111-cong-ton-ghi-so-design.md`).

## Quyền ở API (`api/routes.ts`)

`inventory.stock.view` xem tồn; `inventory.reorder.manage` đặt ngưỡng. `inventory.cost.view` thấy giá vốn, giá trị tồn, giá trên thẻ kho (đọc từ DB mỗi request, `getAccess(res)`). `inventory.receipt.create`, `inventory.document.approve` dành cho phiếu kho (mục 15.3).

## Giới hạn đã biết

- Danh sách tồn lọc và phân trang trong bộ nhớ sau `getVariants()` (D10): ổn tới khoảng 2000 biến thể.
- `stockValue` ra JSON là `number`: trên ~9×10^15 đồng thì mất chính xác.
