# Spec: Đăng nhập Google, quản lý nhân viên, mời bằng link, xác thực hai lớp

- **Ngày:** 21/10/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#7 và thảo luận 20–21/10/2026
- **Trạng thái:** đã duyệt (Khang, 21/10/2026). Thành chốt phần tài liệu 21/10/2026 (Documents#4), kèm một thay đổi: mã khôi phục giảm từ 10 xuống 2
- **Thay cho:** phần "mời nhân viên kèm mật khẩu tạm" của #7 bản 16/10

Spec gồm bốn phần, ký hiệu dùng xuyên suốt:

| Ký hiệu | Phần | Ghi chú |
|---|---|---|
| **[A]** | Đăng nhập Google cho tài khoản đã có | Giữ để đáp ứng "xác thực OAuth2/JWT" của đề bài |
| **[B]** | Quản lý nhân viên: danh sách, đổi vai trò, khoá, mở khoá | UC-PI-05 |
| **[C]** | Mời nhân viên bằng link một lần, OTP, Admin duyệt | UC-PI-05 viết lại |
| **[D]** | Xác thực hai lớp TOTP bắt buộc | Nhóm tự thêm; làm sau cùng, cắt được |

---

## 1. Mục tiêu và tiêu chí thành công

1. Nhân viên đăng nhập được bằng Google vào đúng tài khoản đã có, rồi chọn công ty như đăng nhập mật khẩu. Google không tạo tài khoản.
2. Admin xem, đổi vai trò, khoá, mở khoá nhân viên trong công ty mình; không đụng được CEO và chính mình; không cấp được quyền mình không có.
3. Admin mời nhân viên mới mà **không gửi mật khẩu qua email**: tạo link, gửi tay; người nhận tự xác minh email, tự đặt mật khẩu; Admin duyệt rồi mới có tài khoản.
4. Mọi tài khoản đăng nhập bằng mật khẩu hay Google đều phải nhập mã từ app Authenticator (khi bật [D]).
5. Không lệch đề bài; tài liệu (Documents, Report) và hợp đồng FE khớp với code.

Đo bằng: acceptance criteria ở mục 11 qua hết; `npm run check` xanh; QA (Khoa) nghiệm thu được trên staging.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `develop` (đã kiểm):**
- #4 (đăng ký, đăng nhập, refresh, chọn công ty, đổi mật khẩu) và #8 (`authorize`, `withCompany`, API vai trò) đã merge 18/10.
- Có sẵn: `staff.accounts.google_sub` (unique); `staff.memberships` có `status` (`active`/`suspended`) và `version`; `authorize` đọc trạng thái công ty, membership, quyền từ DB mỗi request; `select-company` chặn `company_locked`, `account_locked`; outbox + Kafka; `assignRole`, `rolesAndPermissions` (access); `recordAudit` (audit).
- Chưa có: router `staff` (rỗng), hạ tầng email, guard cho quản trị nền tảng (router `platform` rỗng).

**Ràng buộc phải giữ:**
- Migration 0017: role `commerio_app` (dùng trong `withCompany`) chỉ SELECT, INSERT `staff.accounts`; mọi UPDATE bảng này chạy bằng role chủ bảng, ngoài `withCompany`.
- Lớp module (`.dependency-cruiser.cjs`): `platform`, `staff`, `access`, `audit`, `files` là lớp nền; `identity` ở trên. `staff` → `access` được, `access` → `staff` cấm. `staff` không import `identity`, `payment`.
- `docs/17` mục 4: email do worker gửi, không gửi trong request HTTP.
- `docs/19` D26 đã bỏ bảng `invitations`; spec này đảo một phần D26 (mục 9).
- Hợp đồng FE–BE ở `Documents/21`: lỗi Problem Details, 422 `validation_failed` với `errors` theo ô, `version_conflict` kèm `current`, bản ghi công ty khác trả 404, phân trang `{ items, total, page, pageSize }`.
- Interceptor của FE gặp 401 thì gọi `refresh` (A8). Các API công khai của luồng mời **không dùng 401** cho lỗi nhập liệu, để không kích interceptor.

## 3. Quyết định đã chốt

| # | Quyết định | Lý do |
|---|---|---|
| Q1 | Bỏ "mời kèm mật khẩu tạm". Admin chọn vai trò, bấm tạo link, tự copy gửi | Không gửi mật khẩu qua email |
| Q2 | Link dùng cho một người, sống 72 giờ | Gửi tay thì người nhận có thể mở muộn |
| Q3 | Người nhận nhập email, họ tên; xác minh bằng OTP 6 số, sống 5 phút, sai tối đa 5 lần, gửi lại sau 60 giây, tối đa 5 lần gửi mỗi link, giới hạn theo IP và email | Link không gắn email; chặn spam, chặn đoán mã |
| Q4 | Email mới: đặt mật khẩu và nhập lại. Email đã có tài khoản: đăng nhập bằng mật khẩu của tài khoản đó, không đặt lại | Tránh biến luồng này thành quên mật khẩu (A7, D26) |
| Q5 | Đã là thành viên: 409 `already_member`. Email quản trị nền tảng: 422 `errors.email` (V15) | |
| Q6 | Admin duyệt hai nút Có/Không. Chỉ khi duyệt mới tạo tài khoản | Không để lại tài khoản thừa; `commerio_app` không xoá được tài khoản |
| Q7 | Lúc duyệt kiểm lại luật vai trò | Quyền Admin có thể đổi từ lúc tạo link |
| Q8 | Không gửi thư báo kết quả duyệt | Nhóm chốt |
| Q9 | Thư OTP do worker gửi qua Gmail SMTP; worker tự sinh mã, chỉ lưu bản băm | Mã không đi qua Kafka |
| Q10 | Giữ đăng nhập Google, chỉ để đăng nhập tài khoản đã có | Đề bài "xác thực OAuth2/JWT" |
| Q11 | 2FA TOTP bắt buộc mọi tài khoản, kể cả CEO và quản trị nền tảng; 2 mã khôi phục (Thành và Khang giảm từ 10, 21/10/2026); quản trị nền tảng reset | Nhóm tự thêm. Admin công ty không reset vì tài khoản dùng chung nhiều công ty |
| Q12 | [D] làm sau cùng, cắt được; bật bằng cờ `TWO_FACTOR_MODE` | Trễ hạn thì P1 vẫn chạy |

Chốt thêm khi viết spec (từ điểm mở của bản thiết kế chi tiết):

| # | Quyết định | Lý do |
|---|---|---|
| Q13 | Link gắn với email ở bước **verify** (OTP đúng), không phải lúc xin mã | Gõ sai email lần đầu không làm hỏng link; muốn chiếm link phải sở hữu email thật |
| Q14 | Kiểm `already_member` và quản trị nền tảng ở `verify` (sau OTP) | `/join/otp` không lộ email nào có tài khoản |
| Q15 | Không thêm mã lỗi cho OTP: sai, hết hạn, hết lượt dùng 422 `errors.code`; vượt giới hạn dùng 429 `too_many_requests` | Ít mã, FE đọc thông điệp |
| Q16 | Sai mật khẩu ở bước tham gia bằng tài khoản đã có: 422 `errors.password` (như `change-password`), không 401 | Không kích interceptor 401 của FE |
| Q17 | `registrationToken` hết hạn: 410 `registration_expired` | FE đưa người dùng về bước nhập OTP; tách khỏi "link hết hạn" |
| Q18 | Tài khoản vừa còn mật khẩu thư mời vừa chưa bật 2FA: `me`, `change-password`, `2fa/setup`, `2fa/confirm`, `refresh`, `logout` cho phép cả hai cờ | Không bế tắc theo thứ tự nào |
| Q19 | Nhật ký liên kết Google dùng `action: update`, `after: { googleLinked: true }` | Enum `audit_action` chỉ có `create`, `update`, `delete` |

## 4. Phạm vi

**Trong phạm vi:** [A], [B], [C], [D] như mục 5–8; hạ tầng email (`src/shared/mail`, Mailpit cho máy dev); guard quản trị nền tảng tối thiểu cho API reset 2FA; tài liệu và báo cáo đi kèm (mục 9, 10).

**Ngoài phạm vi:** thu hồi link chưa dùng; thư báo kết quả duyệt; đăng ký bằng Google; quên mật khẩu; Redis cho bộ đếm rate limit; giao diện FE (Khoa làm ở FE#2, FE#3 theo hợp đồng mới).

## 5. Luồng người dùng

### 5.1 [A] Đăng nhập Google
1. FE lấy `credential` (ID token) bằng Google Identity Services, gọi `POST /identity/google`.
2. BE kiểm token. Tìm tài khoản theo `google_sub`; không có thì theo email đã xác minh. Lần đầu thì lưu `google_sub`.
3. Phản hồi giống `/login`. Người dùng chọn công ty qua `select-company`; công ty hoặc membership bị khoá thì 403 như hiện nay.
4. [D] Tài khoản đã bật 2FA thì phải qua bước nhập mã (5.4).

### 5.2 [B] Quản lý nhân viên
Admin xem danh sách (tìm theo tên, email; lọc theo trạng thái, vai trò), đổi vai trò, khoá, mở khoá. Khoá có hiệu lực ngay với API; kênh SSE đang mở đóng chậm nhất khi token hết hạn (`Documents/21` mục 13.1).

### 5.3 [C] Mời bằng link
```
Admin      POST /identity/invitations { roleIds }        → link <PUBLIC_WEB_URL>/tham-gia#<token>, copy gửi tay
Nhân viên  POST /identity/join/check    { token }          → tên công ty, hạn link
           POST /identity/join/otp      { token, email, fullName }   → 202; worker gửi thư OTP
           POST /identity/join/verify   { token, email, code }       → registrationToken, next
           [D] POST /identity/join/2fa/setup, /join/2fa/confirm      (chỉ next = set_password)
           POST /identity/join/complete { registrationToken, … }     → chờ duyệt
Admin      GET  /identity/invitations?status=pending                  → hàng đợi
           POST /identity/invitations/:id/approve | /reject { version }
```
- `next = set_password`: email chưa có tài khoản → nhập mật khẩu và nhập lại.
- `next = sign_in`: email đã có tài khoản ở công ty khác → nhập mật khẩu của tài khoản đó ([D] kèm mã TOTP nếu đã bật).
- Token đặt sau `#` để không lọt vào log proxy và header `Referer`.

### 5.4 [D] Xác thực hai lớp
- Đã bật: `/login`, `/google` trả `{ mfaRequired: true, mfaToken }`, không cấp phiên. `POST /identity/login/2fa` với `code` hoặc `recoveryCode` → phiên như `/login`.
- Chưa bật: đăng nhập cấp token mang cờ `tfs`; chỉ gọi được các API ở Q18; API khác 403 `two_factor_setup_required`. `POST /identity/2fa/setup` → `{ secret, otpauthUrl }` (FE vẽ QR, hiện secret làm setup key); `POST /identity/2fa/confirm { code }` → 2 mã khôi phục; FE gọi `refresh` để bỏ cờ.
- Mất điện thoại và hết mã khôi phục: quản trị nền tảng gọi `POST /platform/accounts/:accountId/2fa/reset`.

---

## 6. Thiết kế backend

### 6.1 Phân loại và tải (bước 1)
- Endpoint HTTP đồng bộ ở tiến trình `api`; một consumer Kafka (`staff.invitation_otp_requested`) ở `worker`; một tích hợp ra ngoài (Gmail SMTP).
- Tải: demo đồ án, dưới 5 request/giây, vài chục thư mỗi ngày (Gmail giới hạn vài trăm thư/ngày). Staging một bản sao `api`, nên bộ đếm rate limit trong bộ nhớ chấp nhận được; chốt chặn bền nằm ở DB.

### 6.2 Bố cục và ranh giới

| Nơi | Thêm hoặc sửa |
|---|---|
| `shared/crypto/` (mới) | `aes-gcm.ts` (tách từ `payment/service/credentials-cipher.ts`, payment gọi lại), `password.ts` (chuyển `hashPassword`, `verifyPassword` từ identity, identity re-export), `codes.ts` (`randomDigits`, `sha256Hex`, `safeEqualHex`, mã khôi phục), [D] `totp.ts` (RFC 6238 bằng `node:crypto`, không thêm thư viện) |
| `shared/auth/` | `purpose-token.ts` (token mục đích riêng: `invite`, `join`, `mfa`, cùng khoá Ed25519, issuer riêng), `password-policy.ts` (schema Zod mật khẩu dùng chung cho identity và staff, quy tắc A5); [D] sửa `jwt.ts` (claim `tfs`), `authenticate.ts` (`allowTwoFactorSetup`), `authorize.ts` (403 `two_factor_setup_required`); [D] `platform-admin.ts` (guard, nhận loader qua tham số) |
| `shared/mail/` (mới) | `sendMail`, `MailError { kind: 'transient' \| 'permanent' }`, transport nodemailer từ `SMTP_URL`, `setMailTransport` cho test |
| `modules/staff/` | `repository/invitations.ts` (mới), sửa `repository/accounts.ts`, `schema.ts`; `domain/invitation-machine.ts`, `domain/member-rules.ts`, `domain/otp.ts`; `service/members.ts`, `service/invitations.ts`, `service/join.ts`, `service/otp-consumer.ts`, `service/otp-mail.ts`; `api/routes.ts`, `schemas.ts`, `openapi.ts`; `CLAUDE.md` mới |
| `modules/access/` | `findRolesWithPermissions`, `memberRolesOf`, `replaceMemberRoles`, `permissionsNotHeld`, `isCeoRole` |
| `modules/identity/` | `service/google.ts` [A], tách `service/session.ts` (dựng phiên dùng chung cho `/login`, `/google`, `/login/2fa`), [D] `service/two-factor.ts`; route `/google`, [D] `/login/2fa`, `/2fa/setup`, `/2fa/confirm`; gắn `staffRouter(ctx)` sau `accessRouter(ctx)` |
| `modules/platform/` | Sự kiện `staff.invitation_otp_requested` trong `domain/events.ts` (PR riêng); [D] route reset 2FA |
| `wiring.ts` | [D] tiêm `authorizePlatform`, `resetAccountTwoFactor` |

Chiều gọi: identity → staff, access, audit. staff → access, audit, platform (`publishEvent`). access không gọi staff. platform không gọi staff, identity (hàm cần thiết do `wiring.ts` tiêm). Router staff do identity gắn dưới `/identity`, giống `accessRouter`.

### 6.3 Dữ liệu (bước 2)

**Bảng mới `staff.invitations`** (migration 0018, RLS ở 0019):

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | Cũng là `jti` của token link |
| `company_id` | uuid NOT NULL | RLS `company_isolation` |
| `role_ids` | uuid[] NOT NULL | Vai trò chọn lúc tạo link |
| `created_by` | uuid NOT NULL → `staff.accounts` | |
| `expires_at` | timestamptz NOT NULL | `created_at + 72 giờ` |
| `status` | enum `staff.invitation_status` | `open`, `claimed`, `pending`, `approved`, `rejected` |
| `email`, `full_name` | text | Ghi ở `/join/otp`; cố định khi sang `claimed` |
| `account_id` | uuid → `staff.accounts` | Tài khoản đã có (`sign_in`) hoặc tài khoản tạo lúc duyệt |
| `password_hash` | text | Chỉ `set_password`; xoá khi duyệt hoặc từ chối |
| `otp_hash`, `otp_expires_at` | text, timestamptz | `sha256(code + ':' + id)` |
| `otp_attempts` | int NOT NULL DEFAULT 0 | 0..5 |
| `otp_send_count` | int NOT NULL DEFAULT 0 | 0..5 |
| `otp_requested_at` | timestamptz | Cắt về mili giây khi ghi |
| `submitted_at`, `decided_by`, `decided_at` | | |
| `created_at`, `updated_at`, `version` | | Theo `shared/db/columns.ts` |
| [D] `totp_secret_enc`, `totp_confirmed_at`, `recovery_code_hashes` | bytea, timestamptz, text[] | Migration 0020 |

CHECK (đặt tên để service đọc qua `pgError().constraint`):

| Tên | Điều kiện |
|---|---|
| `invitations_role_ids_nonempty` | `cardinality(role_ids) >= 1` |
| `invitations_identity_present` | `status = 'open' OR (email IS NOT NULL AND full_name IS NOT NULL)` |
| `invitations_pending_shape` | `status <> 'pending' OR (submitted_at IS NOT NULL AND ((password_hash IS NOT NULL)::int + (account_id IS NOT NULL)::int) = 1)` |
| `invitations_approved_shape` | `status <> 'approved' OR (account_id IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)` |
| `invitations_rejected_shape` | `status <> 'rejected' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)` |
| `invitations_otp_counters_range` | `otp_attempts BETWEEN 0 AND 5 AND otp_send_count BETWEEN 0 AND 5` |
| `invitations_decided_clean` | `status NOT IN ('approved','rejected') OR (password_hash IS NULL AND otp_hash IS NULL)`; [D] mở rộng thêm `totp_secret_enc IS NULL` |

Index: `(company_id, status, submitted_at DESC NULLS LAST, id)` cho hàng đợi; `(company_id, created_at DESC)` cho danh sách tất cả; unique một phần `(company_id, email) WHERE status = 'pending'` (một yêu cầu chờ duyệt mỗi email mỗi công ty).

RLS (0019, viết theo mẫu `0003_rls.sql`): `ENABLE ROW LEVEL SECURITY`, policy `company_isolation` có `USING` và `WITH CHECK`; `REVOKE DELETE` khỏi `commerio_app` (lời mời không xoá, chỉ đổi trạng thái). Thêm bảng vào `EXPECTED_PRIVILEGES` của `test/integration/shared/rls-coverage.test.ts`.

**[D] Cột mới `staff.accounts`** (0020): `totp_secret_enc bytea` (AES-256-GCM, AAD `totp:<accountId>`), `totp_enabled_at timestamptz`, `totp_last_step bigint`, `recovery_code_hashes text[] NOT NULL DEFAULT '{}'`; CHECK `accounts_totp_enabled_has_secret`: `totp_enabled_at IS NULL OR totp_secret_enc IS NOT NULL`. Các cột này ghi bằng role chủ bảng (0017).

**Bất biến không đặt được bằng CHECK** (service giữ, test kiểm): chuyển trạng thái chỉ theo bảng 6.4; vai trò của lời mời không chứa CEO và nằm trong quyền người duyệt lúc duyệt.

### 6.4 Máy trạng thái lời mời

| Từ | Đến | Điều kiện (nằm trong WHERE của UPDATE) | Kích hoạt |
|---|---|---|---|
| — | `open` | Người gọi có `identity.account.manage`, vai trò hợp lệ | `POST /invitations` |
| `open` | `open` | Còn hạn; `otp_send_count < 5`; đã qua 60 giây từ lần xin trước. Ghi đè `email`, `full_name`, xoá mã cũ | `POST /join/otp` |
| `claimed` | `claimed` | Như trên, và `email` trùng email đã gắn | `POST /join/otp` |
| `open` hoặc `claimed` | `claimed` | Mã đúng, chưa hết hạn, `otp_attempts < 5`, `email` trùng email đã xin mã | `POST /join/verify` |
| `claimed` | `pending` | `email` trùng token đăng ký; còn hạn link; [D] đủ 2FA khi bật. Ghi `submitted_at` và đúng một trong `password_hash`, `account_id` | `POST /join/complete` |
| `pending` | `approved` | `version` trùng; luật vai trò qua lúc duyệt. Hết hạn link không chặn | `POST /invitations/:id/approve` |
| `pending` | `rejected` | `version` trùng | `POST /invitations/:id/reject` |

`approved`, `rejected` là trạng thái cuối. `expired` suy ra từ `expires_at` khi `open`/`claimed`, không lưu. Mọi chuyển trạng thái tăng `version`. Bảng này nằm ở `domain/invitation-machine.ts` để test; câu UPDATE có điều kiện là nguồn sự thật cuối.

### 6.5 Hợp đồng API

Route có quyền: `ctx.authorize` → `validate`. Route công khai: rate limit → `validate`.

**[A]**

| Method, path | Body | Thành công | Lỗi theo thứ tự kiểm |
|---|---|---|---|
| `POST /identity/google` | `{ credential: string 20..4096 }` | 200 như `/login`; [D] `{ mfaRequired, mfaToken }` | 422 → 503 `google_unavailable` (không lấy được khoá của Google, hoặc thiếu `GOOGLE_CLIENT_ID`) → 401 `google_token_invalid` (chữ ký, `iss`, `aud`, hạn, `email_verified !== true`) → 401 `google_account_not_found` (không có tài khoản, hoặc đã gắn `sub` khác) |

**[B]** (`StaffMember = { accountId, email, fullName, roles: {id,name}[], status: 'active'|'locked', isCeo, pendingFirstLogin, joinedAt, version }`; `pendingFirstLogin` = `must_change_password`, `joinedAt`/`version` của membership)

| Method, path | Quyền | Body / query | Thành công | Lỗi theo thứ tự kiểm |
|---|---|---|---|---|
| `GET /identity/staff` | `identity.account.view` | `search` (≤100), `status`, `roleId` (uuid), `page` (≥1, mặc định 1), `pageSize` (1..100, mặc định 20) | 200 `{ items, total, page, pageSize }` | 403, 422 |
| `PUT /identity/staff/:accountId/roles` | `identity.account.manage` | `{ roleIds: uuid[1..20], version }` | 200 `StaffMember` | 404 → 403 `protected_account` (đích là CEO hoặc chính mình) → 409 `version_conflict` + `current` → 422 `errors.roleIds` (không tồn tại, của công ty khác) → 403 `protected_account` (gán CEO) → 403 `permission_not_held` (vai trò thêm hoặc gỡ có quyền ngoài quyền thô của người gọi) |
| `POST /identity/staff/:accountId/lock`, `/unlock` | `identity.account.manage` | `{ version }` | 200 `StaffMember` | 404 → 403 `protected_account` → 409 `version_conflict` (lệch, hoặc đã ở trạng thái đích) |

**[C] phía Admin** (`Invitation = { id, status, expired, email, fullName, roles: {id,name}[], outdated, existingAccount, createdBy: {id, fullName}, createdAt, expiresAt, submittedAt, decidedAt, version }`; `outdated` khi có vai trò đã bị xoá; `existingAccount` không lộ công ty nào)

| Method, path | Quyền | Body / query | Thành công | Lỗi theo thứ tự kiểm |
|---|---|---|---|---|
| `POST /identity/invitations` | `identity.account.manage` | `{ roleIds: uuid[1..20] }` | 201 `{ id, link, expiresAt }`; link chỉ trả lần này, DB không lưu token | 422 `errors.roleIds` → 403 `protected_account` (có CEO) → 403 `permission_not_held` |
| `GET /identity/invitations` | `identity.account.view` | `status` (mặc định `pending`), `page`, `pageSize` | 200 `{ items: Invitation[], total, page, pageSize }` | 403, 422 |
| `POST /identity/invitations/:id/approve` | `identity.account.manage` | `{ version }` | 200 `{ invitation, member: StaffMember }` | 404 → 409 `version_conflict` + `current` (kể cả không còn `pending`) → 409 `invitation_outdated` (vai trò đã bị xoá) → 403 `protected_account` → 403 `permission_not_held` → 409 `already_member` → 409 `email_taken` |
| `POST /identity/invitations/:id/reject` | `identity.account.manage` | `{ version }` | 200 `{ invitation }` | 404 → 409 `version_conflict` |

**[C] phía người được mời** (công khai; token trong body)

| Method, path | Body | Thành công | Lỗi theo thứ tự kiểm |
|---|---|---|---|
| `POST /identity/join/check` | `{ token }` | 200 `{ companyName, expiresAt }` | 410 `invitation_invalid` (sai chữ ký, sai issuer, hết hạn, không còn dòng) → 409 `invitation_used` (đã `pending`, `approved`, `rejected`) |
| `POST /identity/join/otp` | `{ token, email (≤254, chữ thường), fullName (2..100) }` | 202 `{}`, như nhau dù email có tài khoản hay không | 422 → 410 → 409 `invitation_used` (đã gắn email khác, hoặc đã nộp) → 429 `too_many_requests` (chưa qua 60 giây, có `Retry-After`; hết 5 lần gửi; vượt giới hạn IP, email) |
| `POST /identity/join/verify` | `{ token, email, code: 6 chữ số }` | 200 `{ registrationToken, next: 'set_password' \| 'sign_in', twoFactorRequired }` (thêm 21/10/2026, Khang chọn) | 422 → 410 → 409 `invitation_used` → 422 `errors.code` (sai, hết hạn, chưa có mã, đã sai 5 lần thì mã hết hiệu lực) → 409 `already_member` → 422 `errors.email` (quản trị nền tảng) |
| `POST /identity/join/complete` | `{ registrationToken, password, confirmPassword?, totpCode? }` | 200 `{ status: 'pending' }` | 422 (mật khẩu sai quy tắc A5; `confirmPassword` khác khi `set_password`) → 410 `registration_expired` (token đăng ký sai hoặc quá 30 phút) → 410 `invitation_invalid` (link hết hạn) → 422 `errors.password` (sai mật khẩu khi `sign_in`) → [D] 422 `errors.totpCode` → 409 `already_member` → 409 `invitation_used` |
| [D] `POST /identity/join/2fa/setup` | `{ registrationToken }` | 200 `{ secret, otpauthUrl }` | 410 `registration_expired`, 409 `two_factor_disabled` (tắt 2FA), 422 `errors.registrationToken` (`sign_in`), 409 `invitation_used` |
| [D] `POST /identity/join/2fa/confirm` | `{ registrationToken, code }` | 200 `{ recoveryCodes: string[2] }` | 410, 409, 422 `errors.code` |

**[D]**

| Method, path | Xác thực | Body | Thành công | Lỗi |
|---|---|---|---|---|
| `POST /identity/login/2fa` | `mfaToken` | `{ mfaToken, code? \| recoveryCode? }` (đúng một) | 200 như `/login` | 422 → 401 `unauthorized` (mfaToken sai, quá 5 phút) → 429 → 401 `two_factor_invalid` (sai, đã dùng) |
| `POST /identity/2fa/setup` | access token, cho phép cờ `tfs`, `pwc` | — | 200 `{ secret, otpauthUrl }` | 409 `two_factor_already_enabled` |
| `POST /identity/2fa/confirm` | như trên | `{ code }` | 200 `{ recoveryCodes }`, đặt cookie refresh mới, thu hồi phiên cũ | 422 `errors.code`, 409 `two_factor_already_enabled`, 429 |
| `POST /platform/accounts/:accountId/2fa/reset` | quản trị nền tảng | — | 204 (gọi lại vẫn 204) | 401, 403 `forbidden`, 404 |

**Mã lỗi mới** (thêm vào `Documents/21`): `google_unavailable` 503, `invitation_invalid` 410, `invitation_used` 409, `invitation_outdated` 409, `registration_expired` 410, `two_factor_invalid` 401, `two_factor_setup_required` 403, `two_factor_already_enabled` 409. Dùng lại: `google_token_invalid`, `google_account_not_found`, `protected_account`, `permission_not_held`, `already_member`, `email_taken`, `version_conflict`, `too_many_requests`, `forbidden`, `not_found`, `validation_failed`.

### 6.6 Token

| Token | Issuer | Claim | Sống |
|---|---|---|---|
| Link mời | `commerio-invite` | `jti` (id lời mời), `cid` (công ty, để mở `withCompany` trước khi đọc dòng) | 72 giờ |
| Đăng ký | `commerio-join` | `jti`, `cid`, `em` (email đã xác minh), `nxt` | 30 phút |
| [D] MFA | `commerio-mfa` | `sub` (tài khoản) | 5 phút |

Ký bằng khoá Ed25519 sẵn có của access token. `verifyAccessToken` đòi issuer `commerio`, nên token mục đích riêng không dùng nhầm làm access token được, và ngược lại.

### 6.7 Luồng ghi và chạy đồng thời (bước 5)

Ký hiệu: **WC** = `withCompany(cid)` (role `commerio_app`, RLS có hiệu lực); **OWNER** = ngoài `withCompany` (role chủ bảng). Nguyên tắc: bước phải giữ bộ đếm (sai OTP, sai TOTP) thì commit trước rồi mới ném `AppError`, để rollback không xoá bộ đếm.

- **[A] Google (OWNER).** `linkGoogleSub` = `UPDATE staff.accounts SET google_sub = $sub WHERE id = $id AND google_sub IS NULL`. Không trúng dòng thì đọc lại: `sub` trùng (hai request cùng người) coi như đã liên kết; khác thì 401. `23505 accounts_google_sub_unique` → 401 `google_account_not_found`. Liên kết lần đầu ghi nhật ký cấp tài khoản (Q19).
- **[B] Đổi vai trò (WC, một giao dịch).** Đọc membership (RLS) → `protected_account` → so `version` → kiểm vai trò → `UPDATE staff.memberships SET version = version + 1 WHERE id AND version = $v` → `replaceMemberRoles` (xoá rồi chèn trong cùng giao dịch) → nhật ký `update` (`before.roles`, `after.roles`, chỉ id). `23503 member_roles_company_fk` → 422 `errors.roleIds`.
- **[B] Khoá (WC).** `UPDATE staff.memberships SET status = $to, version = version + 1 WHERE id AND version = $v AND status = $from`; không trúng thì đọc lại, 409 kèm `current`. Hiệu lực ngay vì `authorize` đọc DB mỗi request.
- **[C] Tạo link (WC).** Kiểm vai trò → `INSERT staff.invitations` → ký token → nhật ký `create`.
- **[C] Xin OTP (WC, một giao dịch).** `UPDATE … SET email, full_name, otp_requested_at = date_trunc('milliseconds', now()), otp_send_count = otp_send_count + 1, otp_attempts = 0, otp_hash = NULL, version = version + 1 WHERE id AND expires_at > now() AND otp_send_count < 5 AND (status = 'open' OR (status = 'claimed' AND email = $e)) AND (otp_requested_at IS NULL OR otp_requested_at < now() - interval '60 seconds')`. Trúng dòng thì `publishEvent('staff.invitation_otp_requested', { invitationId, requestedAt })` cùng giao dịch. Không trúng thì đọc lại để chọn 410 / 409 / 429. Xoá `otp_hash` làm mã cũ mất hiệu lực ngay.
- **[C] Consumer OTP (worker, WC theo `event.companyId`, cùng giao dịch với `processed_events`).** Bỏ (log, metric `stale`) nếu sự kiện cũ hơn 5 phút. `SELECT … FOR UPDATE`; bỏ nếu không còn dòng, trạng thái ngoài `open`/`claimed`, hoặc `otp_requested_at` khác `requestedAt`. Sinh mã, `UPDATE otp_hash, otp_expires_at = now() + 5 phút`, gửi thư (timeout 10 giây, giữ giao dịch, chấp nhận ở tải này). `MailError` `transient` → ném để outbox thử lại 1 s, 5 s, 30 s rồi DLQ; `permanent` → log `error`, metric, không ném. Gửi xong mà commit lỗi thì lần thử lại gửi mã mới; mã sau cùng có hiệu lực.
- **[C] Verify (WC).** `UPDATE … SET otp_attempts = otp_attempts + 1 WHERE id AND email = $e AND status IN ('open','claimed') AND otp_hash IS NOT NULL AND otp_expires_at > now() AND otp_attempts < 5 RETURNING otp_hash` (tăng bộ đếm nguyên tử, chạy song song không vượt 5). So bằng `timingSafeEqual`. Đúng → `UPDATE … SET status = 'claimed', otp_hash = NULL, otp_expires_at = NULL` (mã dùng một lần). Commit, rồi mới ném lỗi nếu sai. Sau đó đọc tài khoản theo email: quản trị nền tảng → 422; đã là thành viên → 409; có tài khoản → `sign_in`; chưa có → `set_password`. Ký `registrationToken`.
- **[C] Complete.** `hashPassword` hoặc `verifyPassword` chạy **trước** khi mở giao dịch (argon2 chậm; `verifyPassword` chạy cả khi không có tài khoản để cùng thời gian). WC: `UPDATE … SET status = 'pending', submitted_at = now(), password_hash = $h, account_id = $a, version = version + 1 WHERE id AND status = 'claimed' AND email = $em AND expires_at > now()` ([D] thêm `AND totp_confirmed_at IS NOT NULL` cho `set_password` khi `TWO_FACTOR_MODE=required`). Không trúng → đọc lại, 410 hoặc 409. `23505` trên unique pending → 409 `invitation_used`. Không ghi nhật ký (chưa có hành động của Admin).
- **[C] Approve (WC, một giao dịch, thứ tự khoá cố định: lời mời → tài khoản → membership → vai trò).** `SELECT … FOR UPDATE` lời mời → 409 nếu không `pending` hoặc lệch `version` → kiểm vai trò lại → nhánh `set_password`: email đã có tài khoản → 409 `email_taken`, chưa có → `INSERT staff.accounts` (`must_change_password = false`, [D] chép secret: giải mã bằng AAD lời mời, mã hoá lại bằng AAD tài khoản) → `INSERT staff.memberships` (`23505` → 409 `already_member`) → `assignRole` từng vai trò (`23503` → 409 `invitation_outdated`) → `UPDATE` lời mời sang `approved`, xoá `password_hash`, OTP, [D] secret → nhật ký `create`. `23505 accounts_email_unique` → 409 `email_taken`.
- **[C] Reject (WC).** `UPDATE … SET status = 'rejected', decided_by, decided_at, xoá dữ liệu nhạy cảm WHERE id AND version = $v AND status = 'pending'` → nhật ký `update`.
- **[D] Login 2FA (OWNER).** Bộ đếm sai theo tài khoản; đủ 5 lần trong 15 phút → 429 trước khi so mã. Giải mã secret, `matchTotp` (±1 bước) → `UPDATE staff.accounts SET totp_last_step = $s WHERE id AND (totp_last_step IS NULL OR totp_last_step < $s)`; không trúng dòng (mã đã dùng) → 401. Mã khôi phục: `UPDATE … SET recovery_code_hashes = array_remove(recovery_code_hashes, $h) WHERE id AND $h = ANY(recovery_code_hashes)`.
- **[D] Setup, confirm (OWNER).** Setup ghi secret khi `totp_enabled_at IS NULL` (gọi lại thì ghi đè bản chưa xác nhận). Confirm: `UPDATE … SET totp_enabled_at = now(), totp_last_step, recovery_code_hashes WHERE id AND totp_enabled_at IS NULL AND totp_secret_enc IS NOT NULL`.
- **[D] Reset (OWNER).** Xoá các cột TOTP, `revokeAllRefreshTokens`, nhật ký cấp nền tảng.

Phát lại và đồng thời:

| Tình huống | Kết quả |
|---|---|
| Bấm duyệt hai lần, hai Admin duyệt cùng lúc, duyệt và từ chối cùng lúc | Một thắng, bên kia 409 `version_conflict` |
| Hai lời mời cùng email mới cùng được duyệt | Một thành công, một 409 `email_taken` |
| Hai `complete` cùng token đăng ký | Một 200, một 409 `invitation_used` |
| Nhiều `verify` song song | `otp_attempts` không vượt 5; mã đúng chỉ dùng được một lần |
| Hai `lock` cùng `version` | Một 200, một 409 |
| Hai lần liên kết Google với hai `sub` khác nhau | Đúng một thắng |
| Sự kiện OTP giao lại, lệch thứ tự | `processed_events` chặn trùng; so `requestedAt` bỏ sự kiện cũ |
| [D] Hai lần dùng cùng mã TOTP hoặc cùng mã khôi phục | Một thành công |
| Tạo link hai lần | Hai link độc lập, vô hại; không cần khoá chống lặp |

### 6.8 Email
- `src/shared/mail/`: nodemailer (thư viện mới, ghi vào bảng thư viện `docs/17`). Biến môi trường `SMTP_URL`, `MAIL_FROM`.
- Staging: Gmail, `smtps://<địa chỉ Gmail>:<App Password>@smtp.gmail.com:465`. App Password chỉ tạo được khi tài khoản Gmail đã bật xác minh 2 bước. `MAIL_FROM` là chính địa chỉ đó. Không commit `SMTP_URL`.
- Máy dev: Mailpit trong `deploy/compose.yaml`. Test: transport giả qua `setMailTransport`.
- Phân loại lỗi: lỗi kết nối, timeout, mã SMTP 4xx → `transient`; mã 5xx, lỗi xác thực SMTP → `permanent`. Không chép phản hồi SMTP vào lỗi (có thể chứa địa chỉ).
- Thư OTP (`service/otp-mail.ts`): tiếng Việt, có họ tên, tên công ty, mã, hạn 5 phút; không có link.

### 6.9 Lỗi và bảo mật (bước 3)

| Rủi ro | Chặn bằng |
|---|---|
| Dùng link để spam email bất kỳ | Giới hạn IP, email, link (6.11); trần 5 lần gửi mỗi link ở DB |
| Đoán OTP | 5 lần sai mỗi mã, mã sống 5 phút, tối đa 5 mã mỗi link: tối đa 25 lần đoán trên 1 triệu khả năng |
| Dò email nào có tài khoản | `/join/otp` trả như nhau; trạng thái tài khoản chỉ lộ sau khi qua OTP |
| Dùng nhầm token | Issuer riêng cho từng loại token |
| Token lọt log | Token link sau `#`; không log body; thêm `body.credential`, `body.token`, `body.registrationToken`, `body.code`, `body.password` vào `redact` phòng khi log body |
| So mã theo thời gian | `timingSafeEqual`; `verifyPassword` chạy bản băm giả khi không có tài khoản |
| Google không trả khoá | 503 `google_unavailable`, phân biệt với token sai |
| Lộ secret 2FA khi lộ DB | AES-256-GCM với `TOTP_ENCRYPTION_KEY` riêng; mã khôi phục chỉ lưu băm |
| Hết hạn mức Gmail | Lỗi `permanent`, metric và cảnh báo; người dùng xin mã lại sau |
| Ai đó cầm link chiếm trước bằng email của chính họ | Phải qua OTP của email đó; Admin thấy email lạ trong hàng đợi thì từ chối và tạo link khác |

Không log: email, họ tên, mã OTP, token, mật khẩu, secret. Log dùng id.

### 6.10 Phân quyền (bước 4)

| Thao tác | Ai | Kiểm ở đâu |
|---|---|---|
| `/google`, `/join/*` | Công khai, có rate limit | Người cầm token link chỉ chạm một lời mời của một công ty (`withCompany(cid)` + RLS); token đăng ký giới hạn ở lời mời đó và email đã xác minh |
| `GET /staff`, `GET /invitations` | `identity.account.view` trong công ty của token | `ctx.authorize` + RLS |
| Ghi nhân viên, tạo link, duyệt | `identity.account.manage` + luật domain (`protected_account`, `permission_not_held` so quyền thô `getAccess(res)`) | `ctx.authorize` + `domain/member-rules.ts` |
| `/2fa/setup`, `/2fa/confirm` | Chính tài khoản đó | `authenticate` |
| Reset 2FA | Quản trị nền tảng | Guard đọc `is_platform_admin` từ DB mỗi request (không tin claim) |
| Consumer OTP | Sự kiện topic `staff` | Handler chạy trong `withCompany(event.companyId)` |

### 6.11 Rate limit
`express-rate-limit` trong bộ nhớ như `identity/api/routes.ts`; lỗi 429 `too_many_requests`. Khoá theo email băm SHA-256 để không giữ email trong bộ đếm. Ngưỡng đọc từ env để test chỉnh được.

| Endpoint | Khoá | Ngưỡng |
|---|---|---|
| `/google` | IP | `AUTH_RATE_LIMIT` / 15 phút (dùng chung `authLimiter`) |
| `/join/check` | IP | 60 / 15 phút |
| `/join/otp` | IP; email; id lời mời | 10 / 15 phút; 5 / giờ; 6 / giờ |
| `/join/verify` | IP; id lời mời | 30 / 15 phút; 10 / 15 phút |
| `/join/complete` | IP; email (chỉ đếm lỗi) | 20 / 15 phút; 5 / 15 phút |
| [D] `/login/2fa` | IP; tài khoản (chỉ đếm lỗi) | `AUTH_RATE_LIMIT` / 15 phút; 5 / 15 phút |
| [D] `/2fa/confirm`, `/join/2fa/confirm` | tài khoản hoặc lời mời (chỉ đếm lỗi) | 5 / 15 phút |

Bộ đếm mất khi khởi động lại và không chia sẻ giữa bản sao; chốt chặn bền (5 lần sai mỗi mã, 5 lần gửi mỗi link, `totp_last_step`) nằm ở DB.

### 6.12 Quan sát (bước 6)

| Metric | Nhãn |
|---|---|
| `auth_login_total` | `method` (`password`, `google`, `mfa`), `result` (`ok`, `invalid`, `not_found`, `unavailable`, `mfa_required`) |
| `otp_requests_total` | `result` (`accepted`, `cooldown`, `limit`, `stale`, `skipped`, `sent`) |
| `mail_send_total` | `template`, `result` (`ok`, `transient`, `permanent`) |
| `mail_send_duration_seconds` | `template` |
| `invitation_transitions_total` | `to` (tăng sau commit) |
| `two_factor_verifications_total` | `result` (`ok`, `invalid`, `replay`, `recovery`, `locked`) |

- Cảnh báo (thêm vào `deploy/monitoring/rules/alerts.yml`): `increase(mail_send_total{result="permanent"}[15m]) > 0`; DLQ của topic `staff` > 0.
- Log pino JSON: `info` ở mỗi chuyển trạng thái lời mời, liên kết Google, đổi vai trò, khoá; `warn` khi sai OTP, dùng mã khôi phục, bị khoá 2FA; `error` khi gửi thư lỗi vĩnh viễn, không lấy được khoá Google. Có `requestId` (pino-http) hoặc `eventId` (consumer).
- Health của worker không phụ thuộc SMTP; lỗi SMTP chỉ thấy qua metric.

### 6.13 Cấu hình

| Biến | Ghi chú |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client loại Web; Authorized JavaScript origins cho máy dev và staging. BE không cần client secret |
| `PUBLIC_WEB_URL` | Đã có; gốc của link mời |
| `SMTP_URL`, `MAIL_FROM` | Gmail ở staging, Mailpit ở máy dev |
| `JOIN_RATE_LIMIT_*` | Ngưỡng 6.11 |
| [D] `TOTP_ENCRYPTION_KEY` | 32 byte base64, kiểm bằng Zod như `PAYMENT_CREDENTIALS_KEY` |
| [D] `TWO_FACTOR_MODE` | `off` (mặc định) hoặc `required`. `off`: không phát cờ `tfs`, không trả `mfaRequired`, `complete` không đòi 2FA |
| [D] `DEMO_TOTP_SECRET` | Secret cố định của tài khoản demo trong seed (dữ liệu giả) |

### 6.14 Test
Theo `test/CLAUDE.md`: file ở `test/`, tên `.test.ts`, import `#src/...ts`, không gọi mạng thật.
- **Unit:** TOTP theo bộ vector RFC 6238; AES-GCM (AAD sai, bản mã hỏng); token mục đích riêng (không qua được `verifyAccessToken` và ngược lại); phân loại lỗi mail; máy trạng thái lời mời; luật `protected_account`, `permission_not_held`; phân loại lỗi `jose` cho Google (khoá tự sinh bằng `createLocalJWKSet`, `vi.useFakeTimers` cho hết hạn).
- **API** (`createApp()`): `authorize` trước `validate` (thiếu quyền ra 403 chứ không 422); 422 theo ô; `/join/otp` trả như nhau; token sai issuer ra 410; [D] cờ `tfs` bị chặn đúng route.
- **Integration** (PostgreSQL thật): CHECK và RLS của `staff.invitations`; luồng đầy đủ `open → claimed → pending → approved` với transport giả; các ca biên ở mục 11; consumer (sự kiện cũ, lệch `requestedAt`, trùng, lỗi tạm và vĩnh viễn); liên kết Google; [D] 2FA.
- **Test chạy đua bắt buộc:** đủ các dòng của bảng ở 6.7.

---

## 7. Thứ tự giao

Chi tiết từng PR nằm trong plan. Tóm tắt:

1. Nền dùng chung: `shared/crypto`, `shared/auth/purpose-token.ts`, `shared/auth/password-policy.ts`, `shared/mail`, env.
2. [A] Đăng nhập Google.
3. [B] Hàm vai trò của access, luật domain, rồi API nhân viên.
4. [C] Migration và repository lời mời; sự kiện và consumer OTP (sửa danh mục sự kiện bằng PR riêng); API Admin; API công khai.
5. [D] Migration TOTP và hàm TOTP; cờ `tfs`, `/2fa/*`, `/login/2fa`; bước 2FA trong luồng mời và guard quản trị nền tảng; seed demo, bật `TWO_FACTOR_MODE=required` ở staging.

[A] và [B] làm được ngay, không phụ thuộc tài liệu mới vì không đổi hợp đồng đã chốt. [C] và [D] chờ `Documents/21`, `docs/19` được chốt (Thành chốt 21/10/2026, Documents#4). Cắt [D] thì không merge phần 5, hoặc để `TWO_FACTOR_MODE=off`.

## 8. Ảnh hưởng tới FE (Khoa)
- FE#2: nút Google gửi `{ credential }` (đã đúng); [D] bước nhập mã sau đăng nhập; màn thiết lập khi gặp `two_factor_setup_required`.
- FE#3: bỏ dialog mời theo email; thêm "Tạo link mời" (chọn vai trò, hiện link để copy) và hàng đợi duyệt Có/Không.
- Trang mới `/tham-gia`: đọc token sau `#`, nhập email và họ tên, nhập OTP, đặt mật khẩu hoặc đăng nhập, [D] thiết lập 2FA (QR từ `otpauthUrl`, setup key, mã khôi phục), báo chờ duyệt. Các API này không trả 401 trừ `/login/2fa`, nên interceptor không cần ngoại lệ mới.
- Mock MSW đổi theo hợp đồng mới.

## 9. Ảnh hưởng tới Documents
- `14-danh-sach-use-case.md`: dòng UC-PI-05; UC mới cho người được mời (đề xuất UC-PI-09 "Tham gia công ty qua link mời", tác nhân "Người được mời") hoặc gộp vào UC-PI-05; Thành chọn tách riêng (21/10/2026); QT-10 thêm mã xác thực hai lớp.
- `17-modular-monolith.md`: bảng thư viện thêm `nodemailer`; bỏ `openid-client` (không làm luồng chuyển hướng, A6).
- `19-mo-hinh-du-lieu.md`: sửa D26; thêm D39 (`staff.invitations`), D40 (cột TOTP).
- `20-ke-hoach-implement.md`: phạm vi #7 và các phần mới.
- `21-hop-dong-api-fe-be.md`: thay I2; thêm mục API mời, tham gia, 2FA; mã lỗi mới (6.5); V10 thêm API được gọi khi chưa bật 2FA; V46 trở đi cho Q1–Q19; A3 ghi body Google `{ credential }`.
- `handoff/`: bản giao cho Khoa.

## 10. Ảnh hưởng tới Report
- `sections/uc/UC-PI-05.tex`: viết lại theo luồng link và duyệt; giữ ngoại lệ đổi vai trò, khoá, CEO, chính mình, công ty khác, vừa bị sửa.
- UC mới (nếu tách): đặc tả người được mời, có các ngoại lệ ở mục 11 (AC-C3 đến AC-C11).
- `sections/uc/UC-PI-03.tex`: thêm bước nhập mã 2FA và các ngoại lệ (mã sai, mã khôi phục, chưa thiết lập).
- `assets/uc/pi.json`, `tong-quat.json`: thêm UC và tác nhân mới (nếu tách), vẽ lại.
- `assets/erd/nen-tang.json`: thêm `staff.invitations`, cột TOTP; sinh lại DBML và SQL vào `Documents/erd/`.
- `sections/thiet-ke.tex`, `cong-nghe.tex`: sửa đoạn tả mời kèm mật khẩu (nếu có); thêm 2FA vào phần bảo mật, `nodemailer` vào công nghệ.

---

## 11. Acceptance criteria

### [A] Đăng nhập Google
- **AC-A1** Tài khoản `a@x.vn` chưa liên kết; ID token hợp lệ (chữ ký, hạn, `aud`, `email_verified = true`) có email đó → 200 cùng dạng `/login`, cookie refresh `HttpOnly; Secure; SameSite=Strict`, lưu `google_sub`, một dòng nhật ký cấp tài khoản.
- **AC-A2** Tài khoản đã liên kết `sub = S`; token có `sub = S`, kể cả email đã đổi → đăng nhập đúng tài khoản; không ghi nhật ký lần nữa.
- **AC-A3** Email không có tài khoản (kể cả đang chờ duyệt) → 401 `google_account_not_found`, số dòng `staff.accounts` không đổi.
- **AC-A4** Tài khoản đã gắn `sub` khác → 401 `google_account_not_found`, `google_sub` giữ nguyên.
- **AC-A5** Token sai chữ ký, hết hạn, sai `aud`, sai `iss`, `email_verified` khác `true` → 401 `google_token_invalid`. Không lấy được khoá của Google → 503 `google_unavailable`.
- **AC-A6** Sau đăng nhập Google, `select-company` vào công ty khoá → 403 `company_locked`; membership khoá → 403 `account_locked`; khoá ở A vẫn vào được B. Tài khoản còn `mustChangePassword` vẫn phải đổi mật khẩu.

### [B] Quản lý nhân viên
- **AC-B1** `GET /identity/staff` với `identity.account.view` → `{ items, total, page, pageSize }` chỉ gồm công ty của token; `search` không phân biệt hoa thường; thiếu quyền 403.
- **AC-B2** Đổi vai trò hợp lệ → 200 `StaffMember` mới, `version` tăng, nhật ký `update` có vai trò trước và sau; request kế tiếp của người đó dùng quyền mới.
- **AC-B3** Vai trò thêm hoặc gỡ có quyền người gọi không có → 403 `permission_not_held`; gán CEO → 403 `protected_account`; `roleIds` rỗng, không tồn tại, của công ty khác → 422 `errors.roleIds`.
- **AC-B4** Đích là CEO hoặc chính người gọi → 403 `protected_account` cho đổi vai trò, khoá, mở khoá.
- **AC-B5** Khoá → `status: locked`, `version` tăng, nhật ký `before.status = active`, `after.status = locked`; request sau đó bằng token cũ của người bị khoá → 403 `account_locked`; `select-company` vào công ty này → 403 `account_locked`. Mở khoá làm ngược lại.
- **AC-B6** `version` lệch hoặc đã ở trạng thái đích → 409 `version_conflict` kèm `current`, không đổi gì, không ghi nhật ký.
- **AC-B7** `accountId` của công ty khác, không tồn tại, không phải uuid → 404; Sale gọi API ghi → 403 `forbidden`.

### [C] Mời bằng link
- **AC-C1** Tạo link với vai trò hợp lệ → 201 `{ id, link, expiresAt }`, link dạng `<PUBLIC_WEB_URL>/tham-gia#<token>`, hạn 72 giờ, dòng `open`, nhật ký `create`.
- **AC-C2** Tạo link có CEO → 403 `protected_account`; có quyền người gọi không có → 403 `permission_not_held`; `roleIds` sai → 422; Sale → 403. Không tạo dòng nào.
- **AC-C3** Token link sai chữ ký, sai issuer (vd dùng access token), hết hạn → 410 `invitation_invalid` ở mọi `/join/*`, không gửi thư.
- **AC-C4** Xin mã hợp lệ → 202; worker gửi đúng một thư có mã 6 số; DB chỉ có bản băm; phản hồi như nhau dù email có tài khoản hay không.
- **AC-C5** Xin lại trong 60 giây, quá 5 lần gửi mỗi link, vượt giới hạn IP hay email → 429, không gửi thư.
- **AC-C6** Mã sai → 422 `errors.code`; sai đến lần 5 hoặc quá 5 phút thì mã hết hiệu lực. Xin mã cho email khác trong lúc `open` thì mã cũ mất hiệu lực.
- **AC-C7** Mã đúng, email chưa có tài khoản → `{ registrationToken, next: 'set_password' }`, lời mời `claimed` với email đó; email khác dùng lại link → 409 `invitation_used`.
- **AC-C8** `complete` với mật khẩu đúng quy tắc và `confirmPassword` trùng → 200 `pending`, mật khẩu băm argon2id, chưa có dòng `staff.accounts` mới; `confirmPassword` khác hoặc mật khẩu sai quy tắc → 422 theo ô.
- **AC-C9** Email đã có tài khoản ở công ty khác → `next: 'sign_in'`; `complete` đúng mật khẩu → `pending`, không đổi mật khẩu; sai → 422 `errors.password`, quá 5 lần trong 15 phút → 429; không phản hồi nào chứa thông tin công ty kia.
- **AC-C10** Email đã là thành viên → 409 `already_member` ở `verify`; email quản trị nền tảng → 422 `errors.email`.
- **AC-C11** Token đăng ký sai hoặc quá 30 phút → 410 `registration_expired`.
- **AC-C12** Hàng đợi `GET /identity/invitations?status=pending` chỉ gồm lời mời của công ty, có `email`, `fullName`, `roles`, `existingAccount`, `submittedAt`, `version`.
- **AC-C13** Duyệt email mới → tạo tài khoản (mật khẩu đã đặt, `must_change_password = false`), membership `active`, đúng vai trò, nhật ký `create`; lời mời `approved`, `password_hash` bị xoá; nhân viên đăng nhập được.
- **AC-C14** Duyệt tài khoản đã có → chỉ thêm membership và vai trò; không tạo tài khoản, không đổi mật khẩu.
- **AC-C15** Từ chối → `rejected`, không tạo gì, nhật ký `update`.
- **AC-C16** Lúc duyệt: vai trò đã bị xoá → 409 `invitation_outdated`; người duyệt thiếu quyền → 403 `permission_not_held`; email đã có tài khoản do đường khác → 409 `email_taken`; đã là thành viên → 409 `already_member`. Không tạo gì.
- **AC-C17** `version` lệch hoặc đã quyết định ở phiên khác → 409 `version_conflict` kèm `current`; hai Admin bấm cùng lúc → một 200, một 409.
- **AC-C18** `:id` của công ty khác, không tồn tại, không phải uuid → 404; Sale duyệt → 403.
- **AC-C19** Thư do worker gửi; SMTP lỗi tạm thì thử lại rồi DLQ; lỗi vĩnh viễn ghi metric, không thử lại; sự kiện cũ hơn 5 phút bị bỏ.
- **AC-C20** Log, nhật ký, phản hồi không chứa mật khẩu, mã OTP, token link, token đăng ký.

### [D] Xác thực hai lớp (khi `TWO_FACTOR_MODE=required`)
- **AC-D1** Tài khoản đã bật đăng nhập đúng mật khẩu → `{ mfaRequired: true, mfaToken }`, không access token, không cookie.
- **AC-D2** `login/2fa` mã đúng → phiên như `/login`; mã sai hoặc đã dùng → 401 `two_factor_invalid`; `mfaToken` sai hoặc quá 5 phút → 401 `unauthorized`.
- **AC-D3** Đăng nhập Google với tài khoản đã bật → cũng `mfaRequired`.
- **AC-D4** Mã khôi phục dùng được một lần.
- **AC-D5** Sai 5 lần trong 15 phút → 429, kể cả mã đúng.
- **AC-D6** Tài khoản chưa bật → token có cờ `tfs`; API ngoài Q18 → 403 `two_factor_setup_required`.
- **AC-D7** `setup` trả `secret` base32 và `otpauthUrl`, DB chỉ giữ bản mã hoá; `confirm` sai → 422 `errors.code`; đúng → 2 mã khôi phục, 2FA bật, `refresh` cho token không còn cờ.
- **AC-D8** Đăng ký qua link (`set_password`) chưa xác nhận 2FA → `complete` 422; duyệt xong tài khoản có 2FA bật sẵn.
- **AC-D9** Tài khoản đã có, đã bật 2FA, tham gia qua link → `complete` thiếu hoặc sai `totpCode` → 422 `errors.totpCode`.
- **AC-D10** Quản trị nền tảng reset → xoá 2FA và mã khôi phục, thu hồi refresh token, lần sau phải thiết lập lại, nhật ký cấp nền tảng; Admin, CEO công ty gọi → 403.
- **AC-D11** `TWO_FACTOR_MODE=off` → mọi luồng [A]–[C] chạy như không có 2FA.

## 12. Rủi ro và điểm còn mở

1. Không thu hồi được link chưa dùng; mất link thì tạo link mới (ngoài phạm vi).
2. Người khác cầm link có thể chiếm trước bằng email của chính họ (sau khi qua OTP), hoặc dùng hết 5 lượt gửi mã; Admin từ chối và tạo link khác. Chấp nhận cho đồ án.
3. Bộ đếm rate limit trong bộ nhớ; chạy nhiều bản sao thì chuyển sang Redis.
4. Giữ giao dịch trong lúc gửi SMTP (tối đa 10 giây) chiếm một kết nối pool của worker; chấp nhận ở tải này.
5. Bật `TWO_FACTOR_MODE=required` trên staging buộc mọi tài khoản hiện có thiết lập ở lần đăng nhập sau: báo trước cả nhóm; tài khoản demo trong seed có secret cố định.
6. Guard quản trị nền tảng làm ở đây, trùng phạm vi với #10 (UC-PI-08): #10 dùng lại guard này.
7. Tên hàm hiện có (`revokeAllRefreshTokens`, schema mật khẩu) đã đối chiếu; chỗ nào lệch `docs/17`, `docs/19` lúc làm thì hỏi trước theo `CLAUDE.md`.
8. Reset 2FA không cắt access token đang dùng (sống tới 15 phút); Khang chọn giữ (21/10/2026). Muốn cắt ngay thì thêm mốc phiên vào tài khoản.
9. Ai biết mật khẩu và thiết lập 2FA trước chủ tài khoản thì giữ tài khoản (lần đầu bật, hoặc sau reset); chủ tài khoản nhờ quản trị nền tảng reset rồi đổi mật khẩu.
