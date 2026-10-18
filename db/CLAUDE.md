# db/

Migration của PostgreSQL. Một database, mỗi module một schema cùng tên (`notification` không có schema).

- `migrations/`: do `drizzle-kit` sinh ra, **không sửa tay** file đã merge vào `develop`. Muốn đổi thì sửa `src/modules/<tên>/repository/schema.ts` rồi chạy `npm run db:generate -- --name <mo-ta>` để có migration mới.
- `0000_tao-schema-module.sql` tạo 18 schema rỗng.
- `0001_nen-tang.sql` bảng của platform, identity, staff, access, audit, files (ERD `nen-tang`).
- `0002_seed-quyen.sql` danh mục quyền và bốn vai trò có sẵn (`Documents/21` mục 8), cùng nguồn với `src/modules/access/domain/catalog.ts`. Đổi danh mục thì thêm migration seed mới và sửa file đó; test integration so DB với file đó.
- Thứ Drizzle không sinh được (Row-Level Security policy, `CREATE EXTENSION vector`, trigger): `npx drizzle-kit generate --custom --name <mo-ta>` tạo file SQL trống rồi viết tay.
- `0003_rls.sql` role `commerio_app`, quyền trên bảng, chính sách RLS.
- `0004_outbox.sql` bảng `platform.outbox_messages`, `platform.processed_events`; `0005_outbox-rls-ten-vai-tro.sql` RLS và quyền chỉ-INSERT của outbox, unique tên vai trò theo chữ thường (`roles_company_lower_name_uq`).
- `0006_san-pham-gia-kho.sql` 18 bảng catalog, pricing, inventory (ERD core, thêm `variant_attribute_values.position`, `stock_moves.done_by`, `inventory.doc_counters`; tên danh mục, thuộc tính, giá trị thuộc tính, sản phẩm không trùng theo chữ thường); `0007_san-pham-gia-kho-rls.sql` RLS 18 bảng, thẻ kho `stock_moves` chỉ thêm (không UPDATE, DELETE).
- `0008_ban-hang-kenh.sql` 12 bảng sales, fulfillment, channel; `0009_thanh-toan-tai-chinh-bao-cao.sql` 12 bảng payment, finance, report (ERD core, mở rộng, cộng cột của plan chuẩn bị A7, R2: `payment_code`, `(gateway, gateway_txn_id)`, `webhook_receiver_key` unique toàn hệ thống; chứng từ đảo số âm, một lần, có lý do; một hoá đơn `posted` chưa đảo mỗi đơn; `order_payments.delivered_at`, `paid_at`; `sales.doc_counters`, `finance.doc_counters`); `0010_p3-p5-rls.sql` RLS 24 bảng, lịch sử trạng thái đơn `fulfillment.order_status_history` chỉ thêm.
- `0011_vai-tro-co-san-rls.sql` policy `RESTRICTIVE` cho UPDATE, DELETE trên `access.roles`, `access.role_permissions`: công ty chỉ sửa, xoá vai trò của mình và quyền của chúng (vá lỗ của 0003: xoá được vai trò có sẵn, xoá hay chuyển quyền của nó).
- `0012_vector.sql` `CREATE EXTENSION IF NOT EXISTS vector` (pgvector không "trusted", cần superuser: test bật sẵn trong `global-setup.ts`, Supabase bật bằng extension cho phép hoặc dashboard); `0013_phan-he-tuy-chon-doi-soat.sql` 15 bảng purchasing, inbox, assistant (`document_chunks.embedding vector(1536)`), `finance.supplier_invoices`, `settlement_statements`, `settlement_lines` (cộng `kind`, `external_transaction_id` unique theo công ty, `shipping_cost`, `adjustment`, `discrepancy_reason`, `raw`), khoá ngoại `receipts.settlement_line_id`, `payment_vouchers.supplier_invoice_id`; `0014_phan-he-tuy-chon-doi-soat-rls.sql` RLS 15 bảng.
- Index **biểu thức** cần `NULLS NOT DISTINCT` (vd `(company_id, lower(name))` với vai trò có sẵn `company_id` trống) Drizzle không sinh được: viết trong migration `--custom`, không khai trong `schema.ts` để `db:generate` sau này không đòi xoá; ghi chú trong `schema.ts` trỏ tới migration đó.
- Staging là PostgreSQL 17 trên Supabase, chạy migration bằng user không phải superuser. Không dùng tính năng chỉ có ở PG18 (`uuidv7()`, cột ảo). Test integration đã chạy migration bằng role `NOSUPERUSER CREATEROLE` cho giống; thử trên PG17: `TEST_PG_IMAGE=pgvector/pgvector:pg17 npx vitest run --project integration`.

## Row-Level Security

Bảng thuộc công ty có `company_id` và chính sách `company_isolation`: chỉ thấy dòng có `company_id = current_setting('app.company_id')`.

- **Request trong một công ty:** transaction chạy `SET LOCAL ROLE commerio_app` và `set_config('app.company_id', <id>, true)`. Role này không phải chủ bảng nên RLS có hiệu lực; chưa đặt `app.company_id` thì không thấy dòng nào.
- **Luồng không thuộc công ty nào** (đăng ký, đăng nhập, chọn công ty, quản trị nền tảng, worker): chạy bằng role đăng nhập, là chủ bảng nên bỏ qua RLS. Vì vậy không bật `FORCE ROW LEVEL SECURITY`.
- Bảng mới tạo bằng migration tự cấp quyền cho `commerio_app` (`ALTER DEFAULT PRIVILEGES`), nhưng **phải tự viết** `ENABLE ROW LEVEL SECURITY` và policy trong một migration `--custom`.
- Bảng chung không có RLS: `platform.companies`, `staff.accounts`, `access.permissions`, `identity.refresh_tokens` (chỉ luồng xác thực đọc). Vai trò có sẵn (`company_id` trống) công ty nào cũng đọc được nhưng không sửa, không xoá được, kể cả quyền của nó (0003 + 0011).

- `test/integration/shared/rls-coverage.test.ts` quét mọi bảng: bảng có `company_id` thiếu RLS/policy, hay quyền của `commerio_app` khác mong đợi, là đỏ. Bảng cố ý khác thì thêm vào `RLS_EXCEPTIONS`/`EXPECTED_PRIVILEGES` trong file đó kèm lý do.

## Hai nhánh cùng sinh migration: người merge sau **bắt buộc** sinh lại

`drizzle-kit migrate` chạy mọi migration đang chờ trong **một** giao dịch, và chỉ chạy migration có `when` (trong `meta/_journal.json`) **lớn hơn** migration cuối đã chạy trên DB đó. Migration sinh trên nhánh khác trước nhưng merge sau sẽ bị **bỏ qua im lặng** trên DB đã có dữ liệu (staging), trong khi test (DB trống) vẫn xanh. Vì vậy người merge sau xoá migration của mình (file `.sql`, snapshot, dòng journal), rebase lên `develop` rồi sinh lại. `test/unit/db/journal.test.ts` đỏ nếu `when` không tăng theo `idx`.

Seed dữ liệu demo (dữ liệu giả, không dùng thông tin khách hàng thật) đặt ở `db/seed/`, chạy bằng `npm run db:seed` (`db/seed/index.ts`, #37).
