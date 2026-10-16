# db/

Migration của PostgreSQL. Một database, mỗi module một schema cùng tên (`notification` không có schema).

- `migrations/`: do `drizzle-kit` sinh ra, **không sửa tay** file đã merge vào `develop`. Muốn đổi thì sửa `src/modules/<tên>/repository/schema.ts` rồi chạy `npm run db:generate -- --name <mo-ta>` để có migration mới.
- `0000_tao-schema-module.sql` tạo 18 schema rỗng.
- `0001_nen-tang.sql` bảng của platform, identity, staff, access, audit, files (ERD `nen-tang`).
- `0002_seed-quyen.sql` danh mục quyền và bốn vai trò có sẵn (`Documents/21` mục 8), cùng nguồn với `src/modules/access/domain/catalog.ts`. Đổi danh mục thì thêm migration seed mới và sửa file đó; test integration so DB với file đó.
- Thứ Drizzle không sinh được (Row-Level Security policy, `CREATE EXTENSION vector`, trigger): `npx drizzle-kit generate --custom --name <mo-ta>` tạo file SQL trống rồi viết tay.
- `0003_rls.sql` role `commerio_app`, quyền trên bảng, chính sách RLS.

## Row-Level Security

Bảng thuộc công ty có `company_id` và chính sách `company_isolation`: chỉ thấy dòng có `company_id = current_setting('app.company_id')`.

- **Request trong một công ty:** transaction chạy `SET LOCAL ROLE commerio_app` và `set_config('app.company_id', <id>, true)`. Role này không phải chủ bảng nên RLS có hiệu lực; chưa đặt `app.company_id` thì không thấy dòng nào.
- **Luồng không thuộc công ty nào** (đăng ký, đăng nhập, chọn công ty, quản trị nền tảng, worker): chạy bằng role đăng nhập, là chủ bảng nên bỏ qua RLS. Vì vậy không bật `FORCE ROW LEVEL SECURITY`.
- Bảng mới tạo bằng migration tự cấp quyền cho `commerio_app` (`ALTER DEFAULT PRIVILEGES`), nhưng **phải tự viết** `ENABLE ROW LEVEL SECURITY` và policy trong một migration `--custom`.
- Bảng chung không có RLS: `platform.companies`, `staff.accounts`, `access.permissions`, `identity.refresh_tokens` (chỉ luồng xác thực đọc). Vai trò có sẵn (`company_id` trống) công ty nào cũng đọc được nhưng không sửa được.

Khi hai người cùng sinh migration trên hai nhánh, số thứ tự trùng nhau. Người merge sau xoá migration của mình, rebase lên `develop` rồi sinh lại.

Seed dữ liệu demo (dữ liệu giả, không dùng thông tin khách hàng thật) sẽ đặt ở `db/seed/`.
