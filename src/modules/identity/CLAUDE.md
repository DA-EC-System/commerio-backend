# Module `identity`

Đăng ký công ty, đăng nhập, phiên làm việc, đổi mật khẩu (UC-PI-01, 03, 04). Hợp đồng API: `Documents/21` mục 2 và mục 10 (V2–V14). Không có bảng nghiệp vụ riêng ngoài `identity.refresh_tokens`; tài khoản nằm ở `staff`, công ty ở `platform`, vai trò ở `access`.

## Luồng

| API | Việc | Gọi module |
|---|---|---|
| `POST /register` | Công ty, tài khoản CEO, phân hệ, vai trò CEO, nhật ký cấp nền tảng, **một transaction** | staff, platform, access, audit |
| `POST /login` | Access token chưa gắn công ty + cookie refresh | staff, platform, access |
| `POST /select-company` | Kiểm membership, công ty, cờ khoá rồi cấp token gắn công ty; phiên refresh nhớ công ty | staff, platform, access |
| `POST /refresh` | Xoay vòng refresh token, giữ công ty nếu còn dùng được | staff, platform, access |
| `POST /logout` | Thu hồi refresh token, xoá cookie | |
| `GET /me` | Tài khoản và các công ty | staff, platform, access |
| `POST /change-password` | Băm mật khẩu mới, bỏ cờ thư mời, nhật ký cấp tài khoản | staff, audit |

## Bất biến

- Mật khẩu băm argon2id (`@node-rs/argon2`). Không trả `passwordHash` ra API, không log mật khẩu, token.
- Sai email hay sai mật khẩu: cùng lỗi 401 `invalid_credentials`, cùng thời gian (email không có vẫn chạy argon2 trên bản băm giả).
- Refresh token: 32 byte ngẫu nhiên, DB chỉ lưu SHA-256, sống 30 ngày, cookie `commerio_refresh` (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/identity`). Mỗi lần refresh cấp token mới, token cũ thu hồi.
- Access token: JWT EdDSA 15 phút, mang `sub` (tài khoản), `cid` (công ty), `perms` (đã bỏ quyền của phân hệ chưa bật), `pwc` (còn mật khẩu thư mời). Ký và kiểm ở `src/shared/auth/`.
- Còn mật khẩu thư mời: chỉ `me`, `change-password`, `refresh`, `logout` chạy được. Đổi xong, FE gọi `refresh` để lấy token không còn `pwc`.
- Không thuộc công ty trả 404 `not_found`; công ty khoá 403 `company_locked`; tài khoản khoá trong công ty 403 `account_locked`.
- `login`, `register` giới hạn `AUTH_RATE_LIMIT` lần mỗi 15 phút cho một IP (bộ đếm trong bộ nhớ của từng bản sao; chạy nhiều bản sao thì chuyển sang Redis).

## Chưa làm

- Đăng nhập Google: commerio-backend#7.
- Chặn token còn hạn khi công ty hoặc tài khoản vừa bị khoá: #8 (middleware `authorize` kiểm lại trạng thái).
