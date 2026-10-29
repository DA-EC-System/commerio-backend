# channel/channel

Gian hàng sàn, token, listing kiêm bảng ghép SKU, lần tính giá theo sàn, dữ liệu gốc của đơn sàn. Chỉ đọc tồn khả dụng, không đổi tồn. Hợp đồng API ở `Documents/21` §18.

## Gian hàng (#103)

Máy trạng thái ở `domain/shop.ts` (§18.1, cùng bảng với FE `src/lib/machines/channel.ts`): `connecting` → `active` (`finish_setup`, #104) → `needs_reauth` (`lose_auth`, hệ thống) → `active` (`reconnect`); ngắt từ mọi trạng thái trừ `disconnected`. Riêng BE có `resume_setup` (`disconnected` → `connecting`) cho gian hàng ngắt khi chưa thiết lập, vì CHECK `shops_active_cutoff` bắt `active` phải có `order_cutoff_at`. Mọi lần chuyển ghi `core.state_transitions` (`entity_type = 'shops'`; listing gỡ do ngắt ghi `'listings'`).

- Gian hàng định danh bằng `(platform, external_shop_id)`; nối lại cùng seller thì dùng lại bản ghi. Index `shops_platform_external_live_uq` chặn một seller gắn hai công ty cùng lúc (409 `shop_connected_elsewhere`); ngắt rồi thì công ty khác nối được.
- Ba cách nối: OAuth (`authorize-url` → sàn → `callback`), hoặc dán token console (`POST /shops/:platform/token`, shop thử Lazada không đi OAuth được). `state` OAuth là token ký 10 phút (`purpose-token.ts`, loại `oauth`), gắn công ty, người bấm, sàn; không dùng Redis.
- Gọi sàn trước, ngoài giao dịch; ghi DB sau trong `withCompany`. Kiểm "seller đã gắn công ty khác" đọc ngoài `withCompany` (role chủ bảng), như tra mã thanh toán.
- Token lưu mã hoá AES-GCM bằng `CHANNEL_TOKEN_KEY`, AAD `<shopId>:access|refresh`. Ngắt thì xoá token. Token không bao giờ có trong response, log, lỗi.

## Adapter sàn

`service/marketplaces/`: `common.ts` (interface `MarketplaceAdapter`, `TokenSet`, `SellerInfo`, `MarketplaceError`), `lazada.ts` (ký HMAC-SHA256, gọi, đổi lỗi), `index.ts` (`getAdapter`, test thay bằng `registerAdapter`/`resetAdapters`). Thêm sàn = một file + một dòng ở `index.ts`; năng lực mới (listing, đơn, kiện) thêm vào interface khi issue cần. Code ngoài adapter không rẽ nhánh theo sàn.

Lỗi sàn: `MarketplaceError.kind` đổi sang mã app ở `service/shops.ts` (`toAppError`, Documents/21 §1.1 R8, R9): `unavailable` 503 `marketplace_unavailable`; `unsupported` 422 `marketplace_unsupported`; còn lại 409 `marketplace_rejected` kèm `platformCode`, `platformMessage`. Seller ngoài whitelist của app bị Lazada chặn ngay trên trang uỷ quyền (không có `code`), BE không nhận được lỗi đó; FE báo theo `error` trên URL callback. Base URL Lazada đọc từ `LAZADA_API_URL`, `LAZADA_AUTH_URL` để trỏ sang sàn giả lập (#115).

## Cho module khác

- `getShops(ids)`: tên, sàn của gian hàng (report).
- `markNeedsReauth(shopId, reason)`: gọi trong `withCompany` khi làm mới token thất bại (#102) hoặc sàn báo gỡ app (#133).
- **Cổng quyết toán cho finance** (#117, `service/settlement-port.ts`, tiêm qua `ctx.settlementSource` ở `src/wiring.ts`): `settlementTransactions(companyId, shopId, from, to)`, `settlementPayouts(companyId, shopId, from)` gọi `getTransactions`/`getPayouts` của adapter (Lazada `/finance/transaction/details/get` lật trang 500, `/finance/payout/status/get`); `shopsToSettle()` các gian hàng `active` mọi công ty cho vòng kéo 6 giờ. Adapter chưa có `getTransactions` thì 422 `marketplace_unsupported` (lần chạy `failed`), chưa có `getPayouts` thì coi như không có kỳ nào. Dấu, tên khoản giữ nguyên của sàn; finance tự đổi loại (`kindOfTransaction`). Dạng phản hồi theo tài liệu Lazada, chưa so với dữ liệu thật.

## Listing (#104)

Máy trạng thái ở `domain/listing.ts` (§18.3, cùng bảng FE). Mỗi lần chuyển ghi `core.state_transitions` (`entity_type = 'listings'`); thao tác của sàn có `actor_id` null. Gian hàng gọi được sàn qua `shopSession(id)` (`connecting`, `active`, còn token), không thì 409 `shop_not_connected`.

- **Ghép danh mục** (`service/categories.ts`, bảng `category_maps`): danh mục Commerio → danh mục lá của sàn kèm thuộc tính bắt buộc cấp sản phẩm; ghép phải đủ, đúng lựa chọn của sàn (422 `errors["attributes.<tên>"]`).
- **Đẩy** (`service/listings.ts`): một SKU Commerio là một sản phẩm trên sàn, SellerSku = SKU. Ghi `pushing` và commit trước, gọi sàn ngoài giao dịch, ghi kết quả sau: sàn cho bán ngay (`item_status: Active`) thì `go_live`, không thì `send_review`; lỗi thì `fail` kèm `pushError`. Ảnh: catalog chưa lưu ảnh nên request mang `imageUrls` theo sản phẩm, BE đưa lên sàn và lưu `external_image_urls`. Thất bại theo dòng: `price_missing`, `category_unmapped`, `dimensions_missing`, `images_missing`, `already_listed` (sửa nội dung `/product/update` chưa làm).
- **Đồng bộ** (`service/listing-sync.ts`, route `sync`; #102 sẽ chạy định kỳ): đọc trạng thái sàn **chỉ theo SellerSku của mình** (shop thử dùng chung) → `approve`/`reject`/`hold`/`release` (`syncAction`); `pushing` quá 30 phút → `fail`; đẩy giá chuẩn và khả dụng của listing `stock_sync`/`price_sync` khác `synced`, theo lô 20, lỗi ghi theo từng SKU (`stock_sync_error`, `price_sync_error`).
- **Consumer** `inventory.stock_changed` (`channel-stock-push`) chỉ đánh dấu `stock_sync = pending` (ghi DB, đúng một lần); lần `sync` sau mới gọi sàn, không gọi sàn trong giao dịch của consumer.
- **Thiết lập lần đầu** (`service/setup.ts`, §18.2): gợi ý SKU sàn có SellerSku trùng SKU Commerio, tạo listing `live`, đẩy khả dụng, `finish_setup`. Chỉ chế độ `push`; `stocktake` cần phiếu kiểm kê (#112).
- **Ngắt kèm `zeroStock`**: route gọi `pushZeroStock` trước khi ngắt; không gọi được sàn thì 422 `zero_stock_unavailable`, chưa ngắt.
- **Cổng sang `product`** (`service/product-port.ts`): `getVariants`, `standardPricesOf`. Cân nặng, kích thước, mô tả chờ #110 thêm vào `getVariants` (tới đó đẩy báo `dimensions_missing`); `availableOf` chờ #111 (tới đó tồn đẩy lên là 0). Test thay bằng `setProductPort`.

Lazada (gọi thật 28/10/2026): đổi giá, tồn phải gửi `ItemId` + `SkuId` (SellerSku bị bỏ); lỗi nghiệp vụ sản phẩm cũng mang `type: ISP`, chỉ `6`, `901`, `1000`, `4154` là lỗi tạm; POST mang payload gửi bằng form body.

## Chưa làm

Tự làm mới token, hàng chờ `pendingJobs`, thử lại tự động, đồng bộ định kỳ (#102); kéo đơn khi nối lại (#105, `reconnect.pulledFrom` chỉ báo mốc); push (#133); ẩn/hiện theo trạng thái SKU (#110); giá theo phí (#118); cảnh báo QC; phân loại Lazada.
