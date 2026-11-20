# Schema CSDL

<!-- Sinh tự động bởi `npm run db:docs`. Không sửa tay: sửa comment trong schema.ts (hoặc scripts/db/lib/schema-refs.ts) rồi chạy lại lệnh. -->

Phiên bản **V118** (`20261120104359_gia-ban-sao-sku-san`): 92 bảng trong 6 schema, 67 khoá ngoại, 78 cột tham chiếu không có khoá ngoại. Lịch sử từng phiên bản: [VERSIONS.md](VERSIONS.md).

Nguồn: snapshot của migration mới nhất, comment trong `src/modules/<lớn>/<con>/repository/schema.ts`, khoá ngoại, trigger, index, EXCLUDE viết tay trong migration. Cột, kiểu, ràng buộc, quan hệ của từng bảng ở `db/schema/<schema>.md`.

**Không có ở đây:** RLS và policy (mọi bảng có `company_id` bật RLS với policy `company_isolation`, trừ ngoại lệ ở `test/integration/shared/rls-coverage.test.ts`), quyền của role `commerio_app`, hàm SQL, và mọi thứ tạo bằng SQL động. Xem `db/CLAUDE.md` mục Row-Level Security và các migration viết tay.

## Trước khi thêm bảng, cột, enum

- Tìm ở đây và trong `db/schema/<schema>.md` xem đã có thứ cùng nghĩa chưa. Có rồi thì dùng lại, không thêm bản thứ hai.
- Không xây tiếp lên mục **Đã bỏ** bên dưới (thẻ `@deprecated` trong schema.ts).
- Cột uuid trỏ sang bảng khác mà không có khoá ngoại: khai ở `scripts/db/lib/schema-refs.ts`, không thì `db:docs` báo lỗi.
- Không để hai migration sinh từ schema.ts liền nhau trong một PR (`db/CLAUDE.md`).

## Đã bỏ

- `finance.ledger_entries.replaces_entry_id` (cột): Cặp thay ước tính đã chép sang `ledger_replacements` (#231), cột này không ghi nữa.
- `finance.payment_vouchers` (bảng): Gỡ ở #235: không còn code ghi, chưa drop. Xoá shop vẫn đếm dòng cũ (`shop-purge.ts`).
- `finance.sales_invoice_lines` (bảng): Gỡ ở #235 cùng `sales_invoices`: không còn code ghi, chưa drop.
- `finance.sales_invoices` (bảng): Gỡ ở #235: không còn code ghi, chưa drop. Xoá shop vẫn đếm dòng cũ (`shop-purge.ts`).
- `channel.webhook_events` (bảng): Không dùng: MVP không nhận push của sàn (#133, #135), kéo định kỳ là đường nhận đơn duy nhất. Xoá ở migration sau.

## `core` · Lõi · lớp 1 · 17 bảng

Chi tiết: [schema/core.md](schema/core.md)

- `core.accounts` (staff): Tài khoản đăng nhập, dùng chung mọi công ty nên không có RLS (docs/19 D3, D25).
- `core.attachments` (files): Tệp đính kèm của một chứng từ (ảnh phiếu giao, video mở thùng, biên bản; Documents/21 mục 14.3).
- `core.audit_logs` (audit): Nhật ký thao tác, chỉ thêm, không sửa.
- `core.companies` (platform): Bảng chung của nền tảng, không thuộc công ty nào nên không có RLS.
- `core.company_modules` (platform): Phân hệ đang bật của công ty.
- `core.files` (files): Thông tin tệp; nội dung tệp nằm ở kho đối tượng (Cloudflare R2 qua API S3) theo `storage_key`.
- `core.invitations` (staff): Lời mời bằng link một lần (#7 [C], docs/19 D39, spec 6.3).
- `core.member_roles` (access): Vai trò của một membership (core.memberships, không đặt khoá ngoại chéo module).
- `core.memberships` (staff): Tài khoản thuộc công ty nào; khoá tài khoản tính theo công ty (docs/19 D5).
- `core.outbox_messages` (platform): Outbox (Documents/21 D4, D5): sự kiện ghi cùng giao dịch nghiệp vụ, relay của worker đẩy lên Kafka.
- `core.permissions` (access): Danh mục quyền (Documents/21 mục 8).
- `core.processed_events` (platform): Sự kiện consumer đã xử lý, chống xử lý trùng (D7).
- `core.refresh_tokens` (identity): Refresh token, chỉ lưu bản băm SHA-256.
- `core.registrations` (identity): Lần đăng ký công ty đang chờ mã xác minh email (#459, Documents/21 mục 2.1).
- `core.role_permissions` (access)
- `core.roles` (access): Vai trò có sẵn có `company_id` trống, dùng chung mọi công ty; vai trò tuỳ biến thuộc một công ty.
- `core.state_transitions` (platform): Lịch sử chuyển trạng thái của mọi thực thể có máy trạng thái (N4, Documents/21 mục 14.1: `statusHistory`), chỉ thêm.

## `product` · Sản phẩm · lớp 2 · 21 bảng

Chi tiết: [schema/product.md](schema/product.md)

- `product.attribute_values` (catalog): Giá trị thuộc tính; `code` là phần ghép vào {VAL} của SKU (19-D27, D36).
- `product.attributes` (catalog)
- `product.company_product_settings` (catalog): Cài đặt sản phẩm của công ty (D11): mẫu SKU, số {SEQ} kế tiếp, gợi ý mặc định.
- `product.doc_counters` (inventory): Bộ đếm số chứng từ của cả module lớn `product` (phiếu kho, đề nghị nhập, phiếu nhận, phiếu trả NCC): cấp số bằng `UPDATE … SET next_number = next_number + 1 RETURNING` trong giao dịch.
- `product.goods_receipt_lines` (purchasing): Dòng phiếu nhận: số NCC báo giao, số đạt (vào tồn thực), số lỗi giữ lại (vào chờ xử lý), số trả tại chỗ.
- `product.goods_receipts` (purchasing): Một đợt NCC giao hàng cho một đề nghị.
- `product.product_attribute_value_images` (catalog): Ảnh phân loại theo giá trị của thuộc tính gắn ảnh (#340, Documents/19 §3.2): áo 3 màu × 4 size có 3 dòng.
- `product.product_groups` (catalog): Nhóm hàng (Documents/19 D11, 21 mục 5.2): một cấp, không gắn sàn, không gắn SKU.
- `product.product_images` (catalog): Ảnh sản phẩm theo thứ tự, `position` 0 là ảnh đại diện (#303); `file_id` ở module files, không đặt khoá ngoại chéo schema.
- `product.product_variants` (catalog): Biến thể (SKU); SKU không cấp lại kể cả sau khi lưu trữ (Documents/21 P5).
- `product.products` (catalog): Sản phẩm; đổi nhóm hàng được, SKU không đổi theo (Documents/21 P6, 19/11/2026).
- `product.purchase_request_lines` (purchasing): Dòng đề nghị.
- `product.purchase_requests` (purchasing): Một lần xin nhập hàng của một NCC.
- `product.stock_document_lines` (inventory): Dòng phiếu kho.
- `product.stock_documents` (inventory): Phiếu kho.
- `product.stock_levels` (inventory): Các con số lưu của SKU (25 §7.1, Documents/21 mục 15.1).
- `product.stock_moves` (inventory): Thẻ kho, chỉ thêm (role ứng dụng không UPDATE/DELETE).
- `product.supplier_return_lines` (purchasing)
- `product.supplier_returns` (purchasing): Hàng lỗi trả NCC.
- `product.suppliers` (purchasing): Nhà cung cấp; ngừng giao dịch thì `active = false` (`supplier_inactive`), không xoá.
- `product.variant_attribute_values` (catalog): Tổ hợp giá trị của biến thể; `position` giữ thứ tự thuộc tính để ghép {VAL} và nhãn (D8).

## `order` · Đơn hàng · lớp 3 · 11 bảng

Chi tiết: [schema/order.md](schema/order.md)

- `order.customer_identities` (sales): Danh tính của khách trên một kênh (sàn, hộp thư), gộp về một hồ sơ khách.
- `order.customers` (sales): `shop_id` (channel), `conversation_id` (inbox), `variant_id` (catalog) là uuid thường, không khoá ngoại chéo schema (19-D1).
- `order.doc_counters` (sales): Bộ đếm mã đơn, cùng dạng `product.doc_counters` (plan chuẩn bị A4/K5).
- `order.order_lines` (sales): Dòng đơn: chép SKU, tên sản phẩm, đơn giá lúc tạo đơn để đơn cũ không đổi khi sản phẩm đổi.
- `order.orders` (sales): Đơn hàng.
- `order.package_lines` (fulfillment): Dòng kiện.
- `order.packages` (fulfillment): Một gói hàng đi chung một mã vận đơn, gồm món của một đơn.
- `order.return_request_lines` (sales): Dòng yêu cầu trả: gắn dòng đơn và kiện đã giao chứa phần đó; giá vốn là bình quân các dòng kiện (25 §9).
- `order.return_requests` (sales): Khách trả sau khi đã nhận.
- `order.unmatched_return_parcel_lines` (fulfillment): Dòng hàng của kiện trả không khớp: số kho quét lúc nhận, chỉ món đã rõ SKU (Documents/19, Documents/21 §20).
- `order.unmatched_return_parcels` (fulfillment): Kiện hàng trả quét được mà không khớp yêu cầu trả nào; hàng nằm ở chờ xử lý tới khi gắn hoặc bỏ (Documents/21 mục 20).

## `finance` · Tài chính · lớp 4 · 21 bảng

Chi tiết: [schema/finance.md](schema/finance.md)

- `finance.bank_matches` (finance): Khớp dòng sổ (rút tiền, NCC hoàn tiền, bồi thường) với sao kê ngân hàng (#117, Documents/21 §21.3).
- `finance.config_versions` (finance): Phiên bản cấu hình phí (theo gian hàng), loại hình thuế, quy tắc thuế, ngưỡng lệch, biên tối thiểu.
- `finance.doc_counters` (finance): Bộ đếm số hoá đơn, phiếu thu, phiếu chi; `period` theo tháng nếu #27 đánh số theo kỳ (plan chuẩn bị A4/K5).
- `finance.gateway_configs` (payment): Khoá cổng của công ty, mã hoá AES-256-GCM.
- `finance.ledger_entries` (finance): Sổ tiền, chỉ thêm (T1): mỗi khoản một dòng, số có dấu (vào dương, ra âm), cờ ước tính hay thực tế.
- `finance.ledger_package_lines` (finance): Dòng hàng của kiện đã giao (#231), chép từ payload `fulfillment.package_delivered` lúc ghi sổ: lãi theo SKU (25 §10.2) gộp trong schema finance, không đọc chéo bảng kiện.
- `finance.ledger_replacements` (finance): Quan hệ thay giữa dòng thực tế và dòng ước tính (#231): một dòng thực tế thay tối đa một dòng ước tính và ngược lại.
- `finance.order_payments` (payment): Trạng thái tiền của đơn hộp thư, đơn tạo tay (đơn sàn không có dòng, 19-D11).
- `finance.order_settlements` (finance): Một dòng mỗi đơn sàn.
- `finance.payment_links` (payment): Mã thanh toán.
- `finance.payment_transactions` (payment): Giao dịch cổng báo về, ghi một lần (19-D19).
- `finance.payment_vouchers` (finance) **đã bỏ**: Phiếu chi: nháp → ghi sổ → (đảo).
- `finance.receipts` (finance): Phiếu thu, không có nháp.
- `finance.sales_invoice_lines` (finance) **đã bỏ**: Dòng hoá đơn: chép từ dòng đơn; dòng của hoá đơn đảo mang số âm.
- `finance.sales_invoices` (finance) **đã bỏ**: Hoá đơn bán, tự sinh khi xuất kho.
- `finance.settlement_batches` (finance): Một lần kéo quyết toán của một gian hàng, bằng API hoặc file khi gian hàng đã ngắt.
- `finance.settlement_lines` (finance): Dòng đối soát, một dòng mỗi giao dịch của bảng kê; chạy lại đối soát không sinh trùng nhờ `external_transaction_id`.
- `finance.settlement_statements` (finance): Bảng kê thanh toán của sàn; `shop_id` trỏ channel, `payment_status` giữ nguyên chữ của sàn (PAID, PROCESSING…).
- `finance.supplier_invoices` (finance): Hoá đơn nhà cung cấp (UC-PF-08); `supplier_id`, `purchase_request_id` trỏ purchasing, không khoá ngoại (19-D1).
- `finance.unmatched_receipts` (finance): Tiền về không gán được vào đơn (không có mã, lệch tiền, đơn đã huỷ); gán hoặc hoàn sau (UC-PF-07).
- `finance.webhook_events` (payment): Webhook cổng đã nhận (sau khi kiểm chữ ký), chống xử lý lặp.

## `channel` · Kênh bán · lớp 5 · 18 bảng

Chi tiết: [schema/channel.md](schema/channel.md)

- `channel.api_usage` (channel): Số lời gọi sàn trong một ngày (giờ Việt Nam) (#102 A7, #215).
- `channel.conversation_notes` (inbox): Ghi chú nội bộ trên hội thoại, khách không thấy.
- `channel.conversation_tags` (inbox)
- `channel.conversations` (inbox)
- `channel.listings` (channel): Một SKU trên một gian hàng, đồng thời là bảng ghép SKU sàn → SKU app.
- `channel.message_channels` (inbox): Kênh nhắn tin đã kết nối (trang Messenger, hộp thư, Zalo OA, chat sàn).
- `channel.messages` (inbox): Tin nhắn; tin gửi đi chưa có mã ngoài cho tới khi nền tảng nhận.
- `channel.platform_categories` (channel): Bản sao cây category của sàn (#400, Documents/19 mục 3.3).
- `channel.platform_category_attributes` (channel): Attribute của một leaf category (#400, Documents/19 mục 3.3).
- `channel.price_calculations` (channel): Một lần chạy bộ lọc giá cho một SKU trên một gian hàng (25 §6.2): lưu đầu vào, kết quả từng bước và phiên bản cấu hình phí, thuế đã dùng, để biết giá trên sàn ra từ đâu.
- `channel.product_specs` (channel): Thông tin sàn của một sản phẩm cha, một bộ mỗi sàn, mọi gian hàng của sàn dùng chung (#400, Documents/19 mục 3.3).
- `channel.raw_orders` (channel): Dữ liệu gốc của đơn sàn mỗi lần cập nhật; `order_id` có khi đã tạo đơn trong `order`.
- `channel.remote_skus` (channel): Bản sao danh sách SKU của gian hàng trên sàn (#220 đợt 2, Documents/21 §18.3 "đọc từ lần đồng bộ gần nhất"): trang ghép, kiểm SKU khi ghép và số SKU chưa ghép đọc từ đây, không gọi sàn mỗi lần.
- `channel.shop_category_permissions` (channel): Quyền đăng category của một gian hàng, chỉ TikTok dùng (`permission_statuses`, #400 A17).
- `channel.shop_reauth_mails` (channel): Thư báo gian hàng sắp hết hoặc đã mất uỷ quyền đã xếp (#312, Documents/19).
- `channel.shops` (channel): Gian hàng sàn đã kết nối, định danh bằng (sàn, mã shop của sàn); kết nối lại cùng shop dùng lại bản ghi.
- `channel.tags` (inbox)
- `channel.webhook_events` (channel) **đã bỏ**: Webhook sàn đã nhận, chống xử lý lặp theo `notification_id`.

## `insight` · Phân tích · lớp 5 · 4 bảng

Chi tiết: [schema/insight.md](schema/insight.md)

- `insight.daily_channel_summary` (report): Số liệu theo ngày và gian hàng (V28, D18), dựng lại bằng tính lại từ module nguồn (D7).
- `insight.document_chunks` (assistant): Đoạn tài liệu và embedding 1536 chiều; `role_ids` chép từ `document_roles` để lọc lúc tìm kiếm.
- `insight.document_roles` (assistant): Vai trò được hỏi trợ lý về tài liệu này.
- `insight.documents` (assistant): Tài liệu nội bộ trợ lý AI dùng để trả lời; tách đoạn và tạo embedding ở worker.
