# Spec: Trạng thái kinh doanh, điều kiện lưu trữ, nhãn sản phẩm, sửa SKU (#204)

- **Ngày:** 16/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#204 (thân issue và 5 comment tới 16/11/2026), `Documents/21` §11.2, §17 (bản `origin/main` sau Documents#117), `Documents/25` §5, `Documents/19` (bảng `products`, `product_variants`), `Documents/27` US-SP-02, 03, 05, 06, 07, 08, `Documents/kiem-thu/ca-theo-so-do.md` (B1)
- **Trạng thái:** Khang duyệt 16/11/2026. Thành trả lời D1 đến D11 trên issue #204 ngày 16/11/2026: đồng ý 10 điểm, **sửa D8** theo `Documents/25` §5.1 (mục 10). PR 0 là #338, PR 1 là #339 (đã merge 16/11/2026), sửa `Documents/21` cho D1 đến D3 ở Documents#124
- **Nền:** `main` 2018c63
- **Phạm vi spec:** Khang chốt 16/11/2026 là **một spec, ba PR** (mục 8). Sau khi một reviewer độc lập đọc spec, thêm **PR 0** chỉ khai hai sự kiện, theo luật "thêm loại sự kiện là PR riêng" của `src/modules/CLAUDE.md`. PR 0 và PR 1 gỡ kẹt staging làm trước

---

## 1. Mục tiêu và tiêu chí thành công

1. **Sửa SKU.** Admin sửa giá chuẩn, giá muốn bán, cân nặng, kích thước gói của một SKU qua `PATCH /catalog/products/:id/variants/:variantId`. Module khác đọc được các trường này qua `getVariants`. Đổi giá muốn bán thì channel được báo bằng sự kiện.
2. **Trạng thái kinh doanh theo SKU.** Admin tạm ngừng, bỏ tạm ngừng, ngừng nhập, nhập lại, lưu trữ, khôi phục từng SKU hoặc cả sản phẩm cha, đúng 6 thao tác của sơ đồ B1. Lưu trữ bị chặn khi SKU còn tồn hoặc chứng từ mở, kèm lý do. Mỗi lần đổi có lịch sử và phát sự kiện để channel và inventory phản ứng.
3. **Ba lớp nhãn.** Danh sách và chi tiết sản phẩm trả độ hoàn thiện, trạng thái kinh doanh, hiện diện trên sàn của từng SKU; nhãn cha suy từ con.
4. **Sản phẩm cha không mang trạng thái.** Bỏ `products.archived_at`, thêm mã cha `code`. `DELETE /catalog/products/:id` chỉ còn nghĩa xoá hẳn.

Đo bằng: AC ở mục 9 đều qua; `npm run check` xanh ở từng PR; mỗi ca B1 ở `ca-theo-so-do.md` có test mang mã ca.

**Vì sao làm ngay:** issue mang nhãn `priority: urgent`. Staging đang kẹt đẩy sản phẩm lên Lazada vì `getVariants` chưa trả cân nặng, kích thước nên `push-block.ts` luôn báo `dimensions_missing`, và chưa có route nào ghi các cột đó (Thành 11/11, Khoa 16/11). FE đã có sẵn hộp thoại thông số SKU và trang trạng thái, đang chạy mock.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (2018c63):**

- `product_variants` đã có đủ cột: `business_status` (enum 4 giá trị, mặc định `selling`), `archived_at`, `standard_price`, `target_net_price`, `min_margin_pct`, `weight_g`, `length_mm`, `width_mm`, `height_mm`, `version`. CHECK: `(business_status = 'archived') = (archived_at is not null)`; giá `>= 0`; cân nặng, kích thước `> 0`. PR 1 **không cần migration**.
- `products` còn `archived_at`; index unique tên `where archived_at is null`. Chưa có `code`.
- Route catalog hiện có: `POST`/`PUT`/`DELETE /products/:id` (DELETE là lưu trữ cha), `POST /products/:id/variants` (tổ hợp từng ngừng bán thì **bán lại ngầm**, trả 200), `DELETE /products/:id/variants/:variantId` (ngừng bán: đặt `archived`, lỗi `last_variant`). Chưa có PATCH SKU, chưa có `business-status`.
- `getVariants` (`catalog/service/variants.ts`) trả `id, productId, productName, sku, categoryId, categoryName, archived, businessStatus, attributes`. `archived` = SKU có `archived_at` **hoặc** cha có `archived_at`. Đang được dùng ở inventory (`documents.ts`, `stock.ts`) và channel (`listing-push.ts`, `listings.ts`, `mapping.ts`, `setup.ts`, `product-port.ts`).
- `channel/service/product-port.ts` đã đọc tuỳ chọn `description`, `weightG`, `lengthMm`, `widthMm`, `heightMm` từ `getVariants`: catalog trả là channel dùng được ngay, không cần sửa channel.
- Catalog chưa phát sự kiện nào. `catalog.variant_status_changed` và `catalog.variant_price_changed` **chưa có** trong `core/platform/domain/events.ts` trên `main` hay nhánh remote nào (kiểm 16/11/2026), dù comment 13/11 của Thành nói đã khai ở PR #225.
- "Ngừng nhập không gợi ý nhập lại" **đã có**: `purchasing/service/requests.ts` chặn bằng `purchasable(businessStatus)` ("SKU đã ngừng nhập"), `inventory/domain/stock.ts` `isBelowMin`, `nextAlertState` bỏ qua `discontinued`, `archived`. Việc còn lại của ô này chỉ là test.
- `recheckThresholds(variantIds)` (`inventory/service/thresholds.ts`) đã có, đã xét `businessStatus`; chưa ai gọi khi trạng thái SKU đổi.
- Module lớn `product` chưa có việc nền nào (`startBackground`), chưa có consumer nào.
- Đơn bán có 4 trạng thái `unpaid`, `processing`, `completed`, `cancelled` (`sales/repository/schema.ts`); không có `pending` như `Documents/21` §17.3 ghi.
- Ngưỡng tồn `min_qty` là cột của `stock_levels`, không có bảng riêng; `lockLevels` tự tạo dòng 0 cho SKU từng được chạm tới. Phiếu kho từ chối SKU `archived` ngay lúc lập (`inventory/service/documents.ts`).
- Khung máy trạng thái: `defineMachine`, `assertTransition`, `availableActions` (`core/platform/domain/state-machine.ts`), lịch sử bằng `recordTransition` (`core/platform/service/transitions.ts`), sự kiện bằng `publishEvent` trong giao dịch `withCompany`, nghe bằng `registerConsumer`.
- FE: máy trạng thái ở `FE/src/lib/machines/product.ts` (6 mũi tên, `archive` có guard `archiveBlockers.length`), kiểu ở `FE/src/types/catalog.ts`. `archiveBlockers` là **câu tiếng Việt** hiển thị thẳng ("Còn 3 tồn thực"), không phải mã.

**Ràng buộc kiến trúc:**

- `product` là lớp 2. Catalog không import được `order` (lớp 3) và `channel` (lớp 5): dữ liệu của hai module này đi qua `ModuleContext` do `src/wiring.ts` dựng.
- Trong module lớn `product`, inventory và purchasing đã import catalog, nên catalog không import ngược: dữ liệu của hai module con này được nối ở `src/modules/product/index.ts` (cùng cách với `setIncomingSource`, `withContext`).
- Mọi thao tác đổi tập biến thể, và thao tác đổi trạng thái do người dùng gọi, lấy `lockVariants(companyId)` ở đầu giao dịch (bất biến sẵn có của catalog). Riêng hệ thống tự khôi phục không lấy khoá này (mục 5.2).
- Thêm loại sự kiện vào `events.ts` là sửa file dùng chung: PR riêng, báo bên nghe (`src/modules/CLAUDE.md`).
- Tiền: `numeric` trong DB, `Decimal` trong service, số nguyên đồng trên API.

## 3. Phạm vi

**Trong phạm vi:** mọi ô ở mục "Việc" và "Cần cho listing" của issue, trừ phần ghi ở dưới.

**Ngoài phạm vi (không làm trong #204):**

- **Channel phản ứng với sự kiện** (ẩn, hiện, gỡ listing khi SKU tạm ngừng, lưu trữ; chạy lại bộ lọc giá): việc của channel (Thành, #225 và phần nghe `variant_status_changed`). #204 chỉ phát sự kiện đúng hợp đồng. Hệ quả: AC "listing `live` → `hidden`" của US-SP-06 dòng 1 đến 3 chỉ qua trọn khi channel nghe xong.
- **Ba việc Thành đề xuất 09/11:** thương hiệu ở sản phẩm cha, ảnh theo biến thể, khoá trục phân loại khi đã có listing. Tách issue riêng (cần cho #295, #305). Vì vậy PATCH **chưa nhận `imageFileId`** dù `Documents/21` §17.2 có liệt kê (D1).
- **Sửa hàng loạt và gợi ý** (#242). #242 dùng lại hàm sửa một SKU của PR 1.
- **Sửa mã `code` của cha, sửa mã SKU, đổi trục phân loại, chuyển SKU sang cha khác:** chưa có route nào cho các thao tác này, nên luật "khoá sau khi có listing" chưa có gì để kiểm.
- **Cờ Cần xử lý** khi SKU tự khôi phục (US-SP-07 dòng 4): chưa có nơi lưu cờ theo SKU; chờ khung việc #209 (D6).
- **`too_many_axes` ở đề nghị nhập** (`purchasing`, `Documents/21` dòng 949): #204 chỉ trả mã này ở `POST /catalog/products`.
- **FE và E2E:** nối trang FE vào API thật, sửa kiểu FE, spec Playwright nằm ở repo FE, lên kế hoạch riêng sau từng PR backend. Mục 7 liệt kê chỗ FE phải đổi.

**Không được xảy ra (dù test vẫn xanh):**

- SKU `archived` mà còn tồn, còn đơn mở hay chứng từ mở.
- Trạng thái đổi mà không có dòng lịch sử hoặc không phát sự kiện, hoặc phát sự kiện khi giao dịch đã rollback.
- `getVariants` đổi chữ ký hay đổi nghĩa trường cũ làm inventory, channel hỏng im lặng.
- Một SKU lỗi làm cả thao tác hàng loạt trên cha thất bại.

## 4. Các cách đã cân nhắc

| Cách | Được | Mất |
|---|---|---|
| **A. Một spec, ba PR** (chọn) | Staging được gỡ kẹt trong PR đầu, không migration; thiết kế PATCH và trạng thái nhìn chung một lần nên không phải sửa lại; mỗi PR review được | Ba lần gộp `main`; hai migration ở PR 3 |
| B. Một spec, một PR | Gộp một lần | Staging chờ tới khi xong cả issue; PR quá lớn để Thành review |
| C. Spec riêng cho phần gấp, phần còn lại spec sau | Nhanh nhất cho staging | Hình dạng `ProductDetail`, `version` của SKU, sự kiện có thể phải sửa khi làm trạng thái |

Khang chọn A ngày 16/11/2026.

**Cách lấy dữ liệu của module khác cho điều kiện lưu trữ và nhãn** (người soạn chọn):

- Mỗi module giữ dữ liệu tự trả **câu lý do** và **"SKU đã dùng chưa"** của phần mình qua một cổng nhỏ; catalog chỉ gom lại. Catalog không biết bảng hay trạng thái chứng từ của module khác. Đã loại: catalog tự truy vấn bảng module khác (vi phạm luật ranh giới), và một cổng trả số liệu thô để catalog tự diễn giải (catalog phải biết nghĩa trạng thái của từng chứng từ).

## 5. Thiết kế

### 5.1 PR 1: sửa SKU, `getVariants`, sự kiện đổi giá

**`getVariants`** (`VariantSummary`) thêm, không đổi trường cũ:

| Trường | Kiểu | Nguồn |
|---|---|---|
| `description` | `string \| null` | `products.description` |
| `weightG`, `lengthMm`, `widthMm`, `heightMm` | `number \| null` | cột của SKU |

Thêm hàm công khai `targetNetPricesOf(variantIds): Promise<Map<string, Decimal | null>>`, cùng hình với `standardPricesOf`, để #225 đọc giá muốn bán mà không đọc bảng catalog (D2).

**`PATCH /catalog/products/:id/variants/:variantId`**, quyền `catalog.product.manage`.

Body (Zod `strictObject`, trường lạ kể cả `imageFileId` trả 422):

| Trường | Luật |
|---|---|
| `version` | bắt buộc, số nguyên: `version` **của SKU** |
| `standardPrice`, `targetNetPrice` | tuỳ chọn; số nguyên đồng `> 0`; `null` để xoá |
| `weightG`, `lengthMm`, `widthMm`, `heightMm` | tuỳ chọn; số nguyên `> 0`, vừa `integer` của PostgreSQL; `null` để xoá |

Bỏ trường là giữ nguyên. Chỉ gửi `version` thì không ghi gì, trả 200 với bản hiện tại (không tăng `version`, không nhật ký, không sự kiện).

Xử lý, trong một giao dịch `withCompany`:

1. Đọc sản phẩm và SKU; SKU không thuộc sản phẩm, id sai, của công ty khác: 404 `not_found`.
2. Cha đã lưu trữ (còn `archived_at` tới PR 3): 409 `product_archived`, như các route ghi khác. SKU `archived` **vẫn sửa được** (để điền cho đủ trước khi khôi phục).
3. `UPDATE … WHERE id = … AND version = …`, tăng `version` SKU, `updated_at`; không trúng thì 409 `version_conflict` kèm `current` là `ProductDetail` mới nhất.
4. `touchProduct` (đổi `updated_at` của cha, không đổi `version` cha).
5. `recordAudit` hành động `update`, thực thể `product.product_variants`, `before`/`after` chỉ gồm trường đổi.
6. Nếu `targetNetPrice` **thật sự đổi giá trị** (so bằng `Decimal`): `publishEvent('catalog.variant_price_changed')`. Đổi `standardPrice` không phát.

Trả `ProductDetail`.

**Sự kiện** (khai trong `events.ts` ở PR 0):

```
'catalog.variant_price_changed': { variantId, productId, from: money | null, to: money | null, changedAt }
```

`from`, `to` là chuỗi `numeric` của `target_net_price`. `to` là `null` khi người dùng xoá giá muốn bán (D3: comment 13/11 của Thành ghi `to: string`).

**Biến thể trong `ProductDetail`** thêm: `version`, `businessStatus`, `targetNetPrice`, `weightG`, `lengthMm`, `widthMm`, `heightMm`. Trường cũ giữ nguyên.

Hàm service sửa một SKU viết sao cho #242 gọi lại được cho từng dòng (nhận `variantId`, `version`, các trường đổi; ném `AppError`).

### 5.2 PR 2: máy trạng thái, điều kiện lưu trữ, sự kiện đổi trạng thái

**Máy trạng thái** `catalog/domain/business-status.ts`, chép đúng bảng `FE/src/lib/machines/product.ts`:

| Thao tác | Từ | Đến |
|---|---|---|
| `pause` | `selling`, `discontinued` | `paused` |
| `unpause` | `paused` | `selling` |
| `discontinue` | `selling`, `paused` | `discontinued` |
| `reactivate` | `discontinued` | `selling` |
| `archive` | `discontinued` | `archived` (guard: còn lý do chặn thì `archive_blocked`) |
| `restore` | `archived` | `discontinued` |

Mọi mũi tên mang quyền `catalog.product.manage`. Không bước nào cần người thứ hai hay lý do.

**`POST /catalog/products/:id/business-status`**, quyền `catalog.product.manage`, body `{ action, variantIds? }`.

- `variantIds` bỏ trống: áp cho mọi SKU con. Có giá trị: mảng uuid không rỗng, không lặp; id nào không thuộc sản phẩm thì 422 `errors.variantIds`.
- Trả `{ product: ProductDetail, applied: string[], skipped: { variantId, sku, code, reasons: string[] }[] }`.
- SKU không có thao tác này từ trạng thái hiện tại: vào `skipped` với `code: 'invalid_transition'`, `reasons: []`. SKU bị chặn lưu trữ: `code: 'archive_blocked'`, `reasons` là các câu lý do.
- **Đúng một** `variantIds` mà không làm được: không trả 200, ném 409 `invalid_transition` (kèm `current`) hoặc 409 `archive_blocked` (kèm `reasons`).
- Cha còn `archived_at` (tới PR 3): 409 `product_archived`.

Xử lý trong một giao dịch: `lockVariants` → đọc SKU → gom lý do chặn một lần cho mọi SKU ứng viên lưu trữ → với từng SKU: `assertTransition`, `UPDATE … WHERE id = … AND business_status = <từ>` (đặt `archived_at = now()` khi sang `archived`, `null` khi rời; tăng `version` SKU), `recordTransition` (`entityType: 'product_variants'`, tên bảng trần như các module khác; người làm), `recordAudit` (`update`, `before`/`after` là trạng thái), `publishEvent('catalog.variant_status_changed')`. Cuối cùng `touchProduct`.

**Sự kiện** (khai ở PR 0):

```
'catalog.variant_status_changed': { variantId, productId, from, to, changedAt }
```

`from`, `to` thuộc 4 trạng thái. Mỗi SKU đổi một sự kiện.

**Điều kiện lưu trữ.** Kiểu chung đặt ở catalog:

```ts
interface VariantUsageSource {
  /** Câu lý do chặn lưu trữ theo SKU; SKU không bị chặn thì không có trong Map. */
  archiveBlockers(variantIds: readonly string[]): Promise<Map<string, string[]>>;
  /** SKU đã xuất hiện ở chứng từ hoặc listing nào của module này (kể cả đã đóng). Dùng ở PR 3. */
  inUse(variantIds: readonly string[]): Promise<Set<string>>;
}
```

Bốn nguồn, mỗi module tự viết phần mình, gọi trong `withCompany` của catalog:

| Nguồn | Chặn khi | Nối bằng |
|---|---|---|
| inventory | tồn thực, đang giữ, chờ xử lý khác 0; còn phiếu kho nháp hoặc chờ duyệt có SKU | `src/modules/product/index.ts` |
| purchasing | đang về khác 0; đề nghị nhập chưa xong, phiếu nhận đang kiểm, phiếu trả NCC chưa có kết quả có SKU | `src/modules/product/index.ts` |
| order (sales) | đơn `unpaid`, `processing` có SKU (D9); yêu cầu trả đang mở có SKU | `src/wiring.ts` |
| channel | listing của SKU đang `pushing` | `src/wiring.ts` |

Câu lý do viết cho người đọc, có số khi có ("Còn 3 tồn thực", "Đang về 10", "Còn 2 đơn chưa xong", "Listing đang đẩy lên sàn"). Catalog nối các câu theo thứ tự bảng trên. Thiếu một nguồn lúc khởi động là lỗi lập trình (ném), không được coi là "không chặn".

**Ghi song song** (D10). Giao dịch lưu trữ, sau `lockVariants`, khoá dòng tồn của các SKU ứng viên (qua hàm của nguồn inventory) rồi mới gom lý do chặn: ghi sổ kho không chen được vào giữa lúc kiểm và lúc ghi. Đơn, yêu cầu trả, listing chỉ được kiểm tại thời điểm lưu trữ; #204 **không** sửa đường ghi của sales và channel để chặn tuyệt đối. Trường hợp lọt (đơn sàn về ngay sau khi lưu trữ) được đỡ bằng tự khôi phục khi có hàng vào, và bằng việc channel gỡ listing khi nghe sự kiện.

`archiveBlockers` trả kèm từng biến thể trong `ProductDetail` (rỗng với SKU không ở `discontinued`), để FE hiện nút Lưu trữ đúng.

**Hệ thống tự khôi phục** (`Documents/21` §17.3 dòng "(hệ thống)", US-SP-07 dòng 4). Catalog xuất `restoreArchivedBySystem(variantIds)`: SKU nào đang `archived` thì chuyển `discontinued` bằng cùng máy trạng thái (thao tác `restore`, `actor: null`), ghi lịch sử, phát sự kiện; SKU khác bỏ qua. Inventory gọi hàm này trong giao dịch ghi sổ, tại lõi `applyChange` (`inventory/service/posting.ts`), khi tồn thực hoặc chờ xử lý của một SKU **tăng**, và gọi **trước** `recheckThresholds` ở cuối `applyChange` để cờ ngưỡng tính theo trạng thái mới. Hàm này **không** lấy `lockVariants`: nó chạy khi dòng tồn đã bị khoá, lấy khoá công ty ở đây sẽ ngược thứ tự khoá với luồng lưu trữ (deadlock) và bắt mọi lần ghi sổ của công ty xếp hàng. Nó chỉ dùng `UPDATE … WHERE business_status = 'archived'`. Phiếu kho không lập được cho SKU `archived`, nên đường thật dẫn tới đây là kiểm hàng trả và cổng tồn theo kiện (`receiveBack`). Không bật cờ Cần xử lý (D6).

**Thêm biến thể** (`POST /catalog/products/:id/variants`): tổ hợp trùng SKU đã lưu trữ trả 409 `variant_archived` kèm `variantId`, không bán lại ngầm. Tổ hợp trùng SKU chưa lưu trữ vẫn 409 `variant_exists`. Route chỉ còn trả 201.

**Bỏ:** `DELETE /catalog/products/:id/variants/:variantId`, lỗi `last_variant`, `setVariantArchived`.

**Inventory nghe sự kiện.** Inventory chưa có việc nền: thêm `startBackground` cho `inventoryModule` (mẫu `order/fulfillment/index.ts`), trong đó `registerConsumer('catalog.variant_status_changed', …)` gọi `recheckThresholds([variantId])` trong `withCompany` của công ty mang sự kiện. Xử lý lặp an toàn (hàm sẵn đã không báo trùng).

**Tạm thời tới PR 3:** `products.archived_at` và `DELETE /catalog/products/:id` (lưu trữ cha) giữ nguyên hành vi cũ; `getVariants().archived` giữ nguyên công thức.

### 5.3 PR 3: nhãn, độ hoàn thiện, mã cha, bỏ `products.archived_at`

**Migration** (một migration, sinh ở bước cuối, có phần viết tay):

1. Sản phẩm đang có `archived_at` (D11): SKU con chưa `archived` mà dòng `stock_levels` có tồn thực, đang giữ hoặc chờ xử lý khác 0 thì chuyển `discontinued`; SKU còn lại chuyển `archived`, `archived_at` lấy của cha. Migration chỉ đọc bảng trong schema `product`, không đọc đơn hay listing. Không phát sự kiện, không ghi lịch sử (dữ liệu cũ).
2. Thêm `products.code text`, điền cho dòng cũ theo quy tắc ở dưới, rồi `NOT NULL`, unique `(company_id, code)`.
3. Tên sản phẩm: bỏ index unique một phần, thay bằng unique `(company_id, lower(name))` trên mọi sản phẩm (D4). Trước khi tạo index, sản phẩm đã lưu trữ trùng tên với sản phẩm khác được đổi tên thêm hậu tố mã cha.
4. Bỏ `products.archived_at`.

**Mã cha `code`** (D5): `renderSku(quy tắc danh mục, số thứ tự của SKU đầu tiên, [])`, tức SKU đầu tiên bỏ phần `{VAL}`. Không tiêu thêm số `{SEQ}` nào, nên bản xem trước SKU ở FE và bảng ví dụ `Documents/21` mục 9 không đổi. Sản phẩm một SKU không thuộc tính: `code` trùng SKU. Trùng `code` đã có trong công ty (hai danh mục cùng quy tắc) thì thêm `-2`, `-3`… Sinh trong cùng giao dịch và cùng khoá `lockVariants` với việc cấp SKU, cho cả `createProduct` và `createPurchaseProducts`. Không route nào sửa `code`.

Điền `code` cho sản phẩm cũ: quy tắc danh mục có thể đã bị sửa sau khi cấp SKU và số `{SEQ}` cũ không được lưu, nên không dựng lại từ quy tắc. Lấy SKU của biến thể tạo sớm nhất, cắt phần mã giá trị thuộc tính của chính biến thể đó nếu SKU kết thúc bằng phần ấy (kèm dấu nối); không cắt được thì lấy nguyên SKU. Trùng thì thêm `-2`, `-3`… Mã cũ được phép lệch quy tắc hiện tại.

**Độ hoàn thiện** `catalog/domain/readiness.ts`, hàm thuần. `missing` theo thứ tự cố định:

| `missing` | Thiếu khi | Ở |
|---|---|---|
| `name` | tên rỗng | cha |
| `category` | không có danh mục | cha |
| `image` | sản phẩm không có ảnh nào | cha |
| `price` | `target_net_price` null (giá muốn bán, D7) | SKU |
| `minQty` | chưa đặt ngưỡng tồn | SKU (inventory) |
| `weight` | `weight_g` null | SKU |
| `dimensions` | một trong ba kích thước null | SKU |

`readiness = 'ready'` khi `missing` rỗng, ngược lại `'incomplete'`. Cha thiếu trường chung thì mọi SKU con mang cùng phần thiếu đó. Ngưỡng tồn lấy từ inventory bằng một hàm tra theo lô, nối ở `src/modules/product/index.ts`.

**Hiện diện trên sàn.** Channel cấp qua `ModuleContext` một hàm tra theo lô trả, cho mỗi SKU: `presence`, `listingCount`, `hasListingError`. Quy tắc tính nằm ở channel, theo `Documents/25` §5.1 (D8, Thành sửa 16/11/2026):

- `presence`: `live` nếu có listing `live`; không thì `error` nếu có `push_failed`, `rejected`, `platform_hold`; không thì `pending` nếu có `pushing`, `under_review`; còn lại `not_listed`. `hidden` không tính là `live` (SKU tạm ngừng thì nhãn chính đã là Tạm ngừng).
- `hasListingError`: có listing `push_failed`, `rejected`, `platform_hold`, kể cả khi đã có `live`. FE hiện nhãn phụ "Có lỗi" khi `presence = 'live'` và cờ này bật.
- `listingCount`: số listing chưa `delisted` của SKU.

Nhãn chính của SKU (tính ở catalog): trạng thái kinh doanh khác `selling` thì lấy trạng thái đó; `selling` thì lấy `presence`. Nhãn chính có 7 giá trị: `archived`, `discontinued`, `paused`, `live`, `error`, `pending`, `not_listed`. `error` là nhãn chính khi SKU đang bán mà không có listing `live` nào, chỉ có listing lỗi. FE đang có 6 giá trị và đổi `error` thành `live`: phải sửa theo (mục 7).

**`ProductVariant`** (trong `ProductDetail`) đủ theo `FE/src/types/catalog.ts`, thêm so với PR 2: `readiness`, `missing`, `minQty`, `presence`, `listingCount`, `hasListingError`.

**`ProductListItem`** thêm và đổi:

| Trường | Nghĩa |
|---|---|
| `code` | mã cha |
| `variantCount` | số SKU chưa lưu trữ |
| `variantTotal` | mọi SKU |
| `labelCounts` | số SKU theo 7 nhãn chính, đủ 7 khoá |
| `incompleteCount` | số SKU chưa lưu trữ đang `incomplete` |
| `errorCount` | số SKU chưa lưu trữ có `hasListingError` (kể cả SKU đang `live`: lỗi đếm riêng, D8) |
| `status` | `'archived'` khi mọi SKU `archived`, ngược lại `'active'` (suy ra, không lưu) |

**`GET /catalog/products`:** `status=active` (mặc định) là sản phẩm còn ít nhất một SKU chưa lưu trữ; `status=archived` là sản phẩm mọi SKU đã lưu trữ. Thêm `businessStatus` (`selling`, `paused`, `discontinued`): sản phẩm có ít nhất một SKU ở trạng thái đó; gửi `archived` thì 422. Một trang danh sách dùng số câu truy vấn cố định (SKU của cả trang, ngưỡng tồn, hiện diện, ảnh mỗi thứ một lần gọi), không theo số dòng.

**`DELETE /catalog/products/:id?version=`** thành xoá hẳn: chỉ khi mọi SKU `incomplete` **và** không nguồn nào trong bốn `VariantUsageSource` báo `inUse` **và** không SKU nào có `source_request_line_id`. Ngược lại 409 `product_in_use`. Sai `version`: 409 `version_conflict`. Xoá trong một giao dịch: giá trị thuộc tính của biến thể, biến thể, ảnh gắn (không xoá tệp), `product_channel_specs`, sản phẩm; dòng `stock_levels` của SKU (chỉ mang ngưỡng tồn, không phải chứng từ) do inventory xoá qua một hàm cổng. `inUse` của inventory dựa vào thẻ kho và dòng phiếu kho, không dựa vào việc có dòng `stock_levels`. Ghi `recordAudit` `delete`.

**Sau khi bỏ `archived_at` của cha:**

- `getVariants().archived` = `businessStatus === 'archived'`. Bên gọi không phải sửa.
- Bỏ lỗi `product_archived` và mọi chỗ kiểm cha lưu trữ. Sản phẩm mọi SKU đã lưu trữ vẫn sửa tên, mô tả, ảnh, thêm biến thể được.
- `productCount`, `inUse` của danh mục, thuộc tính vẫn tính mọi sản phẩm.

**`too_many_axes`:** `POST /catalog/products` có biến thể mang quá 2 giá trị thuộc tính trả 422 `too_many_axes` (kiểm ở service trước khi ghi, thay cho lỗi CHECK của DB).

**Cho channel:** catalog xuất `variantReadiness(variantIds): Promise<Map<string, { readiness, missing }>>` để channel thay cách tạm "`paused` là chưa sẵn sàng" (`product-port.ts`). `getVariants` **không** mang `readiness` (hàm này được gọi trong lúc khoá dòng tồn, không nên kéo thêm truy vấn).

## 6. Lỗi

| Mã | HTTP | Khi | PR |
|---|---|---|---|
| `version_conflict` | 409 | PATCH SKU sai `version` SKU; DELETE sai `version` cha. Kèm `current` | 1, 3 |
| `invalid_transition` | 409 | Đúng một SKU, thao tác không có từ trạng thái hiện tại. Kèm `current` | 2 |
| `archive_blocked` | 409 | Đúng một SKU, còn lý do chặn. Kèm `reasons` | 2 |
| `variant_archived` | 409 | Thêm biến thể trùng tổ hợp SKU đã lưu trữ. Kèm `variantId` | 2 |
| `product_in_use` | 409 | Xoá hẳn sản phẩm đã hoàn thiện hoặc đã dùng | 3 |
| `too_many_axes` | 422 | Tạo sản phẩm quá 2 trục | 3 |
| `forbidden` | 403 | Thiếu `catalog.product.manage` | 1, 2, 3 |

Mọi lỗi ném `AppError`, trả Problem Details. Bảng mã lỗi `Documents/21` §17.4 đã có đủ, trừ việc `version_conflict` của PATCH (đã ghi ở dòng 1004).

## 7. Tài liệu và FE phải đổi theo

**PR Documents** (mở cùng PR backend tương ứng, sau khi Thành xác nhận các điểm D):

- `21` §17.2: PATCH chưa nhận `imageFileId` (D1); `to` của `variant_price_changed` có thể `null` (D3); cổng `targetNetPricesOf`, `variantReadiness`, `restoreArchivedBySystem` vào §11.3; quy tắc `code` (D5); `presence` (D8).
- `19`: tên sản phẩm unique trên mọi sản phẩm (D4).
- `21` §17.1 (PR 3): `presence` theo `25` §5.1 (D8 Thành sửa): `pending` là `pushing`, `under_review` (không còn "đã ghép, chưa đẩy"); thứ tự `live` > `error` > `pending`; nhãn chính có `error`; `hasListingError`; `errorCount` đếm SKU có listing lỗi kể cả đang `live`.
- `21` §17.3 (PR 2): "đơn mở" là `unpaid`, `processing` (D9); mức chặn khi ghi song song (D10); tự khôi phục chưa bật cờ Cần xử lý (D6).

**Issue #209** (việc của Khang theo Thành, D6): ghi phần nợ "SKU tự khôi phục thì bật cờ Cần xử lý" (`25` §5.1, US-SP-07 dòng 4) để khung việc làm.
- `kiem-thu/ca-theo-so-do.md`: ca B1 đã đủ cho máy trạng thái; thêm ca cho PATCH SKU, xoá hẳn, tự khôi phục nếu Thành muốn mã ca.

**`src/modules/product/catalog/CLAUDE.md`** cập nhật ở từng PR (bất biến Lưu trữ, mục Gọi vào và gọi ra, "Không phát sự kiện").

**FE (việc cho Khoa, báo trong mô tả PR):**

- `ProductVariant` và `VariantUpdateInput` thiếu `targetNetPrice`.
- `MISSING_LABELS.price` đang ghi "giá chuẩn"; theo `21` §17.1 là giá muốn bán.
- `ProductListItem` thiếu `code`; `labelCounts`, `incompleteCount`, `errorCount` chuyển thành bắt buộc sau PR 3, bỏ nhánh dự phòng ở `businessStatus.tsx`.
- Sau PR 2: bỏ gọi `DELETE …/variants/:variantId`; `POST …/variants` không còn trả 200.
- Sau PR 3: `DELETE /catalog/products/:id` là xoá hẳn, không còn là lưu trữ.
- Sau PR 3 (D8 Thành sửa): `VariantMainLabel` thêm `error` ("Có lỗi"); `mainLabel` không đổi `error` thành `live` nữa; nhãn phụ "Có lỗi" dựa vào `ProductVariant.hasListingError` khi `presence = 'live'`; `labelCounts` có 7 khoá.

## 8. Chia PR

| PR | Nội dung | Migration | Mở khoá |
|---|---|---|---|
| 0 | Khai `catalog.variant_price_changed`, `catalog.variant_status_changed` trong `events.ts`, cập nhật `src/modules/CLAUDE.md` nếu cần; báo Thành (channel nghe) | không | PR 1, PR 2, #225 |
| 1 | Mục 5.1 | không | Đẩy Lazada trên staging (FE#168 đợt 3), #225, #242 |
| 2 | Mục 5.2 | không | Trang trạng thái FE, channel nghe `variant_status_changed` |
| 3 | Mục 5.3 | có (một) | Nhãn ở danh sách (FE#177), #295 |

Mỗi PR từ `feature/204-…` vào `main`, `npm run check` xanh, có Thành review. PR 2 chứa hàm cổng mới ở inventory, purchasing, sales, channel; PR 3 thêm hàm tra hiện diện ở channel. Các hàm này chỉ đọc, do Khang viết, chủ module (Thành với channel) review trong cùng PR.

## 9. Tiêu chí chấp nhận và test

Test đặt theo `test/CLAUDE.md`: hàm thuần ở `test/unit/…`, route ở `test/api/catalog.test.ts`, cần PostgreSQL ở `test/integration/product/catalog/…`. Test integration parse body trả về bằng đúng schema Zod đăng ký trong `api/openapi.ts` (`.meta({ id })` trùng tên kiểu FE).

**PR 1**

1. PATCH đặt 4 số đo cho SKU: `GET` chi tiết trả đúng; `getVariants` trả đúng; `version` SKU tăng 1; `version` cha không đổi.
2. Gửi `null` xoá từng trường. Số 0, số âm, số lẻ, trường lạ (`imageFileId`): 422.
3. Sai `version`: 409 `version_conflict` kèm `current`; dữ liệu không đổi.
4. SKU của sản phẩm khác, công ty khác: 404.
5. Đổi `targetNetPrice`: đúng một dòng outbox `catalog.variant_price_changed` với `from`, `to` đúng. Gửi lại cùng giá, hoặc chỉ đổi `standardPrice`: không có dòng outbox mới.
6. Sale, Kho gọi PATCH: 403.
7. Channel: SKU đủ số đo không còn `dimensions_missing`. Test sẵn của channel (`listings.test.ts`) dùng cổng giả, nên thêm một test với `productPort` thật.

**PR 2**

8. Ca B1-01 đến B1-08, B1-01q đến B1-08q, B1-07g, B1-X01 đến B1-X04, mỗi ca một test mang mã ca.
9. Mỗi lần đổi: một dòng `core.state_transitions`, một dòng nhật ký, một dòng outbox `catalog.variant_status_changed`.
10. Cha 6 SKU, `pause` không `variantIds`: 6 SKU `paused`, `applied` đủ 6. Cha có SKU lệch trạng thái: SKU đó vào `skipped` với `invalid_transition`, SKU khác vẫn đổi.
11. Lưu trữ bị chặn bởi từng nguồn trong bốn nguồn (mỗi nguồn một test với cổng thật của module đó), `reasons` có câu tương ứng.
12. Thêm biến thể trùng tổ hợp SKU lưu trữ: 409 `variant_archived` kèm `variantId`.
13. SKU `archived`, hàng vào qua kiểm hàng trả hoặc cổng `receiveBack` làm tồn thực hoặc chờ xử lý tăng: SKU về `discontinued`, lịch sử có dòng `restore` người làm trống.
14. Sự kiện `variant_status_changed` sang `discontinued`: cờ cảnh báo dưới ngưỡng tắt; quay lại `selling` khi đang dưới ngưỡng: phát `inventory.below_threshold`.
15. SKU `discontinued` không thêm được vào đề nghị nhập (test cho hành vi đã có).

**PR 3**

16. US-SP-03 dòng 1 đến 3: `missing` đúng từng trường; cha không ảnh thì mọi SKU `incomplete` với `image`.
17. US-SP-08 dòng 1 đến 4: nhãn chính, `errorCount`, `labelCounts` cho "Đang bán 4/6", sản phẩm mọi SKU lưu trữ không có trong danh sách mặc định.
18. Lọc `businessStatus`; `archived` trả 422.
19. Xoá hẳn: sản phẩm chờ hoàn thiện chưa dùng thì 204 và hết dòng trong DB; sản phẩm đã `ready`, hoặc có đơn, phiếu, listing, hoặc sinh từ đề nghị nhập: 409 `product_in_use`.
20. Tạo sản phẩm 3 trục: 422 `too_many_axes`.
21. `code`: tạo sản phẩm có `code` đúng quy tắc; hai danh mục cùng quy tắc không trùng `code`.
22. Migration: sản phẩm cha đang lưu trữ thành mọi SKU `archived`; `npm run db:ci-check` xanh.
23. `getVariants().archived` đúng theo `businessStatus` ở các chỗ inventory, channel đang dùng (test sẵn của hai module vẫn xanh).

## 10. Điểm người soạn tự quyết, Thành đã xác nhận

Thành trả lời trên issue #204 ngày 16/11/2026. Cột cuối là ý kiến của Thành.

| # | Điểm | Đề xuất | Vì sao | Thành |
|---|---|---|---|---|
| D1 | `21` §17.2 PATCH có `imageFileId` | Chưa nhận, gửi thì 422 | Ảnh theo biến thể cần bảng mới, tách issue cùng thương hiệu và khoá trục | Đồng ý. Thành tạo issue riêng cho ảnh phân loại theo SKU, thương hiệu, khoá trục; đổi phụ thuộc của #295 sang issue đó |
| D2 | #225 đọc giá muốn bán bằng gì | Catalog xuất `targetNetPricesOf` | Channel không được đọc bảng catalog; `ProductPort` hiện chỉ có `standardPrices` | Đồng ý |
| D3 | `to` của `variant_price_changed` | `string \| null` | PATCH cho phép xoá giá muốn bán bằng `null` (`21` §17.2) |
| D4 | Tên sản phẩm sau khi bỏ `archived_at` | Unique trên mọi sản phẩm của công ty | Trạng thái cha là suy ra, index một phần không tham chiếu được SKU con; khôi phục không sinh hai sản phẩm trùng tên | Đồng ý. Là đổi luật; migration PR 3 phải xử lý tên đang trùng (thêm hậu tố), không thì tạo index lỗi |
| D5 | Cách sinh `code` | SKU đầu tiên bỏ `{VAL}`, trùng thì thêm `-2` | `21` §17 chỉ ghi "sinh theo quy tắc danh mục"; cách này không tiêu thêm `{SEQ}` nên không lệch bản xem trước SKU của FE | Đồng ý |
| D6 | Cờ Cần xử lý khi tự khôi phục | Chưa làm, chỉ khôi phục và phát sự kiện | Chưa có nơi lưu cờ theo SKU; chờ #209 | Đồng ý tạm. `25` §5.1 có bật cờ Cần xử lý: Khang ghi phần cờ còn nợ vào #209 |
| D7 | `missing: 'price'` là giá nào | Giá muốn bán `target_net_price` | `21` §17.1, `25` §5.2; FE đang ghi nhãn "giá chuẩn" | Đồng ý; nhãn FE "giá chuẩn" phải sửa |
| D8 | Cách tính `presence` | `error` > `live` (gồm `hidden`) > `pending` (`pushing`, `under_review`) > `not_listed` | `21` §17.1 ghi `pending` là "đã ghép, chưa đẩy", `25` §5.1 ghi theo trạng thái listing; FE hiện `error` như `live` kèm nhãn phụ | **Sửa**: `live` > `error` > `pending` > `not_listed`, `hidden` không tính là `live`, lỗi đếm riêng (`25` §5.1). `21` §17.1 sửa `pending` theo `25` trong PR Documents của PR 3. Đã sửa mục 5.3 |
| D9 | "Đơn mở" ở `21` §17.3 ghi `pending`, `processing` | `unpaid`, `processing` | Enum đơn trong code không có `pending` | Đồng ý; sửa `21` §17.3 theo enum trong code |
| D10 | Mức chặn khi có ghi song song | Khoá dòng tồn khi lưu trữ; đơn và listing chỉ kiểm tại thời điểm lưu trữ | Chặn tuyệt đối phải sửa đường ghi của sales, channel, vượt phạm vi issue | Đồng ý |
| D11 | SKU của cha đang lưu trữ mà còn tồn, khi migration | Còn tồn thì `discontinued`, còn lại `archived` | `DELETE` cha kiểu cũ không kiểm điều kiện; không để SKU `archived` còn tồn | Đồng ý |

## 11. Để lại cho người thi công

- Tên hàm, tên file, cách chia file trong `service/`, `repository/`.
- Hình dạng chính xác của trường `ctx` cho bốn nguồn và hàm tra hiện diện, miễn đúng luật ranh giới và quên nối là lỗi kiểu ở `wiring.ts`.
- Câu chữ của lý do chặn.
- Câu SQL của danh sách sản phẩm, miễn số truy vấn không theo số dòng.
- Cách consumer của inventory lấy công ty từ sự kiện (theo mẫu consumer sẵn có).
