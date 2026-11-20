# src/modules/product/purchasing/

Nhà cung cấp, đề nghị nhập (#108, sơ đồ A1), phiếu nhận (#109, A2), phiếu trả NCC (B4). Bảng nằm trong schema `product`. Hợp đồng API: `Documents/21` mục 16. Thiết kế: `docs/superpowers/specs/2026-10-28-108-de-nghi-nhap-design.md`. Phân hệ tuỳ chọn `purchasing`: tắt thì mọi quyền `purchasing.*` mất hiệu lực.

Hiện có: nhà cung cấp, báo cáo theo NCC, đề nghị nhập (lập, sửa, thêm dòng từ gợi ý nhập lại, loại dòng, chín thao tác của máy trạng thái), số "đang về", phiếu nhận (lập, kiểm đếm, ghi sổ, huỷ, ghi kết quả giao thiếu; `docs/superpowers/specs/2026-10-28-109-phieu-nhan-hang-design.md`). Ghi sổ lập phiếu trả NCC nháp cho hàng lỗi. Phiếu trả NCC đủ vòng đời (#210, `service/supplier-returns.ts`) và đề nghị bù hàng (`sourceReturnId`). Tệp đính kèm phiếu nhận (#212) qua module `files`.

## Quyền

| Thao tác | Mã quyền |
|---|---|
| Xem NCC, đề nghị | Một quyền `purchasing.*` bất kỳ (`anyOf`) |
| Thêm, sửa NCC; lập, sửa, gửi, rút, huỷ nháp; đặt NCC | `purchasing.request.manage` |
| Duyệt, trả về, từ chối, loại dòng, đóng thiếu, huỷ đề nghị đã duyệt | `purchasing.request.approve` |
| Thấy giá nhập (`unitCost`, `totalCost`) | `inventory.cost.view`, `purchasing.request.manage` hoặc `purchasing.request.approve`; còn lại `null` |
| Xem phiếu nhận, báo cáo NCC | Một quyền `purchasing.*` bất kỳ |
| Lập, kiểm đếm, ghi sổ, huỷ phiếu nhận | `purchasing.receipt.manage`; ghi sổ cần người khác người lập đề nghị, trừ CEO và công ty một người (`self_approved` trên phiếu) |
| Ghi kết quả giao thiếu | `purchasing.request.manage`; kết quả `close_short` cần thêm `purchasing.request.approve` |

Thao tác `POST /requests/:id/:action` và `POST /goods-receipts/:id/:action` chỉ kiểm quyền xem ở route; quyền của từng bước do `assertTransition` kiểm (bọc bởi `service/transitions.ts` `checkTransition`) theo `domain/request-machine.ts`, `domain/receipt-machine.ts`. Hai bảng chép từ FE `src/lib/machines/purchasing.ts`, thêm `allowSelfApproval` cho duyệt, trả về, từ chối, ghi sổ, và bước `resolve` của phiếu nhận (FE dùng route riêng `/short-resolution`).

## Bất biến

- **Còn chờ** của dòng = đặt − nhận − lỗi giữ − đóng thiếu (CHECK ≥ 0); dòng bị loại tính 0 (`domain/request.ts` `outstanding`). Dùng hàm này ở mọi chỗ, không tự trừ.
- **Đang về** của SKU = tổng còn chờ của dòng không bị loại thuộc đề nghị `ordered`, `partially_received`; tính khi đọc (`incomingOf`), không lưu.
- Đặt NCC (`order`) bắt buộc `expectedDeliveryDate` (422 `errors.expectedDeliveryDate`), lưu `supplierOrderCode` tuỳ chọn; loại dòng bắt buộc lý do (`excluded_reason`, 422 `reason_required`); đóng thiếu chỉ từ `partially_received`, đề nghị đã đặt chưa nhận lần nào thì huỷ (#243).
- Giá và dòng chỉ sửa ở `draft`, `changes_requested` (409 `not_draft`). `PUT` thay toàn bộ dòng. Nháp được để giá 0; gửi duyệt thì dòng còn hiệu lực phải > 0 (422 `errors["lines.i.unitCost"]`).
- Một SKU một dòng trong một đề nghị (unique `(request_id, variant_id)`); tên NCC không trùng theo chữ thường (`suppliers_company_lower_name_uq`).
- **Dòng sản phẩm mới** (#243, `Documents/21` mục 16.3): `newProduct { parentId, parentName, groupId, optionValues }`, đúng một trong `parentId` (cha có sẵn) và `parentName` (cha mới, cần `groupId`), Zod `.strict()`. Lưu `new_parent_product_id` hoặc `new_parent_name` (đã gộp khoảng trắng), `new_group_id` (chỉ cha mới), `new_option_values` dạng mảng `[{ axis, value }]` để giữ thứ tự trục (object jsonb tự sắp khoá); API nhận, trả `Record`. Luật gộp cha, trục, trùng tổ hợp do catalog kiểm (`validateNewProducts` lúc lập, sửa; `createPurchaseProducts` lúc duyệt, mục catalog). Lỗi ở `lines.<i>.newProduct.<trường>`; cha mới gộp quá 2 trục thì mã `too_many_axes`, còn lại `validation_failed`.
- Duyệt: dòng sản phẩm mới không bị loại sinh SKU (các dòng cùng cha mới sinh một sản phẩm cha) qua `catalog.createPurchaseProducts` trong cùng giao dịch, rồi điền `variant_id`; SKU ghi `source_request_line_id`. Lỗi khi duyệt (cha có thêm SKU cùng tổ hợp, tên vừa bị dùng) trả 422 kèm câu "Trả về cho người lập sửa dòng này" và rollback cả lần duyệt; SKU quá dài trả `lines.<i>` không kèm câu đó. Bản xem: `productName` là tên cha, `attributesLabel` ghép giá trị khi chưa có SKU; `newProduct.parentId` sau duyệt là cha của SKU.
- Số chứng từ lấy từ `inventory.nextDocNumber`: đề nghị `DN-000001` (`purchase_request`), phiếu nhận `NH-` (`goods_receipt`), phiếu trả NCC `TN-` (`supplier_return`).
- **Thứ tự khoá** của mọi thao tác ghi: bản ghi đề nghị (`lockRequest`, `FOR UPDATE`) → các dòng (`lockLines`) → phiếu nhận (`lockOwnReceipt` khoá cả ba theo thứ tự này) → khoá công ty của catalog → dòng tồn. So `version` sau khi khoá; lệch thì 409 `version_conflict` kèm `current`.
- Mỗi lần chuyển trạng thái ghi `recordTransition` (`purchase_requests`, `goods_receipts`, `supplier_returns`); lập, sửa ghi `recordAudit` (`product.purchase_requests`, `product.goods_receipts`, `product.suppliers`).

### Phiếu nhận

- Dòng phiếu sinh lúc lập, từ mỗi dòng đề nghị còn chờ (mọi số 0); `PUT` sửa số theo `lineId` là **id dòng đề nghị**. Chỉ sửa khi `counting` (409 `not_draft`). Đạt + lỗi + trả tại chỗ ≤ báo giao (CHECK); có thiếu, lỗi hoặc trả thì bắt buộc lý do. `shortage_qty` là cột tự tính.
- `deliveryMode` ở API là `waiting`/`left`, DB là `driver_waiting`/`driver_left` (`domain/receipt.ts`). Người giao đã đi thì `check_deadline = created_at + 24h` (repository tính).
- **Ghi sổ** (`post`, `post_short`, một giao dịch): kiểm lại `đạt + lỗi ≤ còn chờ` sau khi khoá các dòng đề nghị (422 `over_outstanding`, hai phiếu đua nhau thì phiếu sau trượt), cộng số nhận vào dòng đề nghị, `inventory.receiveGoods` (đạt vào tồn thực theo giá đề nghị, lỗi vào chờ xử lý), lập phiếu trả NCC nháp cho hàng lỗi (`created_by` trống, nguồn `receipt_defect`), rồi `applyReceiving` chuyển đề nghị sang nhận một phần hoặc nhận xong.
- **Tự Đã xử lý** (`autoResolveShort`, lịch sử `auto_resolve` nguồn hệ thống): đề nghị nhận xong thì mọi phiếu `short` sang `resolved` kết quả `follow_up` trỏ phiếu vừa ghi sổ (kể cả phiếu đang kiểm còn lại, chỉ có thiếu hoặc trả tại chỗ, ghi sổ sau khi đề nghị đã nhận xong: đề nghị giữ nguyên trạng thái); đề nghị đóng thiếu thì kết quả `close_short`, ghi chú là lý do.
- **Đóng thiếu** chỉ có một đường: `service/request-receiving.ts` `closeShortRequest`, dùng cho thao tác `close_short` của đề nghị và kết quả giao thiếu `close_short`. Còn phiếu đang kiểm thì 409 `receipt_counting`.
- Phiếu giao bù (#244): lập phiếu với `followsUpReceiptId` là phiếu `short` của cùng đề nghị (sai thì 422 `errors.followsUpReceiptId`), chỉ để tham chiếu; chi tiết trả `followsUp`.
- **Tệp đính kèm** (#212): `PUT` nhận `attachmentIds` thay toàn bộ, không gửi thì giữ nguyên. `confirmUploads` của `files` chạy **trước** `withCompany` (hỏi kho qua mạng), `attachmentProblem` trong giao dịch, lỗi vào `errors.attachments`; nhật ký `update` ghi `attachmentIds` trước và sau. Chi tiết phiếu trả `attachments` (link ký sẵn 15 phút).
- **Bằng chứng** (`domain/receipt.ts` `needsEvidence`): ghi sổ (`post`, `post_short`) phiếu `driver_left` có lỗi giữ hoặc thiếu mà chưa đính tệp nào thì 422 `evidence_required`, kiểm sau `empty_document`.

### Phiếu trả NCC (#210)

- Nguồn: hàng lỗi của phiếu nhận (`receipt_defect`, #109), kiểm hàng về (`customer_return`), xuất huỷ bị từ chối (`write_off_rejected`) do inventory gọi `draftSupplierReturn` qua `product/index.ts`; kho lập tay (`manual`) cho hàng ở chờ xử lý (số lượng không vượt chờ xử lý). Phiếu hệ thống lập có `created_by` trống; người gửi duyệt thành người lập.
- Bảng chuyển `domain/return-machine.ts`: duyệt và gửi, trả về khác người lập; ghi kết quả (hoàn tiền, bù hàng, không nhận) khác người gửi; CEO hoặc công ty một người tự làm được (`self_approved`, `result_self_approved`; CHECK `supplier_returns_result_by` cho qua khi tự duyệt).
- Tồn đổi qua `inventory.moveSupplierReturn`: duyệt và gửi trừ chờ xử lý; NCC không nhận cộng lại; huỷ chọn nhập lại thì chờ xử lý sang tồn thực theo giá vốn bình quân hiện tại (riêng hàng nguồn khách trả theo giá vốn trên dòng kiện, US-NH-15), chọn xuất huỷ thì `createQuarantineWriteOff` nháp. Chờ xử lý không đủ: 422 `stock_insufficient` theo dòng.
- Ghi hoàn tiền phát `purchasing.supplier_return_refunded { supplierReturnId, supplierId, refundAmount, recordedAt }` (sổ tiền nghe ở #228). Bù hàng: lập đề nghị với `sourceReturnId` (phiếu `replaced`, chưa có đề nghị bù, cùng NCC), đề nghị nguồn `replacement`, phiếu trả trỏ `replacement_request_id`.
- Nhắc khi đã gửi quá 14 ngày chưa có kết quả chưa làm: chờ khung nhắc việc của #209.

## Gọi vào và gọi ra

- Gọi ra: `inventory` (`nextDocNumber`, `stockOf` lấy giá vốn cho `add-line`, `receiveGoods` khi ghi sổ phiếu nhận, `recheckThresholds` sau khi đang về đổi: đề nghị vào/ra Đã đặt, Nhận một phần, ghi sổ phiếu nhận, đóng thiếu), `catalog` (`getVariants`, `validateNewProducts`, `createPurchaseProducts`, `groupNames`, `parentProducts`, `normalizeName`), `core` (máy trạng thái, lịch sử, audit, `canSelfApprove`, `publishEvent`, tệp đính kèm của `files`).
- Gọi vào: `inventory` nhận `incomingOf` qua `ctx` (`product/index.ts` bọc `withContext`), vì purchasing đã import inventory. Cảnh báo dưới ngưỡng nhận cùng hàm qua `setIncomingSource` lúc nạp `product/index.ts`.
- Gọi vào: catalog nhận `purchaseArchiveBlockers(variantIds)` qua `ctx` (`product/index.ts`, #204): câu lý do chặn lưu trữ SKU (đang về, đề nghị chưa xong, phiếu nhận `counting`, phiếu trả NCC `draft`/`pending_approval`/`sent`). Cùng cách đó `purchaseInUse(variantIds)`: SKU nằm trên dòng đề nghị, phiếu nhận, phiếu trả NCC ở mọi trạng thái, hoặc thuộc sản phẩm cha mà dòng sản phẩm mới của đề nghị nháp, chờ duyệt, bị trả về trỏ tới (#243; `new_parent_product_id` không có khoá ngoại) (catalog không xoá hẳn sản phẩm có SKU này).
- Gọi vào: thẻ kho của `inventory` nhận `purchaseDocumentNumbers({ goodsReceipts, supplierReturns })` qua `ctx` cùng cách đó (#206 phần 2a): số `NH-`, `TN-` theo id, tách theo loại; mỗi loại một câu, chỉ khi có id; id sai loại hoặc của công ty khác thì vắng.
- Phát `purchasing.request_submitted { requestId, number }` khi gửi và gửi lại; `notification` báo người có `purchasing.request.approve`.
- Phát `purchasing.goods_receipt_posted { receiptId, requestId, supplierId, postedAt, replacement, lines: { variantId, accepted, defective, unitPrice }[] }` khi ghi sổ phiếu nhận (chỉ dòng có đạt hoặc lỗi; `unitPrice` là giá dòng đề nghị, `replacement` khi đề nghị có `sourceReturnId`). Sổ tiền nghe để ghi khoản trả NCC (#357). `inventory.stock_changed` do inventory phát trong cùng giao dịch.
