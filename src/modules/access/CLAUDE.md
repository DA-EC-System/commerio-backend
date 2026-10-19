# Module `access`

Vai trò có sẵn và tuỳ biến, danh mục quyền (UC-PI-06). Hợp đồng API: `Documents/21` mục 3 (I1–I5), mục 8 (danh mục), mục 10 (V4–V8, V16, D1–D3).

## Bảng

| Bảng | Ghi chú |
|---|---|
| `access.permissions` | Danh mục 43 quyền, seed bằng migration, khớp hằng `PERMISSIONS` (`domain/catalog.ts`) |
| `access.roles` | `company_id` trống = vai trò có sẵn (4 vai trò, id cố định trong `BUILTIN_ROLES`); tên không trùng theo chữ thường trong công ty (index `roles_company_lower_name_uq`) |
| `access.role_permissions` | Xoá theo vai trò (cascade) |
| `access.member_roles` | Vai trò của membership (`staff`), có `company_id` cho RLS |

## API (gắn dưới `/api/v1/identity`, router do `identity` gắn)

| API | Quyền | Việc |
|---|---|---|
| `GET /permissions` | `identity.role.view` | Danh mục cấp được của phân hệ đang bật, `{ code, module, label }`, không có `platform.*` |
| `GET /roles` | `identity.role.view` hoặc `identity.account.view` | Có sẵn (CEO, Admin, Sale, Nhân viên kho) trước, tuỳ biến theo tên; `memberCount` đếm trong công ty |
| `POST /roles` | `identity.role.manage` | Tạo vai trò tuỳ biến, nhật ký `create` |
| `PUT /roles/:id` | `identity.role.manage` | Sửa tên và trọn danh sách quyền theo `version`, nhật ký `update` |
| `DELETE /roles/:id?version=` | `identity.role.manage` | Xoá vai trò không còn ai mang, nhật ký `delete` |

## Bất biến

- Thứ tự kiểm sau `authorize → validate`: `PUT` 404 → `builtin_role` → `version_conflict` → `permission_not_held` (quyền đang có của vai trò) → 422 phân hệ tắt → `role_name_taken` → `permission_not_held` (quyền gửi lên). `POST`, `DELETE` theo cùng thứ tự, bỏ bước không áp dụng.
- `permission_not_held` so với **quyền thô hiện tại** của người gọi đọc từ DB (`loadCompanyAccess` của identity, nhận qua `AccessRouterContext`), kể cả quyền của phân hệ đang tắt; không dùng `perms` trong token (D1).
- Quyền của phân hệ đang tắt: gửi lên thì 422 `errors.permissions`; `PUT` giữ nguyên các quyền đó mà vai trò đang có (D2).
- Tên trùng không phân biệt hoa thường, tính cả tên vai trò có sẵn (D3). Kiểm bằng `lower()` của PostgreSQL như index; ghi đua bị `23505` thì cũng ra 409 `role_name_taken`.
- Mọi truy vấn vai trò chạy trong `withCompany`. RLS chặn công ty sửa, xoá vai trò có sẵn và quyền của chúng (`test/integration/access/builtin-role-rls.test.ts`); service vẫn kiểm `builtin_role` trước mọi câu ghi và chỉ ghi theo id vai trò tuỳ biến đã đọc được.
- **Lỗ còn mở:** `access.member_roles.role_id` vẫn trỏ được tới vai trò tuỳ biến của công ty khác (khoá ngoại bỏ qua RLS). Trước khi gán vai trò, đọc vai trò đó dưới `withCompany` của công ty mình. DB tự chặn sẽ làm ở commerio-backend#62.
- `:id` không phải uuid trả 404 `not_found` như vai trò không tồn tại.

## Cho module khác (`index.ts`)

`BUILTIN_ROLES`, `permissionModule`, `assignRole`, `rolesAndPermissions` (identity, staff dùng); `accessRouter`, `registerAccessOpenApi` (chỉ identity gắn).
