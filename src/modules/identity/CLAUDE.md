# Module `identity`

Đăng ký công ty, đăng nhập, phiên làm việc, đổi mật khẩu (UC-PI-01, 03, 04). Hợp đồng API: `Documents/21` mục 2 và mục 10 (V2–V14). Không có bảng nghiệp vụ riêng ngoài `identity.refresh_tokens`; tài khoản nằm ở `staff`, công ty ở `platform`, vai trò ở `access`.

## Luồng

| API | Việc | Gọi module |
|---|---|---|
| `POST /register` | Công ty, tài khoản CEO, phân hệ, vai trò CEO, nhật ký cấp nền tảng, **một transaction** | staff, platform, access, audit |
| `POST /login` | Access token chưa gắn công ty + cookie refresh | staff, platform, access |
| `POST /google` | Như `/login` nhưng bằng ID token Google (`service/google.ts`, #7 [A]): tìm theo `google_sub`, không có thì theo email đã xác minh rồi liên kết (nhật ký cấp tài khoản `update`, `after: { googleLinked: true }`). Không tạo tài khoản | staff, audit |
| `POST /select-company` | Kiểm membership, công ty, cờ khoá rồi cấp token gắn công ty; phiên refresh nhớ công ty | staff, platform, access |
| `POST /refresh` | Xoay vòng refresh token, giữ công ty nếu còn dùng được | staff, platform, access |
| `POST /logout` | Thu hồi refresh token, xoá cookie | |
| `GET /me` | Tài khoản và các công ty | staff, platform, access |
| `POST /change-password` | Băm mật khẩu mới, bỏ cờ thư mời, thu hồi mọi refresh token và cấp cookie mới, nhật ký cấp tài khoản, **một transaction** | staff, audit |

## Bất biến

- Mật khẩu băm argon2id (`@node-rs/argon2`). Không trả `passwordHash` ra API, không log mật khẩu, token.
- Sai email hay sai mật khẩu: cùng lỗi 401 `invalid_credentials`, cùng thời gian (email không có vẫn chạy argon2 trên bản băm giả).
- Refresh token: 32 byte ngẫu nhiên, DB chỉ lưu SHA-256, sống 30 ngày, cookie `commerio_refresh` (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/identity`). Mỗi lần refresh cấp token mới, token cũ thu hồi.
- Access token: JWT EdDSA 15 phút, mang `sub` (tài khoản), `cid` (công ty), `perms` (đã bỏ quyền của phân hệ chưa bật), `pwc` (còn mật khẩu thư mời). Ký và kiểm ở `src/shared/auth/`.
- Còn mật khẩu thư mời: chỉ `me`, `change-password`, `refresh`, `logout` chạy được. Đổi xong, mọi phiên khác mất refresh token (cookie cũ hết hiệu lực); phản hồi đặt cookie mới, FE gọi `refresh` bằng cookie đó để lấy token không còn `pwc`. Mọi access token đã phát trước lần đổi (kể cả của chính phiên vừa đổi) bị 401 ở request kế tiếp: token mang dấu `password_changed_at` (claim `pca`), `authorize`, kênh SSE, `me`, `select-company`, `change-password` so với DB (#62). Token còn `pwc` vẫn ra 403 `password_change_required` trước bước này ở route không cho phép `pwc`.
- Không thuộc công ty trả 404 `not_found`; công ty khoá 403 `company_locked`; tài khoản khoá trong công ty 403 `account_locked`.
- `login`, `google`, `register` giới hạn `AUTH_RATE_LIMIT` lần mỗi 15 phút cho một IP, mỗi API một bộ đếm riêng; `change-password` giới hạn 5 lần lỗi mỗi 15 phút cho một tài khoản (chặn đoán mật khẩu bằng access token bị lộ). Bộ đếm trong bộ nhớ của từng bản sao; chạy nhiều bản sao thì chuyển sang Redis.

## Cho module khác

- `loadCompanyAccess(accountId, companyId)`: trạng thái công ty, membership, quyền thô (chưa lọc theo phân hệ), phân hệ bật và `passwordChangedAt` của tài khoản (join trong `findMembership`, không thêm truy vấn), đọc thẳng DB. `src/wiring.ts` dùng để dựng `ctx.authorize`; route cần quyền phụ đọc lại kết quả đó bằng `getAccess(res)` (`src/shared/auth/authorize.ts`), không gọi lần hai; token còn hạn mà công ty, tài khoản vừa bị khoá hay vừa mất quyền thì request kế tiếp đã bị chặn.
- Router gắn thêm router của `access` (`/identity/roles`, `/identity/permissions`, #8).

## Đăng nhập Google

- Kiểm ID token bằng JWKS của Google (`createRemoteJWKSet`, một bộ khoá cho cả tiến trình): `iss` là `accounts.google.com`, `aud` là `GOOGLE_CLIENT_ID`, `email_verified === true`. Token sai: 401 `google_token_invalid`; không lấy được khoá hoặc chưa đặt `GOOGLE_CLIENT_ID`: 503 `google_unavailable`.
- Liên kết lần đầu: `UPDATE … WHERE google_sub IS NULL` ngoài `withCompany` (migration 0017). Không trúng dòng thì đọc lại: cùng `sub` coi như đã liên kết; tài khoản đã gắn `sub` khác hoặc `sub` đã gắn tài khoản khác thì 401 `google_account_not_found` (Documents/21 V11).
- Test thay khoá của Google bằng `setGoogleKeySource` (`test/integration/identity/helpers.ts`), không gọi mạng.
- `service/session.ts`: `startSession(account)` dựng phiên chung cho `/login`, `/google`. Metric `auth_login_total{method,result}` (`service/metrics.ts`).
