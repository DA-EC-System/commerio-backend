# src/modules/inventory/

Tồn, giữ hàng, phiếu nhập/xuất/nhập hoàn, giá vốn bình quân, ngưỡng tồn (UC-IN-01..03, issue #16). **Nơi duy nhất đổi số tồn.** Hợp đồng API: `Documents/21` mục 7; hợp đồng hàm cho module khác: `Documents/21` §11.

## Bất biến

- `available = on_hand − reserved`; `on_hand ≥ 0`, `0 ≤ reserved ≤ on_hand` (CHECK trong DB là lưới cuối, code kiểm trước để trả lỗi rõ).
- Tồn chỉ đổi khi ghi sổ (phiếu `done`) hoặc giữ/trả hàng. Phiếu đã ghi sổ không sửa, không huỷ; sai thì lập phiếu ngược (K10).
- Mỗi dòng `stock_moves` trỏ đúng một dòng phiếu; bảng chỉ thêm (role ứng dụng không UPDATE/DELETE).
- Giá vốn bình quân gia quyền, tính lại khi ghi sổ phiếu nhập tay; xuất và nhập hoàn lấy giá vốn hiện tại (K2). DB lưu `numeric(18,2)` làm tròn nửa lên; API trả số nguyên đồng; `stockValue = round(onHand × avg_cost của DB)` (V29, V30).
- Chỉ tạo dòng `stock_levels`/`reorder_rules` cho biến thể đã qua `catalog.getVariants` của công ty (phiếu tay, ngưỡng) hoặc lấy từ giữ chỗ/phiếu của chính công ty (hàm biên). `reserve` không tạo dòng tồn: biến thể chưa từng nhập coi như khả dụng 0. Khoá chính `(company_id, variant_id)` (CB-4) là lưới thứ hai.

## Ghi sổ (`service/posting.ts`)

`applyStockMoves({ direction, cost, fromReserved?, doneBy, lines })` là khung chung (Template Method dạng hàm, docs/16 #10): khoá tồn → kiểm khả dụng → giá vốn → cập nhật tồn → thẻ kho → `applyAvailableChange` (sự kiện, ngưỡng). Thêm loại phiếu mới thì gọi khung này, không tự cập nhật `stock_levels`.

**Thứ tự khoá chung** (chống deadlock): phiếu có sẵn thì khoá phiếu (`SELECT … FOR UPDATE`), phiếu mới thì `doc_counters` rồi chèn phiếu → `stock_levels` theo `variant_id` tăng dần → `reservations` → `reorder_rules`. Cần tập biến thể của đơn thì đọc `reservations` **không khoá** trước, khoá `stock_levels`, rồi mới `UPDATE reservations … RETURNING` và dùng số trả về; biến thể trả về mà chưa khoá thì khoá thêm. Số đang giữ để tính thêm/bớt thì đọc **sau** khoá.

## Sự kiện phát (qua `platform.publishEvent`, cùng giao dịch)

| Loại | Khi nào |
|---|---|
| `inventory.stock_changed` | Mỗi lần khả dụng của một biến thể đổi (ghi sổ, giữ hàng, trả giữ chỗ). Xuất theo đơn không đổi khả dụng nên không phát |
| `inventory.below_threshold` | Khả dụng vừa xuống dưới `min_qty` (`alert_active` false → true); lên lại ≥ ngưỡng thì `alert_active = false`; đặt ngưỡng khi đã dưới thì phát ngay (V31) |
| `inventory.receipt_posted`, `inventory.issue_posted` | Mỗi phiếu nhập/xuất ghi sổ (tay, theo đơn, nhập hoàn) |

Không nghe sự kiện nào.

## Hàm cho module khác (`index.ts`), gọi trong `withCompany` của bên gọi

| Hàm | Ai gọi | Hành vi |
|---|---|---|
| `reserve(orderId, lines)` | sales (#24) | Giữ **tới** số yêu cầu mỗi biến thể (gọi lại không cộng dồn; có hàng thêm thì giữ bù). Trả `shortLines { variantId, requested, available }` cho dòng chưa đủ, `available` = số đang giữ được cho đơn. Dòng trùng biến thể được cộng lại. Đơn đã xuất kho thì không giữ thêm (dòng vào `shortLines`) |
| `release(orderId)` | sales/fulfillment (huỷ đơn) | Trả mọi giữ chỗ `active`; gọi lại không lỗi |
| `issueForOrder(orderId, { actorId? })` | fulfillment (#25) | Lập và ghi sổ phiếu `PX-…` `kind = 'order'` từ phần đang giữ, giá vốn lúc xuất. Đơn đã có phiếu chưa huỷ → trả phiếu đó (kể cả gọi đồng thời). Không có giữ chỗ → 409 `not_reserved` |
| `receiveReturn(orderId, lines, { note?, actorId? })` | fulfillment (#25, API `/inventory/returns`) | Phiếu `PN-…` `kind = 'delivery_return'` đã ghi sổ, giá vốn hiện tại, không đổi bình quân. Dòng số 0 bị bỏ; mọi dòng 0 → 422 `errors.lines`; vượt số đã xuất → 422 `errors["lines.<i>.quantity"]`; biến thể không có trong phiếu xuất → 422 `errors["lines.<i>.variantId"]`; khác số đã xuất mà không ghi chú → 422 `errors.note`. Đơn chưa có phiếu xuất đã ghi sổ → 409 `not_issued`; đã có phiếu nhập hoàn chưa huỷ → 409 `already_processed` |
| `getOrderCogs(orderIds)` | report (#29) | Giá vốn đã xuất của từng đơn: Σ `quantity × unit_cost` phiếu xuất theo đơn đã ghi sổ; đơn chưa xuất vắng mặt (`service/daily-totals.ts`) |

Hàm biên không ghi nhật ký thao tác (bên gọi ghi thao tác của họ) và không kiểm `orderId` có thật (đơn là của sales). `reference` (mã đơn) của phiếu theo đơn để trống: chữ ký chưa nhận mã đơn.

## Quyền ở API (`api/routes.ts`)

`inventory.stock.view` xem tồn và phiếu; `inventory.receipt.create` lập, sửa, ghi sổ, huỷ phiếu; `inventory.reorder.manage` đặt ngưỡng. Hai quyền đổi dữ liệu trả về đọc từ DB mỗi request bằng `identity.loadCompanyAccess` (D1): `inventory.cost.view` thấy giá vốn, giá trị tồn, giá trên thẻ kho và mọi dòng phiếu; chỉ có `inventory.receipt.create` thì thấy giá nhập trên phiếu nhập tay.

## Giới hạn đã biết

- Danh sách tồn lọc và phân trang trong bộ nhớ sau `getVariants()` (D10): ổn tới khoảng 2000 biến thể.
- `reorderVersion` về 0 khi bỏ ngưỡng; xoá rồi đặt lại thì một bản cũ cùng số `version` có thể ghi đè mà không 409 (ABA, chấp nhận theo V33).
- `stockValue` ra JSON là `number`: trên ~9×10^15 đồng thì mất chính xác.
- `release`/`issueForOrder` khoá thêm biến thể mà `reserve` cùng đơn vừa thêm giữa lúc đọc và lúc khoá; khoá thêm này không theo thứ tự `variant_id` nên khi có giao dịch thứ ba chen đúng lúc, PostgreSQL có thể báo deadlock (`40P01`, 500). Hiếm (cần gọi đồng thời trên cùng đơn); bên gọi (#24, #25) thử lại giao dịch.
- Hàm biên ném lỗi nghiệp vụ (409, 422) thì bên gọi phải rollback giao dịch, không bắt lỗi rồi commit tiếp.
- Lỗi dạng (Zod: kiểu, giới hạn số) báo trước; luật theo loại phiếu, dòng trùng và biến thể không còn bán báo chung một lượt sau đó.
