# src/modules/catalog/

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
- Ảnh (`imageFileIds`) trả 422 `errors.images` tới khi #14 làm; `thumbnailUrl: null`, `images: []`. `product_has_active_orders` chưa kiểm (#24).

## Gọi vào và gọi ra

- Module khác gọi `getVariants(ids?)` (`index.ts`) trong `withCompany` của mình: biến thể kèm sản phẩm, danh mục, thuộc tính theo `position`; `archived` = biến thể ngừng bán hoặc sản phẩm lưu trữ.
- Giá chuẩn của chi tiết sản phẩm lấy qua `ctx.standardPrices` (`standardPricesOf`), không import `pricing`; chưa có thì `null`. API trả số nguyên đồng.
- Catalog chỉ gọi `audit` (nhật ký). Không phát sự kiện.
