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

## Chưa làm

Thiết lập lần đầu, ghép SKU, đẩy tồn và giá, `zeroStock` khi ngắt (#104); tự làm mới token và hàng chờ `pendingJobs` (#102, tới đó `pendingJobs` = 0); kéo đơn khi nối lại (#105, `reconnect.pulledFrom` chỉ báo mốc); push (#133).
