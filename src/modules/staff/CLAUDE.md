# Module `staff`

Tài khoản, membership (tài khoản thuộc công ty nào), quản lý nhân viên trong công ty (UC-PI-05, #7). Hợp đồng API: `Documents/21` mục 3 (I1, I5), mục 3.1. Vai trò nằm ở `access`, đăng nhập và phiên ở `identity`.

## Bảng

| Bảng | Ghi chú |
|---|---|
| `staff.accounts` | Tài khoản dùng chung mọi công ty, **không RLS**. Email chữ thường, unique; `google_sub` unique. `commerio_app` chỉ SELECT, INSERT (migration 0017): mọi UPDATE (mật khẩu, liên kết Google) chạy ngoài `withCompany` bằng role chủ bảng |
| `staff.memberships` | (công ty, tài khoản) unique; `status` `active`/`suspended` (API gọi `suspended` là `locked`); `version` cho khoá lạc quan. RLS `company_isolation` |

## API (gắn dưới `/api/v1/identity`, router do `identity` gắn sau router của `access`)

| API | Quyền | Việc |
|---|---|---|
| `GET /staff` | `identity.account.view` | Trang `StaffMember`: `search` (họ tên, email, `ILIKE` có thoát `\`, `%`, `_`), `status`, `roleId`, `page`, `pageSize` |
| `PUT /staff/:accountId/roles` | `identity.account.manage` | Thay trọn vai trò theo `version` của membership, nhật ký `update` (`before.roles`, `after.roles`, chỉ id) |
| `POST /staff/:accountId/lock`, `/unlock` | `identity.account.manage` | Đổi `status` theo `version`, nhật ký `update` (`before.status`, `after.status`) |

## Bất biến

- Thứ tự kiểm sau `authorize → validate`: 404 → 403 `protected_account` (đích là CEO hoặc chính mình) → 409 `version_conflict` kèm `current` → 422 `errors.roleIds` → 403 `protected_account` (gán CEO) → 403 `permission_not_held`. Khoá, mở khoá: 404 → `protected_account` → 409 (lệch version hoặc đã ở trạng thái đích).
- `permission_not_held` tính trên quyền của vai trò **được thêm và bị gỡ**, so với quyền thô của người gọi (`getAccess(res)`, D1); vai trò giữ nguyên không tính. Luật thuần ở `domain/member-rules.ts` (`checkRoleGrant`, `isProtectedTarget`), dùng lại khi tạo link mời và duyệt.
- Ghi có điều kiện `WHERE id AND version (AND status)`; không trúng dòng thì đọc lại, 409 kèm bản mới nhất. Hai lần khoá cùng `version`: một 200, một 409.
- Khoá có hiệu lực ngay: `authorize` đọc trạng thái membership từ DB mỗi request (403 `account_locked`). Kênh SSE đang mở đóng chậm nhất khi token hết hạn.
- `accountId` sai dạng, của công ty khác hay không tồn tại: 404 `not_found` (C4, V6).
- Không log email, họ tên; log dùng id.

## Cho module khác (`index.ts`)

- `identity`: `findAccountByEmail`, `findAccountById`, `findAccountByGoogleSub`, `linkGoogleSub`, `createAccount`, `createMembership`, `findMembership`, `membershipsOfAccount`, `updatePassword`; `staffRouter`, `registerStaffOpenApi` (identity gắn).
- Gọi `access` (`findRolesWithPermissions`, `memberRolesOf`, `replaceMemberRoles`, `membershipIdsWithRole`) và `audit`. `access` không gọi `staff`.
