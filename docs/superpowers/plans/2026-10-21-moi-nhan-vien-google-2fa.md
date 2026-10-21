# Đăng nhập Google, quản lý nhân viên, mời bằng link, 2FA: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Làm trọn bốn phần [A] Google, [B] quản lý nhân viên, [C] mời bằng link, [D] 2FA ở backend, cùng phần sửa tương ứng của Report và Documents, đúng spec đã duyệt.

**Architecture:** Backend theo modular monolith sẵn có: luật thuần ở `domain/`, ghi có điều kiện trong `repository/`, giao dịch ở `service/` (`withCompany` cho dữ liệu công ty, role chủ bảng cho `staff.accounts`), HTTP ở `api/`. Thư OTP đi qua outbox tới consumer trong `worker`. Report sửa đặc tả UC bằng skill `use-case` của repo Report; Documents sửa hợp đồng và quyết định dữ liệu trước khi code [C], [D].

**Tech Stack:** Node.js 24 (chạy thẳng `.ts`), Express 5, TypeScript 6, Zod 4, Drizzle ORM, PostgreSQL 18 + RLS, Kafka qua outbox, `jose`, `@node-rs/argon2`, `nodemailer` (mới), pino, prom-client, Vitest + Testcontainers; LaTeX (`latexmk`), drawio-ai-kit cho Report.

**Spec:** `docs/superpowers/specs/2026-10-21-moi-nhan-vien-google-2fa-design.md` (mục, mã Q, mã AC trong plan này trỏ về spec).

## Global Constraints

- Node 24 chạy thẳng `.ts`; chỉ cú pháp TypeScript xoá được (không `enum`, `namespace`, parameter property); import tương đối có đuôi `.ts`; test import bằng `#src/...ts`.
- Định danh tiếng Anh; comment, thông báo lỗi tiếng Việt. Lỗi nghiệp vụ ném `AppError(status, code, message, extensions?)`; không `res.status(4xx)` trong controller.
- Route có quyền: `ctx.authorize('<mã>')` trước `validate()`; route công khai: rate limit trước `validate()`. Đọc body bằng `validated<typeof Schema>(res, 'body')`.
- Dữ liệu công ty chạy trong `withCompany(companyId, fn)`. Mọi UPDATE `staff.accounts` chạy ngoài `withCompany` (migration 0017).
- Luật lớp: `staff` → `access`, `audit`, `platform` được; `access` → `staff` cấm; `staff` không import `identity`, `payment`. `shared` không biết module.
- Test chỉ ở `test/`, tên `.test.ts`; không gọi mạng thật; đọc `test/CLAUDE.md` trước khi viết test.
- Hằng số chốt: link 72 giờ; token đăng ký 30 phút; `mfaToken` 5 phút; OTP 6 chữ số, sống 5 phút, sai tối đa 5 lần mỗi mã, gửi lại sau 60 giây, tối đa 5 lần gửi mỗi link; sự kiện OTP cũ hơn 5 phút bị bỏ; TOTP SHA-1, 6 số, bước 30 giây, lệch ±1 bước; 10 mã khôi phục; 2FA sai 5 lần trong 15 phút → 429.
- Issuer token: `commerio` (access, có sẵn), `commerio-invite`, `commerio-join`, `commerio-mfa`.
- API công khai `/join/*` không trả 401 (Q16, Q17); chỉ `/google`, `/login/2fa` trả 401.
- Mã lỗi mới, đúng tên: `google_unavailable` 503, `invitation_invalid` 410, `invitation_used` 409, `invitation_outdated` 409, `registration_expired` 410, `two_factor_invalid` 401, `two_factor_setup_required` 403, `two_factor_already_enabled` 409.
- Enum `audit_action` chỉ có `create`, `update`, `delete` (Q19).
- Không log email, họ tên, mã OTP, token, mật khẩu, secret; log dùng id.
- Dùng npm. Backend: nhánh `feature/7-nhan-vien-google-2fa` (đã tạo), PR vào `develop`. Report, Documents: nhánh `khang/7-moi-nhan-vien-2fa` từ `main`, PR vào `main`, người khác duyệt (gói PI là của Thành).
- Commit message theo repo: tiếng Việt không dấu, dòng cuối `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `npm run check` xanh trước mỗi PR backend; `latexmk -pdf main.tex` không lỗi trước mỗi PR Report.

## Review Focus

1. **FE gặp 401 ở luồng tham gia.** Interceptor của FE coi 401 là hết phiên và gọi `refresh`. Mong đợi: mọi lỗi của `/join/*` là 409, 410, 422 hoặc 429. Test ở Task B11 (`không API nào của /join trả 401`).
2. **Email viết hoa hoặc thừa khoảng trắng.** Người dùng gõ ` A@X.vn ` trong khi tài khoản là `a@x.vn`. Mong đợi: chuẩn hoá chữ thường và cắt khoảng trắng, nhận ra tài khoản (`next = sign_in`). Test ở Task B11.
3. **Ký tự `%`, `_` trong ô tìm kiếm nhân viên.** Mong đợi: tìm đúng chuỗi, không thành ký tự đại diện của `ILIKE`. Test ở Task B6.
4. **Duyệt sau khi link đã hết 72 giờ.** Yêu cầu đã `pending` trước lúc hết hạn. Mong đợi: vẫn duyệt được (spec 6.4). Test ở Task B10.
5. **Máy dev chưa đặt `SMTP_URL`.** Mong đợi: worker không sập; consumer ghi lỗi `permanent`, không thử lại vô hạn. Test ở Task B3 và B9.

---

## Thứ tự giữa ba phần

```
Documents T-D1 (hợp đồng, quyết định) ── Thành duyệt ──┬─► Backend B7..B11 ([C])
                                                       ├─► Backend B12..B15 ([D])
                                                       └─► Report T-R1..T-R6
Backend B1..B6 ([nền], [A], [B]) làm ngay, song song với Documents
Report T-R5 (ERD) ghi vào Documents/erd, nên chạy sau khi T-D2 merge
```

---

# Phần 1: Backend (`commerio-backend`)

## Bản đồ file

| File | Trách nhiệm | Task |
|---|---|---|
| `src/shared/crypto/aes-gcm.ts` (mới) | AES-256-GCM chung: phiên bản, iv, tag, AAD | B1 |
| `src/shared/crypto/password.ts` (mới, chuyển từ `identity/service/passwords.ts`) | Băm, so mật khẩu argon2id (bản băm giả khi không có tài khoản) | B1 |
| `src/shared/crypto/codes.ts` (mới) | Số ngẫu nhiên, SHA-256, so an toàn thời gian, mã khôi phục | B1, B12 |
| `src/shared/auth/purpose-token.ts` (mới) | Token mục đích riêng `invite`, `join`, `mfa` | B2 |
| `src/shared/auth/password-policy.ts` (mới) | Schema Zod mật khẩu A5 dùng chung | B2 |
| `src/shared/mail/index.ts`, `transport.ts` (mới) | Gửi thư SMTP, phân loại lỗi, transport giả cho test, metric | B3 |
| `src/modules/identity/service/session.ts` (mới, tách từ `auth-service.ts`) | Dựng phiên sau bước xác thực thứ nhất | B4 |
| `src/modules/identity/service/google.ts` (mới) | Kiểm ID token, tìm và liên kết tài khoản | B4 |
| `src/modules/identity/service/metrics.ts` (mới) | `auth_login_total`, `two_factor_verifications_total` | B4, B13 |
| `src/modules/access/repository/roles.ts`, `index.ts` (sửa) | Đọc vai trò kèm quyền, vai trò của membership, thay vai trò | B5 |
| `src/modules/staff/domain/member-rules.ts` (mới) | Luật CEO, chính mình, vai trò hợp lệ, quyền đủ | B5 |
| `src/modules/staff/repository/accounts.ts` (sửa) | Google sub, danh sách nhân viên, ghi membership có điều kiện, [D] TOTP | B4, B6, B12 |
| `src/modules/staff/service/members.ts` (mới) | Danh sách, đổi vai trò, khoá | B6 |
| `src/modules/staff/api/routes.ts`, `schemas.ts`, `openapi.ts` (sửa) | Router `/staff`, `/invitations`, `/join/*` | B6, B10, B11 |
| `src/modules/staff/repository/schema.ts` (sửa), `repository/invitations.ts` (mới) | Bảng `staff.invitations`, câu ghi có điều kiện | B7 |
| `src/modules/staff/domain/invitation-machine.ts`, `domain/otp.ts` (mới) | Bảng chuyển trạng thái; hằng và luật OTP | B7 |
| `src/modules/platform/domain/events.ts` (sửa, PR riêng) | Sự kiện `staff.invitation_otp_requested` | B8 |
| `src/modules/staff/service/otp-consumer.ts`, `otp-mail.ts`, `metrics.ts` (mới) | Sinh mã, gửi thư; mẫu thư; metric của staff | B9 |
| `src/modules/staff/service/invitations.ts` (mới) | Tạo link, danh sách, duyệt, từ chối | B10 |
| `src/modules/staff/service/join.ts` (mới) | `check`, `otp`, `verify`, `complete`, [D] 2FA lúc đăng ký | B11, B14 |
| `src/shared/crypto/totp.ts` (mới) | RFC 6238 | B12 |
| `src/modules/identity/service/two-factor.ts` (mới) | Setup, confirm, bước nhập mã, reset | B13, B14 |
| `src/shared/auth/jwt.ts`, `authenticate.ts`, `authorize.ts` (sửa) | Cờ `tfs` | B13 |
| `src/shared/auth/platform-admin.ts` (mới), `src/modules/platform/api/routes.ts`, `src/wiring.ts` (sửa) | Guard quản trị nền tảng, API reset | B14 |
| `db/migrations/0018..0020` | Bảng lời mời, RLS, cột TOTP | B7, B12 |
| `db/seed/demo.ts` (sửa) | Tài khoản demo có TOTP | B15 |
| `vitest.config.ts` (sửa) | Env test: `GOOGLE_CLIENT_ID`, `PUBLIC_WEB_URL`, `JOIN_RATE_LIMIT_SCALE`, `TOTP_ENCRYPTION_KEY` | B3, B4, B11, B12 |

Gom PR: B1–B3 (nền) · B4 ([A]) · B5–B6 ([B]) · B7 · B8 (PR riêng danh mục sự kiện) · B9–B11 ([C]) · B12–B15 ([D]).

---

### Task B1: Nền mã hoá dùng chung

**Files:**
- Create: `src/shared/crypto/aes-gcm.ts`, `src/shared/crypto/password.ts`, `src/shared/crypto/codes.ts`
- Modify: `src/modules/payment/service/credentials-cipher.ts` (ruột gọi `aes-gcm.ts`, giữ tên và lỗi `payment_credentials_unreadable`), `src/modules/identity/service/passwords.ts` (chỉ còn re-export từ `shared/crypto/password.ts`), `src/modules/identity/index.ts` (giữ export `hashPassword`, `verifyPassword`)
- Test: `test/unit/shared/crypto/aes-gcm.test.ts`, `test/unit/shared/crypto/codes.test.ts`

**Interfaces:**
- Produces:
  - `encryptBytes(plain: Buffer, aad: string, key: Buffer): Buffer`: `1 byte phiên bản (1) | iv 12 | tag 16 | bản mã`, trùng định dạng payment đang dùng.
  - `decryptBytes(data: Buffer, aad: string, key: Buffer): Buffer`: ném `CipherError` khi sai AAD, sai khoá, hỏng dữ liệu, sai phiên bản.
  - `class CipherError extends Error`.
  - `hashPassword(password: string): Promise<string>`, `verifyPassword(hash: string | null | undefined, password: string): Promise<boolean>` (chữ ký như hiện có).
  - `randomDigits(length: number): string` (dùng `crypto.randomInt`, giữ số 0 đầu), `sha256Hex(input: string): string`, `safeEqualHex(a: string, b: string): boolean` (độ dài khác thì `false`, không ném).

- [ ] **Step 1: Viết test hỏng**

```ts
// test/unit/shared/crypto/aes-gcm.test.ts
it('giải mã lại đúng bản rõ khi cùng AAD', () => {
  const key = randomBytes(32);
  expect(decryptBytes(encryptBytes(Buffer.from('bí mật'), 'totp:a', key), 'totp:a', key).toString()).toBe('bí mật');
});
it('AAD khác thì ném CipherError', () => { /* encrypt với 'totp:a', decrypt với 'totp:b' → toThrow(CipherError) */ });
it('bản mã bị sửa một byte thì ném CipherError', () => { /* lật byte cuối */ });
it('byte phiên bản khác 1 thì ném CipherError', () => { /* đổi byte 0 thành 2 */ });
it('đọc được bản mã payment đã ghi trước khi tách', () => { /* encryptCredentials(...) rồi decryptBytes cùng AAD, JSON.parse ra đúng ô */ });

// test/unit/shared/crypto/codes.test.ts
it('randomDigits(6) luôn đủ 6 chữ số, kể cả số 0 đầu', () => { /* 1000 lần, mỗi lần match /^\d{6}$/ */ });
it('safeEqualHex trả false khi độ dài khác, không ném', () => { expect(safeEqualHex('ab', 'abcd')).toBe(false); });
```

- [ ] **Step 2: Chạy để thấy hỏng**

Run: `npx vitest run test/unit/shared/crypto`
Expected: FAIL, không tìm thấy module `#src/shared/crypto/aes-gcm.ts`.

- [ ] **Step 3: Viết `aes-gcm.ts`, `password.ts` (chuyển nguyên `identity/service/passwords.ts`), `codes.ts`; sửa payment và identity gọi sang**

- [ ] **Step 4: Chạy test của task và test sẵn có của payment, identity**

Run: `npx vitest run test/unit/shared/crypto test/integration/payment/credentials-unreadable.test.ts test/integration/identity`
Expected: PASS hết.

- [ ] **Step 5: Commit**

```bash
git add src/shared/crypto src/modules/payment/service/credentials-cipher.ts src/modules/identity/service/passwords.ts src/modules/identity/index.ts test/unit/shared/crypto
git commit -m "Tach ma hoa AES-GCM, bam mat khau, ma ngau nhien ra shared/crypto (#7)"
```

### Task B2: Token mục đích riêng, quy tắc mật khẩu dùng chung

**Files:**
- Create: `src/shared/auth/purpose-token.ts`, `src/shared/auth/password-policy.ts`
- Modify: `src/shared/auth/jwt.ts` (export `signingKeys()` thay cho `loadKeys` nội bộ), `src/modules/identity/api/schemas.ts` (`newPassword` lấy từ `password-policy.ts`)
- Test: `test/unit/shared/auth/purpose-token.test.ts`

**Interfaces:**
- Consumes: `signingKeys(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }>` từ `jwt.ts`.
- Produces:
  - `type TokenPurpose = 'invite' | 'join' | 'mfa'`
  - `interface PurposeClaims { jti?: string; sub?: string; cid?: string; em?: string; nxt?: 'set_password' | 'sign_in' }`
  - `PURPOSE_TTL_SECONDS = { invite: 259_200, join: 1_800, mfa: 300 } as const`
  - `signPurposeToken(purpose: TokenPurpose, claims: PurposeClaims): Promise<string>`: issuer `commerio-<purpose>`, `exp` theo bảng trên.
  - `verifyPurposeToken(purpose: TokenPurpose, token: string): Promise<PurposeClaims & { exp: number }>`: sai chữ ký, sai issuer, hết hạn thì ném `PurposeTokenError`.
  - `newPasswordSchema` (Zod): giữ nguyên quy tắc và thông báo của `newPassword` hiện tại.

- [ ] **Step 1: Viết test hỏng**

```ts
it('token invite không qua được verifyAccessToken', async () => {
  const token = await signPurposeToken('invite', { jti: ID, cid: ID });
  await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
});
it('access token không qua được verifyPurposeToken("invite")', async () => {
  await expect(verifyPurposeToken('invite', await signAccessToken(base))).rejects.toBeInstanceOf(PurposeTokenError);
});
it('token join không qua được verifyPurposeToken("invite")', async () => { /* ... rejects PurposeTokenError */ });
it('token invite hết hạn sau đúng 72 giờ', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-21T00:00:00Z') });
  const token = await signPurposeToken('invite', { jti: ID, cid: ID });
  vi.setSystemTime(new Date('2026-10-24T00:00:01Z'));
  await expect(verifyPurposeToken('invite', token)).rejects.toBeInstanceOf(PurposeTokenError);
});
```

- [ ] **Step 2: Run `npx vitest run test/unit/shared/auth/purpose-token.test.ts`** → FAIL, module chưa có.
- [ ] **Step 3: Viết hai file, sửa `jwt.ts`, `identity/api/schemas.ts`**
- [ ] **Step 4: Run `npx vitest run test/unit/shared/auth`** → PASS (gồm `jwt.test.ts` sẵn có).
- [ ] **Step 5: Commit** `git commit -m "Token muc dich rieng (invite, join, mfa) va quy tac mat khau dung chung (#7)"`

### Task B3: Gửi thư (`shared/mail`), Mailpit

**Files:**
- Create: `src/shared/mail/index.ts`, `src/shared/mail/transport.ts`
- Modify: `src/shared/config/env.ts` (`SMTP_URL: z.url().optional()`, `MAIL_FROM: z.string().min(3).optional()`), `.env.example` (mẫu Gmail và Mailpit, ghi chú App Password), `deploy/compose.yaml` (dịch vụ `mailpit`, ảnh `axllent/mailpit` ghim đúng một tag phiên bản có thật trên Docker Hub lúc làm, không dùng `latest`; cổng 1025 SMTP và 8025 giao diện xem thư), `package.json` (`nodemailer`, `@types/nodemailer`), `src/shared/CLAUDE.md` (dòng `mail/`)
- Test: `test/unit/shared/mail/mail.test.ts`

**Interfaces:**
- Produces:
  - `interface MailMessage { to: string; subject: string; text: string }`
  - `class MailError extends Error { readonly kind: 'transient' | 'permanent' }`
  - `type MailTransport = { sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown> }`
  - `sendMail(message: MailMessage, template: string): Promise<void>`: timeout 10 giây; ghi `mail_send_total{template,result}`, `mail_send_duration_seconds{template}`.
  - `setMailTransport(transport: MailTransport | null): void` (test).
  - `classifyMailError(err: unknown): 'transient' | 'permanent'`: `ECONNECTION`, `ETIMEDOUT`, `ESOCKET`, `EDNS`, `responseCode` 400–499 → `transient`; `responseCode` ≥ 500, `EAUTH` → `permanent`; còn lại → `transient`.

- [ ] **Step 1: Viết test hỏng**

```ts
it.each([
  [{ code: 'ECONNECTION' }, 'transient'], [{ code: 'ETIMEDOUT' }, 'transient'],
  [{ responseCode: 421 }, 'transient'], [{ responseCode: 550 }, 'permanent'], [{ code: 'EAUTH' }, 'permanent'],
])('phân loại lỗi SMTP %o là %s', (err, kind) => expect(classifyMailError(err)).toBe(kind));
it('gửi qua transport đã đặt, from là MAIL_FROM', async () => { /* setMailTransport(fake); sendMail(...); fake nhận đúng to, subject */ });
it('chưa đặt SMTP_URL và không có transport giả thì ném MailError permanent', async () => {
  setMailTransport(null);
  await expect(sendMail(msg, 'test')).rejects.toMatchObject({ kind: 'permanent' });
});
it('MailError không chép phản hồi SMTP vào message', async () => { /* fake ném { responseCode: 550, response: '550 a@x.vn ...' } → message không chứa 'a@x.vn' */ });
```

- [ ] **Step 2: Run `npx vitest run test/unit/shared/mail`** → FAIL.
- [ ] **Step 3: Viết `mail`, sửa env, compose, `.env.example`; `npm install nodemailer @types/nodemailer`**
- [ ] **Step 4: Run `npx vitest run test/unit/shared/mail && docker compose -f deploy/compose.yaml config -q`** → PASS, compose hợp lệ.
- [ ] **Step 5: Commit** `git commit -m "Gui thu qua SMTP (nodemailer), Mailpit cho may dev (#7)"`

**Cuối B1–B3:** `npm run check` → xanh. Mở PR "Nền cho #7: shared/crypto, token mục đích riêng, gửi thư" vào `develop`.

---

### Task B4: [A] Đăng nhập Google

**Files:**
- Create: `src/modules/identity/service/google.ts`, `src/modules/identity/service/session.ts`, `src/modules/identity/service/metrics.ts`
- Modify: `src/modules/identity/service/auth-service.ts` (`login` dùng `startSession`), `src/modules/identity/api/routes.ts` (`POST /google`, `authLimiter()`), `src/modules/identity/api/schemas.ts` (`GoogleLoginBody`), `src/modules/identity/api/openapi.ts`, `src/modules/staff/repository/accounts.ts`, `src/modules/staff/index.ts`, `src/shared/config/env.ts` (`GOOGLE_CLIENT_ID: z.string().min(1).optional()`), `.env.example`, `vitest.config.ts` (env `GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com'`), `src/modules/identity/CLAUDE.md` (bỏ "Chưa làm: Google", thêm luồng `/google`), `README.md` (cách tạo OAuth client ID loại Web, Authorized JavaScript origins)
- Test: `test/unit/modules/identity/service/google.test.ts`, `test/integration/identity/google-login.test.ts`

**Interfaces:**
- Consumes: `findAccountByEmail` (có sẵn), `recordAudit` (có sẵn).
- Produces:
  - staff: `findAccountByGoogleSub(sub: string): Promise<AccountRow | undefined>`; `linkGoogleSub(accountId: string, sub: string): Promise<boolean>` (`UPDATE … WHERE id = $1 AND google_sub IS NULL`, `true` khi trúng dòng); `AccountRow` thêm `googleSub: string | null`.
  - identity: `verifyGoogleCredential(credential: string): Promise<{ sub: string; email: string }>` (401 `google_token_invalid`, 503 `google_unavailable`); `setGoogleKeySource(source: JWTVerifyGetKey | null): void` (test); `loginWithGoogle(credential: string): Promise<LoginResult>`.
  - `startSession(account: AccountRow): Promise<LoginResult>`, với `LoginResult = { accessToken: string; refreshToken: string; account: AccountView; memberships: MembershipView[] }`.
  - Metric `auth_login_total{method: 'password' | 'google' | 'mfa', result: 'ok' | 'invalid' | 'not_found' | 'unavailable' | 'mfa_required'}`.

- [ ] **Step 1: Viết test unit hỏng** (khoá tự sinh, `createLocalJWKSet`, ký RS256 bằng `SignJWT`)

```ts
it('token hợp lệ trả sub và email chữ thường', async () => { expect(await verifyGoogleCredential(sign({ email: 'A@X.vn' }))).toEqual({ sub: 'g-1', email: 'a@x.vn' }); });
it.each([
  ['sai aud', { aud: 'khac' }], ['sai iss', { iss: 'https://evil.example' }],
  ['email_verified false', { email_verified: false }], ['hết hạn', { exp: past }],
])('%s → 401 google_token_invalid', async (_n, claims) => {
  await expect(verifyGoogleCredential(sign(claims))).rejects.toMatchObject({ status: 401, code: 'google_token_invalid' });
});
it('không lấy được khoá (JWKSTimeout) → 503 google_unavailable', async () => { /* setGoogleKeySource(() => { throw new errors.JWKSTimeout() }) */ });
```

- [ ] **Step 2: Viết test integration hỏng** (`google-login.test.ts`, dùng `setGoogleKeySource` với khoá tự sinh, `registerCompany`, `addMember`): một `it` cho mỗi AC-A1 đến AC-A6. Ví dụ AC-A1:

```ts
it('AC-A1: liên kết lần đầu theo email, trả như /login, ghi google_sub và một dòng nhật ký', async () => {
  const res = await request(app).post('/api/v1/identity/google').send({ credential: sign({ email, sub: 'g-a1' }) });
  expect(res.status).toBe(200);
  expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'account', 'memberships']);
  expect(refreshCookie(res)).toMatch(/^commerio_refresh=/);
  expect((await db.query('select google_sub from staff.accounts where email = $1', [email])).rows[0].google_sub).toBe('g-a1');
  const log = await db.query("select action, after from audit.audit_logs where entity_type = 'staff.accounts' and entity_id = $1 and company_id is null", [accountId]);
  expect(log.rows).toEqual([{ action: 'update', after: { googleLinked: true } }]);
});
```

Thêm test chạy đua: hai `POST /google` cùng tài khoản với `sub` khác nhau qua `Promise.all` → đúng một 200, một 401 `google_account_not_found`.

- [ ] **Step 3: Run `npx vitest run test/unit/modules/identity test/integration/identity/google-login.test.ts`** → FAIL.
- [ ] **Step 4: Viết `google.ts`, `session.ts`, `metrics.ts`, hàm staff, route, schema, openapi** (thứ tự lỗi theo spec 6.5 [A]; `createRemoteJWKSet` tạo một lần ở mức module).
- [ ] **Step 5: Run lại lệnh Step 3 và `npx vitest run test/integration/identity`** → PASS (gồm `auth.test.ts`, `change-password.test.ts`).
- [ ] **Step 6: Commit** `git commit -m "Dang nhap Google cho tai khoan da co, lien ket theo email da xac minh (#7 A)"`

**Cuối B4:** `npm run check` → xanh. PR "#7 [A] Đăng nhập Google" vào `develop`.

---

### Task B5: [B] Hàm vai trò của access, luật đổi nhân viên

**Files:**
- Modify: `src/modules/access/repository/roles.ts`, `src/modules/access/index.ts`, `src/modules/access/CLAUDE.md` (mục "Cho module khác")
- Create: `src/modules/staff/domain/member-rules.ts`
- Test: `test/unit/modules/staff/domain/member-rules.test.ts`, `test/integration/access/member-roles-api.test.ts`

**Interfaces:**
- Produces (access, chạy trong `withCompany` của bên gọi, `requireCompanyId` ở đầu):
  - `interface RoleWithPermissions { id: string; name: string; isCeo: boolean; permissions: string[] }`
  - `findRolesWithPermissions(roleIds: readonly string[]): Promise<RoleWithPermissions[]>` (vai trò có sẵn và của công ty hiện tại; id không thấy thì không có trong kết quả)
  - `memberRolesOf(membershipIds: readonly string[]): Promise<Map<string, RoleWithPermissions[]>>`
  - `replaceMemberRoles(membershipId: string, companyId: string, roleIds: readonly string[]): Promise<void>` (xoá rồi chèn trong cùng giao dịch)
  - export thêm `lacking` (có sẵn ở `access/domain/roles.ts`: `lacking(required, held)` trả các quyền còn thiếu)
- Produces (staff domain, thuần):
  - `type RoleCheck = 'ok' | 'unknown_roles' | 'ceo_role' | 'not_held'`
  - `checkRoleGrant(input: { requestedIds: readonly string[]; found: readonly RoleWithPermissions[]; currentRoles: readonly RoleWithPermissions[]; callerPermissions: readonly string[] }): RoleCheck`: thứ tự `unknown_roles` → `ceo_role` → `not_held`; `not_held` tính trên quyền của vai trò **thêm và gỡ** (hiệu đối xứng giữa `requestedIds` và `currentRoles`). Tạo link và duyệt gọi với `currentRoles: []`.
  - `isProtectedTarget(input: { callerId: string; targetId: string; targetRoles: readonly RoleWithPermissions[] }): boolean` (chính mình, hoặc mang vai trò CEO)

- [ ] **Step 1: Viết test unit hỏng**

```ts
it('gỡ vai trò có quyền người gọi không có cũng là not_held', () => {
  expect(checkRoleGrant({ requestedIds: [sale.id], found: [sale], currentRoles: [sale, kho], callerPermissions: adminPerms })).toBe('not_held');
});
it('giữ nguyên vai trò mình không đủ quyền thì vẫn ok', () => {
  expect(checkRoleGrant({ requestedIds: [kho.id, sale.id], found: [kho, sale], currentRoles: [kho], callerPermissions: adminPerms })).toBe('ok');
});
it('có vai trò CEO là ceo_role, trước not_held', () => { /* ... */ });
it('id không có trong found là unknown_roles', () => { /* ... */ });
it('đích là chính mình hoặc CEO thì isProtectedTarget', () => { /* hai ca true, một ca false */ });
```

- [ ] **Step 2: Viết test integration hỏng**: `replaceMemberRoles` thay trọn vai trò; `findRolesWithPermissions` không trả vai trò tuỳ biến của công ty khác (dưới `withCompany` của công ty A); gọi ngoài `withCompany` thì ném lỗi lập trình.
- [ ] **Step 3: Run `npx vitest run test/unit/modules/staff test/integration/access`** → FAIL.
- [ ] **Step 4: Viết hàm access, `member-rules.ts`**
- [ ] **Step 5: Run lại** → PASS; `npm run depcruise` → không vi phạm.
- [ ] **Step 6: Commit** `git commit -m "Ham vai tro cho staff va luat doi nhan vien (#7 B)"`

### Task B6: [B] API nhân viên

**Files:**
- Create: `src/modules/staff/service/members.ts`, `src/modules/staff/CLAUDE.md`
- Modify: `src/modules/staff/repository/accounts.ts`, `src/modules/staff/api/routes.ts`, `schemas.ts`, `openapi.ts`, `src/modules/staff/index.ts` (export `staffRouter`, `registerStaffOpenApi`; `staffModule` không còn tự gắn router), `src/modules/identity/api/routes.ts` (gắn `staffRouter(ctx)` sau `accessRouter(ctx)`), `src/modules/identity/api/openapi.ts` (gọi `registerStaffOpenApi`)
- Test: `test/integration/staff/members.test.ts`, `test/api/staff.test.ts`

**Interfaces:**
- Consumes: B5 (toàn bộ), `getAccess(res)`, `recordAudit`.
- Produces:
  - repository: `findMemberByAccount(accountId: string): Promise<MemberRow | undefined>`; `listMembers(query: StaffQuery): Promise<{ rows: MemberRow[]; total: number }>`; `bumpMembershipVersion(id: string, version: number): Promise<boolean>`; `updateMembershipStatus(id: string, version: number, from: 'active' | 'suspended', to: 'active' | 'suspended'): Promise<boolean>`, với `MemberRow = { membershipId, accountId, email, fullName, status, mustChangePassword, joinedAt: Date, version }`.
  - `interface StaffQuery { search?: string; status?: 'active' | 'locked'; roleId?: string; page: number; pageSize: number }`
  - service: `interface Caller { accountId: string; companyId: string; permissions: readonly string[] }`; `listStaff(companyId: string, query: StaffQuery): Promise<Page<StaffMember>>`; `changeRoles(caller: Caller, accountId: string, input: { roleIds: string[]; version: number }): Promise<StaffMember>`; `setLocked(caller: Caller, accountId: string, locked: boolean, version: number): Promise<StaffMember>`.
  - `StaffMember` đúng spec 6.5 [B]; `Page<T> = { items: T[]; total: number; page: number; pageSize: number }`.
  - `staffRouter(ctx: ModuleContext): Router`, `registerStaffOpenApi(registry: OpenAPIRegistry): void`.

- [ ] **Step 1: Viết test integration hỏng**: một `it` cho mỗi AC-B1 đến AC-B7. Thêm:

```ts
it('Review Focus 3: tìm "%" và "_" khớp đúng chuỗi, không thành ký tự đại diện', async () => {
  // addMember với họ tên "Nguyễn 50%_Thử" và một người khác tên thường
  const res = await get('/api/v1/identity/staff?search=50%25_', admin.token);
  expect(res.body.items.map((m) => m.fullName)).toEqual(['Nguyễn 50%_Thử']);
});
it('hai lần khoá cùng version chạy song song: một 200, một 409', async () => {
  const [a, b] = await Promise.all([lock(target, 1), lock(target, 1)]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
});
it('AC-B6: 409 kèm current là StaffMember mới nhất, không ghi nhật ký', async () => { /* đếm audit trước và sau */ });
```

- [ ] **Step 2: Viết test API hỏng**: Sale gọi `PUT /identity/staff/x/roles` với body sai → 403 (authorize trước validate); `accountId` không phải uuid → 404.
- [ ] **Step 3: Run `npx vitest run test/integration/staff/members.test.ts test/api/staff.test.ts`** → FAIL.
- [ ] **Step 4: Viết repository, service, router, schema, openapi, `staff/CLAUDE.md`** (thứ tự kiểm theo spec 6.5 [B]; `search` thoát `\`, `%`, `_` trước khi đưa vào `ILIKE … ESCAPE '\'`).
- [ ] **Step 5: Run lại, rồi `npm run check`** → PASS, xanh.
- [ ] **Step 6: Commit** `git commit -m "API nhan vien: danh sach, doi vai tro, khoa va mo khoa (#7 B)"`

**Cuối B6:** PR "#7 [B] Quản lý nhân viên" vào `develop`.

---

> **Cổng:** B7 trở đi chờ Thành duyệt T-D1, T-D2 (Phần 3).

### Task B7: [C] Bảng `staff.invitations`, RLS, máy trạng thái

**Files:**
- Modify: `src/modules/staff/repository/schema.ts` (enum `invitationStatus`, bảng `invitations`, CHECK, index theo spec 6.3)
- Create: `db/migrations/0018_thu-moi-link.sql` (`npm run db:generate -- --name thu-moi-link`), `db/migrations/0019_thu-moi-rls.sql` (`npx drizzle-kit generate --custom --name thu-moi-rls`, viết tay theo `0003_rls.sql`: `ENABLE ROW LEVEL SECURITY`, policy `company_isolation` có `USING` và `WITH CHECK`, `REVOKE DELETE ON staff.invitations FROM commerio_app`), `src/modules/staff/repository/invitations.ts`, `src/modules/staff/domain/invitation-machine.ts`, `src/modules/staff/domain/otp.ts`
- Modify: `test/integration/shared/rls-coverage.test.ts` (`'staff.invitations': ['SELECT', 'INSERT', 'UPDATE']` trong `EXPECTED_PRIVILEGES`)
- Test: `test/unit/modules/staff/domain/invitation-machine.test.ts`, `test/unit/modules/staff/domain/otp.test.ts`, `test/integration/staff/invitations-schema.test.ts`

**Interfaces:**
- Produces:
  - domain: `type InvitationStatus = 'open' | 'claimed' | 'pending' | 'approved' | 'rejected'`; `TRANSITIONS: Readonly<Record<InvitationStatus, readonly InvitationStatus[]>>` (đúng bảng spec 6.4); `canTransition(from: InvitationStatus, to: InvitationStatus): boolean`; `isLinkExpired(row: { status: InvitationStatus; expiresAt: Date }, now: Date): boolean` (chỉ `open`, `claimed`).
  - `otp.ts`: `OTP_LENGTH = 6`, `OTP_TTL_SECONDS = 300`, `OTP_MAX_ATTEMPTS = 5`, `OTP_RESEND_SECONDS = 60`, `OTP_MAX_SENDS = 5`, `OTP_EVENT_MAX_AGE_SECONDS = 300`; `otpHash(code: string, invitationId: string): string` (`sha256Hex(code + ':' + invitationId)`); `isStaleOtpEvent(requestedAt: string, now: Date): boolean`.
  - repository (đều dưới `withCompany`, `requireCompanyId` ở đầu):
    - `insertInvitation(input: { companyId: string; roleIds: string[]; createdBy: string }): Promise<InvitationRow>`
    - `findInvitation(id: string, options?: { forUpdate?: boolean }): Promise<InvitationRow | undefined>`
    - `requestOtpWrite(id: string, email: string, fullName: string): Promise<{ otpRequestedAt: Date } | undefined>` (câu UPDATE ở spec 6.7 "Xin OTP")
    - `storeOtpHash(id: string, otpHash: string): Promise<void>`
    - `consumeOtpAttempt(id: string, email: string): Promise<{ otpHash: string } | undefined>`
    - `markClaimed(id: string, email: string): Promise<boolean>`
    - `submitInvitation(id: string, email: string, input: { passwordHash: string | null; accountId: string | null }): Promise<boolean>`
    - `decideInvitation(id: string, version: number, decision: { status: 'approved' | 'rejected'; decidedBy: string; accountId?: string }): Promise<InvitationRow | undefined>`
    - `listInvitationRows(query: { status: InvitationStatus; page: number; pageSize: number }): Promise<{ rows: InvitationRow[]; total: number }>`
  - `InvitationRow` mang mọi cột của spec 6.3 theo camelCase.

- [ ] **Step 1: Viết test unit hỏng**: mọi cặp `(from, to)` trong bảng 6.4 cho `canTransition === true`, mọi cặp còn lại `false` (sinh bằng hai vòng lặp); `isStaleOtpEvent` đúng ở mốc 300 giây và 301 giây.
- [ ] **Step 2: Viết test integration hỏng**: mỗi CHECK của spec 6.3 bị vi phạm bằng INSERT hoặc UPDATE trực tiếp (`testPool()`), lỗi mang đúng tên constraint; công ty B (`withCompany`) không đọc, không sửa được lời mời của A; `commerio_app` DELETE bị từ chối; unique pending: hai dòng `pending` cùng `(company_id, email)` → `23505`.
- [ ] **Step 3: Run `npx vitest run test/unit/modules/staff/domain test/integration/staff/invitations-schema.test.ts test/integration/shared/rls-coverage.test.ts`** → FAIL.
- [ ] **Step 4: Viết schema, sinh 0018, viết tay 0019, repository, domain**
- [ ] **Step 5: Run lại, cộng `npx vitest run test/unit/db/journal.test.ts`** → PASS.
- [ ] **Step 6: Commit** `git commit -m "Bang staff.invitations, RLS, may trang thai loi moi (#7 C)"`

**Cuối B7:** `npm run check`. PR "#7 [C] Bảng lời mời" vào `develop` (review kèm skill `review-migration`).

### Task B8: [C] Sự kiện `staff.invitation_otp_requested` (PR riêng)

**Files:**
- Modify: `src/modules/platform/domain/events.ts` (`'staff.invitation_otp_requested': z.object({ invitationId: id, requestedAt: timestamp })`)
- Test: `test/unit/modules/platform/domain/events.test.ts` (thêm ca)

- [ ] **Step 1: Thêm test hỏng**: payload `{ invitationId: uuid, requestedAt: '2026-10-21T00:00:00.000Z' }` hợp lệ; thiếu `requestedAt` không hợp lệ; `EVENT_TYPES` chứa loại mới.
- [ ] **Step 2: Run `npx vitest run test/unit/modules/platform/domain/events.test.ts`** → FAIL.
- [ ] **Step 3: Thêm loại vào danh mục**
- [ ] **Step 4: Run lại** → PASS.
- [ ] **Step 5: Commit, mở PR riêng, báo Thành** (file dùng chung): `git commit -m "Danh muc su kien: staff.invitation_otp_requested (#7 C)"`

### Task B9: [C] Consumer gửi OTP

**Files:**
- Create: `src/modules/staff/service/otp-consumer.ts`, `src/modules/staff/service/otp-mail.ts`, `src/modules/staff/service/metrics.ts`
- Modify: `src/modules/staff/index.ts` (`startBackground` gọi `registerConsumer('staff.invitation_otp_requested', handleOtpRequested, { consumer: 'staff-invitation-otp' })`), `deploy/monitoring/rules/alerts.yml`, `deploy/monitoring/rules/alerts.test.yml` (cảnh báo `MailPermanentFailure`: `increase(mail_send_total{result="permanent"}[15m]) > 0`)
- Test: `test/unit/modules/staff/service/otp-mail.test.ts`, `test/integration/staff/otp-consumer.test.ts`

**Interfaces:**
- Consumes: B3 `sendMail`, `MailError`; B7 `findInvitation`, `storeOtpHash`, `otpHash`, `isStaleOtpEvent`; `getCompanies` (platform).
- Produces:
  - `handleOtpRequested(event: EventEnvelope): Promise<void>`
  - `renderOtpMail(input: { fullName: string; companyName: string; code: string }): { subject: string; text: string }`: tiếng Việt, có mã, "hết hạn sau 5 phút", không có link.
  - Metric `otp_requests_total{result}`, `invitation_transitions_total{to}`.

- [ ] **Step 1: Viết test hỏng**

```ts
it('gửi đúng một thư có mã 6 số, DB chỉ giữ bản băm của mã đó', async () => {
  const sent = captureMail();                       // setMailTransport(fake ghi lại thư)
  await handleOtpRequested(eventFor(invitation));
  const code = sent[0]!.text.match(/\b\d{6}\b/)![0];
  expect((await row(invitation.id)).otp_hash).toBe(otpHash(code, invitation.id));
});
it('sự kiện cũ hơn 5 phút: không gửi, không đổi DB', async () => { /* occurredAt, requestedAt lùi 301 giây */ });
it('requestedAt không khớp otp_requested_at: bỏ qua', async () => { /* ... */ });
it('lỗi SMTP tạm thời: ném lại để outbox thử lại', async () => { /* fake ném { code: 'ECONNECTION' } → rejects */ });
it('lỗi SMTP vĩnh viễn: không ném, metric permanent tăng', async () => { /* fake ném { responseCode: 550 } → resolves */ });
it('Review Focus 5: chưa đặt SMTP_URL: không ném, ghi permanent', async () => { /* setMailTransport(null) → resolves */ });
it('requestedAt ghi xong đọc lại vẫn bằng nhau tới mili giây', async () => { /* date_trunc('milliseconds') round trip */ });
```

- [ ] **Step 2: Run `npx vitest run test/unit/modules/staff/service test/integration/staff/otp-consumer.test.ts`** → FAIL.
- [ ] **Step 3: Viết consumer, mẫu thư, metric, đăng ký trong `startBackground`, luật cảnh báo**
- [ ] **Step 4: Run lại** → PASS. Run `docker run --rm -v "$PWD/deploy/monitoring:/m" --entrypoint promtool prom/prometheus:v3.5.0 test rules /m/rules/alerts.test.yml` → `SUCCESS`.
- [ ] **Step 5: Commit** `git commit -m "Consumer gui OTP: sinh ma trong worker, chi luu ban bam (#7 C)"`

### Task B10: [C] API Admin cho lời mời

**Files:**
- Create: `src/modules/staff/service/invitations.ts`
- Modify: `src/modules/staff/api/routes.ts`, `schemas.ts`, `openapi.ts`, `src/modules/staff/repository/accounts.ts` (`insertAccount` nhận `mustChangePassword?: boolean`, mặc định `false`), `vitest.config.ts` (env `PUBLIC_WEB_URL: 'https://commerio.test'`)
- Test: `test/integration/staff/invitations-admin.test.ts`

**Interfaces:**
- Consumes: B5 `checkRoleGrant`, `findRolesWithPermissions`, `assignRole`; B6 `StaffMember`, `Caller`, `Page`; B7 repository; B2 `signPurposeToken`.
- Produces:
  - `createInvitation(caller: Caller, roleIds: string[]): Promise<{ id: string; link: string; expiresAt: string }>`: `link = <PUBLIC_WEB_URL>/tham-gia#<token>`.
  - `listInvitations(companyId: string, query: { status: InvitationStatus; page: number; pageSize: number }): Promise<Page<InvitationView>>`, `InvitationView` đúng spec 6.5 [C].
  - `approveInvitation(caller: Caller, id: string, version: number): Promise<{ invitation: InvitationView; member: StaffMember }>`
  - `rejectInvitation(caller: Caller, id: string, version: number): Promise<{ invitation: InvitationView }>`
  - Test helper (trong file test hoặc `test/integration/helpers/invitations.ts`): `pendingInvitation(companyId, options: { email?: string; existingAccountId?: string; roleIds: string[] })` chèn thẳng dòng `pending` bằng `testPool()`.

- [ ] **Step 1: Viết test hỏng**: một `it` cho AC-C1, C2, C12 đến C18. Thêm:

```ts
it('Review Focus 4: link đã quá 72 giờ nhưng yêu cầu đã pending thì vẫn duyệt được', async () => {
  const inv = await pendingInvitation(companyId, { roleIds: [saleId] });
  await db.query("update staff.invitations set expires_at = now() - interval '1 hour' where id = $1", [inv.id]);
  expect((await approve(inv.id, inv.version)).status).toBe(200);
});
it('hai Admin duyệt cùng lúc: một 200, một 409; chỉ một tài khoản, một membership', async () => { /* Promise.all */ });
it('duyệt và từ chối cùng lúc: đúng một bên thắng', async () => { /* Promise.all */ });
it('hai lời mời cùng email mới cùng được duyệt: một 200, một 409 email_taken', async () => { /* Promise.all */ });
```

- [ ] **Step 2: Run `npx vitest run test/integration/staff/invitations-admin.test.ts`** → FAIL.
- [ ] **Step 3: Viết service, route, schema, openapi** (thứ tự khoá và lỗi theo spec 6.5, 6.7 "Approve").
- [ ] **Step 4: Run lại** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Loi moi: tao link, hang doi, duyet va tu choi (#7 C)"`

### Task B11: [C] API công khai `/join/*`

**Files:**
- Create: `src/modules/staff/service/join.ts`
- Modify: `src/modules/staff/api/routes.ts` (bộ giới hạn theo spec 6.11, ngưỡng nhân `env.JOIN_RATE_LIMIT_SCALE`), `schemas.ts`, `openapi.ts`, `src/shared/config/env.ts` (`JOIN_RATE_LIMIT_SCALE: z.coerce.number().positive().default(1)`), `src/shared/logger.ts` (`redact` thêm `req.body.credential`, `req.body.token`, `req.body.registrationToken`, `req.body.code`, `req.body.password`, `req.body.confirmPassword`), `vitest.config.ts` (env `JOIN_RATE_LIMIT_SCALE: '1000'`)
- Test: `test/integration/staff/join-flow.test.ts`, `test/integration/staff/join-edge.test.ts`, `test/api/join.test.ts`, `test/unit/modules/staff/api/join-limits.test.ts`

**Interfaces:**
- Consumes: B2 token, `newPasswordSchema`; B1 `hashPassword`, `verifyPassword`, `safeEqualHex`; B7 repository; B8 sự kiện; `publishEvent` (platform); `findAccountByEmail`, `findMembership` (staff).
- Produces:
  - `checkInvitation(token: string): Promise<{ companyName: string; expiresAt: string }>`
  - `requestOtp(input: { token: string; email: string; fullName: string }): Promise<void>`
  - `verifyOtp(input: { token: string; email: string; code: string }): Promise<{ registrationToken: string; next: 'set_password' | 'sign_in' }>`
  - `completeJoin(input: { registrationToken: string; password: string; confirmPassword?: string; totpCode?: string }): Promise<{ status: 'pending' }>`
  - `joinLimits(scale: number): Record<'check' | 'otpIp' | 'otpEmail' | 'otpInvitation' | 'verifyIp' | 'verifyInvitation' | 'completeIp' | 'completeEmail', { limit: number; windowMs: number }>` (bảng spec 6.11 nhân `scale`).

- [ ] **Step 1: Viết test integration hỏng**: `join-flow.test.ts` đi trọn `open → claimed → pending → approved` qua HTTP với transport thư giả, sau đó nhân viên `login` được bằng mật khẩu đã đặt. `join-edge.test.ts`: một `it` cho AC-C3 đến C11, C19, C20. Thêm:

```ts
it('Review Focus 1: không API nào của /join trả 401', async () => {
  const statuses = await everyJoinErrorCase();            // gọi đủ các ca lỗi của AC-C3..C11
  expect(statuses.filter((s) => s === 401)).toEqual([]);
});
it('Review Focus 2: email " A@X.vn " nhận ra tài khoản a@x.vn (next = sign_in)', async () => { /* ... */ });
it('xin mã cho email khác lúc còn open: mã cũ mất hiệu lực', async () => { /* AC-C6 */ });
it('hai complete cùng registrationToken: một 200, một 409 invitation_used', async () => { /* Promise.all */ });
it('sáu verify sai song song: otp_attempts dừng ở 5, không lỗi CHECK', async () => { /* Promise.all */ });
it('hai verify đúng mã cùng lúc: đúng một nhận registrationToken', async () => { /* Promise.all */ });
```

- [ ] **Step 2: Viết test API hỏng**: `/join/otp` trả `202 {}` như nhau với email có và không có tài khoản; token là access token hay token `join` ở `/join/check` → 410 `invitation_invalid`; 429 có `Retry-After` và đúng dạng Problem Details. Unit: `joinLimits(1)` đúng bảng spec 6.11; `joinLimits(1000).otpIp.limit === 10_000`.
- [ ] **Step 3: Run `npx vitest run test/integration/staff/join-flow.test.ts test/integration/staff/join-edge.test.ts test/api/join.test.ts test/unit/modules/staff/api`** → FAIL.
- [ ] **Step 4: Viết `join.ts`, route, giới hạn, schema, openapi, `redact`** (thứ tự lỗi spec 6.5; bước giữ bộ đếm commit rồi mới ném, spec 6.7).
- [ ] **Step 5: Run lại, rồi `npm run check`** → PASS, xanh.
- [ ] **Step 6: Commit** `git commit -m "Luong tham gia qua link: check, OTP, verify, complete (#7 C)"`

**Cuối B9–B11:** cập nhật `src/modules/staff/CLAUDE.md` (luồng, bất biến, sự kiện, consumer), `.env.example`. PR "#7 [C] Mời nhân viên bằng link" vào `develop`, review kèm `backend-design:security-reviewer`.

---

### Task B12: [D] Nền TOTP: migration, mã RFC 6238, hàm ghi TOTP

**Files:**
- Create: `src/shared/crypto/totp.ts` (tự viết bằng `node:crypto`, không thêm thư viện), `db/migrations/0020_xac-thuc-hai-yeu-to.sql` (`npm run db:generate -- --name xac-thuc-hai-yeu-to`)
- Modify: `src/modules/staff/repository/schema.ts` (cột TOTP của `accounts`, `invitations`; CHECK `accounts_totp_enabled_has_secret`, `invitations_totp_confirmed_has_secret`; mở rộng `invitations_decided_clean`), `src/modules/staff/repository/accounts.ts`, `src/modules/staff/index.ts`, `src/shared/crypto/codes.ts`, `src/shared/config/env.ts` (`TOTP_ENCRYPTION_KEY` kiểm 32 byte base64 như `PAYMENT_CREDENTIALS_KEY`; `TWO_FACTOR_MODE: z.enum(['off', 'required']).default('off')`), `.env.example`, `vitest.config.ts` (env `TOTP_ENCRYPTION_KEY` là 32 byte base64 cố định cho test)
- Test: `test/unit/shared/crypto/totp.test.ts`, `test/integration/staff/totp-store.test.ts`

**Interfaces:**
- Produces:
  - `generateTotpSecret(): { raw: Buffer; base32: string }` (20 byte); `totpUri(input: { issuer: string; label: string; secretBase32: string }): string`; `totpAt(secret: Buffer, step: number): string`; `matchTotp(secret: Buffer, code: string, nowMs: number, window?: number): number | null` (trả bước khớp).
  - `generateRecoveryCodes(count: number): string[]` (10 ký tự base32 mỗi mã).
  - staff (ngoài `withCompany`, kiểm `currentCompanyId() === null`): `saveTotpSecret(accountId: string, encrypted: Buffer): Promise<boolean>`, `enableTotp(accountId: string, step: number, recoveryHashes: string[]): Promise<boolean>`, `advanceTotpStep(accountId: string, step: number): Promise<boolean>`, `consumeRecoveryCode(accountId: string, hash: string): Promise<boolean>`, `clearTotp(accountId: string): Promise<boolean>`, `isPlatformAdmin(accountId: string): Promise<boolean>`; `AccountRow` thêm `totpSecretEnc: Buffer | null`, `totpEnabledAt: Date | null`.

- [ ] **Step 1: Viết test hỏng**

```ts
// RFC 6238 phụ lục B, SHA-1, secret ASCII "12345678901234567890", lấy 6 số cuối của mã 8 số
it.each([[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']])(
  'thời điểm %i giây cho mã %s', (t, code) => expect(totpAt(RFC_SECRET, Math.floor(t / 30))).toBe(code));
it('matchTotp nhận lệch ±1 bước, trả đúng bước', () => { /* ... */ });
it('matchTotp từ chối lệch 2 bước', () => { /* ... */ });
// integration
it('advanceTotpStep không lùi và không dùng lại cùng bước', async () => { /* lần 2 cùng step → false */ });
it('hai lần dùng cùng mã khôi phục song song: đúng một true', async () => { /* Promise.all */ });
it('saveTotpSecret gọi trong withCompany thì ném lỗi lập trình', async () => { /* ... */ });
```

- [ ] **Step 2: Run `npx vitest run test/unit/shared/crypto/totp.test.ts test/integration/staff/totp-store.test.ts`** → FAIL.
- [ ] **Step 3: Viết `totp.ts`, mã khôi phục, schema, sinh 0020, hàm staff, env**
- [ ] **Step 4: Run lại, cộng `npx vitest run test/unit/db/journal.test.ts test/integration/shared/rls-coverage.test.ts`** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Nen TOTP: RFC 6238, cot TOTP, ghi co dieu kien chong dung lai (#7 D)"`

### Task B13: [D] Bước nhập mã khi đăng nhập, thiết lập 2FA

**Files:**
- Create: `src/modules/identity/service/two-factor.ts`
- Modify: `src/shared/auth/jwt.ts` (`AccessClaims.twoFactorSetupRequired`, claim `tfs`; thiếu claim đọc ra `false`), `src/shared/auth/authenticate.ts` (option `allowTwoFactorSetup`; thiếu option mà `tfs` thì 403 `two_factor_setup_required`, kiểm sau `password_change_required`), `src/shared/auth/authorize.ts` (cùng bước), `src/modules/identity/service/session.ts` (`TWO_FACTOR_MODE=required`: tài khoản đã bật trả `{ mfaRequired: true, mfaToken }`; chưa bật thì ký token có `tfs`), `src/modules/identity/api/routes.ts` (`/login/2fa`, `/2fa/setup`, `/2fa/confirm`; `me`, `change-password` thêm `allowTwoFactorSetup: true` theo Q18), `schemas.ts`, `openapi.ts`, `src/modules/identity/service/metrics.ts`
- Test: `test/unit/shared/auth/authenticate.test.ts` (thêm ca), `test/integration/identity/two-factor.test.ts` (đầu file `vi.hoisted(() => { process.env.TWO_FACTOR_MODE = 'required'; })`)

**Interfaces:**
- Consumes: B12 toàn bộ; B2 `signPurposeToken('mfa', { sub })`, `verifyPurposeToken('mfa', …)`; B1 `encryptBytes`, `decryptBytes`, `sha256Hex`.
- Produces:
  - `beginSetup(auth: AccessClaims): Promise<{ secret: string; otpauthUrl: string }>`
  - `confirmSetup(auth: AccessClaims, code: string): Promise<{ recoveryCodes: string[] }>`
  - `loginSecondFactor(input: { mfaToken: string; code?: string; recoveryCode?: string }): Promise<LoginResult>`
  - `LoginResult` mở rộng thành `LoginResult | { mfaRequired: true; mfaToken: string }` ở `startSession`.
  - Metric `two_factor_verifications_total{result: 'ok' | 'invalid' | 'replay' | 'recovery' | 'locked'}`.

- [ ] **Step 1: Viết test hỏng**: một `it` cho AC-D1 đến AC-D7. Thêm: hai `login/2fa` cùng mã cùng bước qua `Promise.all` → một 200, một 401 `two_factor_invalid`; token có `tfs` gọi được `me`, `change-password`, `2fa/setup`, `2fa/confirm`, `refresh`, `logout`, gọi `GET /identity/staff` thì 403 `two_factor_setup_required`.
- [ ] **Step 2: Viết thêm `test/integration/identity/two-factor-off.test.ts`** (không đặt `TWO_FACTOR_MODE`): AC-D11, `/login` trả như cũ dù tài khoản có cột TOTP.
- [ ] **Step 3: Run `npx vitest run test/unit/shared/auth test/integration/identity`** → FAIL ở ca mới.
- [ ] **Step 4: Viết `two-factor.ts`, sửa jwt, authenticate, authorize, session, route**
- [ ] **Step 5: Run lại** → PASS, kể cả `auth.test.ts`, `change-password.test.ts`, `google-login.test.ts`.
- [ ] **Step 6: Commit** `git commit -m "2FA khi dang nhap mat khau va Google, thiet lap va ma khoi phuc (#7 D)"`

### Task B14: [D] 2FA trong luồng tham gia, guard quản trị nền tảng, reset

**Files:**
- Modify: `src/modules/staff/service/join.ts` (`join2faSetup`, `join2faConfirm`; `completeJoin` đòi `totp_confirmed_at` cho `set_password` và `totpCode` cho `sign_in` khi tài khoản đã bật, chỉ khi `TWO_FACTOR_MODE=required`), `src/modules/staff/service/invitations.ts` (duyệt: giải mã secret bằng AAD `totp:<invitationId>`, mã hoá lại bằng `totp:<accountId>`, chép `recovery_code_hashes`, đặt `totp_enabled_at`), `src/modules/staff/api/routes.ts`, `schemas.ts`, `openapi.ts`
- Create: `src/shared/auth/platform-admin.ts`
- Modify: `src/modules/platform/api/routes.ts` (`POST /accounts/:accountId/2fa/reset`, `PlatformContext`), `src/modules/identity/index.ts` (export `resetTwoFactor`, `isPlatformAdmin`), `src/wiring.ts` (`authorizePlatform: createPlatformAdminGuard(isPlatformAdmin)`, `resetAccountTwoFactor: resetTwoFactor`), `test/unit/wiring.test.ts`
- Test: `test/integration/staff/join-2fa.test.ts` (`TWO_FACTOR_MODE=required`), `test/integration/platform/two-factor-reset.test.ts`

**Interfaces:**
- Consumes: B11, B12, B13.
- Produces:
  - `join2faSetup(registrationToken: string): Promise<{ secret: string; otpauthUrl: string }>`; `join2faConfirm(registrationToken: string, code: string): Promise<{ recoveryCodes: string[] }>`
  - `createPlatformAdminGuard(loader: (accountId: string) => Promise<boolean>): RequestHandler`: 401 `unauthorized` → 403 `forbidden`; đọc DB mỗi request; dùng `readAccessClaims` và `assertTokenCurrent`.
  - `resetTwoFactor(accountId: string, actorId: string): Promise<void>`
  - `type PlatformContext = ModuleContext & { authorizePlatform: RequestHandler; resetAccountTwoFactor: (accountId: string, actorId: string) => Promise<void> }`

- [ ] **Step 1: Viết test hỏng**: AC-D8, AC-D9 (`join-2fa.test.ts`); AC-D10 (`two-factor-reset.test.ts`: reset gọi lại vẫn 204; Admin và CEO công ty gọi → 403; `accountId` không phải uuid → 404); sau khi duyệt, nhân viên đăng nhập phải qua `login/2fa` với mã sinh từ secret đã quét lúc đăng ký.
- [ ] **Step 2: Run `npx vitest run test/integration/staff/join-2fa.test.ts test/integration/platform/two-factor-reset.test.ts test/unit/wiring.test.ts`** → FAIL.
- [ ] **Step 3: Viết phần thêm vào join, duyệt, guard, route platform, wiring**
- [ ] **Step 4: Run lại, rồi `npm run check`** → PASS, xanh.
- [ ] **Step 5: Commit** `git commit -m "2FA luc tham gia qua link, guard quan tri nen tang, reset 2FA (#7 D)"`

### Task B15: [D] Seed demo, tài liệu, bật trên staging

**Files:**
- Modify: `db/seed/demo.ts` (tài khoản demo có TOTP bật sẵn từ `DEMO_TOTP_SECRET`, cộng một mã khôi phục cố định; secret mã hoá bằng `TOTP_ENCRYPTION_KEY` lúc seed), `db/seed/index.ts`, `.env.example` (`DEMO_TOTP_SECRET`, giá trị công khai vì là dữ liệu giả), `db/CLAUDE.md` (cách đăng nhập demo khi bật 2FA), `src/modules/identity/CLAUDE.md`, `src/modules/staff/CLAUDE.md`, `deploy/staging/.env.example` (`TWO_FACTOR_MODE=required`, `SMTP_URL`, `MAIL_FROM`, `GOOGLE_CLIENT_ID`, `TOTP_ENCRYPTION_KEY`)
- Test: `test/integration/seed/seed.test.ts` (thêm ca)

- [ ] **Step 1: Thêm test hỏng**: chạy seed hai lần không sinh trùng (V37); tài khoản demo có `totp_enabled_at`; mã `totpAt(DEMO_SECRET, bước hiện tại)` đăng nhập qua `login/2fa` được.
- [ ] **Step 2: Run `npx vitest run test/integration/seed/seed.test.ts`** → FAIL.
- [ ] **Step 3: Sửa seed, env mẫu, CLAUDE.md**
- [ ] **Step 4: Run lại, rồi `npm run check`** → PASS, xanh.
- [ ] **Step 5: Commit** `git commit -m "Seed demo co TOTP, cau hinh staging cho 2FA (#7 D)"`

**Cuối B12–B15:** PR "#7 [D] Xác thực hai lớp" vào `develop`. Trước khi đặt `TWO_FACTOR_MODE=required` trên staging, báo cả nhóm (spec mục 12, rủi ro 5).

---

# Phần 2: Report (`D:\DA-TMDT\Report`)

Nhánh `khang/7-moi-nhan-vien-2fa` từ `main`. Đặc tả UC làm bằng skill `use-case` của repo (`.claude/skills/use-case/SKILL.md`): soạn nháp ở `draft/uc/`, **dừng ở Cổng 1** chờ duyệt, rồi đưa vào `sections/uc/`, build, commit. Gói PI là của Thành: skill sẽ nhắc; Thành duyệt ở Cổng 1. Không tự thêm tình huống ngoài spec và `Documents/14` (luật của skill).

> **Cổng:** T-R1 đến T-R4 chờ T-D3 (dòng UC-PI-09, tác nhân "Người được mời" trong `Documents/14`) đã merge. T-R5 chờ T-D2.

### Task T-R1: Viết lại UC-PI-05 "Quản lý tài khoản nhân viên"

**Files:**
- Create: `draft/uc/UC-PI-05.md` (nháp của skill)
- Modify: `sections/uc/UC-PI-05.tex`

**Nội dung phải có** (từ spec mục 5.2, 5.3, Q1, Q5–Q8; giữ các ngoại lệ cũ không đổi):
- `uc-meta` extend: `Tạo link mời, Duyệt yêu cầu tham gia, Gán thêm hoặc đổi vai trò, Tạm khoá tài khoản, Mở khoá tài khoản`.
- Luồng chính: Admin mở màn nhân viên → hệ thống hiện danh sách → Admin bấm Tạo link mời, chọn vai trò → hệ thống kiểm vai trò chỉ gồm quyền Admin có, không có vai trò CEO → hệ thống tạo link dùng một lần, sống 72 giờ, ghi nhật ký → Admin sao chép link gửi cho nhân viên.
- Ngoại lệ thêm: Admin mở hàng đợi yêu cầu tham gia, bấm Có (hệ thống kiểm lại vai trò, tạo tài khoản nếu chưa có, thêm vào công ty, gán vai trò, ghi nhật ký) hoặc Không (đóng yêu cầu, ghi nhật ký); vai trò trong link đã bị xoá; người khác vừa duyệt.
- Bỏ: "sinh mật khẩu ngẫu nhiên", "gửi thư mời kèm mật khẩu", postcondition "đăng nhập bằng mật khẩu trong thư mời".
- Dependencies thêm `UC-PI-09 Tham gia công ty qua link mời (xảy ra sau)`.

- [ ] **Step 1:** Chạy `/use-case UC-PI-05` trong repo Report; skill soạn `draft/uc/UC-PI-05.md`.
- [ ] **Step 2:** Đối chiếu nháp với danh sách "Nội dung phải có"; dừng ở Cổng 1, đưa Thành duyệt.
- [ ] **Step 3:** Duyệt xong, skill đưa vào `sections/uc/UC-PI-05.tex`. Run `latexmk -pdf main.tex` → không lỗi; `grep -n "mật khẩu" sections/uc/UC-PI-05.tex` → không còn câu về mật khẩu thư mời.
- [ ] **Step 4:** Commit `git commit -m "UC-PI-05: moi nhan vien bang link, duyet yeu cau tham gia (#7)"`

### Task T-R2: Đặc tả mới UC-PI-09 "Tham gia công ty qua link mời"

**Files:**
- Create: `draft/uc/UC-PI-09.md`, `sections/uc/UC-PI-09.tex`
- Modify: `sections/use-case.tex` (bảng tác nhân thêm "Người được mời"; `\input` đặc tả mới đúng thứ tự gói PI)

**Nội dung phải có** (spec 5.3, Q2–Q5, Q13, Q14, [D] spec 5.4):
- Tác nhân chính "Người được mời"; Dependencies: `UC-PI-05 (xảy ra trước)`, `UC-PI-03 Đăng nhập (xảy ra sau)`.
- Luồng chính: mở link → hệ thống hiện tên công ty → nhập email, họ tên → hệ thống gửi mã 6 số tới email (hết hạn sau 5 phút) → nhập mã → hệ thống kiểm mã → nhập mật khẩu và nhập lại → thiết lập xác thực hai lớp (quét mã QR hoặc nhập setup key, nhập một mã từ app, nhận 10 mã khôi phục) → hệ thống báo đăng ký thành công, chờ Admin duyệt.
- Ngoại lệ: link hết hạn hoặc đã được dùng; mã sai, hết hạn, sai quá 5 lần; xin mã lại trước 60 giây hoặc quá 5 lần; email đã có tài khoản ở công ty khác (đăng nhập bằng mật khẩu của tài khoản đó, không đặt lại); email đã là thành viên công ty; email của quản trị nền tảng; mật khẩu sai quy tắc hoặc nhập lại không khớp; quá 30 phút sau khi xác minh mã thì phải xác minh lại.

- [ ] **Step 1:** Chạy `/use-case UC-PI-09` (cần T-D3 đã thêm UC vào `Documents/14`).
- [ ] **Step 2:** Đối chiếu "Nội dung phải có"; Cổng 1, Thành duyệt.
- [ ] **Step 3:** Đưa vào báo cáo; Run `latexmk -pdf main.tex` → không lỗi; bảng UC-PI-09 xuất hiện sau UC-PI-08 trong PDF.
- [ ] **Step 4:** Commit `git commit -m "UC-PI-09: tham gia cong ty qua link moi (#7)"`

### Task T-R3: Sửa UC-PI-03 "Đăng nhập" và UC-PI-04 "Đổi mật khẩu"

**Files:**
- Modify: `sections/uc/UC-PI-03.tex`, `sections/uc/UC-PI-04.tex` (qua `draft/uc/` của skill)

**Nội dung phải có:**
- UC-PI-03: sau bước kiểm mật khẩu hoặc ID token Google, hệ thống yêu cầu mã từ app Authenticator; ngoại lệ: mã sai; dùng mã khôi phục; tài khoản chưa thiết lập xác thực hai lớp thì hệ thống mở màn thiết lập và chặn chức năng khác tới khi xong; sai mã quá 5 lần trong 15 phút. Bỏ ngoại lệ bước 7 "mật khẩu do hệ thống sinh trong thư mời"; dòng Dependencies của UC-PI-04 bỏ "khi tài khoản vẫn dùng mật khẩu trong thư mời".
- UC-PI-04: bỏ nhánh "đăng nhập lần đầu bằng mật khẩu trong thư mời" (bước 1) và câu trong Dependencies.

- [ ] **Step 1:** Chạy `/use-case UC-PI-03`, rồi `/use-case UC-PI-04`; đối chiếu; Cổng 1, Thành duyệt.
- [ ] **Step 2:** Đưa vào báo cáo; Run `latexmk -pdf main.tex` → không lỗi; `grep -rn "thư mời" sections/uc/` → không còn kết quả nào nói mật khẩu thư mời.
- [ ] **Step 3:** Commit `git commit -m "UC-PI-03, UC-PI-04: buoc ma xac thuc hai lop, bo mat khau thu moi (#7)"`

### Task T-R4: Vẽ lại biểu đồ gói PI và biểu đồ tổng quát

**Files:**
- Modify: `assets/uc/pi.json`, `pi.drawio`, `pi.png`, `assets/uc/tong-quat.json`, `tong-quat.drawio`, `tong-quat.png`

- [ ] **Step 1:** Chạy `/use-case ve PI` (skill dựng spec từ các đặc tả đã duyệt, gọi `.claude/skills/use-case/scripts/build_uc.mjs`); kiểm có UC-PI-09, tác nhân "Người được mời", extend mới của UC-PI-05. Cổng 2, Thành duyệt hình.
- [ ] **Step 2:** Sinh lại tổng quát: `node .claude/skills/use-case/scripts/gen_tong_quat.mjs` (theo `HUONG-DAN.md` của skill) rồi `node .claude/skills/use-case/scripts/build_uc.mjs assets/uc/tong-quat.json`.
- [ ] **Step 3:** Run `latexmk -pdf main.tex` → không lỗi, hình mới hiện đúng chỗ.
- [ ] **Step 4:** Commit `git commit -m "Ve lai bieu do Use Case goi PI va tong quat (#7)"`

### Task T-R5: ERD nền tảng: `staff.invitations` và cột TOTP

**Files:**
- Modify: `assets/erd/nen-tang.json` (bảng `invitations` trong schema `staff` đúng cột spec 6.3; `staff.accounts` thêm `totp_secret_enc bytea`, `totp_enabled_at timestamptz`, `totp_last_step bigint`, `recovery_code_hashes text[]`; khoá ngoại `company_id`, `created_by`, `account_id`, `decided_by`), `assets/erd/model.mjs` (enum `invitation_status`; dọn enum `invitation_kind` không còn dùng; khai `TARGET` cho cột khoá ngoại mới), `nen-tang.drawio`, `nen-tang.png`
- Modify (repo Documents, cùng lúc): `erd/commerio-core.dbml`, `erd/supabase-core.sql` (sinh ra, không sửa tay)

- [ ] **Step 1:** Sửa spec JSON và `model.mjs`.
- [ ] **Step 2:** Run trong `assets/erd`: `node build_erd.mjs nen-tang.json && node build_dbml.mjs ../../../Documents/erd && node build_sql.mjs ../../../Documents/erd`. Expected: có `nen-tang.png` mới; hai file DBML, SQL ở Documents đổi đúng bảng, cột thêm.
- [ ] **Step 3:** Đối chiếu cột ERD với `src/modules/staff/repository/schema.ts` sau B7, B12 (tên, kiểu khớp).
- [ ] **Step 4:** Commit ở Report `git commit -m "ERD: staff.invitations va cot TOTP (#7)"`; commit ở Documents `git commit -m "erd: sinh lai sau khi them staff.invitations, cot TOTP (#7)"`.

### Task T-R6: Văn bản báo cáo: giải pháp, công nghệ

**Files:**
- Modify: `sections/giai-phap.tex:146` (dòng Identity), `sections/giai-phap.tex:191-195` (mục Bảo mật), `sections/cong-nghe.tex:74` (dòng `staff`), `sections/cong-nghe.tex:205` (đoạn `staff`), `sections/cong-nghe.tex:289` (dòng công nghệ xác thực)

**Nội dung thay:**
- `giai-phap.tex:146`: câu "Tài khoản nhân viên tạo bằng thư mời gửi tới email, lần đăng nhập đầu phải đổi mật khẩu" → "Admin tạo link mời dùng một lần cho nhân viên mới; nhân viên xác minh email bằng mã gửi qua email, tự đặt mật khẩu, và chỉ có tài khoản sau khi Admin duyệt. Mọi tài khoản đăng nhập bằng mật khẩu hoặc Google đều phải nhập mã xác thực hai lớp từ app Authenticator."
- `giai-phap.tex` mục Bảo mật, thêm hai tiêu chí kiểm được: người không có mã xác thực hai lớp không đăng nhập được kể cả khi biết mật khẩu; người cầm link mời không vào được công ty khi Admin chưa duyệt.
- `cong-nghe.tex:74`: "thư mời" → "link mời và yêu cầu tham gia".
- `cong-nghe.tex:205`: viết lại theo cơ chế đã làm: nhân viên tham gia qua link mời một lần, xác minh email bằng OTP do `worker` gửi, tự đặt mật khẩu, chờ Admin duyệt; khoá tài khoản theo công ty có hiệu lực ngay vì mỗi yêu cầu đọc trạng thái công ty, membership, quyền từ cơ sở dữ liệu (`Documents/21` D1), thay câu "danh sách khoá trong Redis" đã lệch D1.
- `cong-nghe.tex` mục Xác thực (sau đoạn đăng nhập), thêm đoạn 2FA: TOTP theo RFC 6238, secret mã hoá AES-256-GCM, mã khôi phục, quản trị nền tảng reset; `\cite` RFC 6238 (thêm mục vào `sections/ref.bib`).
- `cong-nghe.tex:289`: "jose, openid-client, OAuth2 (Google), JWT" → "jose, OAuth2/OpenID Connect (Google), JWT, TOTP (RFC 6238), nodemailer".

- [ ] **Step 1:** Sửa các đoạn trên; giữ văn phong theo `.claude/skills/use-case/nhan-xet.md` và skill `viet-bao-cao` nếu có.
- [ ] **Step 2:** Run `latexmk -pdf main.tex` → không lỗi, không cảnh báo `Citation undefined`.
- [ ] **Step 3:** Run `grep -rn "openid-client\|danh sách khoá trong Redis\|thư mời gửi tới email" sections/` → không còn kết quả.
- [ ] **Step 4:** Commit `git commit -m "Bao cao: luong moi bang link, xac thuc hai lop, cong nghe (#7)"`

**Cuối Phần 2:** push nhánh, mở PR vào `main`, Thành duyệt.

---

# Phần 3: Documents (`D:\DA-TMDT\Documents`)

Nhánh `khang/7-moi-nhan-vien-2fa` từ `main`. Mọi task là sửa markdown; kiểm bằng đọc lại bảng hiển thị đúng và `grep`. Thành chốt nội dung (người chốt hợp đồng và mô hình dữ liệu). Làm Phần 3 **trước** B7 và T-R1.

### Task T-D1: Hợp đồng API (`21-hop-dong-api-fe-be.md`)

**Files:**
- Modify: `21-hop-dong-api-fe-be.md` mục 0 (checklist FE), mục 2 (A3, A4, thêm A9 và mục 2.1), mục 3 (I2, thêm I10–I12 và mục 3.1), mục 10.2 (V10, V11, thêm V46–V52), mục 13.3 (dòng `password_change_required`)

**Nội dung:**
- Mục 0, checklist FE thêm: trang `/tham-gia`; nút "Tạo link mời" và hàng đợi duyệt ở FE#3; bước nhập mã 2FA và màn thiết lập ở FE#2; body Google `{ credential }` (đã đúng).
- A3: thêm "body `/identity/google` là `{ credential }`". A4: thêm `google_unavailable` (503).
- A9 (mới) và mục **2.1 Xác thực hai lớp**: bảng [D] của spec 6.5, các mã `two_factor_invalid`, `two_factor_setup_required`, `two_factor_already_enabled`; luật Q18; cờ `TWO_FACTOR_MODE` là chi tiết triển khai, không ghi vào hợp đồng.
- I2: thay bằng "Mời bằng link một lần (I10–I12, mục 3.1); bỏ `POST /identity/staff`".
- I10 (tạo link), I11 (tham gia qua link), I12 (duyệt yêu cầu tham gia), mục **3.1 Mời và tham gia**: bảng [B] (giữ đường dẫn I1), [C] phía Admin và [C] phía người được mời của spec 6.5; kiểu `StaffMember`, `Invitation`; mã `invitation_invalid`, `invitation_used`, `invitation_outdated`, `registration_expired`.
- V10: thêm danh sách API gọi được khi chưa bật 2FA (Q18). V11: bỏ đoạn "tài khoản còn mật khẩu thư mời"; giữ phần `google_sub` khác.
- V46–V52: mỗi dòng một quyết định Q13–Q19 của spec, cột "Kéo theo" ghi `#7`, `FE#2` hoặc `FE#3`.
- 13.3: `password_change_required` đổi mô tả "Tài khoản phải đổi mật khẩu (V10)"; thêm dòng `two_factor_setup_required` (403).

- [ ] **Step 1:** Sửa file theo danh sách.
- [ ] **Step 2:** Run `grep -n "POST /identity/staff\b\|mật khẩu thư mời" 21-hop-dong-api-fe-be.md` → chỉ còn dòng ghi "bỏ".
- [ ] **Step 3:** Đối chiếu từng mã lỗi trong file với "Mã lỗi mới" ở Global Constraints → khớp 8/8.
- [ ] **Step 4:** Commit `git commit -m "docs/21: moi bang link, xac thuc hai lop, ma loi moi (#7)"`

### Task T-D2: Mô hình dữ liệu (`19-mo-hinh-du-lieu.md`)

**Files:**
- Modify: `19-mo-hinh-du-lieu.md:75` (D26), thêm D39, D40 sau D38

**Nội dung:**
- D26: bỏ `invitations` khỏi danh sách bị bỏ; thêm "`invitations` khôi phục dưới dạng `staff.invitations` (D39)".
- D39: `staff.invitations`: link một lần kiêm yêu cầu tham gia; trạng thái `open`, `claimed`, `pending`, `approved`, `rejected`; tài khoản chỉ tạo khi duyệt; cột, CHECK, unique một phần, RLS như spec 6.3; ai chốt: Thành, ngày duyệt.
- D40: cột TOTP trong `staff.accounts`, `staff.invitations`; secret mã hoá AES-256-GCM, mã khôi phục chỉ lưu băm; ghi bằng role chủ bảng (migration 0017).

- [ ] **Step 1:** Sửa file.
- [ ] **Step 2:** Run `grep -n "^| D39\|^| D40" 19-mo-hinh-du-lieu.md` → hai dòng.
- [ ] **Step 3:** Commit `git commit -m "docs/19: D39 staff.invitations, D40 cot TOTP, sua D26 (#7)"`

### Task T-D3: Danh sách use case (`14-danh-sach-use-case.md`)

**Files:**
- Modify: `14-danh-sach-use-case.md` mục 2.2 (tác nhân), mục 3.1 (dòng UC-PI-05, thêm UC-PI-09), QT-10 (dòng 210)

**Nội dung:**
- 2.2: thêm "Người được mời: chưa có tài khoản trong công ty; mở link mời, xác minh email, đặt mật khẩu hoặc đăng nhập tài khoản đã có, chờ duyệt".
- 3.1: UC-PI-05 ghi chú "Tạo link mời, duyệt yêu cầu tham gia, gán vai trò, tạm khoá, mở khoá. CEO kế thừa"; thêm `| UC-PI-09 | Tham gia công ty qua link mời | Người được mời | | Xác minh email bằng mã, đặt mật khẩu, thiết lập xác thực hai lớp, chờ duyệt |`.
- QT-10: "Đăng nhập bằng mật khẩu hoặc tài khoản Google, kèm mã xác thực hai lớp từ app Authenticator. …" (giữ phần sau).

- [ ] **Step 1:** Sửa file.
- [ ] **Step 2:** Run `grep -n "UC-PI-09\|Người được mời" 14-danh-sach-use-case.md` → có ở 2.2 và 3.1.
- [ ] **Step 3:** Commit `git commit -m "docs/14: UC-PI-09, tac nhan Nguoi duoc moi, QT-10 co 2FA (#7)"`

### Task T-D4: Kiến trúc, kế hoạch, bàn giao cho FE

**Files:**
- Modify: `17-modular-monolith.md:90` (dòng thư viện xác thực), mục 6 thêm dòng email; `20-ke-hoach-implement.md:55` (dòng #7)
- Create: `handoff/2026-10-21-moi-nhan-vien-2fa-cho-khoa.md`

**Nội dung:**
- `17`: dòng "JWT, OAuth2 Google" → `jose` (bỏ `openid-client`); thêm dòng "Email | JavaMailSender | `nodemailer`"; thêm dòng "Mã xác thực hai lớp | — | TOTP RFC 6238 tự viết bằng `node:crypto`, không thêm thư viện".
- `20`: dòng #7 → "Đăng nhập Google, quản lý nhân viên, mời bằng link, xác thực hai lớp (UC-PI-03, 05, 09)", Size XL, ghi chú "PR theo phần A, B, C, D; D cắt được".
- Handoff cho Khoa: luồng mới (spec mục 5), bảng API (trỏ `21` mục 2.1, 3.1), màn hình FE#2, FE#3, trang `/tham-gia`, mock MSW cần đổi, AC để QA nghiệm thu (spec mục 11).

- [ ] **Step 1:** Sửa hai file, viết handoff.
- [ ] **Step 2:** Run `grep -n "openid-client" 17-modular-monolith.md` → không còn.
- [ ] **Step 3:** Commit `git commit -m "docs/17, 20, handoff: thu vien email, pham vi #7, ban giao FE (#7)"`

**Cuối Phần 3:** push nhánh, PR vào `main`, Thành duyệt; báo Khoa đọc handoff.

---

## Self-review (đã chạy)

- **Phủ spec:** mục 3 (Q1–Q19) → B4–B14, T-D1; mục 6.3 → B7, B12, T-R5, T-D2; mục 6.5 → B4, B6, B10, B11, B13, B14, T-D1; mục 6.7 (đồng thời) → test đua ở B4, B6, B10, B11, B12, B13; mục 6.8 → B3, B9; mục 6.11 → B11; mục 6.12 → B3, B4, B9, B13; mục 8 → T-D1, T-D4; mục 9 → T-D1..T-D4; mục 10 → T-R1..T-R6; mục 11 (AC) → B4, B6, B10, B11, B13, B14.
- **Kiểu nhất quán:** `Caller`, `StaffMember`, `Page`, `RoleWithPermissions`, `InvitationRow`, `InvitationView`, `LoginResult`, `PurposeClaims` định nghĩa một lần ở task đầu tiên dùng, task sau chỉ nhắc tên.
- **Đã chốt với Khang (21/10/2026):** TOTP tự viết bằng `node:crypto` (B12; T-D4 ghi vào `docs/17`). UC-PI-09 tách riêng khỏi UC-PI-05; đây là đề xuất của Khang, Thành chốt ở T-D3. Nếu Thành chọn gộp thì bỏ T-R2, chuyển nội dung vào T-R1.
- **Cách thực thi:** native (superpowers:executing-plans), một lượt review cả nhánh ở cuối.
