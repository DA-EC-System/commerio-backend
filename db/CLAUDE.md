# db/

Migration của PostgreSQL. Một database, **mỗi module lớn một schema cùng tên**: `core`, `product`, `order`, `finance`, `channel`, `insight` (`Documents/19` D1; `notification` không có bảng). Module con khai bảng trong `src/modules/<lớn>/<con>/repository/schema.ts` với `pgSchema('<lớn>')`. Thiết kế từng bảng: `Documents/19-mo-hinh-du-lieu.md` mục 3.

**`order` là từ khoá SQL**: SQL viết tay phải ghi `"order".orders`, không ghi `order.orders` (Drizzle tự thêm ngoặc kép).

- `migrations/`: do `drizzle-kit` sinh ra, **không sửa tay** file đã merge vào `develop`. Muốn đổi thì sửa `schema.ts` rồi chạy `npm run db:generate -- --name <mo-ta>` để có migration mới.
- Bộ migration dựng lại từ đầu ngày 28/10/2026 khi gom 6 module lớn (chưa có dữ liệu thật; staging xoá DB rồi chạy lại):
  - `0000_mo-rong.sql` extension `vector` (pgvector, không "trusted": test bật sẵn trong `global-setup.ts`, Supabase bật bằng danh sách cho phép) và `btree_gist` (ràng buộc EXCLUDE).
  - `0001_tao-bang.sql` 6 schema, 79 bảng, enum, CHECK, index (drizzle sinh).
  - `0002_rls-quyen.sql` (viết tay) role `commerio_app` và quyền trên 6 schema; vòng lặp bật RLS + policy `company_isolation` (USING và WITH CHECK) cho **mọi bảng có `company_id`**, trừ `core.refresh_tokens` (không RLS, `commerio_app` không có quyền) và `core.roles` (vai trò có sẵn có `company_id` trống); policy riêng và RESTRICTIVE cho `core.roles`, `core.role_permissions`; index `roles_company_lower_name_uq`; bảng chỉ thêm (`core.audit_logs`, `core.processed_events`, `core.state_transitions`, `product.stock_moves`, `finance.ledger_entries`: không UPDATE, DELETE); outbox chỉ INSERT; `core.accounts` không UPDATE, DELETE; `core.invitations` không DELETE; trigger `member_roles_company_fk`; EXCLUDE `config_versions_no_overlap` (không hai phiên bản cấu hình `scheduled`/`active` chồng ngày cùng công ty, loại, gian hàng).
  - `0003_seed-quyen.sql` danh mục quyền và năm vai trò có sẵn (CEO, Admin, Sale, Nhân viên kho, Mua hàng), **sinh từ** `src/modules/core/access/domain/catalog.ts`; test integration so DB với file đó. Đổi danh mục thì sửa file đó và thêm migration seed mới.
- Thứ Drizzle không sinh được (RLS, extension, trigger, EXCLUDE): `npx drizzle-kit generate --custom --name <mo-ta>` tạo file SQL trống rồi viết tay. Bảng thêm sau **phải tự bật RLS** trong migration `--custom` (vòng lặp của 0002 chỉ chạy một lần).
- Index **biểu thức** cần `NULLS NOT DISTINCT` (vd `(company_id, lower(name))` với vai trò có sẵn `company_id` trống) Drizzle không sinh được: viết trong migration `--custom`, không khai trong `schema.ts` để `db:generate` sau này không đòi xoá; ghi chú trong `schema.ts` trỏ tới migration đó.
- Staging là PostgreSQL 17 trên Supabase, chạy migration bằng user không phải superuser. Không dùng tính năng chỉ có ở PG18 (`uuidv7()`, cột ảo). Test integration đã chạy migration bằng role `NOSUPERUSER CREATEROLE` cho giống; thử trên PG17: `TEST_PG_IMAGE=pgvector/pgvector:pg17 npx vitest run --project integration`.

## Ràng buộc nghiệp vụ trong DB

- Bảng có bước duyệt dùng cột chung `approval` (`created_by`, `approved_by`, `approved_at`, `self_approved`) và CHECK `approvalCheck` (`src/shared/db/columns.ts`): người duyệt khác người lập, trừ khi `self_approved` (CEO, hoặc công ty một người; service quyết). Người thứ hai giữa hai cột khác (COD, thất lạc, kết quả trả NCC, chốt lệch) là CHECK riêng của bảng.
- Trạng thái kéo theo cột bắt buộc (đã ghi sổ thì có `posted_at`, hoàn tiền NCC thì có số tiền…) là CHECK. Quy tắc trải nhiều bảng (`đạt + lỗi ≤ còn chờ`, người ghi sổ phiếu nhận khác người lập đề nghị) do service kiểm.
- Tồn: `stock_levels_invariant` cho phép tồn thực âm hoặc nhỏ hơn đang giữ **chỉ khi** bật `invariant_broken` (hai ngoại lệ của `25` §7.1).

## Row-Level Security

Bảng thuộc công ty có `company_id` và chính sách `company_isolation`: chỉ thấy dòng có `company_id = current_setting('app.company_id')`.

- **Request trong một công ty:** transaction chạy `SET LOCAL ROLE commerio_app` và `set_config('app.company_id', <id>, true)`. Role này không phải chủ bảng nên RLS có hiệu lực; chưa đặt `app.company_id` thì không thấy dòng nào.
- **Luồng không thuộc công ty nào** (đăng ký, đăng nhập, chọn công ty, quản trị nền tảng, worker): chạy bằng role đăng nhập, là chủ bảng nên bỏ qua RLS. Vì vậy không bật `FORCE ROW LEVEL SECURITY`.
- Bảng mới tạo bằng migration tự cấp quyền cho `commerio_app` (`ALTER DEFAULT PRIVILEGES` của 0002), nhưng **phải tự viết** `ENABLE ROW LEVEL SECURITY` và policy trong một migration `--custom`.
- Bảng chung không có RLS: `core.companies`, `core.accounts`, `core.permissions`, `core.refresh_tokens` (chỉ luồng xác thực đọc). Trong công ty, `core.accounts` chỉ đọc và thêm. Vai trò có sẵn (`company_id` trống) công ty nào cũng đọc được nhưng không sửa, không xoá được, kể cả quyền của nó (0002).

- `test/integration/shared/rls-coverage.test.ts` quét mọi bảng: bảng có `company_id` thiếu RLS/policy, hay quyền của `commerio_app` khác mong đợi, là đỏ. Bảng cố ý khác thì thêm vào `RLS_EXCEPTIONS`/`EXPECTED_PRIVILEGES` trong file đó kèm lý do.

## Hai nhánh cùng sinh migration: người merge sau **bắt buộc** sinh lại

`drizzle-kit migrate` chạy mọi migration đang chờ trong **một** giao dịch, và chỉ chạy migration có `when` (trong `meta/_journal.json`) **lớn hơn** migration cuối đã chạy trên DB đó. Migration sinh trên nhánh khác trước nhưng merge sau sẽ bị **bỏ qua im lặng** trên DB đã có dữ liệu (staging), trong khi test (DB trống) vẫn xanh. Vì vậy người merge sau xoá migration của mình (file `.sql`, snapshot, dòng journal), rebase lên `develop` rồi sinh lại. `test/unit/db/journal.test.ts` đỏ nếu `when` không tăng theo `idx`.

Seed dữ liệu demo (dữ liệu giả, không dùng thông tin khách hàng thật) đặt ở `db/seed/`, chạy bằng `npm run db:seed` (`db/seed/index.ts`, #37).
