# db/

Migration của PostgreSQL. Một database, mỗi module một schema cùng tên (`notification` không có schema).

- `migrations/`: do `drizzle-kit` sinh ra, **không sửa tay** file đã merge vào `develop`. Muốn đổi thì sửa `src/modules/<tên>/repository/schema.ts` rồi chạy `npm run db:generate -- --name <mo-ta>` để có migration mới.
- `0000_tao-schema-module.sql` tạo 18 schema rỗng.
- Thứ Drizzle không sinh được (Row-Level Security policy, `CREATE EXTENSION vector`, trigger): `npx drizzle-kit generate --custom --name <mo-ta>` tạo file SQL trống rồi viết tay.

Khi hai người cùng sinh migration trên hai nhánh, số thứ tự trùng nhau. Người merge sau xoá migration của mình, rebase lên `develop` rồi sinh lại.

Seed dữ liệu demo (dữ liệu giả, không dùng thông tin khách hàng thật) sẽ đặt ở `db/seed/`.
