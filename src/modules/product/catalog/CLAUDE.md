# src/modules/product/catalog/

Danh mục (kèm quy tắc SKU), thuộc tính và giá trị, sản phẩm, biến thể (UC-CP-01, 02, 04). Hợp đồng API: `Documents/21` mục 5, bộ ví dụ SKU mục 9. API gắn tại `/api/v1/catalog`.

## Quyền

| Thao tác | Mã quyền |
|---|---|
| Mọi `GET` | `catalog.product.view` (CEO, Admin, Sale, Nhân viên kho) |
| Ghi danh mục, thuộc tính | `catalog.category.manage` |
| Ghi sản phẩm, biến thể | `catalog.product.manage` |

Bản ghi của công ty khác trả 404 (RLS không thấy); id không phải uuid cũng 404.

## Bất biến

- **SKU** sinh bằng `domain/sku.ts`, chép đúng `FE src/utils/sku.ts` (D9). Đổi một bên thì đổi bên kia và bảng mục 9, test `test/unit/modules/catalog/domain/sku.test.ts`.
- **SKU duy nhất trong công ty, không bao giờ cấp lại**: biến thể ngừng bán giữ SKU; SKU đã có (kể cả của danh mục khác cùng quy tắc) thì bỏ số đó, lấy số kế tiếp, mỗi lần thử tiêu một số (D9).
- **Khoá theo công ty** (`lockVariants`, `pg_advisory_xact_lock`) lấy ở **đầu** giao dịch của mọi thao tác đổi tập biến thể hoặc trạng thái kinh doanh do người dùng gọi: tạo sản phẩm, thêm biến thể, `business-status`. Thiếu khoá thì hai request song song cấp trùng số, tạo trùng tổ hợp hoặc cùng đọc một trạng thái cũ. Hệ thống tự khôi phục không lấy khoá này (mục Trạng thái kinh doanh).
- `sku_next_seq` tăng khi cấp SKU nhưng **không** đổi `version` danh mục; thêm/ngừng biến thể **không** đổi `version` sản phẩm, chỉ đổi `updated_at` (P7).
- **Thứ tự thuộc tính** của sản phẩm = thứ tự giá trị trong biến thể đầu lúc tạo, lưu ở `variant_attribute_values.position`; biến thể sau được sắp lại theo đó trước khi ghép `{VAL}`.
- **Thứ tự giá trị và biến thể** trong một request giữ bằng `created_at = now() + i µs` (`orderedNow`): bảng không có cột thứ tự. Đổi thứ tự giá trị cũ khi `PUT` không được lưu.
- **Lưu trữ sản phẩm cha** (kiểu cũ, tới PR 3 của #204): `DELETE /products/:id` đặt `products.archived_at` (tăng `version`); sản phẩm lưu trữ thì mọi thao tác ghi trả `product_archived` **trước** `version_conflict`.
- Tên danh mục, thuộc tính, sản phẩm không trùng theo chữ thường trong công ty (`name_taken`). Tên của sản phẩm đã lưu trữ dùng lại được; index unique một phần cho việc này do CB-4 thêm.
- `productCount` của danh mục và thuộc tính, `inUse` của giá trị tính cả sản phẩm lưu trữ, biến thể ngừng bán (cùng điều kiện với `in_use` khi xoá, V25).
- **Khoá ngoại bỏ qua RLS** (kiểm bằng quyền chủ bảng): luôn đọc bản ghi cha (danh mục, giá trị thuộc tính) trong `withCompany` trước khi chèn con; không thấy thì 422.
- **Ảnh** (#303, bảng `product_images`, `service/product-images.ts`): tối đa 9 ảnh (P8), `position` 0 là ảnh đại diện. Số ảnh và ảnh lặp kiểm ở Zod (`imageLimits`, trước mọi lời gọi kho). `POST`/`PUT` gọi `confirmUploads` của `files` **trước** giao dịch, rồi `fileProblem(ids, 'product_image', 9)` trong giao dịch (tệp của công ty, đã PUT xong, còn đúng JPG/PNG ≤ 1 MB); lỗi ở `errors.images`. `PUT` không gửi `imageFileIds` thì giữ nguyên, gửi thì thay toàn bộ sau khi ghi trúng `version`; gỡ ảnh không xoá tệp. Link ảnh từ `publicFileUrls` của `files` (không join `core.files`); thiếu `S3_PUBLIC_URL` thì `url: ''`, `thumbnailUrl: null`. Danh sách lấy ảnh đại diện bằng subquery `thumbnailFileId` và một lần `publicFileUrls` cho cả trang. Nhật ký ghi `imageFileIds`. Dọn ảnh không gắn (P9) là issue riêng.
- **Sửa SKU** (`PATCH /products/:id/variants/:variantId`, #204, `Documents/21` §17.2): `version` là của SKU; ghi được thì tăng `version` SKU, đổi `updated_at` của cha, **không** đổi `version` cha (P7). Chỉ ghi trường khác giá trị đang lưu (giá so bằng `Decimal`); không trường nào khác thì không ghi, không kiểm `version`, trả 200 bản hiện tại (gửi lại PATCH đã thành công không 409). Nhật ký chỉ gồm trường đổi, theo dạng API. Chưa nhận `imageFileId` (spec 204 D1). SKU đã ngừng bán vẫn sửa được; sản phẩm lưu trữ trả `product_archived`.
- `product_has_active_orders` chưa kiểm (#24).

## Trạng thái kinh doanh (#204, `Documents/21` §17.2, §17.3)

- Lưu theo SKU (`business_status`, CHECK khớp `archived_at`). Máy trạng thái ở `domain/business-status.ts`, chép đúng FE `src/lib/machines/product.ts`: 6 thao tác, quyền `catalog.product.manage`. `archive` chỉ từ `discontinued`; `restore` về `discontinued`.
- `POST /products/:id/business-status { action, variantIds? }` (`service/business-status.ts`): bỏ `variantIds` là áp cho mọi SKU con; SKU không làm được vào `skipped` (`invalid_transition`, hoặc `archive_blocked` kèm `reasons`). Đúng một `variantIds` mà không làm được thì 409 như máy trạng thái khác (`invalid_transition` kèm `current` là `ProductDetail`). `variantIds` lặp, sai dạng, của sản phẩm khác: 422 `errors.variantIds`.
- Mỗi SKU đổi: `recordTransition` (`product_variants`), `recordAudit` (`product.product_variants`, `businessStatus` trước, sau), `catalog.variant_status_changed`. `touchProduct` một lần.
- **Lý do chặn lưu trữ** (`service/usage.ts` `archiveBlockersOf`): bốn nguồn trong `ctx`, nối theo thứ tự kho (`stockArchiveBlockers`), mua hàng (`purchaseArchiveBlockers`), đơn (`orderArchiveBlockers`), sàn (`listingArchiveBlockers`). Kho, mua hàng nối ở `product/index.ts` (`withContext`); đơn, sàn ở `src/wiring.ts`. Thiếu nguồn là lỗi lập trình. Lưu trữ gọi với `lock: true`: nguồn kho khoá dòng tồn (tạo dòng 0 nếu chưa có), thứ tự khoá công ty → dòng tồn → dòng SKU (spec 204 D10). Đơn, listing chỉ kiểm tại thời điểm lưu trữ.
- `ProductDetail.variants[].archiveBlockers`: chỉ tính cho SKU `discontinued`, đọc không khoá; không có SKU nào như vậy thì không hỏi nguồn.
- **Tự khôi phục** (`restoreArchivedBySystem`, export ở `index.ts`): inventory gọi trong `applyChange` khi tồn thực hoặc chờ xử lý tăng. SKU `archived` về `discontinued`, lịch sử nguồn `system`, người làm trống, phát sự kiện; không lấy `lockVariants`, không bật cờ Cần xử lý (D6), không ghi nhật ký thao tác.
- Thêm biến thể trùng tổ hợp SKU `archived`: 409 `variant_archived` kèm `variantId`; route thêm biến thể chỉ trả 201. Không còn ngừng bán biến thể kiểu cũ (`DELETE …/variants/:variantId`, `last_variant` đã bỏ).

## Gọi vào và gọi ra

- Module khác gọi `getVariants(ids?)` (`index.ts`) trong `withCompany` của mình: biến thể kèm sản phẩm, danh mục, thuộc tính theo `position`, `businessStatus`, mô tả của sản phẩm, `weightG`, `lengthMm`, `widthMm`, `heightMm` (#204); `archived` = biến thể ngừng bán hoặc sản phẩm lưu trữ. Inventory gọi hàm này khi đang khoá dòng tồn: chỉ thêm cột vào câu sẵn có, không thêm truy vấn.
- channel đọc giá muốn bán bằng `targetNetPricesOf(variantIds)` (`index.ts`, bộ lọc giá #225), cùng luật với `standardPricesOf`: đủ mọi id, chưa đặt thì `null`.
- #242 (sửa hàng loạt) gọi `applyVariantUpdate(caller, current, input)` (`service/variants.ts`) cho từng dòng trong giao dịch của mình: trả `unchanged`, `updated` hoặc `stale` (sai `version`), bên gọi tự báo lỗi theo dòng. Bên gọi tự kiểm sản phẩm chưa lưu trữ, SKU thuộc sản phẩm, và gọi `touchProduct` **một lần mỗi sản phẩm sau mọi SKU**: hàm không chạm dòng sản phẩm để giữ thứ tự khoá SKU → sản phẩm, không deadlock với PATCH đơn lẻ.
- purchasing (#108) gọi `validateNewProducts`, `createPurchaseProducts`, `categoryNames` (`service/purchase-products.ts`) trong giao dịch của mình: kiểm dòng sản phẩm mới khi lập đề nghị, tạo khi duyệt (mỗi mục một sản phẩm, một biến thể không thuộc tính, SKU theo quy tắc danh mục, lấy `lockVariants` trước khi kiểm lại tên).
- Giá chuẩn của chi tiết sản phẩm là cột `product_variants.standard_price` (`standardPricesOf`, `Documents/19` D9: bỏ module con pricing); chưa đặt thì `null`. API trả số nguyên đồng. Trạng thái kinh doanh `business_status` (CHECK khớp `archived_at`); ngừng bán kiểu cũ đặt `archived`, máy trạng thái đầy đủ ở issue B1 (`Documents/21` mục 17).
- channel gọi `productImageUrls(productIds, max)` (`index.ts`, qua `ProductPort`) trong `withCompany` của mình: link ảnh theo `position`, tối đa `max`, chỉ sản phẩm có link (ảnh đại diện của listing `max = 1`, đẩy lên sàn `max = 8`).
- Catalog gọi `audit` (nhật ký) và `files` (`confirmUploads`, `fileProblem`, `publicFileUrls`).
- **Sự kiện phát:** `catalog.variant_price_changed { variantId, productId, from, to, changedAt }` khi giá muốn bán (`target_net_price`) của SKU đổi (PATCH; #242 qua `applyVariantUpdate`), cùng giao dịch, sau câu UPDATE đã khoá dòng SKU; `from`, `to` là chuỗi `numeric` của DB, `to` null là đã xoá giá; đổi `standardPrice` không phát. `catalog.variant_status_changed { variantId, productId, from, to, changedAt }` mỗi SKU đổi trạng thái kinh doanh (người dùng hoặc hệ thống tự khôi phục). Bên nghe: channel (ẩn, hiện, gỡ listing), inventory (xét lại ngưỡng).
