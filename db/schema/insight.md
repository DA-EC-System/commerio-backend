# Schema `insight` · Phân tích · lớp 5

<!-- Sinh tự động bởi `npm run db:docs`. Không sửa tay: sửa comment trong schema.ts (hoặc scripts/db/lib/schema-refs.ts) rồi chạy lại lệnh. -->

Phiên bản **V109**, 4 bảng. Mục lục mọi schema và các bảng đã bỏ: [../SCHEMA.md](../SCHEMA.md).

**Không có ở đây:** RLS và policy (mọi bảng có `company_id` bật RLS với policy `company_isolation`, trừ ngoại lệ ở `test/integration/shared/rls-coverage.test.ts`), quyền của role `commerio_app`, hàm SQL, và mọi thứ tạo bằng SQL động. Xem `db/CLAUDE.md` mục Row-Level Security và các migration viết tay.

## `insight.daily_channel_summary`

Số liệu theo ngày và gian hàng (V28, D18), dựng lại bằng tính lại từ module nguồn (D7). `shop_id` trống với đơn hộp thư, đơn tạo tay, nên khoá unique coi hai giá trị trống là trùng. `fees_pending`: có đơn chưa đối soát nên phí sàn đang là 0.

Khai ở `src/modules/insight/report/repository/schema.ts` · module con `report` · theo công ty (`company_id`)

Cột:

- `id` bigint · khoá chính
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `day` date · not null
- `source` enum `insight.order_source` · not null: `marketplace` | `inbox` | `manual`
- `shop_id` uuid · null → `channel.shops.id` (tham chiếu, không có khoá ngoại)
- `revenue` numeric(18,2) · not null · mặc định `'0'`
- `cash_collected` numeric(18,2) · not null · mặc định `'0'`
- `platform_fee` numeric(18,2) · not null · mặc định `'0'`
- `payment_fee` numeric(18,2) · not null · mặc định `'0'`
- `shipping_fee` numeric(18,2) · not null · mặc định `'0'`
- `cogs` numeric(18,2) · not null · mặc định `'0'`
- `profit` numeric(18,2) · not null · mặc định `'0'`
- `fees_pending` boolean · not null · mặc định `false`
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- unique (`company_id`, `day`, `source`, `shop_id`) NULLS NOT DISTINCT `daily_channel_summary_company_id_day_source_shop_id_unique`

## `insight.document_chunks`

Đoạn tài liệu và embedding 1536 chiều; `role_ids` chép từ `document_roles` để lọc lúc tìm kiếm.

Khai ở `src/modules/insight/assistant/repository/schema.ts` · module con `assistant` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `document_id` uuid · not null → `insight.documents.id` (khoá ngoại)
- `chunk_index` integer · not null
- `content` text · not null
- `role_ids` uuid[] · null
- `embedding` vector(1536) · null
- `created_at` timestamptz · not null · mặc định `now()`

Ràng buộc và index:

- unique (`document_id`, `chunk_index`) `document_chunks_document_id_chunk_index_unique`

## `insight.document_roles`

Vai trò được hỏi trợ lý về tài liệu này.

Khai ở `src/modules/insight/assistant/repository/schema.ts` · module con `assistant` · theo công ty (`company_id`)

Cột:

- `document_id` uuid · khoá chính → `insight.documents.id` (khoá ngoại)
- `role_id` uuid · khoá chính → `core.roles.id` (tham chiếu, không có khoá ngoại)
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Ràng buộc và index:

- khoá chính (`document_id`, `role_id`)
- index (`role_id`) `document_roles_role_id_index`

## `insight.documents`

Tài liệu nội bộ trợ lý AI dùng để trả lời; tách đoạn và tạo embedding ở worker.

Khai ở `src/modules/insight/assistant/repository/schema.ts` · module con `assistant` · theo công ty (`company_id`)

Cột:

- `id` uuid · khoá chính · mặc định `gen_random_uuid()`
- `company_id` uuid · not null → `core.companies` (theo công ty)
- `file_id` uuid · not null → `core.files.id` (tham chiếu, không có khoá ngoại)
- `title` text · not null
- `status` enum `insight.doc_processing` · not null · mặc định `'processing'`: `processing` | `ready` | `failed`
- `uploaded_by` uuid · not null → `core.accounts` (người thao tác)
- `created_at` timestamptz · not null · mặc định `now()`
- `updated_at` timestamptz · not null · mặc định `now()`
- `version` integer · not null · mặc định `1`

Trỏ vào bảng này:

- `insight.document_chunks.document_id` (khoá ngoại)
- `insight.document_roles.document_id` (khoá ngoại)
