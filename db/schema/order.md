# Schema `order` · Đơn hàng · lớp 3

<!-- Sinh tự động bởi `npm run db:docs`. Không sửa tay: sửa comment trong schema.ts (hoặc scripts/db/lib/schema-refs.ts) rồi chạy lại lệnh. -->

Phiên bản **V132**, 11 bảng. Mục lục mọi schema và các bảng đã bỏ: [../SCHEMA.md](../SCHEMA.md).

**Không có ở đây:** RLS và policy (mọi bảng có `company_id` bật RLS với policy `company_isolation`, trừ ngoại lệ ở `test/integration/shared/rls-coverage.test.ts`), quyền của role `commerio_app`, hàm SQL, và mọi thứ tạo bằng SQL động. Xem `db/CLAUDE.md` mục Row-Level Security và các migration viết tay.

## `order.customer_identities`

Danh tính của khách trên một kênh (sàn, hộp thư), gộp về một hồ sơ khách.

Khai ở `src/modules/order/sales/repository/schema.ts` · module con `sales` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `customer_id` uuid · not null → `order.customers.id` (khoá ngoại)
- `channel_kind` enum `order.channel_kind` · not null: `tiktok` | `shopee` | `lazada` | `mock` | `messenger` | `email` | `zalo_oa`
- `external_user_id` text · not null: mã bên ngoài (sàn, cổng thanh toán)
- `display_name` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `channel_kind`, `external_user_id`) `customer_identities_company_id_channel_kind_external_user_id_unique`
- index (`customer_id`) `customer_identities_customer_id_index`

Trỏ vào bảng này:

- `channel.conversations.customer_identity_id` (tham chiếu, không có khoá ngoại)

## `order.customers`

`shop_id` (channel), `conversation_id` (inbox), `variant_id` (catalog) là uuid thường, không khoá ngoại chéo schema (19-D1).

Khai ở `src/modules/order/sales/repository/schema.ts` · module con `sales` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `name` text · null
- `phone` text · null
- `email` text · null
- `address` text · null
- `note` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Trỏ vào bảng này:

- `order.customer_identities.customer_id` (khoá ngoại)
- `order.orders.customer_id` (khoá ngoại)

## `order.doc_counters`

Bộ đếm mã đơn, cùng dạng `product.doc_counters` (plan chuẩn bị A4/K5).

Khai ở `src/modules/order/sales/repository/schema.ts` · module con `sales` · theo công ty (`company_id`)

Cột:

- `company_id` uuid · khoá chính → `core.companies` (theo công ty)
- `doc_type` text · khoá chính
- `period` text · khoá chính · mặc định `''`
- `next_number` integer · not null · mặc định `1`

Ràng buộc và index:

- khoá chính (`company_id`, `doc_type`, `period`)

## `order.order_lines`

Dòng đơn: chép SKU, tên sản phẩm, đơn giá lúc tạo đơn để đơn cũ không đổi khi sản phẩm đổi. Đơn sàn có SKU chưa ghép thì `variant_id` trống (cờ `unmapped_sku`), chưa giữ hàng tới khi ghép (E11).

Khai ở `src/modules/order/sales/repository/schema.ts` · module con `sales` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `order_id` uuid · not null → `order.orders.id` (khoá ngoại)
- `variant_id` uuid · null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `external_line_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `external_sku` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `sku` text · null
- `product_name` text · not null
- `quantity` integer · not null
- `cancelled_qty` integer · not null · mặc định `0`
  Số món sàn đã huỷ khi kiện chứa món chưa rời kho; chỉ luồng nhận đơn ghi (spec 205 §5.10).
- `cancelled_at` timestamptz · null
  Lúc app ghi huỷ món theo sàn báo (#417), cho lịch sử đơn: vì sao tiền lúc đặt khác tiền còn thu. Null với món chưa huỷ và món huỷ trước #417.
- `unit_price` numeric(18,2) · not null
- `seller_discount` numeric(18,2) · not null · mặc định `'0'`
- `platform_discount` numeric(18,2) · not null · mặc định `'0'`
- `line_total` numeric(18,2) · not null
- `thumbnail_url` text · null
  Thông tin dòng sàn (#260): kéo lại đơn thì cập nhật, không đụng biến thể và tiền gốc ở trên.
- `attributes_label` text · null
- `external_sku_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `external_shop_sku` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `external_product_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `stock_untracked` boolean · not null · mặc định `false`
  Ghép "không quản tồn" (25 §8.1, #237): không giữ, không trừ tồn. Chưa ghép là `variant_id is null and not stock_untracked`.
- `paid_price` numeric(18,2) · null
- `tax_amount` numeric(18,2) · null
- `shipping_amount` numeric(18,2) · null
- `wallet_credits` numeric(18,2) · null
- `cancel_reason` text · null
- `cancel_reason_detail` text · null
- `cancel_initiator` enum `order.line_cancel_initiator` · null: `buyer` | `seller` | `platform`
- `cancel_kind` enum `order.line_cancel_kind` · null: `cancellation` | `return` | `refund` | `failed_delivery`
- `reverse_order_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `return_status` text · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`order_id`, `external_line_id`) `order_lines_order_id_external_line_id_unique`
- index (`order_id`) `order_lines_order_id_index`
- index (`variant_id`) `order_lines_variant_id_index`
- check `order_lines_quantity`: `quantity > 0`
- check `order_lines_cancelled_qty`: `cancelled_qty >= 0 and cancelled_qty <= quantity`
- check `order_lines_cancelled_at`: `cancelled_at is null or cancelled_qty > 0`
- check `order_lines_unit_price`: `unit_price >= 0`
- check `order_lines_item`: `variant_id is not null or external_sku is not null`
- check `order_lines_untracked`: `not stock_untracked or variant_id is null`
- trigger `order_lines_line_total`: `AFTER UPDATE OF quantity, cancelled_qty, kiểm lúc commit → order.check_order_line_total()`, ở `db/migrations/20261114122001_huy-dong-kiem-bang.sql`

Trỏ vào bảng này:

- `order.return_request_lines.order_line_id` (khoá ngoại)
- `order.package_lines.order_line_id` (tham chiếu, không có khoá ngoại)
- `finance.sales_invoice_lines.order_line_id` (tham chiếu, không có khoá ngoại)

## `order.orders`

Đơn hàng. Đơn sàn không có `payment_method` (sàn thu hộ), đơn hộp thư và đơn tạo tay bắt buộc có (19-D11); đơn sàn bắt buộc có gian hàng và mã đơn sàn, không trùng (19-D32). Thanh toán qua cổng ở `finance.order_payments`, tiền sàn quyết toán ở `finance.order_settlements`.

Khai ở `src/modules/order/sales/repository/schema.ts` · module con `sales` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `code` text · not null
- `customer_id` uuid · null → `order.customers.id` (khoá ngoại)
- `source` enum `order.order_source` · not null: `marketplace` | `inbox` | `manual`
- `shop_id` uuid · null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `external_order_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `conversation_id` uuid · null → `channel.conversations.id` (tham chiếu, không có khoá ngoại)
- `payment_method` enum `order.payment_method` · null: `prepaid` | `cod`
- `is_cod` boolean · not null · mặc định `false`
  Đơn sàn thanh toán khi nhận hàng (sàn thu hộ). Đơn tự bán dùng `payment_method`, cột này luôn false.
- `status` enum `order.order_status` · not null · mặc định `'unpaid'`: `unpaid` | `processing` | `completed` | `cancelled`
- `outcome` enum `order.order_outcome` · null: `full` | `partial` | `none`
- `raw_marketplace_status` text · null
- `placed_at` timestamptz · null
- `paid_at` timestamptz · null
- `ship_by` timestamptz · null
- `return_window_ends_at` timestamptz · null
- `completed_at` timestamptz · null
- `needs_attention` boolean · not null · mặc định `false`
  Cờ lưu. Cờ suy ra được (chưa ghép SKU, sắp trễ hạn, có yêu cầu trả, lệch COD) không lưu (Documents/19 D4).
- `attention_note` text · null
- `cancel_requested` boolean · not null · mặc định `false`
  Khách xin huỷ, chờ Sale trả lời. Chỉ bật khi đơn còn mở (CHECK `orders_cancel_requested_open`).
- `cancel_pending` boolean · not null · mặc định `false`
  Đã gửi lệnh huỷ cả đơn lên sàn (Sale huỷ, Sale đồng ý khách xin huỷ), chờ sàn huỷ hết món. Cờ `cancelling` của API suy ra lúc đọc: cột này, hoặc sàn đã huỷ cả đơn mà còn kiện chờ mở để huỷ (`cancellingSql` ở `repository/orders.ts`). Chỉ bật khi đơn còn mở (CHECK `orders_cancel_pending_open`).
- `platform_cancelled` boolean · not null · mặc định `false`
- `shop_disconnected` boolean · not null · mặc định `false`
- `shipping_address` jsonb · null
- `subtotal` numeric(18,2) · not null
- `seller_discount` numeric(18,2) · not null · mặc định `'0'`
- `platform_discount` numeric(18,2) · not null · mặc định `'0'`
- `shipping_fee` numeric(18,2) · not null · mặc định `'0'`
- `total` numeric(18,2) · not null
- `cancel_reason` text · null
- `invoice_number` text · null
  Số hoá đơn người bán nhập để gửi sàn (Documents/21 §19.3).
- `platform_payment_method` text · null
  Thông tin đơn sàn (#260): phương thức khách trả trên sàn (giá trị gốc), ghi chú khách, phí ship của sàn.
- `buyer_note` text · null
- `shipping_fee_original` numeric(18,2) · null
- `shipping_fee_discount_seller` numeric(18,2) · null
- `shipping_fee_discount_platform` numeric(18,2) · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `code`) `orders_company_id_code_unique`
- unique (`company_id`, `shop_id`, `external_order_id`) `orders_company_id_shop_id_external_order_id_unique`
- index (`customer_id`) `orders_customer_id_index`
- index (`conversation_id`) `orders_conversation_id_index`
- index (`status`) `orders_status_index`
- check `orders_cancel_pending_open`: `not cancel_pending or status in ('unpaid', 'processing')`
- check `orders_cancel_requested_open`: `not cancel_requested or status in ('unpaid', 'processing')`
- check `orders_outcome`: `(status = 'completed') = (outcome is not null)`
- check `orders_cod`: `source = 'marketplace' or not is_cod`
- check `orders_amounts`: `subtotal >= 0 and total >= 0 and shipping_fee >= 0`
- check `orders_payment_method`: `(source = 'marketplace') = (payment_method is null)`
- check `orders_marketplace_ref`: `source <> 'marketplace' or (shop_id is not null and external_order_id is not null)`
- trigger `orders_ship_by_packages`: `AFTER UPDATE OF ship_by, kiểm lúc commit → order.assert_package_ship_by()`, ở `db/migrations/20261119074938_han-ban-giao-kien.sql`

Trỏ vào bảng này:

- `order.order_lines.order_id` (khoá ngoại)
- `order.return_requests.order_id` (khoá ngoại)
- `product.stock_documents.order_id` (tham chiếu, không có khoá ngoại)
- `order.packages.order_id` (tham chiếu, không có khoá ngoại)
- `finance.ledger_entries.order_id` (tham chiếu, không có khoá ngoại)
- `finance.ledger_package_lines.order_id` (tham chiếu, không có khoá ngoại)
- `finance.payment_links.order_id` (tham chiếu, không có khoá ngoại)
- `finance.payment_transactions.order_id` (tham chiếu, không có khoá ngoại)
- `finance.payment_vouchers.order_id` (tham chiếu, không có khoá ngoại)
- `finance.receipts.order_id` (tham chiếu, không có khoá ngoại)
- `finance.sales_invoices.order_id` (tham chiếu, không có khoá ngoại)
- `finance.settlement_lines.order_id` (tham chiếu, không có khoá ngoại)
- `finance.unmatched_receipts.assigned_order_id` (tham chiếu, không có khoá ngoại)
- `channel.raw_orders.order_id` (tham chiếu, không có khoá ngoại)

## `order.package_lines`

Dòng kiện. Giữ nguyên dòng: `reserved_qty` là 0 hoặc đủ `quantity` (25 §7.4). `unit_cost` chốt lúc bàn giao; `stock_deducted` bảo đảm trừ tồn đúng một lần, kể cả khi sàn báo nhảy cóc. Dòng chưa ghép SKU thì `variant_id` trống.

Khai ở `src/modules/order/fulfillment/repository/schema.ts` · module con `fulfillment` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `package_id` uuid · not null → `order.packages.id` (khoá ngoại)
- `order_line_id` uuid · not null → `order.order_lines.id` (tham chiếu, không có khoá ngoại)
- `variant_id` uuid · null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `stock_untracked` boolean · not null · mặc định `false`
  Ghép "không quản tồn" (25 §8.1, #237): không giữ, không trừ tồn.
- `quantity` integer · not null
- `reserved_qty` integer · not null · mặc định `0`
- `packed_qty` integer · not null · mặc định `0`
- `pending_drop_qty` integer · not null · mặc định `0`
  Số món sàn đã huỷ mà kiện đã đóng gói, chờ mở kiện để bỏ ra (spec 205 §5.10; 19 mục 2).
- `unit_cost` numeric(18,2) · null
- `stock_deducted` boolean · not null · mặc định `false`
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`package_id`) `package_lines_package_id_index`
- index (`variant_id`) `package_lines_variant_id_index`
- index (`order_line_id`) `package_lines_order_line_id_index`
- check `package_lines_quantity`: `quantity > 0`
- check `package_lines_reserved_whole`: `reserved_qty in (0, quantity)`
- check `package_lines_packed`: `packed_qty >= 0 and packed_qty <= quantity`
- check `package_lines_pending_drop`: `pending_drop_qty >= 0 and pending_drop_qty <= quantity`
- check `package_lines_unmapped`: `variant_id is not null or reserved_qty = 0`
- check `package_lines_untracked`: `not stock_untracked or (variant_id is null and reserved_qty = 0 and not stock_deducted)`
- check `package_lines_deducted_cost`: `not stock_deducted or unit_cost is not null`
- trigger `package_lines_line_total`: `AFTER INSERT OR DELETE OR UPDATE OF quantity, package_id, order_line_id, pending_drop_qty, kiểm lúc commit → order.check_package_line_total()`, ở `db/migrations/20261114122001_huy-dong-kiem-bang.sql`

## `order.packages`

Một gói hàng đi chung một mã vận đơn, gồm món của một đơn. Đơn vị giữ hàng, đóng gói, bàn giao, giao, hoàn. Kiện tạm (sàn chưa gửi danh sách kiện) chưa có `platform_package_code`. Sàn gộp nhiều đơn vào một gói thì mỗi đơn một kiện, chung mã kiện sàn và mã vận đơn (nhóm gói). Thất lạc bằng tay cần mã khiếu nại và người thứ hai; xác nhận COD tự giao do người khác người giao.

Khai ở `src/modules/order/fulfillment/repository/schema.ts` · module con `fulfillment` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `code` text · not null
- `order_id` uuid · not null → `order.orders.id` (tham chiếu, không có khoá ngoại)
- `shop_id` uuid · null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `platform_package_code` text · null
- `tracking_code` text · null
- `carrier_code` text · null
- `carrier_name` text · null
- `label_error` boolean · not null · mặc định `false`
- `self_delivery` boolean · not null · mặc định `false`
- `status` enum `order.package_status` · not null: `backordered` | `reserved` | `packed` | `awaiting_pickup` | `self_delivering` | `in_transit` | `delivered` | `delivery_failed` | `returning` | `returned` | `lost` | `cancelled`
- `needs_open` boolean · not null · mặc định `false`
- `open_purpose` enum `order.open_purpose` · null: `cancel` | `edit` | `resplit` | `stocktake`
- `needs_attention` boolean · not null · mặc định `false`
- `flag_note` text · null
- `ship_by` timestamptz · null
- `reserved_at` timestamptz · null
  Lần gần nhất kiện giữ hàng; lấy lại phần giữ xét kiện giữ sau cùng trước (spec 199b §5.1, 25 §7.4).
- `packed_by` uuid · null → `core.accounts` (người thao tác)
- `packed_at` timestamptz · null
- `handed_over_by` uuid · null → `core.accounts` (người thao tác)
- `handed_over_at` timestamptz · null
- `handover_source` enum `order.handover_source` · null: `scan` | `marketplace` | `forced` | `before_cutoff`
- `handover_reverted_by` uuid · null → `core.accounts` (người thao tác)
  Người huỷ bàn giao nhầm gần nhất (Documents/19).
- `pickup_confirmed_at` timestamptz · null
  Lần đầu sàn báo kiện rời kho sau khi kho quét; kiện do sàn báo bàn giao thì bằng `handed_over_at`.
- `delivered_by` uuid · null → `core.accounts` (người thao tác)
- `delivered_at` timestamptz · null
- `cod_expected` numeric(18,2) · null
- `cod_collected` numeric(18,2) · null
- `cod_confirmed_by` uuid · null → `core.accounts` (người thao tác)
- `cod_confirmed_at` timestamptz · null
- `lost_reported_by` uuid · null → `core.accounts` (người thao tác)
- `lost_reported_at` timestamptz · null
- `lost_claim_code` text · null
- `lost_confirmed_by` uuid · null → `core.accounts` (người thao tác)
- `lost_self_approved` boolean · not null · mặc định `false`
  CEO hoặc công ty một người tự xác nhận thất lạc mình báo (spec #238 §5.3).
- `lost_source` text · null
  Ai đưa kiện sang `lost`: `user` (báo và xác nhận), `marketplace` (sàn báo). Chỉ có khi kiện đang `lost`.
- `delivery_posted_at` timestamptz · null
  Lúc `fulfillment.package_delivered` của kiện được ghi outbox; kiện giao đầu tiên của đơn mang ship cấp đơn (spec 199c §5.1, D4). Không bao giờ đặt lại null.
- `replaces_package_id` uuid · null → `order.packages.id` (khoá ngoại)
  Kiện cũ mà kiện này thay khi sàn chia lại kiện (spec #238 §5.6), chỉ để truy vết; "kiện chờ thay" suy ra từ dòng chờ bỏ, không lưu (D9). Kiện không bao giờ bị xoá nên khoá ngoại `no action`.
- `waybill_kept` boolean · not null · mặc định `false`
  Mở kiện `awaiting_pickup` xong còn món: giữ mã kiện sàn, vận đơn, ĐVVC; đóng gói và báo sẵn sàng lại không gọi sàn (spec #238 D25). `updatePackage` tự tắt khi kiện sang trạng thái ngoài `backordered`, `reserved`, `packed`.
- `shipment_provider` text · null
  Vận chuyển do sàn trả (#260).
- `shipping_provider_type` text · null
- `shipping_type` text · null
- `promised_shipping_at` timestamptz · null
- `notices` jsonb · not null · mặc định `'[]'::jsonb`
  Việc chạy ngầm chưa làm được vì chờ issue khác (Documents/21 §18.7.9), vd giữ hàng khi `reserve` còn 501.
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `code`) `packages_company_id_code_unique`
- unique index (`shop_id`, `platform_package_code`, `order_id`) `packages_platform_code_order_uq` where `platform_package_code is not null`
- index (`order_id`) `packages_order_id_index`
- index (`status`) `packages_status_index`
- index (`tracking_code`) `packages_tracking_code_index`
- index (`replaces_package_id`) `packages_replaces_package_id_index` where `replaces_package_id is not null`
- check `packages_open`: `needs_open = (open_purpose is not null)`
- check `packages_waybill_kept`: `not waybill_kept or (platform_package_code is not null and tracking_code is not null)`
- check `packages_carrier`: `(carrier_code is null) = (carrier_name is null)`
- check `packages_cod_second_person`: `cod_confirmed_by is null or cod_confirmed_by is distinct from delivered_by`
- check `packages_lost_second_person`: `lost_confirmed_by is null or lost_confirmed_by is distinct from lost_reported_by or lost_self_approved`
- check `packages_lost_report`: `(lost_reported_by is null) = (lost_claim_code is null)`
- check `packages_lost_source`: `lost_source is null or lost_source in ('user', 'marketplace')`
- check `packages_lost_confirmed`: `status <> 'lost' or lost_source is not distinct from 'marketplace' or lost_confirmed_by is not null`
- check `packages_handed_over`: `status in ('backordered', 'reserved', 'packed', 'awaiting_pickup', 'cancelled') or handed_over_at is not null`
- check `packages_handover_source`: `status in ('backordered', 'reserved', 'packed', 'awaiting_pickup', 'cancelled') or handover_source is not null`
- check `packages_cod`: `cod_expected >= 0 and cod_collected >= 0`
- trigger `packages_line_total`: `AFTER UPDATE OF status, kiểm lúc commit → order.check_package_status_line_total()`, ở `db/migrations/20261114122001_huy-dong-kiem-bang.sql`
- trigger `packages_ship_by_order`: `AFTER INSERT OR UPDATE OF ship_by, status, kiểm lúc commit → order.assert_package_ship_by()`, ở `db/migrations/20261119074938_han-ban-giao-kien.sql`

Trỏ vào bảng này:

- `order.package_lines.package_id` (khoá ngoại)
- `order.packages.replaces_package_id` (khoá ngoại)
- `order.return_request_lines.package_id` (tham chiếu, không có khoá ngoại)
- `finance.ledger_entries.package_id` (tham chiếu, không có khoá ngoại)
- `finance.ledger_package_lines.package_id` (tham chiếu, không có khoá ngoại)

## `order.return_request_lines`

Dòng yêu cầu trả: gắn dòng đơn và kiện đã giao chứa phần đó; giá vốn là bình quân các dòng kiện (25 §9).

Khai ở `src/modules/order/sales/repository/schema.ts` · module con `sales` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `request_id` uuid · not null → `order.return_requests.id` (khoá ngoại)
- `order_line_id` uuid · not null → `order.order_lines.id` (khoá ngoại)
- `package_id` uuid · null → `order.packages.id` (tham chiếu, không có khoá ngoại)
- `variant_id` uuid · null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `quantity` integer · not null
- `unit_price` numeric(18,2) · not null
- `unit_cost` numeric(18,2) · null
- `resell_qty` integer · null
- `external_line_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
  Mã dòng đơn ngược của sàn (Lazada `reverse_order_line_id`).
- `package_returned` boolean · not null · mặc định `false`
  Kiện của dòng đã hoàn về kho trước khi sàn mở yêu cầu (E109): hàng về theo yêu cầu đi như kiện không khớp.
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`request_id`, `order_line_id`) `return_request_lines_request_id_order_line_id_unique`
- index (`request_id`) `return_request_lines_request_id_index`
- index (`order_line_id`) `return_request_lines_order_line_id_index`
- check `return_request_lines_quantity`: `quantity > 0`
- check `return_request_lines_resell`: `resell_qty >= 0 and resell_qty <= quantity`

## `order.return_requests`

Khách trả sau khi đã nhận. Đơn sàn: do sàn đẩy về, khoá (gian hàng, mã yêu cầu sàn); đơn tạo tay: Sale lập. `inspection_id` là phiếu kiểm hàng về (product) sinh khi nhận hàng trả.

Khai ở `src/modules/order/sales/repository/schema.ts` · module con `sales` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `code` text · not null
- `order_id` uuid · not null → `order.orders.id` (khoá ngoại)
- `source` enum `order.order_source` · not null: `marketplace` | `inbox` | `manual`
- `shop_id` uuid · null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `external_return_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `status` enum `order.return_status` · not null · mặc định `'requested'`: `requested` | `rejected` | `refund_only` | `awaiting_return` | `received` | `closed`
- `kind` enum `order.return_kind` · not null · mặc định `'return'`: `return` | `refund`
- `close_result` enum `order.return_close_result` · null: `inspected` | `no_show` | `buyer_cancelled`
- `reason` text · not null
- `status_reason` text · null
- `return_tracking_code` text · null
- `refund_amount` numeric(18,2) · not null · mặc định `'0'`
- `refunded` boolean · not null · mặc định `false`
- `resell_cost` numeric(18,2) · null
- `inspection_id` uuid · null → `product.stock_documents.id` (tham chiếu, không có khoá ngoại)
- `inspection_number` text · null
- `needs_attention` boolean · not null · mặc định `false`
- `attention_note` text · null
- `raw_marketplace_status` text · null
  Thông tin sàn, chỉ để hiện (Documents/21 §20.1, R11); null với yêu cầu tạo tay (#202).
- `ofc_status` text · null
- `dispute_in_progress` boolean · not null · mặc định `false`
- `return_to` text · null
- `external_updated_at` timestamptz · null: mã bên ngoài (sàn, cổng thanh toán)
- `respond_by` timestamptz · null
  Hạn người bán phải trả lời của sàn (TikTok `seller_next_action_response`), chỉ để hiện (#392).
- `refund_approval` text · null
  Báo sàn đồng ý hoàn tiền sau kiểm hàng hoàn (#392, sàn có `approveReturnRefund`): `pending` chờ channel gọi sàn, `done` sàn đã qua bước đó, `withheld` phiếu có khiếu nại nên không báo. Null: sàn không có bước này.
- `reject_reason_id` text · null: mã bên ngoài (sàn, cổng thanh toán)
- `reject_reason_label` text · null
- `received_at` timestamptz · null
- `received_by` uuid · null → `core.accounts` (người thao tác)
- `refunded_at` timestamptz · null
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `code`) `return_requests_company_id_code_unique`
- unique (`shop_id`, `external_return_id`) `return_requests_shop_id_external_return_id_unique`
- index (`order_id`) `return_requests_order_id_index`
- index (`status`) `return_requests_status_index`
- index (`shop_id`) `return_requests_refund_approval_pending_idx` where `refund_approval = 'pending'`
- check `return_requests_return_to`: `return_to is null or return_to in ('warehouse', 'merchant')`
- check `return_requests_received`: `status not in ('received') or received_at is not null`
- check `return_requests_refunded`: `refunded = (refunded_at is not null)`
- check `return_requests_closed`: `(status = 'closed') = (close_result is not null)`
- check `return_requests_marketplace_ref`: `source <> 'marketplace' or (shop_id is not null and external_return_id is not null)`
- check `return_requests_refund`: `refund_amount >= 0`
- check `return_requests_refund_approval`: `refund_approval is null or (refund_approval in ('pending', 'done', 'withheld') and status = 'closed' and source = 'marketplace')`

Trỏ vào bảng này:

- `order.return_request_lines.request_id` (khoá ngoại)
- `order.unmatched_return_parcels.return_request_id` (tham chiếu, không có khoá ngoại)
- `finance.ledger_entries.return_request_id` (tham chiếu, không có khoá ngoại)

## `order.unmatched_return_parcel_lines`

Dòng hàng của kiện trả không khớp: số kho quét lúc nhận, chỉ món đã rõ SKU (Documents/19, Documents/21 §20).

Khai ở `src/modules/order/fulfillment/repository/schema.ts` · module con `fulfillment` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `parcel_id` uuid · not null → `order.unmatched_return_parcels.id` (khoá ngoại)
- `variant_id` uuid · not null → `product.product_variants.id` (tham chiếu, không có khoá ngoại)
- `quantity` integer · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`parcel_id`, `variant_id`) `unmatched_return_parcel_lines_parcel_id_variant_id_unique`
- index (`parcel_id`) `unmatched_return_parcel_lines_parcel_id_index`
- check `unmatched_return_parcel_lines_quantity`: `quantity > 0`

## `order.unmatched_return_parcels`

Kiện hàng trả quét được mà không khớp yêu cầu trả nào; hàng nằm ở chờ xử lý tới khi gắn hoặc bỏ (Documents/21 mục 20).

Khai ở `src/modules/order/fulfillment/repository/schema.ts` · module con `fulfillment` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `code` text · not null
- `scanned_code` text · not null
- `status` enum `order.unmatched_parcel_status` · not null · mặc định `'open'`: `open` | `attached` | `dismissed`
- `return_request_id` uuid · null → `order.return_requests.id` (tham chiếu, không có khoá ngoại)
- `note` text · null
- `status_reason` text · null
- `received_by` uuid · null → `core.accounts` (người thao tác)
- `inspection_id` uuid · null → `product.stock_documents.id` (tham chiếu, không có khoá ngoại)
  Phiếu kiểm hàng hoàn sinh lúc nhận (`receiveBack` nguồn `unmatched_parcel`, Documents/21 §20).
- `inspection_number` text · null
- `resolved_by` uuid · null → `core.accounts` (người thao tác)
- `resolved_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `code`) `unmatched_return_parcels_company_id_code_unique`
- index (`status`) `unmatched_return_parcels_status_index`
- check `unmatched_return_parcels_resolved`: `(status = 'open') = (resolved_at is null)`
- check `unmatched_return_parcels_attached`: `(status = 'attached') = (return_request_id is not null)`
- check `unmatched_return_parcels_dismissed`: `status <> 'dismissed' or status_reason is not null`

Trỏ vào bảng này:

- `order.unmatched_return_parcel_lines.parcel_id` (khoá ngoại)
