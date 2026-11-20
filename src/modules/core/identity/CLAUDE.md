# Module `identity`

Đăng ký công ty, đăng nhập, phiên làm việc, đổi mật khẩu (UC-PI-01, 03, 04). Hợp đồng API: `Documents/21` mục 2 và mục 10 (V2–V14). Bảng riêng: `core.refresh_tokens`, `core.registrations` (lần đăng ký chờ mã, #459); tài khoản nằm ở `staff`, công ty ở `platform`, vai trò ở `access`.

## Luồng

| API | Việc | Gọi module |
|---|---|---|
| `POST /register` | Bước 1 (#459, `service/registration.ts`): kiểm trần theo email, MST chưa có công ty, băm mật khẩu, lưu `core.registrations`, xếp việc `identity.registration_mail` trong cùng giao dịch; 202 `RegistrationStatus`. Không xét email đã có tài khoản | platform, staff (worker) |
| `POST /register/resend` | Xin mã mới sau 60 giây (`Retry-After`), tối đa 5 thư mỗi lần đăng ký; mã cũ mất hiệu lực, đặt lại bộ đếm sai | |
| `POST /register/verify` | Mã đúng: xoá dòng và `createCompanyWithCeo` trong một giao dịch (lõi gồm Kênh bán, cộng Nhập hàng: `DEFAULT_OPTIONAL_MODULES`), trả phiên gắn công ty mới (`cid`) + cookie refresh, `no-store`; 201 | staff, platform, access, audit |
| `POST /login` | Access token chưa gắn công ty + cookie refresh | staff, platform, access |
| `POST /google` | Như `/login` nhưng bằng ID token Google (`service/google.ts`, #7 [A]): tìm theo `google_sub`, không có thì theo email đã xác minh rồi liên kết (nhật ký cấp tài khoản `update`, `after: { googleLinked: true }`). Không tạo tài khoản | staff, audit |
| `POST /select-company` | Kiểm membership, công ty, cờ khoá rồi cấp token gắn công ty; trả `canSelfApprove`; phiên refresh nhớ công ty | staff, platform, access |
| `POST /refresh` | Xoay vòng refresh token có hạn dùng lại, giữ công ty nếu còn dùng được | staff, platform, access, audit |
| `POST /logout` | Thu hồi cả họ refresh token của cookie, xoá cookie | |
| `GET /me` | Tài khoản và các công ty | staff, platform, access |
| `POST /change-password` | Băm mật khẩu mới, bỏ cờ thư mời, thu hồi mọi refresh token và cấp cookie mới, nhật ký cấp tài khoản, **một transaction** | staff, audit |

## Bất biến

- Mật khẩu băm argon2id (`@node-rs/argon2`). Không trả `passwordHash` ra API, không log mật khẩu, token.
- Sai email hay sai mật khẩu: cùng lỗi 401 `invalid_credentials`, cùng thời gian (email không có vẫn chạy argon2 trên bản băm giả).
- Refresh token: 32 byte ngẫu nhiên, DB chỉ lưu SHA-256, sống 30 ngày, cookie `commerio_refresh` (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/identity`). Mỗi lần refresh cấp token mới cùng họ (`family_id`, một lần đăng nhập một họ) và đánh dấu token cũ `rotated_at` (migration 0018).
- Hạn dùng lại (RFC 9700 §4.14.2, kiểu "reuse interval" của Auth0): token đã xoay vòng trong `REFRESH_REUSE_GRACE_SECONDS` (mặc định 30 s) vẫn đổi được, ra token mới cùng họ, để F5 hai lần hay nhiều tab refresh cùng lúc không bị đăng xuất. Hai refresh cùng cookie xếp hàng bằng `SELECT … FOR UPDATE` trên dòng token. Quá hạn là dùng lại: thu hồi cả họ (`revoked_at`), nhật ký cấp tài khoản `entity_type = 'core.refresh_tokens'`, `after.reason = 'refresh_token_reuse'`, 401 nhưng không xoá cookie (trình duyệt có thể đang giữ cookie mới hơn). `rotated_at` là xoay vòng (còn hạn dùng lại); `revoked_at` là thu hồi hẳn (đăng xuất cả họ, đổi mật khẩu mọi token, dùng lại), không có hạn dùng lại.
- Access token: JWT EdDSA 15 phút, mang `sub` (tài khoản), `cid` (công ty), `perms` (đã bỏ quyền của phân hệ chưa bật), `pwc` (còn mật khẩu thư mời). Ký và kiểm ở `src/shared/auth/`.
- Còn mật khẩu thư mời: chỉ `me`, `change-password`, `refresh`, `logout` chạy được. Đổi xong, mọi phiên khác mất refresh token (cookie cũ hết hiệu lực); phản hồi đặt cookie mới, FE gọi `refresh` bằng cookie đó để lấy token không còn `pwc`. Mọi access token đã phát trước lần đổi (kể cả của chính phiên vừa đổi) bị 401 ở request kế tiếp: token mang dấu `password_changed_at` (claim `pca`), `authorize`, kênh SSE, `me`, `select-company`, `change-password` so với DB (#62). Token còn `pwc` vẫn ra 403 `password_change_required` trước bước này ở route không cho phép `pwc`.
- Mã số thuế (#459, Documents/21 mục 2.1): `normalizeTaxCode` (`platform/domain/tax-code.ts`) bỏ khoảng trắng, chấm, gạch; nhận 10 số, 12 số, 13 số (lưu `0123456789-001`), sai thì 422 `errors["company.taxCode"]`. Lưu dạng chuẩn, CSDL ép unique `companies_tax_code_unique`; trùng thì 409 `tax_code_taken` theo ô `company.taxCode` (bắt 23505 như `email_taken`). Cột null được: quản trị nền tảng gỡ, hoặc mã cũ sai định dạng/trùng bị migration `*_mst-chuan-hoa-kenh-ban-loi` đặt NULL.
- Đăng ký hai bước (#459, Documents/21 mục 2.1): DB chỉ giữ bản băm mã (`registrationOtpHash`, gắn id lần đăng ký); mã 6 số sống 5 phút, sai 5 lần thì hỏng (đếm sai commit trước khi ném 422 `errors.code`); lần đăng ký sống 30 phút (410 `registration_expired`). Trần theo email đếm trong DB dưới khoá advisory: 3 lần còn hạn, 5 thư mỗi giờ (429). Email đã có tài khoản đi y như email mới ở request; chỉ worker biết, gửi thư "đã có tài khoản" không mã (tối đa một thư mỗi 24 giờ), không ghi mã nên mọi mã đều sai. Việc gửi thư cũ quá 5 phút, hoặc của lần xin trước, bị bỏ. Trùng email, MST lúc nhập mã: xoá dòng, 409. Việc `identity.registration_purge` mỗi giờ xoá dòng tạo quá 24 giờ. Bảng không cấp quyền nào cho `commerio_app`.
- Mã thử e2e: `REGISTRATION_TEST_EMAIL_DOMAIN` + `REGISTRATION_TEST_CODE` đặt cùng nhau, chỉ khi `APP_ENV` là `staging`/`test`, miền đuôi `.test`/`.invalid`/`.example`, mã 6 số; sai thì BE không khởi động (`registrationTestIssues`, `shared/config/env.ts`). Email đúng miền (so nguyên phần sau `@`): worker ghi bản băm của mã thử, không gửi thư; mã thử đi chung đường kiểm (đếm sai, hạn); nhật ký tạo công ty ghi `testRegistration: true`; đăng nhập Google từ chối miền này.
- Không thuộc công ty trả 404 `not_found`; công ty khoá 403 `company_locked`; tài khoản khoá trong công ty 403 `account_locked`.
- `login`, `google`, `register`, `register/resend`, `register/verify` giới hạn `AUTH_RATE_LIMIT` lần mỗi 15 phút cho một IP, mỗi API một bộ đếm riêng; `change-password` giới hạn 5 lần lỗi mỗi 15 phút cho một tài khoản (chặn đoán mật khẩu bằng access token bị lộ). `register/verify` thêm 10 lần mỗi 15 phút cho một `registrationId`. Bộ đếm trong bộ nhớ của từng bản sao; chạy nhiều bản sao thì chuyển sang Redis.

## Cho module khác

- `loadCompanyAccess(accountId, companyId)`: trạng thái công ty, membership, quyền thô (chưa lọc theo phân hệ), phân hệ bật và `passwordChangedAt` của tài khoản (join trong `findMembership`, không thêm truy vấn), đọc thẳng DB. `src/wiring.ts` dùng để dựng `ctx.authorize`; route cần quyền phụ đọc lại kết quả đó bằng `getAccess(res)` (`src/shared/auth/authorize.ts`), không gọi lần hai; token còn hạn mà công ty, tài khoản vừa bị khoá hay vừa mất quyền thì request kế tiếp đã bị chặn.
- Router gắn thêm router của `access` (`/identity/roles`, `/identity/permissions`, #8).

## Đăng nhập Google

- Kiểm ID token bằng JWKS của Google (`createRemoteJWKSet`, một bộ khoá cho cả tiến trình): `iss` là `accounts.google.com`, `aud` là `GOOGLE_CLIENT_ID`, `email_verified === true`. Token sai: 401 `google_token_invalid`; không lấy được khoá hoặc chưa đặt `GOOGLE_CLIENT_ID`: 503 `google_unavailable`.
- Liên kết lần đầu: `UPDATE … WHERE google_sub IS NULL` ngoài `withCompany` (migration 0017). Không trúng dòng thì đọc lại: cùng `sub` coi như đã liên kết; tài khoản đã gắn `sub` khác hoặc `sub` đã gắn tài khoản khác thì 401 `google_account_not_found` (Documents/21 V11).
- Test thay khoá của Google bằng `setGoogleKeySource` (`test/integration/identity/helpers.ts`), không gọi mạng.
- `service/session.ts`: `startSession(account)` dựng phiên chung cho `/login`, `/google`. Metric `auth_login_total{method,result}` (`service/metrics.ts`).
