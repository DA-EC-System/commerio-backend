# Spec: Ảnh sản phẩm ở catalog, ảnh đại diện, đẩy ảnh lên sàn từ catalog (#303)

- **Ngày:** 14/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#303, FE#205, `Documents/21` §5.2–5.4 (P8, P9, P10, P15), V26, §14.3, §18 (bảng route listing, mục "Đẩy", bảng 18.5)
- **Trạng thái:** nháp, chờ Khang duyệt
- **Nền:** `main` 15a0f93. #302 (gắn tệp, `confirmUploads`, `uploaded_at`) đã merge 11/11/2026. Documents#102 (đã merge 11/11/2026) đã sửa sẵn phần §18: `ListingRow.thumbnailUrl` là ảnh đầu của sản phẩm, đẩy lấy ảnh catalog (tối đa 8), `imageUrls` bị bỏ qua sau khi #303 merge, `images_missing` theo ảnh catalog. Phía FE của FE#205 đã merge vào `main` của FE: PR #208 (11/11/2026: JPG/PNG ≤ 1 MB, nén trước khi tải, chặn ảnh nhỏ hơn 330×330) và PR #235 (14/11/2026: e2e chạy với backend thật `e2e/be/p2/anh-san-pham.spec.ts`); FE#205 còn mở chỉ để kiểm với API thật.

---

## 1. Mục tiêu và tiêu chí thành công

Mục tiêu trước mắt: **buổi test trên staging Chủ nhật 15/11/2026** chạy được luồng ảnh sản phẩm, và FE#205 (Khoa) nối được API thật.

1. Form sản phẩm lưu được tối đa 9 ảnh theo thứ tự; ảnh đầu là ảnh đại diện; sửa sản phẩm giữ, đổi thứ tự hoặc gỡ được ảnh.
2. Chi tiết sản phẩm trả `images[]`; bảng sản phẩm và trang listing của gian hàng hiện ảnh đại diện (`thumbnailUrl`).
3. Đẩy sản phẩm có ảnh lên sàn không còn báo `images_missing`; ảnh lấy từ catalog, `imageUrls` FE gửi kèm bị bỏ qua.
4. Ảnh sản phẩm trong Commerio luôn đạt điều kiện ảnh của sàn về kiểu và cỡ tệp (JPG/PNG, ≤ 1 MB).

Đo bằng: AC ở mục 9 đều qua; `npm run check` xanh; `npm run smoke:r2` đạt; trên staging làm trọn luồng ở mục 6 bước 4.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (15a0f93):**
- Vé tải lên chạy được (#301, Cloudflare R2, bucket công khai `https://files.letsrides.app`). `PURPOSE_RULES.product_image` cho JPG, PNG, WebP, tối đa 5 MB (`core/files/domain/upload-rules.ts:25`); câu lỗi ở `REJECTION_MESSAGES` (`core/files/service/uploads.ts:29`).
- `core/files/service/attachments.ts` (#302): `confirmUploads(companyId, fileIds)` gọi `HeadObject` ngoài giao dịch, chỉ ghi `uploaded_at` khi cỡ trên kho **đúng bằng** cỡ đã khai; `attachmentProblem(fileIds)` kiểm tối đa 10, không lặp, tệp của công ty (RLS), `purpose = 'attachment'`, đã có `uploaded_at`. Export qua `core/files/index.ts` rồi `core/index.ts`.
- `POST`/`PUT /catalog/products` chặn ảnh bằng `noImages` (`product/catalog/api/schemas.ts:83`): `imageFileIds` khác rỗng → 422 `errors.images` "Chưa hỗ trợ ảnh sản phẩm". `toListItem` trả `thumbnailUrl: null`, `detail` trả `images: []` (`product/catalog/service/products.ts:54, 78`). Nhật ký ghi `images: 0`.
- Bảng `product.product_images (id, company_id, product_id → products, file_id, position, timestamps, version)` có từ migration `0001`, index `product_id`, `file_id`, chưa có code dùng. RLS `company_isolation` bật chung ở migration `0002`.
- Schema `ProductDetail.images` đã khai `{ id, fileId, url, position }` (`schemas.ts:184`), khớp `ProductImage` của FE (`src/types/catalog.ts:68`).
- Channel: `ListingRowView.thumbnailUrl: null`, schema `z.null()` (`channel/api/schemas.ts:387`). `pushListings` lấy ảnh từ `input.imageUrls[productId]` (`channel/service/listings.ts:242`), `pushBlock` báo `images_missing` khi listing chưa có ảnh trên sàn và không có URL, rồi xếp việc `channel.listing_push` mang `imageUrls` (tối đa `PUSH_IMAGE_MAX = 8`, `shop-jobs.ts`). Worker `runListingPush` dùng `external_image_urls` của listing nếu có, không thì đưa `job.imageUrls` lên sàn (`listing-push.ts:67-69`): Lazada `/image/migrate` nhận thẳng URL; TikTok tải ảnh bằng `downloadImage` (chỉ địa chỉ công khai) rồi tải lên.
- Channel đọc dữ liệu product qua `ProductPort` (`channel/service/product-port.ts`), import từ `product/index.ts`; test thay bằng `setProductPort`.
- FE (`main`): `ProductFormPage.tsx` gửi đủ `imageFileIds` cả khi tạo lẫn khi sửa (dòng 171–188), hiện `errors.images`; chỉ dùng `fileId`, `url` của `images[]`. Đẩy listing: `imageUrlsFor` (`src/features/channel/listingPush.ts:26`) gửi `imageUrls: { [productId]: [thumbnailUrl tuyệt đối] }` cho sản phẩm chưa lên sàn, `shops.api.ts:311` chỉ gửi khi khác rỗng: hôm nay rỗng vì `thumbnailUrl` luôn `null`, sau #303 **FE hiện tại sẽ gửi `imageUrls` ở mọi lần đẩy**. Câu lỗi ảnh của mock FE (`src/mocks/handlers/catalog.ts` `validateImages`): "Tối đa 9 ảnh", "Ảnh bị trùng", "Có ảnh chưa tải xong hoặc không thuộc công ty", `Ảnh <tên tệp> lớn hơn 1 MB`. FE `MAX_IMAGE_BYTES = 1024 * 1024`.
- Sàn giả lập: stub `/image/migrate` trả URL cố định cho mọi ảnh (`scripts/lazada-mock/stubs.ts:309`).
- `npm run smoke:r2` ký URL thẳng bằng `signUpload` với PNG 1×1, không qua `rejectUpload`: đổi luật vé không ảnh hưởng.

**Ràng buộc:**
- `core` (lớp 1) không đọc bảng của `product`; `product` (lớp 2) gọi `files` qua `core/index.ts`; `channel` (lớp 5) gọi catalog qua `product/index.ts`. Repository catalog không join `core.files` (khác module lớn): lấy `storage_key` bằng hàm của `files`.
- Lời gọi mạng (`HeadObject`) nằm ngoài giao dịch, như #302.
- Backend không đọc nội dung ảnh, không chuyển đổi ảnh (VPS 4 GB, chốt trong issue): kích thước điểm ảnh ≥ 330×330 và nén do FE#205 lo.
- Module `channel` là của Thành: phần sửa ở channel cần Thành review.
- Hợp đồng sửa ở Documents trước, PR Documents merge trước PR code (issue #303, mục Phụ thuộc).
- Migration sinh ở bước cuối của PR (`CLAUDE.md` gốc).

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| D1 | **Lấy ảnh catalog lúc bấm đẩy.** `pushListings` gọi `port.productImageUrls(productIds)` một lần, lấy tối đa 8 URL đầu theo `position`, kiểm `images_missing`, đặt vào `imageUrls` của việc `channel.listing_push` như hiện nay. Worker và `ListingPushJobSchema` không đổi | Diff nhỏ nhất; việc đã xếp trước khi deploy vẫn chạy. Đánh đổi: worker dùng bộ ảnh tại lúc bấm, đổi ảnh trong lúc việc chờ thì sàn nhận bộ cũ (ảnh cũ vẫn còn trên kho nên đẩy vẫn thành công). Đã loại: đọc ảnh lúc worker chạy (sửa worker, giữ tương thích dữ liệu việc cũ, đọc hai lần); gắn ảnh vào `getVariants` (mọi module gọi `getVariants` tốn thêm truy vấn). Khang chọn ngày 14/11/2026 |
| D2 | **Worker dọn ảnh không gắn (P9) tách issue riêng**, không làm trong PR này | Cần cột `core.files.attached_at` dùng chung với đính kèm #302, đụng ranh giới `core`/`product`; FE#205 và buổi test không cần. Khang chọn ngày 14/11/2026 |
| D3 | Số ảnh (≤ 9, P8) và ảnh lặp kiểm ở Zod (`superRefine` của body, lỗi ở path `images`), **trước** mọi lời gọi mạng. Quyền sở hữu, `purpose`, đã PUT xong kiểm trong giao dịch bằng hàm của `files` | Body gửi hàng trăm id không được kéo theo hàng trăm `HeadObject`; lỗi rơi đúng `errors.images` mà FE đang hiện. Claude đề xuất |
| D4 | `files` tổng quát hoá `attachmentProblem` thành `fileProblem(fileIds, purpose, max)`; `attachmentProblem(ids)` giữ nguyên chữ ký, gọi `fileProblem(ids, 'attachment', MAX_ATTACHMENTS)`. Câu lỗi theo `purpose` (bảng 5.1). `fileProblem` kiểm thêm kiểu, cỡ theo luật **hiện hành** của `purpose` (`rejectUpload`) | Issue yêu cầu không viết hàm thứ hai; bên gọi của #302 không phải sửa. Kiểm lại kiểu, cỡ chặn ảnh WebP hoặc trên 1 MB đã xin vé trước khi đổi luật (vé #301 chạy từ 10/11). Với `attachment` hiện là không đổi gì. Claude đề xuất |
| D5 | Link ảnh = `<S3_PUBLIC_URL bỏ "/" cuối>/<storage_key>`. Thiếu `S3_PUBLIC_URL`: `images[].url = ''`, `thumbnailUrl: null`, `productImageUrls` bỏ ảnh không có link (nên đẩy báo `images_missing`). Không trả 503 | Theo issue: thiếu cấu hình không được làm hỏng cả trang sản phẩm. Lưu khoá, không lưu link (`files/CLAUDE.md`) |
| D6 | `PushBody.imageUrls` vẫn nhận **mọi giá trị** và bỏ qua (`z.unknown().optional()`, `deprecated` trong OpenAPI) | §18 "bỏ qua `imageUrls` FE cũ còn gửi, không báo lỗi". Đây là đường của **FE hiện tại** (`imageUrlsFor` gửi `[thumbnailUrl]` sau #303), không chỉ client cũ; giữ kiểm URL cũ thì một URL lạ làm cả request 422 |
| D7 | Listing đã có ảnh trên sàn (`external_image_urls`, kể cả listing đã gỡ đẩy lại) vẫn dùng ảnh trên sàn, không đưa ảnh catalog mới lên | Giữ hành vi hiện tại (issue: "vẫn giữ `externalImageUrls`"). Đổi ảnh của sản phẩm đang có trên sàn là #293 |
| D8 | `PUT` thay toàn bộ ảnh khi có `imageFileIds`; không gửi thì giữ nguyên; `[]` thì gỡ hết. Gỡ ảnh không xoá tệp | Giống `attachmentIds` của #302 (§14.3) |
| D9 | 1 MB = 1 048 576 byte (hằng `MB` đang có) | Thống nhất với code và FE (`MAX_IMAGE_BYTES = 1024 * 1024`); xem rủi ro R1 ở mục 10 |
| D10 | Giữ cách đưa ảnh lên sàn của #219: mỗi SKU là một sản phẩm trên sàn, mỗi lượt đẩy đưa lên tối đa 8 ảnh (Lazada `/image/migrate` một lời gọi mỗi ảnh); URL ảnh trên sàn chỉ lưu khi đẩy xong nên lần thử lại đưa lên lại. Không làm kho ảnh trên sàn dùng chung theo sản phẩm, gian hàng trong #303 | Buổi test chỉ vài sản phẩm. Dùng chung ảnh cần bảng mới (ảnh trên sàn theo sản phẩm × gian hàng), ngoài phạm vi; xem R6. Claude quyết, Khang đổi được |

## 4. Phạm vi

**Làm (PR Documents rồi PR backend):** mọi việc trong mục "Việc" của #303, trừ worker dọn ảnh (D2).

**Không làm:**
- Worker dọn ảnh tải lên mà không gắn sau 24 giờ (P9): issue riêng (D2).
- Ảnh theo biến thể hoặc theo giá trị trục, `sku_img` TikTok (#295), tải ảnh lên TikTok (#283), cắt, chuyển đổi ảnh ở backend.
- Đổi ảnh của listing đã có ảnh trên sàn (#293).
- Ảnh đại diện ở các chỗ khác ngoài catalog và `ListingRow` (dòng đơn tay, bảng giá): issue sau nếu cần.

## 5. Thiết kế

### 5.1 `core/files`

**Luật vé** (`domain/upload-rules.ts`): `product_image: { contentTypes: ['image/jpeg', 'image/png'], maxBytes: 1 * MB, visibility: 'public' }`. `EXTENSIONS` giữ `image/webp` (đính kèm vẫn nhận WebP). `REJECTION_MESSAGES.product_image` (`service/uploads.ts`): "Ảnh sản phẩm phải là JPG hoặc PNG", "Ảnh sản phẩm tối đa 1 MB".

**Export mới** (qua `core/files/index.ts`, `core/index.ts` đã re-export):
- `fileProblem(fileIds, purpose, max): Promise<string | null>`: gọi trong `withCompany`. Thứ tự kiểm: quá `max` → lặp → id không phải uuid → không thấy (RLS), khác `purpose`, chưa `uploaded_at` → sai kiểu hoặc cỡ theo `rejectUpload(purpose, …)`. Câu lỗi theo `purpose`:

  | Trường hợp | `attachment` (giữ nguyên) | `product_image` (khớp mock FE) |
  |---|---|---|
  | Quá `max` | `Tối đa 10 tệp` | `Tối đa 9 ảnh` |
  | Lặp | `Có tệp bị lặp` | `Ảnh bị trùng` |
  | Không thấy, khác `purpose`, chưa PUT xong, không phải uuid | `Có tệp chưa tải xong hoặc không thuộc công ty` | `Có ảnh chưa tải xong hoặc không thuộc công ty` |
  | Sai kiểu, cỡ theo luật hiện hành | câu của `REJECTION_MESSAGES` | `Ảnh <file_name> không phải JPG hoặc PNG`, `Ảnh <file_name> lớn hơn 1 MB` (dạng câu của mock FE) |

- `publicFileUrls(fileIds): Promise<Map<string, string>>`: gọi trong `withCompany`; một truy vấn `findFiles`; chỉ tệp có `PURPOSE_RULES[purpose].visibility = 'public'`; giá trị là link theo D5 (chuỗi rỗng khi thiếu `S3_PUBLIC_URL`). Không gọi mạng.
- Tên hàm là đề xuất, builder đổi được.

`confirmUploads` không đổi: cỡ trên kho khác cỡ đã khai thì không ghi `uploaded_at`, nên V26 được đáp ứng bằng câu "chưa tải xong" (cỡ đã ký vào URL PUT nên thực tế không gửi to hơn được).

### 5.2 Dữ liệu và migration

`product/catalog/repository/schema.ts`, bảng `productImages` thêm:
- `uniqueIndex('product_images_product_position_uq').on(t.productId, t.position)`;
- `check('product_images_position_nonneg', sql\`${t.position} >= 0\`)`.

Sinh bằng `npm run db:generate -- --name anh-san-pham` ở bước cuối. Bảng đang trống trên staging. Không thêm unique trên `file_id` (xem R3).

### 5.3 `product/catalog`

**Schema** (`api/schemas.ts`):
- Bỏ `noImages`. `imageFileIds = z.array(z.string()).optional()`; `CreateProductBody`, `UpdateProductBody` thêm `superRefine`: dài hơn `MAX_PRODUCT_IMAGES` (= 9) → issue path `['images']` "Tối đa 9 ảnh"; có id lặp → `['images']` "Ảnh bị trùng".
- Item của `ProductDetail.images` đặt `.meta({ id: 'ProductImage' })`, `description` "0 là ảnh đại diện" cho `position`.

**Repository** (đặt hàm ở `repository/products.ts` hay file mới: builder chọn):
- Cột `thumbnailFileId` trong `columns` của `findProduct`/`listProducts`: subquery `(select pi.file_id from product.product_images pi where pi.product_id = products.id and pi.position = 0)`, cùng kiểu với `variantCount`. Danh sách một trang vẫn một câu.
- `productImageRows(productIds, max?)`: `{ id, productId, fileId, position }` xếp theo `product_id, position`; có `max` thì chỉ `position < max`.
- `replaceProductImages(companyId, productId, fileIds)`: xoá dòng cũ rồi chèn `position = i` theo thứ tự gửi (hai câu, cùng giao dịch).

**Service** (`service/products.ts`):
- `createProduct`: `ids = input.imageFileIds ?? []`. Trước `withCompany`: `await confirmUploads(companyId, ids)`. Trong giao dịch, sau `lockVariants`, gom lỗi cùng `categoryId`, `variants`: `fileProblem(ids, 'product_image', MAX_PRODUCT_IMAGES)` có câu thì `errors.images`; có lỗi thì `invalid(errors)`; rồi `name_taken`; tạo sản phẩm, biến thể, `replaceProductImages`.
- `updateProduct`: có `imageFileIds` thì `confirmUploads` trước giao dịch. Trong giao dịch: `editable` (giữ thứ tự `product_archived` trước `version_conflict`), có `imageFileIds` thì `fileProblem` → 422 `errors.images`, rồi `name_taken`, `updateProductIfVersion` (tăng `version` như mọi `PUT`), có `imageFileIds` thì `replaceProductImages`.
- Nhật ký: `snapshot` thay `images: 0` bằng `imageFileIds: string[]`. Tạo: `after` theo input. Sửa: `before` đọc từ DB trước khi ghi, `after` = input hoặc giữ `before` khi không gửi. Lưu trữ (`archiveProduct`, cũng dùng `snapshot`): `before.imageFileIds` đọc từ DB. Sản phẩm tạo từ đề nghị nhập (`purchase-products.ts:61`, tự ghi `images: 0`): đổi thành `imageFileIds: []` cho cùng dạng.
- `detail`: `images` = `productImageRows([id])` kèm `url` từ `publicFileUrls`, theo `position`; `thumbnailUrl` = `url` của ảnh `position` 0, chuỗi rỗng coi là `null`.
- `listProducts`: gom `thumbnailFileId` của trang, một lần `publicFileUrls`, rồi `toListItem`. Tổng cộng thêm một truy vấn mỗi trang, không N+1.
- `productImageUrls(productIds, max): Promise<Map<productId, string[]>>` (gọi trong `withCompany` của bên gọi, như `getVariants`): tối đa `max` URL đầu theo `position`, bỏ URL rỗng (D5). Export ở `catalog/index.ts` (tự có ở `product/index.ts` qua `export *`).

### 5.4 `channel/channel`

- `ProductPort` thêm `productImageUrls(productIds, max)` (bắt buộc); bản thật gọi `productImageUrls` của `product/index.ts`. 14 file trong `test/integration/channel/channel/` gọi `setProductPort` với cổng giả: thêm hàm này (trả Map rỗng là đủ cho ca không xét ảnh), không thì typecheck đỏ.
- `listListings` (không phân trang, mọi biến thể đang bán): một lần `port.productImageUrls(<productId khác nhau>, 1)`; `thumbnailUrl = urls[0] ?? null`. `ListingRowView.thumbnailUrl: string | null`; schema `ListingRow.thumbnailUrl: z.string().nullable()`, mô tả "ảnh đại diện catalog; null khi sản phẩm chưa có ảnh".
- `pushListings(port, actor, shopId, { variantIds })`: trong khối đọc `inCompany`, thêm `images = await port.productImageUrls(<productId của các biến thể tìm thấy>, PUSH_IMAGE_MAX)`. Mỗi dòng: `imageUrls = images.get(v.productId) ?? []`; `pushBlock(…, Boolean(existing?.externalImageUrls?.length || imageUrls.length))`; `enqueue(…, imageUrls)` như cũ.
- Route `push` truyền `{ variantIds }`; `PushBody.imageUrls` theo D6.
- `pushBlock`: câu `images_missing` đổi thành "Sàn bắt buộc ảnh: thêm ảnh cho sản phẩm"; JSDoc của `hasImages` đổi theo.
- `listing-push.ts`, `shop-jobs.ts`: không đổi logic; sửa comment `ListingPushJobSchema` ("URL ảnh catalog lúc bấm đẩy").

### 5.5 Lỗi

| Route | Mã | Khi nào |
|---|---|---|
| `POST /files/uploads` (`product_image`) | 422 `file_type_not_allowed` | Không phải `image/jpeg`, `image/png` |
| `POST /files/uploads` (`product_image`) | 422 `file_too_large` | `sizeBytes` > 1 048 576 |
| `POST`, `PUT /catalog/products` | 422 `validation_failed`, `errors.images` | Bảng ở 5.1 (Zod hoặc `fileProblem`) |
| `POST`, `PUT /catalog/products` | 503 `storage_unavailable` | Kho không trả lời `HeadObject`, hoặc kho chưa cấu hình mà có ảnh chưa xác nhận |
| `PUT /catalog/products/:id` | 409 `product_archived` | Như cũ, kiểm trước ảnh |
| `POST /channel/shops/:id/listings/push` | `images_missing` (theo dòng) | Listing chưa có ảnh trên sàn và sản phẩm không có ảnh có link |

### 5.6 Chạy đồng thời

- Hai `PUT` cùng sản phẩm: `version` của `updateProductIfVersion` chặn người thứ hai (409), `replaceProductImages` chạy sau lần ghi trúng `version` nên không có hai bộ ảnh chen nhau. Unique `(product_id, position)` là chốt chặn cuối.
- `confirmUploads` chạy ngoài giao dịch: tệp được ghi `uploaded_at` mà giao dịch sau đó lỗi thì vô hại (lần sau khỏi hỏi lại kho).
- Đổi ảnh trong lúc việc đẩy chờ chạy: theo D1.

### 5.7 Phân quyền, bảo mật

- Không đổi quyền: vé `product_image` và ghi sản phẩm cùng `catalog.product.manage`; đọc `catalog.product.view`; listing theo quyền channel hiện có.
- Tệp công ty khác không gắn được (RLS trong `fileProblem`); id không phải uuid không chạm DB.
- Ảnh sản phẩm ở bucket công khai theo thiết kế #301; link không chứa tên tệp người dùng, không lộ công ty.
- Giới hạn số id ở Zod trước mọi lời gọi kho (D3).

### 5.8 Hiệu năng

- Danh sách sản phẩm: thêm subquery `thumbnailFileId` trên index `product_images(product_id)` và một câu `findFiles` cho ≤ 100 id.
- Lưu sản phẩm: `HeadObject` chỉ cho ảnh chưa có `uploaded_at` (ảnh cũ khi sửa không hỏi lại), song song, tối đa 9; tính vào thao tác Class B của R2.
- Trang listing không phân trang (mọi biến thể đang bán của công ty): một câu `productImageRows(…, 1)` (chỉ ảnh `position` 0) và một câu `findFiles` cho mọi sản phẩm.
- Đẩy: mỗi SKU tối đa 8 lời gọi `/image/migrate` mỗi lượt (D10, R6).

### 5.9 Test

**Unit:** `test/unit/modules/core/files/domain/upload-rules.test.ts`: `product_image` từ chối WebP và 1 048 577 byte, nhận JPG/PNG 1 048 576 byte; `attachment` không đổi.

**Integration:**
- `test/integration/core/files/uploads.test.ts`: vé `product_image` WebP → 422 `file_type_not_allowed`; quá 1 MB → 422 `file_too_large`, đúng câu.
- `test/integration/product/catalog/` (thêm vào `products.test.ts` hoặc file `product-images.test.ts`), kho giả bằng `setHeadObject`:
  - tạo sản phẩm 3 ảnh: `images[]` đúng thứ tự, `position` 0–2, `url` = `S3_PUBLIC_URL/storage_key`, `thumbnailUrl` = ảnh đầu; nhật ký `after.imageFileIds`;
  - `PUT` không gửi `imageFileIds` giữ nguyên; gửi thứ tự mới thì đổi; gửi `[]` thì `images: []`, `thumbnailUrl: null`; nhật ký `before`/`after`;
  - từ chối, không ghi gì: ảnh chưa PUT (kho giả trả null), ảnh công ty khác, tệp `attachment`, 10 ảnh, ảnh lặp, id không phải uuid, dòng `product_image` WebP chèn thẳng (tệp xin vé trước khi đổi luật);
  - kho giả ném lỗi → 503 `storage_unavailable`, sản phẩm không được tạo;
  - sản phẩm lưu trữ → 409 `product_archived`;
  - danh sách: sản phẩm có và không có ảnh trả đúng `thumbnailUrl`;
  - không có `S3_PUBLIC_URL` → `url: ''`, `thumbnailUrl: null` (nếu cấu hình env của test đổi được trong ca; không thì unit test cho hàm dựng link);
  - ràng buộc: chèn trùng `(product_id, position)` → 23505; `position = -1` → 23514.
- `test/integration/product/purchasing/receipt-attachments.test.ts` vẫn qua (đính kèm không đổi).
- `test/integration/channel/channel/listings.test.ts` (bản giả `ProductPort` thêm `productImageUrls`):
  - `GET listings` trả `thumbnailUrl` của sản phẩm có ảnh, `null` khi không có;
  - đẩy không gửi `imageUrls`: việc mang URL catalog theo thứ tự, sản phẩm 9 ảnh thì 8 ảnh đầu;
  - gửi `imageUrls` thì bỏ qua, không 422: cả dạng FE hiện tại gửi (`{ [productId]: [thumbnailUrl] }`, URL khác ảnh catalog) lẫn giá trị sai kiểu; việc vẫn mang URL catalog;
  - catalog không có ảnh, listing chưa có ảnh trên sàn → `images_missing`, câu mới;
  - listing đã gỡ có `external_image_urls` đẩy lại được khi catalog không có ảnh.
  - Một ca chạy cổng thật (như `stock-push.test.ts`): sản phẩm có ảnh trong catalog → `push` → việc mang đúng link R2.
- Sửa các test đang gửi `imageUrls` (`listings.test.ts`, `listing-push.test.ts`) cho khớp; thêm `productImageUrls` vào cổng giả của 14 file (5.4).
- Sửa test catalog cũ: `products.test.ts:56` (nhật ký đang mong `images: 0`), `products.test.ts:111` (ca "gửi ảnh trước #14" trả 422, nay bỏ hoặc đổi thành ca tạo có ảnh); nhật ký sản phẩm tạo từ đề nghị nhập nếu test purchasing có so.

**Thủ công:** `npm run smoke:r2`; đẩy một sản phẩm có ảnh qua sàn giả lập Lazada (mục 6).

**E2E có sẵn bên FE:** `e2e/be/p2/anh-san-pham.spec.ts` (FE PR #235) chạy với backend thật: xin vé, PUT, lưu sản phẩm, mở `images[0].url` mong HTTP 200 và `content-type` `image/jpeg|png`. Chạy trên staging sau khi deploy là phép kiểm nghiệm thu sẵn có.

## 6. Thứ tự giao

1. **PR Documents** (nhỏ, làm ngay): mục 8. Merge trước PR code.
2. **PR backend** `feature/303-anh-san-pham` vào `main`, theo thứ tự commit: `files` (luật vé, `fileProblem`, `publicFileUrls`) → catalog → channel → `CLAUDE.md` của `files`, `catalog`, `channel` → migration cuối cùng. `npm run check` xanh. Thành review (channel là module của Thành).
3. **FE:** không phải chờ. Phần FE đã merge (PR #208, #235), đã nén về JPG/PNG ≤ 1 MB, nên đổi luật vé không làm hỏng FE đang chạy.
4. **Kiểm trên staging** trước buổi test: `npm run db:migrate:check:staging`; chạy `e2e/be/p2/anh-san-pham.spec.ts` của FE với staging; trên giao diện: tạo sản phẩm 2 ảnh, đổi thứ tự, sửa giữ ảnh, gỡ hết; bảng sản phẩm và trang listing hiện ảnh nhỏ; đẩy sản phẩm có ảnh lên sàn giả lập (hoặc shop thử Lazada) không báo `images_missing`, listing có `external_image_urls`. Xong thì đóng FE#205 (Khoa).
5. **Sau đó:** tạo issue riêng cho P9 (dọn ảnh không gắn, kèm ghi chú `core.files.attached_at` và R3), sửa thân #303 (gạch mục P9, dẫn link issue mới).

## 7. Ảnh hưởng tới FE

Không phải sửa FE cho PR này. Phần code của FE#205 đã merge (nén, JPG/PNG ≤ 1 MB, ≥ 330×330, mock); còn lại là kiểm với API thật (mục 6 bước 4). Câu lỗi `errors.images` của backend cùng dạng câu mock FE (5.1). `ProductImage`, `thumbnailUrl: string | null` đã khớp. `imageUrlsFor` vẫn gửi `[thumbnailUrl]` khi đẩy: backend bỏ qua (D6). Bỏ đoạn đó ở FE là dọn dẹp, không bắt buộc, không chặn buổi test.

## 8. Ảnh hưởng tới Documents (`21-hop-dong-api-fe-be.md`)

- §5.2: `images[]` = `{ id, fileId, url, position }`, `position` 0 là ảnh đại diện, `url` là link cố định của ảnh (chuỗi rỗng khi máy chủ chưa cấu hình link ảnh); `thumbnailUrl` = `url` của ảnh đầu hoặc `null`. `imageFileIds`: tối đa 9, theo thứ tự hiển thị; `PUT` không gửi thì giữ nguyên, gửi `[]` thì gỡ hết, gửi danh sách thì thay toàn bộ; gỡ ảnh không xoá tệp.
- §5.3: `file_type_not_allowed` "Ảnh không phải JPG, PNG"; `file_too_large` "Ảnh lớn hơn 1 MB".
- §5.4: P15 ghi "hết hiệu lực từ commerio-backend#303"; P10 thêm câu lỗi (bảng 5.1, cột `product_image`); P9 ghi "tách issue riêng" (điền số issue khi có).
- V26: 5 MB thành 1 MB; cỡ đã ký vào URL PUT, tệp có cỡ khác cỡ đã khai không được ghi nhận đã tải xong nên trả 422 `errors.images` "Có ảnh chưa tải xong hoặc không thuộc công ty".
- §14.3, bảng `purpose`: `product_image` JPG, PNG, 1 MB.
- §18, đoạn "Đẩy": bỏ câu "Giới hạn ảnh sản phẩm ở danh mục (…) đổi theo commerio-backend#303 thành…", thay bằng giới hạn hiện hành (phần còn lại của §18 Documents#102 đã sửa).

## 9. Acceptance criteria

- **AC-1** Vé `product_image`: `image/webp` → 422 `file_type_not_allowed` "Ảnh sản phẩm phải là JPG hoặc PNG"; `sizeBytes` 1 048 577 → 422 `file_too_large` "Ảnh sản phẩm tối đa 1 MB"; JPG/PNG ≤ 1 048 576 byte được cấp vé. Vé `attachment` như cũ.
- **AC-2** `POST /catalog/products` kèm 3 ảnh đã PUT → 201; `images[]` 3 phần tử đúng thứ tự gửi, `position` 0, 1, 2, `url` = `<S3_PUBLIC_URL>/<storage_key>`; `thumbnailUrl` = `images[0].url`.
- **AC-3** `PUT` không có `imageFileIds` giữ nguyên ảnh; có danh sách đổi thứ tự thì thứ tự mới; `[]` thì `images: []`, `thumbnailUrl: null`. Mỗi lần `PUT` tăng `version`.
- **AC-4** 422 `errors.images`, không ghi gì: 10 ảnh "Tối đa 9 ảnh"; ảnh lặp "Ảnh bị trùng"; ảnh chưa PUT, ảnh công ty khác, tệp `attachment`, id không phải uuid "Có ảnh chưa tải xong hoặc không thuộc công ty"; tệp `product_image` WebP hoặc trên 1 MB có từ trước → `Ảnh <tên tệp> không phải JPG hoặc PNG` / `Ảnh <tên tệp> lớn hơn 1 MB`.
- **AC-5** Kho không trả lời lúc kiểm ảnh → 503 `storage_unavailable`, không ghi gì.
- **AC-6** `PUT` sản phẩm đã lưu trữ kèm ảnh → 409 `product_archived`.
- **AC-7** `GET /catalog/products`: sản phẩm có ảnh trả `thumbnailUrl` của ảnh `position` 0, không có thì `null`; số truy vấn không tăng theo số dòng.
- **AC-8** Nhật ký: tạo ghi `after.imageFileIds`; sửa ghi `before.imageFileIds`, `after.imageFileIds`.
- **AC-9** `GET /channel/shops/:id/listings`: `thumbnailUrl` = ảnh đại diện catalog của sản phẩm hoặc `null`; OpenAPI khai `string | null`.
- **AC-10** `POST …/listings/push` `{ variantIds }` cho sản phẩm 9 ảnh, chưa có listing → dòng `pushing`, việc mang 8 URL đầu theo thứ tự. Body kèm `imageUrls` bất kỳ, kể cả dạng FE hiện tại gửi (`[thumbnailUrl]`) → bỏ qua, không 422, việc vẫn mang URL catalog. Sản phẩm không ảnh, listing chưa có ảnh trên sàn → `images_missing` "Sàn bắt buộc ảnh: thêm ảnh cho sản phẩm". Listing đã gỡ có `external_image_urls` → đẩy được dù catalog không có ảnh.
- **AC-11** Không có `S3_PUBLIC_URL`: chi tiết trả `images[].url = ''`, `thumbnailUrl: null` ở cả catalog và listing, đẩy ra `images_missing`; không route nào 5xx vì thiếu biến này.
- **AC-12** DB: trùng `(product_id, position)` → vi phạm unique; `position < 0` → vi phạm CHECK.
- **AC-13** OpenAPI có `ProductImage`; `ListingRow.thumbnailUrl` nullable string; `npm run check` xanh; `npm run smoke:r2` đạt; `CLAUDE.md` của `files`, `catalog`, `channel` cập nhật (bảng luật vé, bất biến ảnh, mục Ảnh của Listing, bỏ dòng "Chưa làm" tương ứng).
- **AC-14** Staging: làm trọn mục 6 bước 4, gồm `e2e/be/p2/anh-san-pham.spec.ts` của FE xanh.

## 10. Rủi ro và điểm còn mở

- **R1, 1 MB của sàn.** Backend nhận tới 1 048 576 byte. Nếu sàn hiểu 1 MB là 1 000 000 byte thì ảnh 1 000 001–1 048 576 byte bị sàn từ chối lúc đẩy (`marketplace_rejected` kèm câu của sàn, listing `push_failed`, người dùng thay ảnh rồi đẩy lại). FE đang nén tới ≤ 1 048 576 byte; nếu gặp lỗi này thì hạ đích nén của FE xuống 1 000 000 byte, backend không phải đổi. Không chặn buổi test.
- **R2, ảnh trên sàn không theo catalog.** Listing đã có ảnh trên sàn giữ ảnh cũ khi catalog đổi ảnh (D7); cập nhật ảnh là #293.
- **R3, một tệp gắn nhiều sản phẩm.** Không có unique trên `file_id`: gửi cùng `fileId` cho hai sản phẩm thì hai sản phẩm dùng chung tệp. Luồng FE luôn xin vé mới mỗi ảnh nên thực tế không xảy ra; issue dọn ảnh (P9) phải coi tệp còn được **bất kỳ** sản phẩm hay chứng từ nào tham chiếu là đang dùng.
- **R4, máy dev không có R2.** Thiếu `S3_PUBLIC_URL` thì đẩy báo `images_missing` (D5); thử đẩy có ảnh cần cấu hình `S3_*` như staging.
- **R5, thời gian.** Buổi test là Chủ nhật 15/11/2026; PR Documents và PR backend phải merge trong ngày 14/11 để kịp kiểm trên staging (mục 6). FE không chặn (đã merge).
- **R6, hạn mức gọi Lazada.** Trước đây FE gửi 1 ảnh mỗi sản phẩm, nay mỗi SKU đưa lên tối đa 8 ảnh mỗi lượt (D10): sản phẩm 10 SKU tốn tới 80 lời gọi `/image/migrate` khi trơn tru, tới 400 nếu cả 5 lần thử đều lỗi tạm, trên `LAZADA_DAILY_CALL_LIMIT` (mặc định 9000 mỗi ngày, chung mọi công ty). Đủ cho buổi test. Khi có nhiều gian hàng thật: issue riêng để lưu URL ảnh đã đưa lên theo (tệp, gian hàng) và dùng lại giữa các SKU, giữa các lần thử.

**Để builder quyết:** đặt hàm repository, service ảnh ở file nào; tên hàm export (`fileProblem`, `publicFileUrls`, `productImageUrls` là đề xuất); cách tính `thumbnailUrl` trong `detail` và `toListItem`; ca "không có `S3_PUBLIC_URL`" là integration hay unit, tuỳ việc đổi env trong test.
