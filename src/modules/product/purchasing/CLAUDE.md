# src/modules/product/purchasing/

Nhà cung cấp, đề nghị nhập (#108, sơ đồ A1), phiếu nhận (#109, A2), phiếu trả NCC (B4). Bảng nằm trong schema `product`. Hợp đồng API: `Documents/21` mục 16. Thiết kế: `docs/superpowers/specs/2026-10-28-108-de-nghi-nhap-design.md`. Phân hệ tuỳ chọn `purchasing`: tắt thì mọi quyền `purchasing.*` mất hiệu lực.

Hiện có: nhà cung cấp, đề nghị nhập (lập, sửa, thêm dòng từ gợi ý nhập lại, loại dòng, chín thao tác của máy trạng thái), số "đang về". Phiếu nhận, phiếu trả NCC, đề nghị bù hàng (`sourceReturnId`) chưa làm.

## Quyền

| Thao tác | Mã quyền |
|---|---|
| Xem NCC, đề nghị | Một quyền `purchasing.*` bất kỳ (`anyOf`) |
| Thêm, sửa NCC; lập, sửa, gửi, rút, huỷ nháp; đặt NCC | `purchasing.request.manage` |
| Duyệt, trả về, từ chối, loại dòng, đóng thiếu, huỷ đề nghị đã duyệt | `purchasing.request.approve` |
| Thấy giá nhập (`unitCost`, `totalCost`) | `inventory.cost.view`, `purchasing.request.manage` hoặc `purchasing.request.approve`; còn lại `null` |

Thao tác `POST /requests/:id/:action` chỉ kiểm quyền xem ở route; quyền của từng bước do `assertTransition` kiểm theo `domain/request-machine.ts` (chép bảng FE `src/lib/machines/purchasing.ts`, thêm `allowSelfApproval` cho duyệt, trả về, từ chối).

## Bất biến

- **Còn chờ** của dòng = đặt − nhận − lỗi giữ − đóng thiếu (CHECK ≥ 0); dòng bị loại tính 0 (`domain/request.ts` `outstanding`). Dùng hàm này ở mọi chỗ, không tự trừ.
- **Đang về** của SKU = tổng còn chờ của dòng không bị loại thuộc đề nghị `ordered`, `partially_received`; tính khi đọc (`incomingOf`), không lưu.
- Giá và dòng chỉ sửa ở `draft`, `changes_requested` (409 `not_draft`). `PUT` thay toàn bộ dòng. Nháp được để giá 0; gửi duyệt thì dòng còn hiệu lực phải > 0 (422 `errors["lines.i.unitCost"]`).
- Một SKU một dòng trong một đề nghị (unique `(request_id, variant_id)`); tên NCC không trùng theo chữ thường (`suppliers_company_lower_name_uq`).
- Duyệt: dòng sản phẩm mới sinh sản phẩm và một biến thể không thuộc tính qua `catalog.createPurchaseProducts` trong cùng giao dịch; tên vừa bị dùng thì 422 và rollback cả lần duyệt.
- Số chứng từ `DN-000001` lấy từ `inventory.nextDocNumber('purchase_request')`.
- **Thứ tự khoá** của mọi thao tác ghi: bản ghi đề nghị (`lockRequest`, `FOR UPDATE`) → các dòng → phiếu nhận → khoá công ty của catalog → dòng tồn. So `version` sau khi khoá; lệch thì 409 `version_conflict` kèm `current`.
- Mỗi lần chuyển trạng thái ghi `recordTransition` (`entityType: 'purchase_requests'`); lập, sửa, loại dòng ghi `recordAudit` (`product.purchase_requests`, `product.suppliers`).

## Gọi vào và gọi ra

- Gọi ra: `inventory` (`nextDocNumber`, `stockOf` lấy giá vốn cho `add-line`), `catalog` (`getVariants`, `validateNewProducts`, `createPurchaseProducts`, `categoryNames`), `core` (máy trạng thái, lịch sử, audit, `canSelfApprove`, `publishEvent`).
- Gọi vào: `inventory` nhận `incomingOf` qua `ctx` (`product/index.ts` bọc `withContext`), vì purchasing đã import inventory.
- Phát `purchasing.request_submitted { requestId, number }` khi gửi và gửi lại; `notification` báo người có `purchasing.request.approve`.
