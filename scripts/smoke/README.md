# Smoke test sàn: Lazada, eBay

Script kiểm tra tài khoản developer gọi được API thật trước khi viết adapter trong module `channel`. Không phụ thuộc thư viện ngoài, không đụng DB. Token uỷ quyền lưu ở `backend/.smoke-tokens.json` (đã gitignore).

## Chuẩn bị

1. Tạo app trên console của sàn, khai báo **Redirect URL** (vd domain staging; trang đích trả 404 cũng được, chỉ cần đọc `code` trên thanh địa chỉ).
2. Điền vào `backend/.env` (mẫu ở `.env.example`):

```
LAZADA_APP_KEY=
LAZADA_APP_SECRET=
LAZADA_REDIRECT_URL=
# LAZADA_ACCESS_TOKEN=     # token từ nút Get Token (tài khoản mượn), có thì không cần auth-url, token
# LAZADA_API_URL=         # mặc định https://api.lazada.vn/rest
```

## Lazada

Đã chạy được 27/10/2026 bằng tài khoản mượn (3/3 API). App phải thuộc loại **Seller In-house APP**; loại LazPay không có quyền sản phẩm, đơn.

**Cách nhanh, dùng tài khoản mượn** (không cần shop thật, không cần mật khẩu):
1. App Console → Testing Tools → **Loan Test Account** → mượn tài khoản region Vietnam. Hạn vài ngày, hết thì mượn lại.
2. Testing Tools → **API Explorer**: chọn app, region Vietnam, API Path `/seller/get`, HTTP Method GET, bấm **Get Token**, Submit thử.
3. Chép token vào `LAZADA_ACCESS_TOKEN` trong `backend/.env`, rồi chạy `check`.

Tài khoản mượn là shop dùng chung của nhiều developer, đã có sẵn hàng trăm sản phẩm và đơn; thông tin khách bị Lazada che. Testing Tools → **Create Test Case** tạo được 10 đơn thử mỗi ngày (cần `item_id` lấy từ `/products/get`).

**Cách uỷ quyền shop thật:** app loại "Allow binding users to authorize" chỉ nhận seller có trong *Authorized Seller Whitelist* (cuối trang Manage của app, phải nhập email và mật khẩu seller).

```bash
npm run smoke:lazada -- check                     # /seller/get, /products/get, /orders/get
npm run smoke:lazada -- call GET /orders/get created_after=2026-10-01T00:00:00+07:00 limit=5
npm run smoke:lazada -- auth-url                  # chỉ cho shop thật
npm run smoke:lazada -- token <code>
npm run smoke:lazada -- refresh
```

Chạy trong Git Bash thì đặt `MSYS_NO_PATHCONV=1` trước lệnh `call`, nếu không Git Bash đổi `/orders/get` thành đường dẫn Windows và Lazada trả `InvalidApiPath`. PowerShell, cmd không bị.

## eBay (Sandbox)

Đã chạy được 28/10/2026 (3/3 API, đăng bán được listing thử). Chi tiết: `Documents/tich-hop-san/ebay.md`.

1. [Application Keys](https://developer.ebay.com/my/keys), cột Sandbox: lấy App ID và Cert ID.
2. [User Tokens](https://developer.ebay.com/my/auth/?env=sandbox): tạo RuName bật OAuth (Add eBay Redirect URL, Save), tạo user sandbox, chọn OAuth, Sign in to Sandbox for OAuth, Agree. Dùng cửa sổ thường, không ẩn danh.
3. Điền `backend/.env`, token **bọc nháy đơn** vì có dấu `#`:

```
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_USER_TOKEN='v^1.1#...'
EBAY_RUNAME=
```

```bash
npm run smoke:ebay -- check                       # privilege, inventory_item, order
npm run smoke:ebay -- call GET "/sell/fulfillment/v1/order?limit=5"
npm run smoke:ebay -- call POST /sell/account/v1/program/opt_in '{"programType":"SELLING_POLICY_MANAGEMENT"}'
npm run smoke:ebay -- auth-url                    # lấy refresh token qua RuName
npm run smoke:ebay -- token <code>
npm run smoke:ebay -- refresh
```

Script tự gọi Finances API (`/sell/finances/`) qua host `apiz.sandbox.ebay.com`.

## Đọc kết quả

Mỗi bước in `OK` hoặc `LỖI` kèm phản hồi của sàn. Lỗi hay gặp:

| Sàn | Lỗi | Nghĩa |
|---|---|---|
| Lazada | `IncompleteSignature` | Sai app secret |
| Lazada | `InvalidCode` | Code đã dùng hoặc hết hạn, chạy lại `auth-url` |
| Lazada | `AppWhiteIpLimit` / `InsufficientPermission` | App chưa được duyệt hoặc thiếu quyền API |
| Lazada | `InvalidApiPath` | Gõ sai path, hoặc Git Bash đổi path (xem trên) |
| eBay | `401` `Invalid access token` | Token hết hạn (2 giờ), hoặc `.env` không bọc nháy nên token bị cắt ở dấu `#` |
| eBay | `25709` `Accept-Language` | Thiếu header, script đã gửi sẵn |
| eBay | `20403` Business Policy | Chưa opt-in `SELLING_POLICY_MANAGEMENT` |
