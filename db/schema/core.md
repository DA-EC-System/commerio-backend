# Schema `core` · Lõi · lớp 1

<!-- Sinh tự động bởi `npm run db:docs`. Không sửa tay: sửa comment trong schema.ts (hoặc scripts/db/lib/schema-refs.ts) rồi chạy lại lệnh. -->

Phiên bản **V150**, 17 bảng. Mục lục mọi schema và các bảng đã bỏ: [../SCHEMA.md](../SCHEMA.md).

**Không có ở đây:** RLS và policy (mọi bảng có `company_id` bật RLS với policy `company_isolation`, trừ ngoại lệ ở `test/integration/shared/rls-coverage.test.ts`), quyền của role `commerio_app`, hàm SQL, và mọi thứ tạo bằng SQL động. Xem `db/CLAUDE.md` mục Row-Level Security và các migration viết tay.

## `core.accounts`

Tài khoản đăng nhập, dùng chung mọi công ty nên không có RLS (docs/19 D3, D25). Email lưu chữ thường; mật khẩu băm argon2id.

Khai ở `src/modules/core/staff/repository/schema.ts` · module con `staff`

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `email` text · not null
- `full_name` text · not null
- `password_hash` text · null
- `must_change_password` boolean · not null · mặc định `false`
- `google_sub` text · null
- `is_platform_admin` boolean · not null · mặc định `false`
- `password_changed_at` timestamptz · null
  Lần đổi mật khẩu gần nhất; access token mang dấu này, khác thì 401 (#62). Trống: chưa từng đổi.
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`email`) `accounts_email_unique`
- unique (`google_sub`) `accounts_google_sub_unique`

Trỏ vào bảng này:

- `core.invitations.created_by` (khoá ngoại)
- `core.invitations.account_id` (khoá ngoại)
- `core.invitations.decided_by` (khoá ngoại)
- `core.memberships.account_id` (khoá ngoại)
- `core.refresh_tokens.account_id` (tham chiếu, không có khoá ngoại)
- người thao tác, 53 cột: `core.attachments.created_by`, `core.audit_logs.actor_id`, `core.company_modules.enabled_by`, `core.company_modules.ai_consent_by`, `core.files.uploaded_by`, `core.state_transitions.actor_id`, `product.goods_receipts.resolved_by`, `product.goods_receipts.created_by`, `product.goods_receipts.posted_by`, `product.purchase_product_drafts.updated_by`, `product.purchase_requests.created_by`, `product.purchase_requests.approved_by`, `product.purchase_requests.ordered_by`, `product.purchase_requests.closed_by`, `product.stock_documents.created_by`, `product.stock_documents.approved_by`, `product.stock_documents.posted_by`, `product.stock_moves.done_by`, `product.supplier_returns.created_by`, `product.supplier_returns.approved_by`, `product.supplier_returns.sent_by`, `product.supplier_returns.result_by`, `order.packages.packed_by`, `order.packages.handed_over_by`, `order.packages.handover_reverted_by`, `order.packages.delivered_by`, `order.packages.cod_confirmed_by`, `order.packages.lost_reported_by`, `order.packages.lost_confirmed_by`, `order.return_requests.received_by`, `order.return_requests.created_by`, `order.unmatched_return_parcels.received_by`, `order.unmatched_return_parcels.resolved_by`, `finance.bank_matches.matched_by`, `finance.config_versions.created_by`, `finance.config_versions.approved_by`, `finance.fee_templates.updated_by`, `finance.gateway_configs.updated_by`, `finance.ledger_entries.created_by`, `finance.order_settlements.resolved_by`, `finance.order_settlements.approved_by`, `finance.payment_links.created_by`, `finance.payment_vouchers.created_by`, `finance.payment_vouchers.posted_by`, `finance.settlement_batches.created_by`, `channel.conversation_notes.author_id`, `channel.conversations.assignee_id`, `channel.listing_sync_runs.requested_by`, `channel.listings.approved_by`, `channel.listings.pending_requested_by`, `channel.listings.mapping_requested_by`, `channel.price_calculations.confirmed_by`, `insight.documents.uploaded_by`

## `core.attachments`

Tệp đính kèm của một chứng từ (ảnh phiếu giao, video mở thùng, biên bản; Documents/21 mục 14.3). `entity_type` là tên bảng của chứng từ, vd `goods_receipts`; không khoá ngoại vì chứng từ nằm ở module khác.

Khai ở `src/modules/core/files/repository/schema.ts` · module con `files` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `file_id` uuid · not null → `core.files.id` (khoá ngoại)
- `entity_type` text · not null
- `entity_id` uuid · not null: đa hình: bảng đích theo cột `entity_type`
- `purpose` text · null
- `created_by` uuid · null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`entity_type`, `entity_id`) `attachments_entity_type_entity_id_index`
- index (`file_id`) `attachments_file_id_index`

## `core.audit_logs`

Nhật ký thao tác, chỉ thêm, không sửa. `company_id` trống là nhật ký cấp nền tảng hoặc cấp tài khoản (docs/19 D4; Documents/21 V12).

Khai ở `src/modules/core/audit/repository/schema.ts` · module con `audit` · theo công ty (`company_id`)

Cột:

- `id` bigint · khoá chính
- `company_id` uuid · null → `core.companies` (theo công ty)
- `actor_id` uuid · null → `core.accounts` (người thao tác)
- `action` enum `core.audit_action` · not null: `create` | `update` | `delete`
- `entity_type` text · not null
- `entity_id` uuid · null: đa hình: bảng đích theo cột `entity_type`
- `entity_label` text · null
  Tên đối tượng lúc ghi (#352); trống ở dòng ghi trước đó.
- `operation` text · null
  Mã thao tác cụ thể (`lock`, `change_roles`, `approve_send`…); trống khi chỉ là thêm/sửa/xoá thường.
- `before` jsonb · null
- `after` jsonb · null
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- index (`company_id`, `created_at`) `audit_logs_company_id_created_at_index`

## `core.companies`

Bảng chung của nền tảng, không thuộc công ty nào nên không có RLS.

Khai ở `src/modules/core/platform/repository/schema.ts` · module con `platform`

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `name` text · not null
- `tax_code` text · null
  Dạng chuẩn hoá (`domain/tax-code.ts`); null khi quản trị nền tảng gỡ hoặc mã cũ không hợp lệ (#459).
- `address` text · null
  Hồ sơ công ty (#292): địa chỉ đăng ký; tổ chức chịu trách nhiệm hàng hoá, null = theo tên, địa chỉ công ty.
- `responsible_name` text · null
- `responsible_address` text · null
- `status` enum `core.company_status` · not null · mặc định `'active'`: `active` | `locked`
- `lock_reason` text · null
- `locked_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`tax_code`) `companies_tax_code_unique`

Trỏ vào bảng này:

- 95 bảng có `company_id`

## `core.company_modules`

Phân hệ đang bật của công ty. Chỉ có dòng cho phân hệ đã bật hoặc từng bật.

Khai ở `src/modules/core/platform/repository/schema.ts` · module con `platform` · theo công ty (`company_id`)

Cột:

- `company_id` uuid · khoá chính → `core.companies` (theo công ty)
- `module_code` enum `core.module_code` · khoá chính: `platform` | `identity` | `catalog` | `pricing` | `inventory` | `sales` | `fulfillment` | `finance` | `payment` | `notification` | `purchasing` | `channel` | `inbox` | `assistant` | `report`
- `enabled` boolean · not null · mặc định `true`
- `enabled_by` uuid · null → `core.accounts` (người thao tác)
  Tài khoản ở module staff, không đặt khoá ngoại chéo module.
- `ai_consent_at` timestamptz · null
- `ai_consent_by` uuid · null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- khoá chính (`company_id`, `module_code`)

## `core.files`

Thông tin tệp; nội dung tệp nằm ở kho đối tượng (Cloudflare R2 qua API S3) theo `storage_key`. Dòng được tạo lúc cấp vé tải lên (#212), trước khi FE PUT tệp: dòng có mà tệp chưa có trên kho là bình thường. `uploaded_at` ghi lần đầu thấy tệp trên kho (khi gắn vào chứng từ); trống là chưa xác nhận đã PUT xong.

Khai ở `src/modules/core/files/repository/schema.ts` · module con `files` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `storage_key` text · not null
- `file_name` text · not null
- `content_type` text · not null
- `size_bytes` bigint · not null
- `purpose` enum `core.file_purpose` · not null: `product_image` | `attachment`
- `uploaded_by` uuid · null → `core.accounts` (người thao tác)
- `uploaded_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`storage_key`) `files_storage_key_unique`
- check `files_size_positive`: `size_bytes > 0`

Trỏ vào bảng này:

- `core.attachments.file_id` (khoá ngoại)
- `product.product_attribute_value_images.file_id` (tham chiếu, không có khoá ngoại)
- `product.product_images.file_id` (tham chiếu, không có khoá ngoại)
- `product.products.size_chart_file_id` (tham chiếu, không có khoá ngoại)
- `product.purchase_product_drafts.size_chart_file_id` (tham chiếu, không có khoá ngoại)
- `finance.settlement_batches.file_id` (tham chiếu, không có khoá ngoại)
- `insight.documents.file_id` (tham chiếu, không có khoá ngoại)

## `core.invitations`

Lời mời bằng link một lần (#7 [C], docs/19 D39, spec 6.3). `id` cũng là `jti` của token link; DB không lưu token. Chuyển trạng thái theo `domain/invitation-machine.ts`, ghi có điều kiện ở `repository/invitations.ts`. Không xoá: `commerio_app` không có quyền DELETE (migration 0019). RLS `company_isolation` có `WITH CHECK`.

Khai ở `src/modules/core/staff/repository/schema.ts` · module con `staff` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `role_ids` uuid[] · not null
- `created_by` uuid · not null → `core.accounts.id` (khoá ngoại)
- `expires_at` timestamptz · not null
- `status` enum `core.invitation_status` · not null · mặc định `'open'`: `open` | `claimed` | `pending` | `approved` | `rejected` | `revoked`
- `email` text · null
  Ghi ở `/join/otp`, cố định khi sang `claimed`. Email chữ thường.
- `full_name` text · null
- `account_id` uuid · null → `core.accounts.id` (khoá ngoại)
  Tài khoản đã có (`sign_in`) hoặc tài khoản tạo lúc duyệt.
- `password_hash` text · null
  Chỉ khi `set_password`; xoá khi duyệt hoặc từ chối.
- `otp_hash` text · null
  `sha256(mã + ':' + id)` (`domain/otp.ts`).
- `otp_expires_at` timestamptz · null
- `otp_attempts` integer · not null · mặc định `0`
- `otp_send_count` integer · not null · mặc định `0`
- `otp_requested_at` timestamptz · null
  Cắt về mili giây khi ghi để so khớp với `requestedAt` trong sự kiện.
- `submitted_at` timestamptz · null
- `decided_by` uuid · null → `core.accounts.id` (khoá ngoại)
- `decided_at` timestamptz · null
- `purged_at` timestamptz · null
  Việc dọn nháp quá hạn (`staff.invitation_purge`) xoá email, họ tên, OTP của link `open`, `claimed` chưa nộp.
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- index (`company_id`, `status`, `submitted_at`, `id`) `invitations_queue_idx`
- index (`company_id`, `created_at`) `invitations_created_idx`
- index (`created_by`) `invitations_created_by_index`
- index (`account_id`) `invitations_account_id_index`
- index (`decided_by`) `invitations_decided_by_index`
- unique index (`company_id`, `email`) `invitations_one_pending_per_email` where `status = 'pending'`
- check `invitations_role_ids_nonempty`: `cardinality(role_ids) >= 1`
- check `invitations_identity_present`: `status::text in ('open', 'revoked') or purged_at is not null or (email is not null and full_name is not null)`
- check `invitations_purged_shape`: `purged_at is null or (status::text in ('open', 'claimed', 'revoked') and email is null and full_name is null and otp_hash is null and password_hash is null)`
- check `invitations_pending_shape`: `status <> 'pending' or (submitted_at is not null and ((password_hash is not null)::int + (account_id is not null)::int) = 1)`
- check `invitations_approved_shape`: `status <> 'approved' or (account_id is not null and decided_by is not null and decided_at is not null)`
- check `invitations_rejected_shape`: `status <> 'rejected' or (decided_by is not null and decided_at is not null)`
- check `invitations_revoked_shape`: `status::text <> 'revoked' or (decided_by is not null and decided_at is not null)`
- check `invitations_otp_counters_range`: `otp_attempts between 0 and 5 and otp_send_count between 0 and 5`
- check `invitations_decided_clean`: `status not in ('approved', 'rejected') or (password_hash is null and otp_hash is null)`

## `core.member_roles`

Vai trò của một membership (core.memberships, không đặt khoá ngoại chéo module). Có `company_id` để RLS lọc thẳng, không phải tra sang staff. Trigger `member_roles_company_fk` (migration 0017, viết tay) bắt vai trò trống công ty hoặc cùng công ty, và membership cùng công ty (#62).

Khai ở `src/modules/core/access/repository/schema.ts` · module con `access` · theo công ty (`company_id`)

Cột:

- `membership_id` uuid · khoá chính → `core.memberships.id` (tham chiếu, không có khoá ngoại)
- `role_id` uuid · khoá chính → `core.roles.id` (khoá ngoại)
- `company_id` uuid · not null → `core.companies` (theo công ty)

Ràng buộc và index:

- khoá chính (`membership_id`, `role_id`)
- index (`role_id`) `member_roles_role_id_index`
- trigger `member_roles_company_fk`: `BEFORE INSERT OR UPDATE OF membership_id, role_id, company_id → core.check_member_role_company()`, ở `db/migrations/0002_rls-quyen.sql`

## `core.memberships`

Tài khoản thuộc công ty nào; khoá tài khoản tính theo công ty (docs/19 D5).

Khai ở `src/modules/core/staff/repository/schema.ts` · module con `staff` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `account_id` uuid · not null → `core.accounts.id` (khoá ngoại)
- `status` enum `core.membership_status` · not null · mặc định `'active'`: `active` | `suspended`
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `account_id`) `memberships_company_id_account_id_unique`
- index (`account_id`) `memberships_account_id_index`

Trỏ vào bảng này:

- `core.member_roles.membership_id` (tham chiếu, không có khoá ngoại)

## `core.outbox_messages`

Outbox (Documents/21 D4, D5): sự kiện ghi cùng giao dịch nghiệp vụ, relay của worker đẩy lên Kafka. `company_id` trống với sự kiện cấp nền tảng. Role ứng dụng chỉ được INSERT (0005), nên `event_id` sinh ở ứng dụng, không dùng RETURNING; relay đọc bằng role chủ bảng.

Khai ở `src/modules/core/platform/repository/schema.ts` · module con `platform` · theo công ty (`company_id`)

Cột:

- `id` bigint · khoá chính
- `event_id` uuid · not null: mã sự kiện của outbox, không phải khoá của bảng nào
- `company_id` uuid · null → `core.companies` (theo công ty)
- `type` text · not null
- `topic` text · not null
- `key` text · not null
- `payload` jsonb · not null
- `created_at` timestamptz · not null · mặc định `now()`
- `published_at` timestamptz · null

Ràng buộc và index:

- unique (`event_id`) `outbox_messages_event_id_unique`
- index (`id`) `outbox_messages_unpublished_idx` where `published_at is null`

## `core.permissions`

Danh mục quyền (Documents/21 mục 8). Dùng chung mọi công ty, không có RLS; seed bằng migration.

Khai ở `src/modules/core/access/repository/schema.ts` · module con `access`

Cột:

- `code` text · khoá chính
- `module_code` text · not null
  Mã phân hệ của quyền; quyền chỉ có hiệu lực khi phân hệ đó đang bật.
- `description` text · not null

Trỏ vào bảng này:

- `core.role_permissions.permission_code` (khoá ngoại)

## `core.processed_events`

Sự kiện consumer đã xử lý, chống xử lý trùng (D7). Không thuộc công ty nên không có RLS.

Khai ở `src/modules/core/platform/repository/schema.ts` · module con `platform`

Cột:

- `consumer` text · khoá chính
- `event_id` uuid · khoá chính: mã sự kiện của outbox, không phải khoá của bảng nào
- `processed_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- khoá chính (`consumer`, `event_id`)

## `core.refresh_tokens`

Refresh token, chỉ lưu bản băm SHA-256. Thuộc tài khoản chứ không thuộc công ty, nên không có RLS; `company_id` là công ty đang chọn của phiên (để trống khi chưa chọn). Họ token (`family_id`): mọi token xoay vòng từ một lần đăng nhập. `rotated_at` là lúc token bị thay bằng token kế tiếp (còn dùng lại được trong hạn `REFRESH_REUSE_GRACE_SECONDS`); `revoked_at` là thu hồi hẳn (đăng xuất, đổi mật khẩu, phát hiện dùng lại), không có hạn dùng lại.

Khai ở `src/modules/core/identity/repository/schema.ts` · module con `identity` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `account_id` uuid · not null → `core.accounts.id` (tham chiếu, không có khoá ngoại)
- `company_id` uuid · null → `core.companies` (theo công ty)
- `family_id` uuid · not null · mặc định `gen_random_uuid()`: họ refresh token: các token sinh từ cùng một lần đăng nhập
  Mặc định ngẫu nhiên: đăng nhập mở họ mới, dòng có sẵn lúc thêm cột mỗi dòng một họ.
- `token_hash` text · not null
- `expires_at` timestamptz · not null
- `rotated_at` timestamptz · null
- `revoked_at` timestamptz · null
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`token_hash`) `refresh_tokens_token_hash_unique`
- index (`account_id`) `refresh_tokens_account_id_index`
- index (`family_id`) `refresh_tokens_family_id_index`

## `core.registrations`

Lần đăng ký công ty đang chờ mã xác minh email (#459, Documents/21 mục 2.1). Không thuộc công ty nào nên không RLS (luồng đăng ký chạy bằng role chủ bảng). Chỉ giữ mật khẩu đã băm argon2id và bản băm của mã (`sha256(mã + ':' + id)`, `domain/registration.ts`). Sống 30 phút (`expires_at`); việc nền dọn dòng tạo quá 24 giờ (giữ lâu hơn hạn để đếm trần thư theo email và thư "email đã có tài khoản" mỗi 24 giờ). Tạo công ty xong thì xoá.

Khai ở `src/modules/core/identity/repository/schema.ts` · module con `identity`

Cột:

- `id` uuid · khoá chính
- `email` text · not null
  Email chữ thường, đã cắt khoảng trắng.
- `full_name` text · not null
- `password_hash` text · not null
- `company_name` text · not null
- `tax_code` text · not null
  Dạng chuẩn hoá (`platform/domain/tax-code.ts`); chưa giữ chỗ, so trùng lại lúc tạo công ty.
- `otp_hash` text · null
  Null tới khi việc nền gửi thư mã; email đã có tài khoản thì luôn null (không mã nào đúng).
- `otp_requested_at` timestamptz · not null
- `otp_expires_at` timestamptz · not null
- `otp_attempts` integer · not null · mặc định `0`
- `otp_send_count` integer · not null · mặc định `1`
- `account_notice_at` timestamptz · null
  Lúc gửi thư "email đã có tài khoản" của lần đăng ký này (tối đa một thư mỗi email mỗi 24 giờ).
- `expires_at` timestamptz · not null
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- index (`email`, `created_at`) `registrations_email_created_at_index`
- index (`created_at`) `registrations_created_at_index`
- check `registrations_otp_counters_range`: `otp_attempts between 0 and 5 and otp_send_count between 1 and 5`

## `core.role_permissions`

Khai ở `src/modules/core/access/repository/schema.ts` · module con `access`

Cột:

- `role_id` uuid · khoá chính → `core.roles.id` (khoá ngoại, ON DELETE cascade)
- `permission_code` text · khoá chính → `core.permissions.code` (khoá ngoại)

Ràng buộc và index:

- khoá chính (`role_id`, `permission_code`)

## `core.roles`

Vai trò có sẵn có `company_id` trống, dùng chung mọi công ty; vai trò tuỳ biến thuộc một công ty. Tên không trùng theo chữ thường: index `roles_company_lower_name_uq` viết tay ở migration 0005 (Drizzle không sinh được). `kind` ràng với `company_id`: có sẵn thì trống công ty, tuỳ biến thì có (#62).

Khai ở `src/modules/core/access/repository/schema.ts` · module con `access` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · null → `core.companies` (theo công ty)
- `name` text · not null
- `kind` enum `core.role_kind` · not null: `builtin` | `custom`
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `name`) NULLS NOT DISTINCT `roles_company_id_name_unique`
- check `roles_kind_company_check`: `(kind = 'builtin') = (company_id is null)`
- unique index viết tay `roles_company_lower_name_uq`: `(company_id, lower(name)) NULLS NOT DISTINCT`, ở `db/migrations/0002_rls-quyen.sql`

Trỏ vào bảng này:

- `core.member_roles.role_id` (khoá ngoại)
- `core.role_permissions.role_id` (khoá ngoại)
- `insight.document_roles.role_id` (tham chiếu, không có khoá ngoại)

## `core.state_transitions`

Lịch sử chuyển trạng thái của mọi thực thể có máy trạng thái (N4, Documents/21 mục 14.1: `statusHistory`), chỉ thêm. `entity_type` là tên bảng (vd `packages`), `actor_id` trống khi sàn hoặc hệ thống chuyển. Thực thể nằm ở module khác nên không có khoá ngoại.

Khai ở `src/modules/core/platform/repository/schema.ts` · module con `platform` · theo công ty (`company_id`)

Cột:

- `id` bigint · khoá chính
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `entity_type` text · not null
- `entity_id` uuid · not null: đa hình: bảng đích theo cột `entity_type`
- `from_state` text · null
- `to_state` text · not null
- `action` text · not null
- `actor_id` uuid · null → `core.accounts` (người thao tác)
- `source` enum `core.transition_source` · not null: `user` | `marketplace` | `system`
- `reason` text · null
- `self_approved` boolean · not null · mặc định `false`
  Bước người duyệt khác đi theo ngoại lệ tự duyệt (Documents/21 mục 14.1, #246).
- `at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- index (`entity_type`, `entity_id`, `at`) `state_transitions_entity_type_entity_id_at_index`
