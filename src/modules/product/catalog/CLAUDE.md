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
- **Khoá theo công ty** (`lockVariants`, `pg_advisory_xact_lock`) lấy ở **đầu** giao dịch của mọi thao tác đổi tập biến thể: tạo sản phẩm, thêm, ngừng bán biến thể. Thiếu khoá thì hai request song song cấp trùng số, tạo trùng tổ hợp hoặc ngừng hết biến thể.
- `sku_next_seq` tăng khi cấp SKU nhưng **không** đổi `version` danh mục; thêm/ngừng biến thể **không** đổi `version` sản phẩm, chỉ đổi `updated_at` (P7).
- **Thứ tự thuộc tính** của sản phẩm = thứ tự giá trị trong biến thể đầu lúc tạo, lưu ở `variant_attribute_values.position`; biến thể sau được sắp lại theo đó trước khi ghép `{VAL}`.
- **Thứ tự giá trị và biến thể** trong một request giữ bằng `created_at = now() + i µs` (`orderedNow`): bảng không có cột thứ tự. Đổi thứ tự giá trị cũ khi `PUT` không được lưu.
- **Lưu trữ**: xoá sản phẩm là đặt `archived_at` (tăng `version`); sản phẩm lưu trữ thì mọi thao tác ghi trả `product_archived` **trước** `version_conflict`. Ngừng bán biến thể không nhận `version`. Phải còn ít nhất một biến thể đang bán (`last_variant`).
- Tên danh mục, thuộc tính, sản phẩm không trùng theo chữ thường trong công ty (`name_taken`). Tên của sản phẩm đã lưu trữ dùng lại được; index unique một phần cho việc này do CB-4 thêm.
- `productCount` của danh mục và thuộc tính, `inUse` của giá trị tính cả sản phẩm lưu trữ, biến thể ngừng bán (cùng điều kiện với `in_use` khi xoá, V25).
- **Khoá ngoại bỏ qua RLS** (kiểm bằng quyền chủ bảng): luôn đọc bản ghi cha (danh mục, giá trị thuộc tính) trong `withCompany` trước khi chèn con; không thấy thì 422.
- **Ảnh** (#303, bảng `product_images`, `service/product-images.ts`): tối đa 9 ảnh (P8), `position` 0 là ảnh đại diện. Số ảnh và ảnh lặp kiểm ở Zod (`imageLimits`, trước mọi lời gọi kho). `POST`/`PUT` gọi `confirmUploads` của `files` **trước** giao dịch, rồi `fileProblem(ids, 'product_image', 9)` trong giao dịch (tệp của công ty, đã PUT xong, còn đúng JPG/PNG ≤ 1 MB); lỗi ở `errors.images`. `PUT` không gửi `imageFileIds` thì giữ nguyên, gửi thì thay toàn bộ sau khi ghi trúng `version`; gỡ ảnh không xoá tệp. Link ảnh từ `publicFileUrls` của `files` (không join `core.files`); thiếu `S3_PUBLIC_URL` thì `url: ''`, `thumbnailUrl: null`. Danh sách lấy ảnh đại diện bằng subquery `thumbnailFileId` và một lần `publicFileUrls` cho cả trang. Nhật ký ghi `imageFileIds`. Dọn ảnh không gắn (P9) là issue riêng.
- `product_has_active_orders` chưa kiểm (#24).

## Gọi vào và gọi ra

- Module khác gọi `getVariants(ids?)` (`index.ts`) trong `withCompany` của mình: biến thể kèm sản phẩm, danh mục, thuộc tính theo `position`, `businessStatus`; `archived` = biến thể ngừng bán hoặc sản phẩm lưu trữ.
- purchasing (#108) gọi `validateNewProducts`, `createPurchaseProducts`, `categoryNames` (`service/purchase-products.ts`) trong giao dịch của mình: kiểm dòng sản phẩm mới khi lập đề nghị, tạo khi duyệt (mỗi mục một sản phẩm, một biến thể không thuộc tính, SKU theo quy tắc danh mục, lấy `lockVariants` trước khi kiểm lại tên).
- Giá chuẩn của chi tiết sản phẩm là cột `product_variants.standard_price` (`standardPricesOf`, `Documents/19` D9: bỏ module con pricing); chưa đặt thì `null`. API trả số nguyên đồng. Trạng thái kinh doanh `business_status` (CHECK khớp `archived_at`); ngừng bán kiểu cũ đặt `archived`, máy trạng thái đầy đủ ở issue B1 (`Documents/21` mục 17).
- channel gọi `productImageUrls(productIds, max)` (`index.ts`, qua `ProductPort`) trong `withCompany` của mình: link ảnh theo `position`, tối đa `max`, chỉ sản phẩm có link (ảnh đại diện của listing `max = 1`, đẩy lên sàn `max = 8`).
- Catalog gọi `audit` (nhật ký) và `files` (`confirmUploads`, `fileProblem`, `publicFileUrls`). Không phát sự kiện.
