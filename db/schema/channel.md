# Schema `channel` · Kênh bán · lớp 5

<!-- Sinh tự động bởi `npm run db:docs`. Không sửa tay: sửa comment trong schema.ts (hoặc scripts/db/lib/schema-refs.ts) rồi chạy lại lệnh. -->

Phiên bản **V149**, 24 bảng. Mục lục mọi schema và các bảng đã bỏ: [../SCHEMA.md](../SCHEMA.md).

**Không có ở đây:** RLS và policy (mọi bảng có `company_id` bật RLS với policy `company_isolation`, trừ ngoại lệ ở `test/integration/shared/rls-coverage.test.ts`), quyền của role `commerio_app`, hàm SQL, và mọi thứ tạo bằng SQL động. Xem `db/CLAUDE.md` mục Row-Level Security và các migration viết tay.

## `channel.api_usage`

Số lời gọi sàn trong một ngày (giờ Việt Nam) (#102 A7, #215). Dòng `company_id` trống là tổng của cả app, mọi công ty cộng chung: hạn mức gọi do sàn đặt cho app (Lazada 10.000/ngày). Dòng có `company_id` là phần công ty đó đã dùng (Documents/21 §18.6.8). Một lượt gọi cộng cả hai dòng trong một giao dịch (`repository/api-usage.ts`). Chỉ đọc ghi bằng role chủ bảng ngoài `withCompany`; RLS bật theo luật bảng có `company_id` (migration `rls-han-muc-cong-ty`).

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `platform` text · not null → `channel.marketplaces.code` (khoá ngoại viết tay)
- `day` date · not null
- `company_id` uuid · null → `core.companies` (theo công ty)
- `calls` integer · not null

Ràng buộc và index:

- unique (`platform`, `day`, `company_id`) NULLS NOT DISTINCT `api_usage_platform_day_company_uq`
- khoá ngoại viết tay (`platform`) → `channel.marketplaces` (`code`), ở `db/migrations/20261121115038_bang-san-fk.sql`

## `channel.axis_mappings`

Ánh xạ thuộc tính phân loại của công ty sang sales attribute của sàn (#448, Documents/19 §3.3, Documents/21 §18.8.3 nguồn 2): mỗi (thuộc tính, sàn) một danh sách mã theo `priority` (1 là ưu tiên nhất). Thuộc tính có `platform_kind` không cần dòng: dùng mặc định của adapter; có dòng thì dòng thắng. `attribute_id` trỏ `product.attributes`, không có khoá ngoại chéo schema. RLS (migration `*_anh-xa-truc-rls`).

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
  NULL: ánh xạ nền tảng của thuộc tính chuẩn, dùng chung mọi công ty, chỉ migration ghi; có giá trị: của công ty.
- `attribute_id` uuid · not null → `product.attributes.id` (tham chiếu, không có khoá ngoại)
- `platform` text · not null → `channel.marketplaces.code` (khoá ngoại viết tay)
- `attribute_code` text · not null
  Mã sales attribute của sàn (`platform_category_attributes.code`, `kind = 'sales'`).
- `priority` smallint · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`company_id`, `attribute_id`, `platform`, `attribute_code`) `axis_mappings_code_uq`
- unique (`company_id`, `attribute_id`, `platform`, `priority`) `axis_mappings_priority_uq`
- unique index (`attribute_id`, `platform`, `attribute_code`) `axis_mappings_platform_code_uq` where `company_id IS NULL`
- unique index (`attribute_id`, `platform`, `priority`) `axis_mappings_platform_priority_uq` where `company_id IS NULL`
- check `axis_mappings_priority`: `priority >= 1`
- khoá ngoại viết tay (`platform`) → `channel.marketplaces` (`code`), ở `db/migrations/20261121115038_bang-san-fk.sql`

## `channel.conversation_notes`

Ghi chú nội bộ trên hội thoại, khách không thấy.

Khai ở `src/modules/channel/inbox/repository/schema.ts` · module con `inbox` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `conversation_id` uuid · not null → `channel.conversations.id` (khoá ngoại)
- `author_id` uuid · not null → `core.accounts` (người thao tác)
- `body` text · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`conversation_id`) `conversation_notes_conversation_id_index`

## `channel.conversation_tags`

Khai ở `src/modules/channel/inbox/repository/schema.ts` · module con `inbox` · theo công ty (`company_id`)

Cột:

- `conversation_id` uuid · khoá chính → `channel.conversations.id` (khoá ngoại)
- `tag_id` uuid · khoá chính → `channel.tags.id` (khoá ngoại)
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- khoá chính (`conversation_id`, `tag_id`)
- index (`tag_id`) `conversation_tags_tag_id_index`

## `channel.conversations`

Khai ở `src/modules/channel/inbox/repository/schema.ts` · module con `inbox` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `message_channel_id` uuid · not null → `channel.message_channels.id` (khoá ngoại)
- `customer_identity_id` uuid · null → `order.customer_identities.id` (tham chiếu, không có khoá ngoại)
- `assignee_id` uuid · null → `core.accounts` (người thao tác)
- `external_conversation_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `last_message_at` timestamptz · null
- `unread_count` integer · not null · mặc định `0`
- `reply_window_expires_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`message_channel_id`) `conversations_message_channel_id_index`
- index (`assignee_id`) `conversations_assignee_id_index`

Trỏ vào bảng này:

- `channel.conversation_notes.conversation_id` (khoá ngoại)
- `channel.conversation_tags.conversation_id` (khoá ngoại)
- `channel.messages.conversation_id` (khoá ngoại)
- `order.orders.conversation_id` (tham chiếu, không có khoá ngoại)

## `channel.listing_sync_runs`

Lượt đồng bộ do người bấm (Documents/21 §18 "Kết quả lượt đồng bộ", thiết kế `trang-san-pham-tab/design/v2.html` Màn 2). Lượt định kỳ 15 phút không ghi. `queued` lúc bấm; việc `channel.listing_sync` bắt đầu thì nhận mọi lượt `queued` của gian hàng (`running`, `started_at`), mỗi lô đẩy xong tăng `processed`, `succeeded`, `failed` và nối `errors` (tối đa 200 dòng), xong thì `done` hoặc `failed` kèm `error`. `total` null khi chưa biết (đang đọc sàn). Một lượt `queued` mỗi gian hàng (`listing_sync_runs_one_queued_uq`): bấm khi đang có lượt chờ thì dùng lại lượt đó.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · not null → `channel.shops.id` (khoá ngoại, ON DELETE cascade)
- `status` text · not null · mặc định `'queued'`
- `requested_by` uuid · null → `core.accounts` (người thao tác)
- `requested_at` timestamptz · not null · mặc định `now()`
- `started_at` timestamptz · null
- `finished_at` timestamptz · null
- `total` integer · null
- `processed` integer · not null · mặc định `0`
- `succeeded` integer · not null · mặc định `0`
- `failed` integer · not null · mặc định `0`
- `errors` jsonb · not null · mặc định `'[]'::jsonb`
- `error` jsonb · null
  Lỗi cả lượt `{ code, message }` (sàn lỗi cả lô, mất uỷ quyền, gian hàng ngắt).

Ràng buộc và index:

- unique index (`shop_id`) `listing_sync_runs_one_queued_uq` where `status = 'queued'`
- index (`shop_id`, `requested_at`) `listing_sync_runs_shop_idx`
- check `listing_sync_runs_status`: `status in ('queued', 'running', 'done', 'failed')`
- check `listing_sync_runs_counts`: `processed >= 0 and succeeded >= 0 and failed >= 0 and succeeded + failed = processed`
- check `listing_sync_runs_total`: `total is null or processed <= total`
- check `listing_sync_runs_started`: `(status = 'queued') = (started_at is null)`
- check `listing_sync_runs_finished`: `(status in ('done', 'failed')) = (finished_at is not null)`
- check `listing_sync_runs_error`: `error is null or status = 'failed'`

## `channel.listings`

Một SKU trên một gian hàng, đồng thời là bảng ghép SKU sàn → SKU app. Mã sàn trống khi chưa đẩy lần nào. Tồn và giá đồng bộ riêng (`stock_sync`, `price_sync`). `delisted_by_disconnect`: gỡ do ngắt, kết nối lại thì đưa lên.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · not null → `channel.shops.id` (khoá ngoại)
- `mode` enum `channel.listing_mode` · not null · mặc định `'mapped'`: `mapped` | `unmanaged`
- `variant_id` uuid · null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `external_product_id` text · null → `channel.shop_products.external_product_id` (khoá ngoại)
- `external_sku_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `seller_sku` text · null
- `status` enum `channel.listing_status` · not null · mặc định `'pushing'`: `pushing` | `push_failed` | `under_review` | `rejected` | `live` | `hidden` | `platform_hold` | `delisted`
- `reject_reason` text · null
- `push_error` jsonb · null
  Lỗi của lượt đẩy (§18.6.4): `{ code, message, at }`; `code` là mã lỗi sàn hoặc mã chặn khi việc chạy (mô tả ở `ChannelListing.pushError`).
- `push_attempts` integer · not null · mặc định `0`
- `push_started_at` timestamptz · null
- `external_category_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
  Category thật của listing trên gian hàng này (#400, Documents/19 mục 3.3): ghi khi đẩy xong, khi ghép SKU đọc sàn và khi đồng bộ thấy sàn đổi. Cột thông tin, ghi không tăng `version` (L029: không làm `runListingPush` bỏ kết quả).
- `create_attempted_at` timestamptz · null
  Lần đầu app gọi `createProduct` cho listing này (#399): mốc phân biệt sản phẩm app tạo với sản phẩm người bán có sẵn. Chỉ ghi khi null, không tăng `version`.
- `hidden_by` enum `channel.hidden_by` · null: `platform` | `zero_stock`
- `outside_change_kind` enum `channel.outside_change_kind` · null: `disabled` | `price_changed`
  Sàn đổi listing ngoài app (#360, 21 §18.3 `outsideChange`): dừng bán, chờ CEO quyết. Giá chỉ có khi `price_changed`.
- `outside_change_price` numeric(18,2) · null
- `outside_change_at` timestamptz · null
- `stock_sync` enum `channel.sync_state` · not null · mặc định `'pending'`: `synced` | `pending` | `error`
- `price_sync` enum `channel.sync_state` · not null · mặc định `'pending'`: `synced` | `pending` | `error`
- `platform_stock` integer · null
- `stock_sync_error` jsonb · null
  Lỗi lần đẩy gần nhất của riêng SKU này (§18.4): `{ code, message, at }`, null khi đã đồng bộ.
- `price_sync_error` jsonb · null
- `last_pushed_at` timestamptz · null
- `last_price_pushed_at` timestamptz · null
  Lần sàn nhận giá app đẩy gần nhất (#360). So giá sàn bị sửa ngoài app chờ 15 phút sau mốc này; không dùng `last_pushed_at` vì lần đẩy tồn cũng ghi mốc đó, SKU đổi tồn mỗi chu kỳ sẽ không bao giờ được so giá.
- `external_image_urls` text[] · null: mã bên ngoài (sàn, cổng thanh toán)
  Ảnh đã đưa lên sàn (URL trên sàn), dùng lại cho lần đẩy sau.
- `listed_price` numeric(18,2) · null
- `manual_price` numeric(18,2) · null
- `price_calc_id` uuid · null → `channel.price_calculations.id` (khoá ngoại)
- `delisted_by_disconnect` boolean · not null · mặc định `false`
- `approved_by` uuid · null → `core.accounts` (người thao tác)
- `pending_variant_id` uuid · null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
  Ghép chờ CEO duyệt (#220, Documents/19, 21 §18.6.5): ghép sang "không quản tồn" hoặc đổi ghép đã có đơn do người không phải CEO làm. `pending_mode = 'unmanaged'` thì `pending_variant_id` trống. Duyệt thì chép sang `mode`, `variant_id`; từ chối thì xoá bốn cột này.
- `pending_mode` enum `channel.listing_mode` · null: `mapped` | `unmanaged`
- `pending_requested_by` uuid · null → `core.accounts` (người thao tác)
- `pending_requested_at` timestamptz · null
- `pending_external_sku_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
  SKU sàn chờ CEO duyệt ghép vào listing lỗi đẩy chưa có mã sàn (#346, Documents/19): đổi SKU người bán mà đã có đơn mang SKU người bán cũ. Duyệt thì chép sang `external_*`, `seller_sku`; từ chối thì xoá cùng bốn cột chờ duyệt.
- `pending_external_product_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `pending_seller_sku` text · null
- `mapping_self_approved` boolean · not null · mặc định `false`
  Ghép hiện hành do CEO (hoặc công ty một người) tự làm ở bước cần CEO duyệt (25 §11 ngoại lệ tự duyệt).
- `mapping_requested_by` uuid · null → `core.accounts` (người thao tác)
  Người xin ghép hiện hành, giữ lại sau khi duyệt (`pending_requested_by` bị xoá lúc duyệt) để CSDL ép người duyệt khác người xin (Documents/19 mục 2 "Người duyệt khác", #220). Null với dòng có trước #220 hay chưa từng qua bước duyệt.
- `revision_status` enum `channel.listing_revision_status` · null: `auditing` | `failed`
  Bản sửa nội dung chờ sàn duyệt (`pendingRevision`, #293): ghi khi `update_content` mà sàn vẫn bán bản cũ; đồng bộ xoá khi qua duyệt, ghi `failed` kèm lý do khi trượt. Giữ khi ẩn, sàn khoá; xoá khi rời các trạng thái đó.
- `revision_reject_reason` text · null
- `revision_at` timestamptz · null
- `category_change` jsonb · null
  Lượt đổi category trên sàn (`categoryChange`, commerio-backend#467): `{ status, toCategoryId, toCategoryPath, code, message, attempts, at }`, null khi không có hoặc sàn đã nhận mà không lệch (trạng thái duyệt ở `revision_*`). Xoá khi gỡ.
- `content_source` enum `channel.listing_content_source` · not null · mặc định `'platform'`: `app` | `platform`
  Mặc định `platform` (không rõ nguồn thì không ghi đè nội dung người bán); mọi chỗ tạo listing ghi rõ giá trị.
- `remote_title_at_match` text · null
  Tên trên sàn lúc ghép (#396, 21 §18.3 `remoteTitleChanged`): mốc để biết người bán đổi tên ngoài app. Đặt khi ghép có hiệu lực, thiết lập, xác nhận (từ bản sao) và khi app đẩy, sửa nội dung (tên app vừa gửi). `matched_at` null: tên tiếng Anh lúc ghép chưa biết, lần ghi bản sao kế tiếp lấy `title_en` làm mốc; có giá trị thì chỉ bản sao đọc từ mốc đó trở đi mới được so (lượt đọc bắt đầu trước khi đẩy xong còn tên cũ). `changed_at`: lúc thấy tên khác mốc.
- `remote_title_en_at_match` text · null
- `remote_title_matched_at` timestamptz · null
- `remote_title_changed_at` timestamptz · null
- `replaces_listing_id` uuid · null → `channel.listings.id` (khoá ngoại)
  Dòng `delisted` mà dòng này thay (đẩy lại sau khi gỡ, kết nối lại; Documents/19, 25 §6.1).
- `shop_product_id` uuid · null → `channel.shop_products.id` (khoá ngoại)
  Sản phẩm sàn của listing (#295, `shop_products`): có `external_product_id` thì bắt buộc, và hai mã sàn phải bằng nhau (khoá ngoại ghép). Lần đẩy đầu của cha trỏ dòng `app` còn chưa có mã sàn.
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique index (`shop_id`, `variant_id`) `listings_shop_variant_uq` where `variant_id is not null and status <> 'delisted'`
- unique index (`shop_id`, `external_sku_id`) `listings_shop_external_sku_uq` where `external_sku_id is not null and status <> 'delisted'`
- unique index (`shop_id`, `pending_external_sku_id`) `listings_shop_pending_external_sku_uq` where `pending_external_sku_id is not null`
- index (`variant_id`) `listings_variant_id_index`
- index (`shop_product_id`) `listings_shop_product_id_index`
- check `listings_mode`: `(mode = 'mapped') = (variant_id is not null)`
- check `listings_unmanaged_approved`: `mode = 'mapped' or approved_by is not null or pending_requested_by is not null`
- check `listings_pending_mapping`: `(pending_mode is null and pending_variant_id is null and pending_requested_by is null and pending_requested_at is null)
        or (pending_requested_by is not null and pending_requested_at is not null and pending_mode is not null and (pending_mode = 'mapped') = (pending_variant_id is not null))`
- check `listings_pending_external`: `(pending_external_sku_id is null and pending_external_product_id is null and pending_seller_sku is null)
        or (pending_external_sku_id is not null and pending_external_product_id is not null and pending_seller_sku is not null
          and pending_requested_by is not null and status = 'push_failed' and external_sku_id is null)`
- check `listings_delisted_no_pending`: `status <> 'delisted' or pending_requested_by is null`
- check `listings_self_approved_has_approver`: `not mapping_self_approved or approved_by is not null`
- check `listings_mapping_second_person`: `approved_by is null or mapping_requested_by is null or approved_by <> mapping_requested_by or mapping_self_approved`
- check `listings_hidden_by`: `hidden_by is null or status in ('hidden', 'live')`
- check `listings_outside_change`: `(outside_change_kind is null and outside_change_price is null and outside_change_at is null) or (outside_change_kind is not null and status = 'hidden' and outside_change_at is not null and (outside_change_kind = 'price_changed') = (outside_change_price is not null))`
- check `listings_revision`: `(revision_status is null) = (revision_at is null)
        and (revision_reject_reason is null or revision_status = 'failed')
        and (revision_status is null or status in ('live', 'hidden', 'platform_hold'))`
- check `listings_remote_title`: `(remote_title_at_match is not null or (remote_title_en_at_match is null and remote_title_matched_at is null))
        and (remote_title_changed_at is null or remote_title_matched_at is not null)`
- check `listings_category_change`: `category_change is null or (status <> 'delisted' and category_change ->> 'status' in ('queued', 'failed', 'mismatch'))`
- check `listings_reject_reason`: `status <> 'rejected' or reject_reason is not null`
- check `listings_push_attempts`: `push_attempts >= 0`
- check `listings_prices`: `listed_price >= 0 and manual_price >= 0`
- trigger `listings_attach_shop_product`: `BEFORE INSERT OR UPDATE OF external_product_id, shop_product_id → channel.listings_attach_shop_product()`, ở `db/migrations/20261120221509_san-pham-san-du-lieu.sql`

Trỏ vào bảng này:

- `channel.listings.replaces_listing_id` (khoá ngoại)

## `channel.marketplaces`

Danh mục sàn dùng chung cho mọi công ty (Documents/19 mục 3.3, thay enum `channel.marketplace` 21/11/2026). Dòng do migration chèn; thêm sàn = adapter + một dòng `INSERT` (`Documents/tich-hop-san/README.md` bước 4). Tên hiển thị không lưu ở đây: nguồn là `adapter.name`. Worker khởi động thì đối chiếu với registry adapter (`verifyMarketplaces`). `commerio_app` chỉ đọc (migration `*_bang-san-fk`).

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel`

Cột:

- `code` text · khoá chính
- `enabled` boolean · not null · mặc định `true`
  `false`: sàn không mở cho người dùng ở môi trường này (sàn chưa có adapter, sàn giả lập `mock`).
- `created_at` timestamptz · not null · mặc định `now()`

Trỏ vào bảng này:

- `channel.api_usage.platform` (khoá ngoại viết tay)
- `channel.axis_mappings.platform` (khoá ngoại viết tay)
- `channel.platform_categories.platform` (khoá ngoại viết tay)
- `channel.platform_category_attributes.platform` (khoá ngoại viết tay)
- `channel.product_specs.platform` (khoá ngoại viết tay)
- `channel.shops.platform` (khoá ngoại viết tay)
- `channel.spec_field_mappings.platform` (khoá ngoại viết tay)
- `channel.spec_option_mappings.platform` (khoá ngoại viết tay)
- `channel.webhook_events.platform` (khoá ngoại viết tay)

## `channel.message_channels`

Kênh nhắn tin đã kết nối (trang Messenger, hộp thư, Zalo OA, chat sàn). Token lưu đã mã hoá.

Khai ở `src/modules/channel/inbox/repository/schema.ts` · module con `inbox` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `kind` enum `channel.message_kind` · not null: `messenger` | `email` | `zalo_oa` | `tiktok_chat` | `shopee_chat`
- `external_account_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `display_name` text · not null
- `shop_id` uuid · null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `access_token_enc` bytea · null
- `status` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `kind`, `external_account_id`) `message_channels_company_id_kind_external_account_id_unique`

Trỏ vào bảng này:

- `channel.conversations.message_channel_id` (khoá ngoại)

## `channel.messages`

Tin nhắn; tin gửi đi chưa có mã ngoài cho tới khi nền tảng nhận. Chống lặp khi đồng bộ theo mã ngoài.

Khai ở `src/modules/channel/inbox/repository/schema.ts` · module con `inbox` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `conversation_id` uuid · not null → `channel.conversations.id` (khoá ngoại)
- `external_message_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `direction` enum `channel.msg_direction` · not null: `inbound` | `outbound`
- `type` text · not null
- `content` jsonb · not null
- `sender_id` uuid · null: chưa có code ghi; tin đến (`inbound`) là của khách nên không trỏ cố định `core.accounts`
- `send_status` enum `channel.send_status` · null: `pending` | `sent` | `failed`
- `sent_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`company_id`, `external_message_id`) `messages_company_id_external_message_id_unique`
- index (`conversation_id`) `messages_conversation_id_index`

## `channel.platform_categories`

Bản sao cây category của sàn (#400, Documents/19 mục 3.3). Dữ liệu tham chiếu của nền tảng, giống nhau mọi khách thuê: không `company_id`, không RLS; `commerio_app` chỉ `SELECT` (migration `*_category-san-quyen`), ghi bằng role chủ bảng ngoài `withCompany` (Documents/19 mục 2). Category sàn bỏ thì `status = 'removed'`, không xoá dòng (spec cũ còn trỏ tới). `synced_at` null là dòng tạm (leaf mới thấy khi lấy attribute, trước lượt đồng bộ cây): tìm kiếm bỏ qua, đồng bộ ghi đè. `attributes_fetched_at`: lần lấy attribute gần nhất, kể cả khi leaf không có attribute nào (dùng lại 7 ngày).

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel`

Cột:

- `platform` text · khoá chính → `channel.marketplaces.code` (khoá ngoại viết tay)
- `external_id` text · khoá chính: mã bên ngoài (sàn, cổng thanh toán)
- `parent_external_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `name` text · not null
- `is_leaf` boolean · not null
- `path` text · not null
- `path_search` text · not null
  Đường dẫn đã bỏ dấu (cả `đ` → `d`), chữ thường: `normalizePath` ở `domain/product-spec.ts`.
- `status` text · not null · mặc định `'active'`
- `synced_at` timestamptz · null
- `size_chart_rule` text · null
  Luật bảng kích cỡ (#347), lấy cùng lúc với attribute của leaf; null là chưa hỏi.
- `attributes_fetched_at` timestamptz · null

Ràng buộc và index:

- khoá chính (`platform`, `external_id`)
- index (`platform`, `parent_external_id`) `platform_categories_parent_idx`
- index gin (`path_search`) `platform_categories_path_search_trgm`
- check `platform_categories_status`: `status in ('active', 'removed')`
- check `platform_categories_size_chart_rule`: `size_chart_rule in ('required', 'optional', 'unsupported')`
- khoá ngoại viết tay (`platform`) → `channel.marketplaces` (`code`), ở `db/migrations/20261121115038_bang-san-fk.sql`

Trỏ vào bảng này:

- `channel.platform_category_attributes.platform, external_category_id` (khoá ngoại viết tay)

## `channel.platform_category_attributes`

Attribute của một leaf category (#400, Documents/19 mục 3.3). Lấy khi có người mở leaf (route chi tiết, `PUT` spec, việc nền), dùng lại 7 ngày; mỗi lần lấy thay cả tập của leaf (`replaceLeaf`). `code`: Lazada `name`, TikTok id attribute. Không `company_id`, không RLS, `commerio_app` chỉ `SELECT` như `platform_categories`.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel`

Cột:

- `platform` text · khoá chính → `channel.marketplaces.code` (khoá ngoại viết tay)
- `external_category_id` text · khoá chính → `channel.platform_categories.external_id` (khoá ngoại viết tay)
- `code` text · khoá chính
- `label` text · not null
- `kind` text · not null
- `input` text · not null
- `options` jsonb · not null · mặc định `'[]'::jsonb`
- `allow_custom` boolean · not null · mặc định `false`
- `required` boolean · not null · mặc định `false`
- `required_when` jsonb · null
- `is_key` boolean · not null · mặc định `false`
- `tier` text · not null
- `raw` jsonb · not null · mặc định `'{}'::jsonb`
- `fetched_at` timestamptz · not null

Ràng buộc và index:

- khoá chính (`platform`, `external_category_id`, `code`)
- check `platform_category_attributes_kind`: `kind in ('sales', 'property')`
- check `platform_category_attributes_input`: `input in ('select', 'multiselect', 'text', 'number', 'date', 'image', 'cascade')`
- check `platform_category_attributes_tier`: `tier in ('category', 'product', 'company')`
- khoá ngoại viết tay (`platform`) → `channel.marketplaces` (`code`), ở `db/migrations/20261121115038_bang-san-fk.sql`
- khoá ngoại viết tay (`platform`, `external_category_id`) → `channel.platform_categories` (`platform`, `external_id`), ở `db/migrations/20261121115038_bang-san-fk.sql`

## `channel.price_calculations`

Một lần chạy bộ lọc giá cho một SKU trên một gian hàng (25 §6.2): lưu đầu vào, kết quả từng bước và phiên bản cấu hình phí, thuế đã dùng, để biết giá trên sàn ra từ đâu. Đổi phí thì sinh lần mới `pending_confirm`, chờ xác nhận.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · not null → `channel.shops.id` (khoá ngoại)
- `variant_id` uuid · not null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `fee_version_id` uuid · null → `finance.config_versions.id` (tham chiếu, không có khoá ngoại)
- `tax_version_id` uuid · null → `finance.config_versions.id` (tham chiếu, không có khoá ngoại)
  Bản `tax_rules` đã dùng.
- `tax_regime_version_id` uuid · null → `finance.config_versions.id` (tham chiếu, không có khoá ngoại)
- `min_margin_version_id` uuid · null → `finance.config_versions.id` (tham chiếu, không có khoá ngoại)
- `cost` numeric(18,2) · null
  Giá vốn bước 5 (#225); null khi chưa có, khi đó không có cờ Dưới giá thấp nhất.
- `target_net` numeric(18,2) · not null
- `per_item_fee` numeric(18,2) · not null · mặc định `'0'`
- `fee_pct` numeric(5,2) · not null
- `tax_pct` numeric(7,4) · not null
- `min_margin_pct` numeric(5,2) · null
- `raw_price` numeric(18,2) · not null
- `rounded_price` numeric(18,2) · not null
- `net_received` numeric(18,2) · not null
- `margin_pct` numeric(7,2) · null
- `below_floor` boolean · null
- `trigger` text · not null
  Vì sao có lần tính: đẩy lần đầu, đổi giá muốn bán, kích hoạt cấu hình, giá vốn tăng làm giá đang bán dưới giá thấp nhất (`cost`, #225: `target_net` là max(giá muốn bán, giá thấp nhất làm tròn lên đồng)).
- `status` enum `channel.price_calc_status` · not null · mặc định `'pending_confirm'`: `pending_confirm` | `confirmed` | `pushed` | `superseded`
- `confirmed_by` uuid · null → `core.accounts` (người thao tác)
- `confirmed_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`shop_id`, `variant_id`) `price_calculations_shop_id_variant_id_index`
- unique index (`shop_id`, `variant_id`) `price_calculations_one_pending` where `status = 'pending_confirm'`
- check `price_calculations_floor`: `not below_floor or status in ('pending_confirm', 'superseded')`
- check `price_calculations_confirmed`: `status not in ('confirmed', 'pushed') or confirmed_by is not null`
- check `price_calculations_cost_floor`: `(cost is null) = (below_floor is null)`
- check `price_calculations_trigger`: `trigger in ('push', 'target_changed', 'config_activated', 'cost')`

Trỏ vào bảng này:

- `channel.listings.price_calc_id` (khoá ngoại)

## `channel.product_specs`

Thông tin sàn của một sản phẩm cha, một bộ mỗi sàn, mọi gian hàng của sàn dùng chung (#400, Documents/19 mục 3.3). Thay bảng spec cũ của catalog và ghép danh mục Commerio (xoá ở BE3, migration `*_bo-ghep-danh-muc`). `product_id` là uuid thường (không khoá ngoại chéo schema). `attributes` chỉ giữ attribute `tier = 'category'` (xuất xứ, thương hiệu ở catalog). `axis_map`: attributeId của trục Commerio → mã sales attribute của sàn hoặc `__custom`; `value_map`: attributeValueId → mã lựa chọn của sàn. `version = 0` là bản chép từ ghép danh mục cũ chưa ai lưu lại (#400 A18, migration `*_chep-spec-lan-cuoi`); `PUT` spec luôn ra `version ≥ 1`. RLS.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `product_id` uuid · not null → `product.products.id` (tham chiếu, không có khoá ngoại)
- `platform` text · not null → `channel.marketplaces.code` (khoá ngoại viết tay)
- `external_category_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `attributes` jsonb · not null · mặc định `'{}'::jsonb`
- `axis_map` jsonb · not null · mặc định `'{}'::jsonb`
- `value_map` jsonb · not null · mặc định `'{}'::jsonb`
- `source` text · not null
- `category_status` text · not null · mặc định `'ok'`
- `field_sources` jsonb · not null · mặc định `'{}'::jsonb`
  Nguồn từng attribute trong `attributes` (#497): `push`, `match`, `user`.
- `remote_facts` jsonb · null
  Bản sàn đang ghi ở lần đọc gần nhất khi ghép SKU (#497); bản có `remote_read_at` sau thắng.
- `remote_read_at` timestamptz · null
- `remote_shop_id` uuid · null → `channel.shops.id` (khoá ngoại, ON DELETE set null)
  Gian hàng đã đọc; xoá gian hàng thì null, tên còn trong `remote_facts.shopName`.
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`product_id`, `platform`) `product_specs_product_platform_uq`
- index (`platform`, `external_category_id`) `product_specs_category_idx`
- check `product_specs_source`: `source in ('push', 'match')`
- check `product_specs_category_status`: `category_status in ('ok', 'changed', 'removed')`
- check `product_specs_version`: `version >= 0`
- check `product_specs_remote`: `(remote_facts is null) = (remote_read_at is null)`
- khoá ngoại viết tay (`platform`) → `channel.marketplaces` (`code`), ở `db/migrations/20261121115038_bang-san-fk.sql`

## `channel.raw_orders`

Dữ liệu gốc của đơn sàn mỗi lần cập nhật; `order_id` có khi đã tạo đơn trong `order`.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · not null → `channel.shops.id` (khoá ngoại)
- `order_id` uuid · null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `external_order_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `external_status` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `payload` jsonb · not null
- `external_update_time` timestamptz · null: mã bên ngoài (sàn, cổng thanh toán)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`shop_id`, `external_order_id`) `raw_orders_shop_id_external_order_id_unique`
- index (`order_id`) `raw_orders_order_id_index`
- index gin (`("payload" -> 'lines') jsonb_path_ops`) `raw_orders_lines_gin`

## `channel.remote_skus`

Bản sao danh sách SKU của gian hàng trên sàn (#220 đợt 2, Documents/21 §18.3 "đọc từ lần đồng bộ gần nhất"): trang ghép, kiểm SKU khi ghép và số SKU chưa ghép đọc từ đây, không gọi sàn mỗi lần. Ghi bằng `service/remote-skus.ts`: đọc trọn (thiết lập, Tải lại, mỗi ngày) hoặc đọc sản phẩm sửa từ lần trước (sau lượt đồng bộ listing). SKU sàn đã xoá thì xoá dòng.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · not null → `channel.shops.id` (khoá ngoại)
- `external_product_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `external_sku_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `seller_sku` text · not null
  SKU người bán trên sàn; rỗng khi sàn không có (không ghép được tới khi đặt trên sàn).
- `title` text · not null
- `title_en` text · null
  Tên tiếng Anh trên sàn (Lazada `name_en`, #396); null khi sàn không có.
- `state` text · not null
- `quantity` integer · not null
- `price` numeric(18,2) · null
  Giá gốc trên sàn lúc đọc (`RemoteSku.price`: Lazada `skus[].price`, TikTok `tax_exclusive_price`), để hộp ghép so với giá app (#460). null khi sàn không trả hoặc bản sao đọc trước #460.
- `seen_at` timestamptz · not null · mặc định `now()`
  Lần gần nhất đọc thấy SKU này trên sàn.

Ràng buộc và index:

- unique index (`shop_id`, `external_sku_id`) `remote_skus_shop_external_sku_uq`
- check `remote_skus_state`: `state in ('review', 'live', 'rejected', 'hold', 'inactive')`
- check `remote_skus_quantity`: `quantity >= 0`
- check `remote_skus_price`: `price >= 0`

## `channel.shop_category_permissions`

Quyền đăng category của một gian hàng, cho sàn có quyền category theo gian hàng (adapter khai, #400 A17). Ghi từ gợi ý và lần kiểm trước khi đẩy, `checked_at` quá 7 ngày thì kiểm lại. RLS `company_isolation` (migration `*_category-san-quyen`).

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · khoá chính → `channel.shops.id` (khoá ngoại viết tay, ON DELETE cascade)
  Khoá ngoại ghép `(shop_id, company_id) → shops(id, company_id)` (`shop_category_permissions_shop_company_fk`) viết trong migration `*_category-san-quyen` (drizzle-kit sinh khoá ngoại trước unique đích, db/CLAUDE.md): RLS không chặn role chủ bảng ghi `company_id` khác công ty của gian hàng (review BE1 P2-11).
- `external_category_id` text · khoá chính: mã bên ngoài (sàn, cổng thanh toán)
- `status` text · not null
- `checked_at` timestamptz · not null

Ràng buộc và index:

- khoá chính (`shop_id`, `external_category_id`)
- check `shop_category_permissions_status`: `status in ('available', 'invite_only', 'non_main_category', 'prohibited')`
- khoá ngoại viết tay (`shop_id`, `company_id`) → `channel.shops` (`id`, `company_id`), ON DELETE cascade, ở `db/migrations/20261119053555_category-san-quyen.sql`

## `channel.shop_products`

Một sản phẩm cha trên một gian hàng ứng với một sản phẩm trên sàn (commerio-backend#295, Documents/19 câu chốt Q1, 21 §18.8.4). `app`: app tạo bằng lần đẩy gom biến thể (`product_id` bắt buộc, mã sàn null tới khi sàn tạo xong); `match`: sản phẩm sàn có sẵn mà listing trỏ tới (ghép SKU, dữ liệu đẩy trước #295), `product_id` null vì một sản phẩm người bán có thể chứa SKU của nhiều sản phẩm Commerio. Luật "một cha một sản phẩm sàn" ép ở unique một phần theo `origin = 'app'`. `failed`: lần tạo của dòng `app` bị sàn từ chối (gom lại, §18.8.4), lỗi ở `push_error`. `delisted`: sản phẩm sàn đã bị thay (gom lại) hoặc sàn đã xoá. RLS `company_isolation`.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · not null → `channel.shops.id` (khoá ngoại)
- `product_id` uuid · null → `product.products.id` (tham chiếu, không có khoá ngoại)
- `external_product_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `origin` enum `channel.shop_product_origin` · not null: `app` | `match`
- `status` enum `channel.shop_product_status` · not null · mặc định `'active'`: `active` | `delisted` | `failed`
- `push_error` jsonb · null
  Lỗi của lần tạo gần nhất (`{ code, message, at }`), chỉ dòng `app`.
- `push_started_at` timestamptz · null
  Lúc bấm đẩy của lượt tạo đang chạy (dòng `app`): khoá chống tạo trùng `cm-sp-<id>-<mốc>` giữ qua các lần thử.
- `create_attempted_at` timestamptz · null
  Lần gọi tạo gần nhất (như `listings.create_attempted_at`, #399): phân biệt sản phẩm của lượt trước với sản phẩm người bán.
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`id`, `external_product_id`) `shop_products_id_external_uq`
- unique index (`shop_id`, `external_product_id`) `shop_products_shop_external_uq` where `external_product_id is not null and status = 'active'`
- unique index (`shop_id`, `product_id`) `shop_products_shop_app_product_uq` where `origin = 'app' and status = 'active'`
- check `shop_products_origin`: `(origin = 'app') = (product_id is not null)`
- check `shop_products_match_external`: `origin = 'app' or external_product_id is not null`
- check `shop_products_failed`: `status <> 'failed' or (origin = 'app' and external_product_id is null and push_error is not null)`

Trỏ vào bảng này:

- `channel.listings.shop_product_id` (khoá ngoại)
- `channel.listings.shop_product_id, external_product_id` (khoá ngoại)

## `channel.shop_reauth_mails`

Thư báo gian hàng sắp hết hoặc đã mất uỷ quyền đã xếp (#312, Documents/19). Mỗi dòng là một thư cho CEO, Admin. `deadline` là hạn đang tính: `expiring_3d`, `expiring_1d` lấy hạn gần hơn trong `auth_expires_at`, `refresh_expires_at`; `lost` lấy lúc chuyển sang `needs_reauth` (`core.state_transitions`), `seq` là nhịp 6 giờ thứ mấy kể từ lúc đó. Chống trùng ép ở CSDL, dù việc nền chạy lại hay chạy trùng: - unique `(shop_id, deadline, stage, seq)`; - EXCLUDE `shop_reauth_mails_deadline_drift` (migration viết tay, Drizzle không sinh được): hai thư trước hạn cùng gian hàng, cùng mốc mà hạn cách nhau dưới 1 giờ là một mốc. Hạn tính lại từ "số giây còn lại" sau mỗi lần làm mới token lệch vài mili giây tới vài giây; hạn gia hạn thật hay nối lại thì cách xa, tính lại từ đầu. Kết quả gửi: `outcome` null là chưa xong (`sent` đã gửi, `stale` bỏ vì gian hàng đã đổi hoặc mốc sau đã thay, `failed` lỗi vĩnh viễn, không có người nhận, hoặc hết lượt xếp lại). `attempts` là số lần đã phát sự kiện, `queued_at` lần phát gần nhất: việc nền phát lại thư chưa xong khi outbox đã bỏ cuộc (SMTP hỏng lâu). `commerio_app` chỉ UPDATE được bốn cột kết quả, không DELETE (migration viết tay).

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `shop_id` uuid · not null → `channel.shops.id` (khoá ngoại, ON DELETE cascade)
  Xoá gian hàng đã ngắt (#398) xoá luôn thư: `commerio_app` không có DELETE trên bảng này, hành động khoá ngoại chạy bằng quyền chủ bảng.
- `stage` text · not null
- `deadline` timestamptz · not null
- `seq` integer · not null · mặc định `0`
- `outcome` text · null
- `finished_at` timestamptz · null
- `attempts` integer · not null · mặc định `1`
- `queued_at` timestamptz · not null · mặc định `now()`
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`shop_id`, `deadline`, `stage`, `seq`) `shop_reauth_mails_milestone_uq`
- index (`queued_at`) `shop_reauth_mails_pending_idx` where `outcome is null`
- check `shop_reauth_mails_stage`: `stage in ('expiring_3d', 'expiring_1d', 'lost')`
- check `shop_reauth_mails_seq`: `seq >= 0 and (stage = 'lost' or seq = 0)`
- check `shop_reauth_mails_outcome`: `outcome in ('sent', 'stale', 'failed')`
- check `shop_reauth_mails_finished`: `(outcome is null) = (finished_at is null)`
- check `shop_reauth_mails_attempts`: `attempts between 1 and 8`
- EXCLUDE `shop_reauth_mails_deadline_drift`: `EXCLUDE USING gist (shop_id WITH =, stage WITH =, channel.reauth_deadline_window(deadline) WITH &&) WHERE (stage <> 'lost')`, ở `db/migrations/20261112132934_rls-thu-bao-mat-uy-quyen.sql`

## `channel.shops`

Gian hàng sàn đã kết nối, định danh bằng (sàn, mã shop của sàn); kết nối lại cùng shop dùng lại bản ghi. Token lưu đã mã hoá. `order_cutoff_at` là mốc kéo đơn chọn lúc thiết lập; `settlement_cursor` là mốc kéo quyết toán.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `platform` text · not null → `channel.marketplaces.code` (khoá ngoại viết tay)
- `external_shop_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `shop_name` text · not null
- `region` text · null
- `access_token_enc` bytea · null
- `refresh_token_enc` bytea · null
- `access_expires_at` timestamptz · null
- `refresh_expires_at` timestamptz · null
- `auth_expires_at` timestamptz · null
  Hạn uỷ quyền seller chọn trên sàn, null khi sàn không có hạn riêng (Documents/19, 21 §18.4, #201).
- `status` enum `channel.shop_status` · not null · mặc định `'connecting'`: `connecting` | `active` | `needs_reauth` | `disconnected`
- `order_cutoff_at` timestamptz · null
- `return_window_days` integer · null
  Hạn trả hàng (ngày) Admin nhập lúc thiết lập, cho sàn `returnWindow = 'days'` (Documents/21 §18.6.2).
- `last_order_sync_at` timestamptz · null
- `last_return_sync_at` timestamptz · null
  Mốc kéo yêu cầu trả (#202): lúc bắt đầu lượt kéo xong trọn gần nhất.
- `settlement_cursor` timestamptz · null
- `last_error` text · null
- `disconnected_at` timestamptz · null
- `opening_stocktake_id` uuid · null → `product.stock_documents.id` (tham chiếu, không có khoá ngoại)
  Phiếu kiểm kê đầu kỳ đang chờ ghi sổ; khác null là gian hàng `active` ở chế độ chờ kiểm kê lần đầu.
- `opening_stocktake_number` text · null
- `opening_stock_mode` text · null
- `remote_skus_synced_at` timestamptz · null
  Lần đọc trọn danh sách SKU của gian hàng gần nhất (bản sao `remote_skus`, #220 đợt 2); null là chưa có bản sao. Số SKU chưa ghép đếm từ bản sao lúc đọc, không lưu cột (bỏ `unmatched_sku_count`).
- `remote_skus_changed_since` timestamptz · null
  Mốc cho lần đọc "sản phẩm sửa từ lần trước" tiếp theo: giờ bắt đầu của lần làm mới bản sao gần nhất.
- `remote_skus_full_failures` integer · not null · mặc định `0`
  Lượt đọc trọn định kỳ lỗi liên tiếp, và mốc sớm nhất được thử lại (1 giờ, 2 giờ, … tối đa 24 giờ; review #309 vòng 3 R1). Đọc trọn được (kể cả Tải lại) thì về 0 / null. Tải lại không chờ mốc.
- `remote_skus_full_retry_at` timestamptz · null
- `remote_skus_full_failed_at` timestamptz · null
  Lần đọc trọn lỗi gần nhất (định kỳ hay Tải lại): Tải lại trong 10 phút sau đó trả 429 (review #309 vòng 4 B2).
- `remote_skus_full_error` jsonb · null
  Lỗi của lần đọc trọn lỗi gần nhất `{ code, platformCode, message }` (#361): `GET remote-skus` trả ở `refresh.error`. Câu của BE, không chép câu thô của sàn. Đọc trọn được thì xoá cùng các mốc lỗi.
- `remote_skus_refresh_requested_at` timestamptz · null
  Lượt Tải lại đang chờ hoặc chạy nền (#361); xoá khi xong hay lỗi. Quá 15 phút là kẹt (`refresh_stale`).
- `open_orders_pulled_at` timestamptz · null
  Lượt kéo đơn còn mở sau thiết lập đã xong; null thì chưa đẩy tồn (A10).
- `open_orders_skipped` integer · not null · mặc định `0`
  Số đơn còn mở cũ hơn không kéo về vì vượt trần `OPEN_ORDER_PULL_MAX`.
- `stock_pushed_at` timestamptz · null
  Lượt đẩy tồn đầu tiên sau thiết lập đã chạy.
- `allocation_stocktake_id` uuid · null → `product.stock_documents.id` (tham chiếu, không có khoá ngoại)
  Phiếu đầu kỳ đã ghi sổ, gian hàng đang chờ phân hàng: thoát chờ khi nhận `fulfillment.allocation_done` có `cause.documentId` trùng id này (Documents/21 §11.3, §18.6.11; Documents/19 `shops`). Giữ id vì `opening_stocktake_id` đã về null. Sự kiện do `settleOpeningStocktake` phát trong chính giao dịch thoát chờ kiểm kê nên không tới trước cột này; nhận trùng thì cột đã null, tự bị bỏ qua.
- `orders_pulled_ok_at` timestamptz · null
  Giờ bắt đầu của lượt lấy đơn gần nhất chạy xong trọn (không lỗi, không còn trang), không lùi (#223). Mất uỷ quyền, chưa có mốc này hoặc mốc cũ hơn `ORDERS_STALE_MS` là "đơn chưa cập nhật": SKU có listing trên gian hàng này không được cập nhật tồn lên mọi gian hàng của công ty (`domain/shop.ts` `ordersStale`; Documents/19 `shops`, 21 §18.6.6).
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `platform`, `external_shop_id`) `shops_company_id_platform_external_shop_id_unique`
- unique (`id`, `company_id`) `shops_id_company_uq`
- unique index (`platform`, `external_shop_id`) `shops_platform_external_live_uq` where `status <> 'disconnected'`
- unique index (`company_id`) `shops_one_opening_stocktake_uq` where `opening_stocktake_id is not null`
- check `shops_active_cutoff`: `status <> 'active' or order_cutoff_at is not null`
- check `shops_return_window_days`: `return_window_days between 1 and 60`
- check `shops_opening_stocktake`: `(opening_stocktake_id is null) = (opening_stocktake_number is null) and (opening_stocktake_id is null or order_cutoff_at is not null)`
- check `shops_setup_mode`: `opening_stock_mode is null or opening_stock_mode in ('push', 'stocktake')`
- check `shops_open_orders_skipped`: `open_orders_skipped >= 0`
- check `shops_remote_skus_retry`: `remote_skus_full_failures >= 0 and (remote_skus_full_failures = 0) = (remote_skus_full_retry_at is null)`
- check `shops_remote_skus_failed_at`: `remote_skus_full_failures = 0 or remote_skus_full_failed_at is not null`
- check `shops_remote_skus_full_error`: `remote_skus_full_error is null or remote_skus_full_failed_at is not null`
- check `shops_allocation_pending`: `allocation_stocktake_id is null or (opening_stocktake_id is null and order_cutoff_at is not null)`
- check `shops_orders_pulled_ok_at`: `orders_pulled_ok_at is null or order_cutoff_at is not null`
- check `shops_reauth_orders_pulled`: `status <> 'needs_reauth' or orders_pulled_ok_at is null`
- khoá ngoại viết tay (`platform`) → `channel.marketplaces` (`code`), ở `db/migrations/20261121115038_bang-san-fk.sql`

Trỏ vào bảng này:

- `channel.listing_sync_runs.shop_id` (khoá ngoại)
- `channel.listings.shop_id` (khoá ngoại)
- `channel.price_calculations.shop_id` (khoá ngoại)
- `channel.product_specs.remote_shop_id` (khoá ngoại)
- `channel.raw_orders.shop_id` (khoá ngoại)
- `channel.remote_skus.shop_id` (khoá ngoại)
- `channel.shop_products.shop_id` (khoá ngoại)
- `channel.shop_reauth_mails.shop_id` (khoá ngoại)
- `channel.shop_category_permissions.shop_id, company_id` (khoá ngoại viết tay)
- `product.stock_documents.shop_id` (tham chiếu, không có khoá ngoại)
- `order.orders.shop_id` (tham chiếu, không có khoá ngoại)
- `order.packages.shop_id` (tham chiếu, không có khoá ngoại)
- `order.return_requests.shop_id` (tham chiếu, không có khoá ngoại)
- `finance.config_versions.shop_id` (tham chiếu, không có khoá ngoại)
- `finance.ledger_entries.shop_id` (tham chiếu, không có khoá ngoại)
- `finance.ledger_package_lines.shop_id` (tham chiếu, không có khoá ngoại)
- `finance.order_settlements.shop_id` (tham chiếu, không có khoá ngoại)
- `finance.settlement_batches.shop_id` (tham chiếu, không có khoá ngoại)
- `finance.settlement_statements.shop_id` (tham chiếu, không có khoá ngoại)
- `channel.message_channels.shop_id` (tham chiếu, không có khoá ngoại)

## `channel.spec_field_mappings`

Ánh xạ một thông số của công ty (`catalog.spec_fields`, uuid thường) sang attribute của một sàn (#509, Documents/19 mục 3.3, 21 §18.8.1). Một thông số có thể ứng với nhiều mã trên cùng sàn (mã đổi theo category): lúc đẩy lấy mã có `priority` nhỏ nhất mà leaf có; một mã của sàn chỉ nhận từ một thông số. Gợi ý ánh xạ tính lúc đọc, không lưu (§18.8.1). RLS.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
  NULL: ánh xạ nền tảng của thông số chuẩn, dùng chung mọi công ty, chỉ migration ghi; có giá trị: của công ty.
- `field_id` uuid · not null → `product.spec_fields.id` (tham chiếu, không có khoá ngoại)
- `platform` text · not null → `channel.marketplaces.code` (khoá ngoại viết tay)
- `attribute_code` text · not null
  Mã attribute của sàn: TikTok `attribute_id`, Lazada `name`.
- `priority` integer · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`company_id`, `field_id`, `platform`, `attribute_code`) `spec_field_mappings_code_uq`
- unique (`company_id`, `field_id`, `platform`, `priority`) `spec_field_mappings_priority_uq`
- unique (`company_id`, `platform`, `attribute_code`) `spec_field_mappings_attribute_uq`
- unique (`field_id`, `platform`, `attribute_code`) `spec_field_mappings_field_code_uq`
- unique index (`field_id`, `platform`, `priority`) `spec_field_mappings_platform_priority_uq` where `company_id IS NULL`
- unique index (`platform`, `attribute_code`) `spec_field_mappings_platform_attribute_uq` where `company_id IS NULL`
- check `spec_field_mappings_priority`: `priority >= 1`
- khoá ngoại viết tay (`platform`) → `channel.marketplaces` (`code`), ở `db/migrations/20261121115038_bang-san-fk.sql`

Trỏ vào bảng này:

- `channel.spec_option_mappings.field_id, platform, attribute_code` (khoá ngoại viết tay)

## `channel.spec_option_mappings`

Ánh xạ một lựa chọn của thông số sang lựa chọn chuẩn của sàn, theo đúng mã attribute (#509). `company_id` là tầng của lựa chọn: NULL là lựa chọn chuẩn (nền tảng, chỉ migration ghi); công ty là lựa chọn riêng, kể cả lựa chọn riêng thêm vào thông số chuẩn (dòng mã là dòng nền tảng). Khoá ngoại `spec_option_mappings_field_fk` `(field_id, platform, attribute_code)` → `spec_field_mappings_field_code_uq` `ON DELETE CASCADE` (bỏ mã thì bỏ luôn ánh xạ lựa chọn của mã đó) không kèm `company_id`, vì lựa chọn riêng trỏ dòng mã nền tảng. Khoá ngoại đặt ở migration viết tay `*_anh-xa-hai-tang-du-lieu`, không khai ở đây: drizzle sinh câu thêm khoá ngoại trước câu tạo unique nó trỏ tới. RLS.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
- `field_id` uuid · not null → `channel.spec_field_mappings.field_id` (khoá ngoại viết tay, ON DELETE cascade)
- `option_id` uuid · not null → `product.spec_field_options.id` (tham chiếu, không có khoá ngoại)
- `platform` text · not null → `channel.marketplaces.code` (khoá ngoại viết tay)
- `attribute_code` text · not null → `channel.spec_field_mappings.attribute_code` (khoá ngoại viết tay, ON DELETE cascade)
- `platform_option_id` text · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`option_id`, `platform`, `attribute_code`) `spec_option_mappings_option_uq`
- khoá ngoại viết tay (`platform`) → `channel.marketplaces` (`code`), ở `db/migrations/20261121115038_bang-san-fk.sql`
- khoá ngoại viết tay (`field_id`, `platform`, `attribute_code`) → `channel.spec_field_mappings` (`field_id`, `platform`, `attribute_code`), ON DELETE cascade, ở `db/migrations/20261121115038_bang-san-fk.sql`

## `channel.tags`

Khai ở `src/modules/channel/inbox/repository/schema.ts` · module con `inbox` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `name` text · not null
- `color` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `name`) `tags_company_id_name_unique`

Trỏ vào bảng này:

- `channel.conversation_tags.tag_id` (khoá ngoại)

## `channel.webhook_events`

Webhook sàn đã nhận, chống xử lý lặp theo `notification_id`.

**Đã bỏ:** Không dùng: MVP không nhận push của sàn (#133, #135), kéo định kỳ là đường nhận đơn duy nhất. Xoá ở migration sau.

Khai ở `src/modules/channel/channel/repository/schema.ts` · module con `channel` · theo công ty (`company_id`)

Cột:

- `id` bigint · khoá chính
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `platform` text · not null → `channel.marketplaces.code` (khoá ngoại viết tay)
- `notification_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `event_type` text · not null
- `payload` jsonb · not null
- `received_at` timestamptz · not null · mặc định `now()`
- `processed_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`company_id`, `platform`, `notification_id`) `webhook_events_company_id_platform_notification_id_unique`
- khoá ngoại viết tay (`platform`) → `channel.marketplaces` (`code`), ở `db/migrations/20261121115038_bang-san-fk.sql`
