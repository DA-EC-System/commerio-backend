# db/

Migration của PostgreSQL. Một database, **mỗi module lớn một schema cùng tên**: `core`, `product`, `order`, `finance`, `channel`, `insight` (`Documents/19` D1; `notification` không có bảng). Module con khai bảng trong `src/modules/<lớn>/<con>/repository/schema.ts` với `pgSchema('<lớn>')`. Thiết kế từng bảng: `Documents/19-mo-hinh-du-lieu.md` mục 3.

**`order` là từ khoá SQL**: SQL viết tay phải ghi `"order".orders`, không ghi `order.orders` (Drizzle tự thêm ngoặc kép).

- `migrations/`: do `drizzle-kit` sinh ra, **không sửa tay** file đã merge vào `main`. Muốn đổi thì sửa `schema.ts` rồi chạy `npm run db:generate -- --name <mo-ta>` để có migration mới.
- **Tên file từ 11/11/2026:** `<năm tháng ngày giờ phút giây>_<mo-ta>.sql` theo giờ UTC lúc sinh, vd `20261111030018_muc-dich-tep.sql` (`migrations.prefix: 'timestamp'` trong `drizzle.config.ts`), để hai nhánh cùng sinh migration không trùng tên. 29 file đầu `0000`–`0028` giữ tên theo số thứ tự: code, test và tài liệu đang gọi chúng theo số. Không đặt tên tay.
- Bộ migration dựng lại từ đầu ngày 28/10/2026 khi gom 6 module lớn (chưa có dữ liệu thật; staging xoá DB rồi chạy lại):
  - `0000_mo-rong.sql` extension `vector` (pgvector, không "trusted": test bật sẵn trong `global-setup.ts`, Supabase bật bằng danh sách cho phép) và `btree_gist` (ràng buộc EXCLUDE).
  - `0001_tao-bang.sql` 6 schema, 79 bảng, enum, CHECK, index (drizzle sinh).
  - `0002_rls-quyen.sql` (viết tay) role `commerio_app` và quyền trên 6 schema; vòng lặp bật RLS + policy `company_isolation` (USING và WITH CHECK) cho **mọi bảng có `company_id`**, trừ `core.refresh_tokens` (không RLS, `commerio_app` không có quyền) và `core.roles` (vai trò có sẵn có `company_id` trống); policy riêng và RESTRICTIVE cho `core.roles`, `core.role_permissions`; index `roles_company_lower_name_uq`; bảng chỉ thêm (`core.audit_logs`, `core.processed_events`, `core.state_transitions`, `product.stock_moves`, `finance.ledger_entries`: không UPDATE, DELETE); outbox chỉ INSERT; `core.accounts` không UPDATE, DELETE; `core.invitations` không DELETE; trigger `member_roles_company_fk`; EXCLUDE `config_versions_no_overlap` (không hai phiên bản cấu hình `scheduled`/`active` chồng ngày cùng công ty, loại, gian hàng).
  - `0003_seed-quyen.sql` danh mục quyền và năm vai trò có sẵn, **sinh từ** `src/modules/core/access/domain/catalog.ts`; test integration so DB với file đó. Đổi danh mục thì sửa file đó và thêm migration seed mới.
  - `0015_bo-vai-tro-nhap-hang.sql` (viết tay, seed) xoá vai trò id `...0005` (vai trò nhập hàng riêng, #188): chuyển thành viên, lời mời, tài liệu trợ lý đang gắn vai trò này sang Nhân viên kho, thêm hai quyền `purchasing.request.manage`, `purchasing.return.manage` cho Nhân viên kho. Còn bốn vai trò có sẵn.
  - `0018_keo-lai-don-truoc-0017.sql` (viết tay, chỉ dữ liệu) cho đơn sàn lưu trước #260 kéo lại một lần: đơn thô thiếu khoá `info` hoặc địa chỉ lặp phường thì xoá `external_update_time`, gian hàng có đơn như vậy thì xoá `last_order_sync_at` (lượt sau kéo từ `order_cutoff_at`); worker cũ còn chạy lúc đổi image thì chạy lại file này sau rollout (chạy lại được).
- Thứ Drizzle không sinh được (RLS, extension, trigger, EXCLUDE): `npx drizzle-kit generate --custom --name <mo-ta>` tạo file SQL trống rồi viết tay. Bảng thêm sau **phải tự bật RLS** trong migration `--custom` (vòng lặp của 0002 chỉ chạy một lần).
- Index **biểu thức** cần `NULLS NOT DISTINCT` (vd `(company_id, lower(name))` với vai trò có sẵn `company_id` trống) Drizzle không sinh được: viết trong migration `--custom`, không khai trong `schema.ts` để `db:generate` sau này không đòi xoá; ghi chú trong `schema.ts` trỏ tới migration đó.
- Staging là PostgreSQL 17 trên Supabase, chạy migration bằng user không phải superuser. Không dùng tính năng chỉ có ở PG18 (`uuidv7()`, cột ảo). Test integration đã chạy migration bằng role `NOSUPERUSER CREATEROLE` cho giống; thử trên PG17: `TEST_PG_IMAGE=pgvector/pgvector:pg17 npx vitest run --project integration`.

## Ràng buộc nghiệp vụ trong DB

- Bảng có bước duyệt dùng cột chung `approval` (`created_by`, `approved_by`, `approved_at`, `self_approved`) và CHECK `approvalCheck` (`src/shared/db/columns.ts`): người duyệt khác người lập, trừ khi `self_approved` (CEO, hoặc công ty một người; service quyết). Người thứ hai giữa hai cột khác (COD, thất lạc, kết quả trả NCC, chốt lệch) là CHECK riêng của bảng.
- Trạng thái kéo theo cột bắt buộc (đã ghi sổ thì có `posted_at`, hoàn tiền NCC thì có số tiền…) là CHECK. Quy tắc trải nhiều bảng (`đạt + lỗi ≤ còn chờ`, người ghi sổ phiếu nhận khác người lập đề nghị) do service kiểm.
- Tồn: `stock_levels_invariant` cho phép tồn thực âm hoặc nhỏ hơn đang giữ **chỉ khi** bật `invariant_broken` (hai ngoại lệ của `25` §7.1).
- Dòng kiện: constraint trigger `package_lines_line_total` (migration `*_tach-kien-bat-bien`, hàm `"order".check_package_line_total()`, #205): tổng `quantity` của một dòng đơn trên các kiện chưa huỷ không vượt `order_lines.quantity`. `DEFERRABLE INITIALLY DEFERRED` (kiểm lúc commit), chỉ trên dòng kiện vừa chèn hay đổi `quantity`, `package_id`, `order_line_id`; dòng kiện trỏ tới dòng đơn không có thì bỏ qua. Hàm chạy quyền người gọi và **không khoá** dòng đơn (tránh vòng khoá với luồng nhận đơn), nên đường ghi dòng kiện phải khoá kiện trước. Lỗi `23514` kèm `constraint = package_lines_line_total`; muốn báo ngay trong giao dịch thì `set constraints "order".package_lines_line_total immediate`.

## Row-Level Security

Bảng thuộc công ty có `company_id` và chính sách `company_isolation`: chỉ thấy dòng có `company_id = current_setting('app.company_id')`.

- **Request trong một công ty:** transaction chạy `SET LOCAL ROLE commerio_app` và `set_config('app.company_id', <id>, true)`. Role này không phải chủ bảng nên RLS có hiệu lực; chưa đặt `app.company_id` thì không thấy dòng nào.
- **Luồng không thuộc công ty nào** (đăng ký, đăng nhập, chọn công ty, quản trị nền tảng, worker): chạy bằng role đăng nhập, là chủ bảng nên bỏ qua RLS. Vì vậy không bật `FORCE ROW LEVEL SECURITY`.
- Bảng mới tạo bằng migration tự cấp quyền cho `commerio_app` (`ALTER DEFAULT PRIVILEGES` của 0002), nhưng **phải tự viết** `ENABLE ROW LEVEL SECURITY` và policy trong một migration `--custom`.
- Bảng chung không có RLS: `core.companies`, `core.accounts`, `core.permissions`, `core.refresh_tokens` (chỉ luồng xác thực đọc). Trong công ty, `core.accounts` chỉ đọc và thêm. Vai trò có sẵn (`company_id` trống) công ty nào cũng đọc được nhưng không sửa, không xoá được, kể cả quyền của nó (0002).

- `test/integration/shared/rls-coverage.test.ts` quét mọi bảng: bảng có `company_id` thiếu RLS/policy, hay quyền của `commerio_app` khác mong đợi, là đỏ. Bảng cố ý khác thì thêm vào `RLS_EXCEPTIONS`/`EXPECTED_PRIVILEGES` trong file đó kèm lý do.

## Hai nhánh cùng sinh migration: người merge sau **bắt buộc** sinh lại

Migrator của drizzle-orm (`drizzle-orm/pg-core/dialect.js`, hàm `migrate`; `drizzle-kit migrate` dùng chung) đọc dòng mới nhất của `drizzle.__drizzle_migrations` (`order by created_at desc limit 1`) rồi chỉ chạy migration có `when` (trong `meta/_journal.json`) **lớn hơn** `created_at` của dòng đó, mọi migration đang chờ trong **một** giao dịch. Migration sinh trên nhánh khác trước nhưng merge sau sẽ bị **bỏ qua im lặng** trên DB đã có dữ liệu (staging), trong khi test (DB trống) vẫn xanh. Tên file theo thời điểm sinh **không** chữa được: nó chỉ hết trùng tên file, còn thứ tự chạy vẫn theo `when`, và snapshot của hai nhánh vẫn cùng nối vào một snapshot cha.

Ba lớp chặn (`scripts/db/`):

| Lệnh | Chạy ở | Chặn gì |
|---|---|---|
| `npm run db:ci-check` | Job `check` của CI ở mọi PR (`-- --base origin/main`), không cần DB | Migration của nhánh không đứng sau migration mới nhất của main (`when` và tên); nhánh sửa file `.sql` đã có trên main; journal đứt `idx`, `when` không tăng; file `.sql` hay snapshot không có trong journal; snapshot trỏ sai cha (`prevId` khác `id` của snapshot liền trước); `drizzle-kit generate` (chạy trên bản sao trong thư mục tạm) còn sinh ra file, tức `schema.ts` và migration lệch nhau |
| `npm run db:migrate` (`:staging`) | Job `migrate` của deploy staging, job `blackbox` của CI, máy dev | Thay `drizzle-kit migrate`. So journal với `drizzle.__drizzle_migrations` (đã chạy khi và chỉ khi có dòng `created_at` = `when`, như drizzle; hash chỉ để cảnh báo); có migration chưa chạy mà `when` ≤ dòng mới nhất, hoặc có dòng `created_at` NULL, thì **dừng, mã lỗi 1, in tên file, không chạy gì**; không thì chạy migrator của drizzle-orm như cũ, xong kiểm lại không còn sót. Giữ khoá advisory `commerio:db-migrate` trong lúc chạy |
| `npm run db:migrate:check` (`:staging`) | Tay | Chỉ đọc (giao dịch `READ ONLY`, không tạo bảng): liệt kê đã chạy, chưa chạy, lệch thứ tự, dòng trên DB không khớp journal, file `.sql` khác bản đã chạy. Mã lỗi 1 nếu có lệch thứ tự |

**Sinh lại bằng `npm run db:regen`** (sau khi `git merge origin/main` và giải xung đột `schema.ts`; xung đột `_journal.json` để nguyên): lấy `_journal.json` của `origin/main` (`--base <ref>` để đổi), xoá migration của nhánh (file `.sql` và snapshot không có trên main), chạy `drizzle-kit generate --name <slug cũ>` một lần cho mọi migration sinh từ schema, rồi chép nguyên nội dung từng migration viết tay (snapshot giống hệt snapshot cha: RLS, quyền, dữ liệu) vào migration `--custom` mới cùng slug. `--dry-run` chỉ in kế hoạch. Giới hạn:
- Nhiều migration sinh từ schema gộp thành một (tên ghép các slug): không có `schema.ts` của từng bước để sinh riêng. Viết tay đứng trước migration sinh đầu tiên vẫn đứng trước; viết tay đứng giữa hai migration sinh bị dời ra sau migration gộp, lệnh cảnh báo để kiểm lại.
- Câu lệnh viết tay thêm vào migration sinh bị mất khi sinh lại: lệnh so câu lệnh cũ với bản mới, in câu thiếu và trả mã 1 để chép tay.
- drizzle-kit hỏi đổi tên cột/bảng thì trả lời như khi `db:generate`.

### Migration bị bỏ sót trên DB đã có dữ liệu

`db:migrate` dừng và `db:migrate:check` liệt kê ở mục "Lệch thứ tự". Không có lệnh tự sửa. Với migration đã ở main: chạy tay nội dung file trên DB đó, rồi ghi dòng `insert into drizzle.__drizzle_migrations (hash, created_at) values ('<sha256 của file .sql>', <when>)` (hash: `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('db/migrations/<tag>.sql')).digest('hex'))"`), chạy lại `db:migrate:check` thấy hết lệch. **`created_at` là cột bắt buộc** khi chèn tay: dòng thiếu nó bị drizzle coi là mới nhất (`order by created_at desc` xếp NULL lên đầu), đổi thành 0 và chạy lại mọi migration; `db:migrate` dừng khi gặp dòng như vậy.

DB local (máy dev) bị chặn vì từng chạy migration của nhánh khác, hoặc cảnh báo "trùng nội dung một migration đã chạy dưới tên khác" sau `db:regen`: xoá DB rồi `npm run db:migrate` lại.

`test/unit/db/journal.test.ts` đỏ nếu `when` không tăng theo `idx`, hoặc tên file không khớp `when`.

Seed dữ liệu demo (dữ liệu giả, không dùng thông tin khách hàng thật) đặt ở `db/seed/`, chạy bằng `npm run db:seed` (`db/seed/index.ts`, #37).
