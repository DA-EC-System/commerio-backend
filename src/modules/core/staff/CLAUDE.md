# Module `staff`

Tài khoản, membership (tài khoản thuộc công ty nào), quản lý nhân viên trong công ty (UC-PI-05, #7). Hợp đồng API: `Documents/21` mục 3 (I1, I5), mục 3.1. Vai trò nằm ở `access`, đăng nhập và phiên ở `identity`.

## Bảng

| Bảng | Ghi chú |
|---|---|
| `staff.accounts` | Tài khoản dùng chung mọi công ty, **không RLS**. Email chữ thường, unique; `google_sub` unique. `commerio_app` chỉ SELECT, INSERT (migration 0017): mọi UPDATE (mật khẩu, liên kết Google) chạy ngoài `withCompany` bằng role chủ bảng |
| `staff.memberships` | (công ty, tài khoản) unique; `status` `active`/`suspended` (API gọi `suspended` là `locked`); `version` cho khoá lạc quan. RLS `company_isolation` |
| `staff.invitations` | Lời mời bằng link (#7 [C], D39): `open → claimed → pending → approved \| rejected`, `open \| claimed → revoked` (Admin huỷ; `domain/invitation-machine.ts`), mỗi bước một UPDATE có điều kiện (`repository/invitations.ts`). `id` là `jti` của token link, DB không lưu token. OTP chỉ lưu bản băm (`domain/otp.ts`). CHECK đặt tên `invitations_*`; một yêu cầu `pending` mỗi email mỗi công ty (`invitations_one_pending_per_email`). RLS có `WITH CHECK`; `commerio_app` không DELETE (migration 0019) |

## API (gắn dưới `/api/v1/identity`, router do `identity` gắn sau router của `access`)

| API | Quyền | Việc |
|---|---|---|
| `GET /staff` | `identity.account.view` | Trang `StaffMember`: `search` (họ tên, email, `ILIKE` có thoát `\`, `%`, `_`), `status`, `roleId`, `page`, `pageSize` |
| `PUT /staff/:accountId/roles` | `identity.account.manage` | Thay trọn vai trò theo `version` của membership, nhật ký `update` (`before.roles`, `after.roles`, chỉ id) |
| `POST /staff/:accountId/lock`, `/unlock` | `identity.account.manage` | Đổi `status` theo `version`, nhật ký `update` (`before.status`, `after.status`) |
| `POST /invitations` | `identity.account.manage` | Tạo link `<PUBLIC_WEB_URL>/tham-gia#<token>` (token `invite`, 72 giờ, `jti` = id lời mời, `cid` = công ty), nhật ký `create` trên `staff.invitations` |
| `GET /invitations` | `identity.account.view` | Trang `Invitation`, `status` mặc định `pending`; nhiều trạng thái cách nhau dấu phẩy (`open,claimed`: tab "Link đã tạo") |
| `POST /invitations/:id/approve`, `/reject` | `identity.account.manage` | Duyệt: tạo tài khoản (email mới) hoặc dùng tài khoản đã có, thêm membership, vai trò, nhật ký `create` trên `staff.memberships`. Từ chối: nhật ký `update` trên `staff.invitations`. Cả hai phát `staff.invitation_decided` (thư báo kết quả) |
| `POST /invitations/:id/revoke` | `identity.account.manage` | Huỷ link `open`, `claimed` (kể cả quá hạn) theo `version`: `revoked`, ghi `decided_by`, `decided_at`, xoá OTP, nhật ký `update`. Không còn `open`/`claimed`: 409 `invalid_transition`; lệch version: 409 `version_conflict`; cả hai kèm `current` |
| `POST /join/check`, `/join/otp`, `/join/verify`, `/join/complete` | Công khai, rate limit (`api/join-limits.ts`) | Người được mời: mở link, xin mã (202, worker gửi thư), nhập mã (`registrationToken` 30 phút, `next`), nộp (`pending`) |

## Luồng mời (#7 [C], `service/invitations.ts`, `service/join.ts`)

- `/join/otp` ghi email, họ tên rồi phát `staff.invitation_otp_requested` cùng giao dịch. Consumer `staff-invitation-otp` (`service/otp-consumer.ts`, đăng ký ở `service/background.ts`) sinh mã, lưu bản băm, gửi thư (`service/otp-mail.ts`). Bỏ sự kiện cũ hơn 5 phút, lệch `requestedAt`, lời mời đã đổi hay đã gửi thư. SMTP lỗi tạm thì ném để outbox thử lại; lỗi vĩnh viễn log `error`, không ném (cảnh báo `CommerioMailPermanentFailure`).
- `/join/verify` tăng bộ đếm sai trước khi so mã, commit rồi mới ném 422 `errors.code`. Mã đúng thì link gắn email (`claimed`), rồi mới xét tài khoản: đã là thành viên 409 `already_member`, quản trị nền tảng 422 `errors.email`.
- `/join/complete`: argon2 chạy ngoài giao dịch; tài khoản đã có thì kiểm mật khẩu của nó, không đổi. Chưa tạo tài khoản: chỉ lúc duyệt mới tạo. Nộp xong phát `staff.invitation_submitted` cùng giao dịch.
- Link `revoked` trả 410 `invitation_invalid` ở mọi bước `/join/*` (`isDeadLink` trong `service/join.ts`), như link quá hạn.
- Thư sau bước nộp (`service/decision-consumer.ts`, đăng ký ở `service/background.ts`): consumer `staff-invitation-submitted-mail` gửi một thư tới thành viên `active` có quyền `identity.account.manage` (`activeMemberEmailsWithPermission`, qua `access.membershipIdsWithPermission`; trừ quản trị nền tảng), kèm link `<PUBLIC_WEB_URL>/admin/staff?tab=pending`; consumer `staff-invitation-decided-mail` gửi thư duyệt (link `/login`, mật khẩu đã đặt hay mật khẩu hiện có) hoặc từ chối tới email của lời mời. Đọc dòng lúc gửi, trạng thái đã khác thì bỏ; SMTP lỗi tạm ném để thử lại, lỗi vĩnh viễn log `error`. Mẫu thư ở `service/otp-mail.ts`, `service/decision-mail.ts`, khung HTML ở `service/mail-layout.ts` (mọi chuỗi người dùng gõ qua `escapeHtml`); link FE ở `service/web-links.ts`.
- Duyệt khoá dòng lời mời trước (thứ tự lời mời → tài khoản → membership → vai trò), kiểm lại vai trò theo quyền người duyệt (409 `invitation_outdated` khi vai trò đã bị xoá). Hết hạn link không chặn duyệt.
- Giới hạn theo IP đứng trước `validate`; theo email (băm SHA-256), theo lời mời đứng sau và chỉ tính token đã kiểm chữ ký (`readClaims`, `claimLimiter`), nên token rác kèm email người khác không đốt được bộ đếm của họ. Ngưỡng nhân `JOIN_RATE_LIMIT_SCALE`.
- Metric `otp_requests_total{result}`, `invitation_transitions_total{to}` (`service/metrics.ts`).

## Bất biến

- Thứ tự kiểm sau `authorize → validate`: 404 → 403 `protected_account` (đích là CEO hoặc chính mình) → 409 `version_conflict` kèm `current` → 422 `errors.roleIds` → 403 `protected_account` (gán CEO) → 403 `permission_not_held`. Khoá, mở khoá: 404 → `protected_account` → 409 `invalid_transition` (đã ở trạng thái đích) → 409 `version_conflict`.
- Lời mời và nhân viên sai trạng thái kiểm **trước** version (#353, Documents/21 mục 3.1): duyệt, từ chối lời mời không còn `pending`, huỷ link không còn `open`/`claimed`, khoá người đang khoá → 409 `invalid_transition` kèm `current` (`Invitation` hoặc `StaffMember`), câu báo theo trạng thái hiện tại. Bên thua cuộc đua duyệt (chờ khoá dòng) nhận `invalid_transition`; hai lần khoá cùng version thì bên thua trượt ở UPDATE có điều kiện, nhận `version_conflict`.
- `permission_not_held` tính trên quyền của vai trò **được thêm và bị gỡ**, so với quyền thô của người gọi (`getAccess(res)`, D1); vai trò giữ nguyên không tính. Vai có sẵn Sale, Nhân viên kho (`freelyAssignable` do `access` gắn) không tính: ai có `identity.account.manage` cũng gán, gỡ được (Documents/21 I5, #351); vai Admin và vai tự tạo vẫn tính. Luật thuần ở `domain/member-rules.ts` (`checkRoleGrant`, `isProtectedTarget`), dùng lại khi tạo link mời và duyệt.
- Ghi có điều kiện `WHERE id AND version (AND status)`; không trúng dòng thì đọc lại, 409 kèm bản mới nhất. Hai lần khoá cùng `version`: một 200, một 409.
- Khoá có hiệu lực ngay: `authorize` đọc trạng thái membership từ DB mỗi request (403 `account_locked`). Kênh SSE đang mở đóng chậm nhất khi token hết hạn.
- `accountId` sai dạng, của công ty khác hay không tồn tại: 404 `not_found` (C4, V6).
- Không log email, họ tên; log dùng id.
- `/join/*` không trả 401 (FE coi 401 là hết phiên): lỗi là 409, 410, 422 hoặc 429.
- Lời mời: không log, không trả mã OTP, token link, token đăng ký, mật khẩu băm; nhật ký chỉ ghi id.

## Cho module khác (`index.ts`)

- `identity`: `findAccountByEmail`, `findAccountById`, `findAccountByGoogleSub`, `linkGoogleSub`, `createAccount`, `createMembership`, `findMembership`, `membershipsOfAccount`, `updatePassword`; `staffRouter`, `registerStaffOpenApi` (identity gắn).
- Mọi module vòng đời: `canSelfApprove(accountId)` (CEO, hoặc khách thuê chỉ một thành viên `active`), `getStatusHistory(entityType, entityId)` (lịch sử của `platform` kèm họ tên người làm), xem `src/modules/CLAUDE.md` mục Máy trạng thái.
- Trong module: `activeMemberEmailsWithPermission(code)` (thư báo người duyệt lời mời).
- `channel` (#312): `activeMemberEmailsWithRoles(roleIds)` email thành viên `active` có một trong các vai trò, trừ quản trị nền tảng, trong `withCompany` (`service/recipients.ts`).
- Gọi `access` (`findRolesWithPermissions`, `memberRolesOf`, `replaceMemberRoles`, `membershipIdsWithRole`, `membershipIdsWithPermission`), `platform` (`listTransitions`) và `audit`. `access` không gọi `staff`.
