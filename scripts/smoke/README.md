# Smoke test sàn: Shopee, Lazada

Hai script kiểm tra tài khoản developer gọi được API thật trước khi viết adapter trong module `channel`. Không phụ thuộc thư viện ngoài, không đụng DB. Token uỷ quyền lưu ở `backend/.smoke-tokens.json` (đã gitignore).

## Chuẩn bị

1. Tạo app trên console của sàn, khai báo **Redirect URL** (vd domain staging; trang đích trả 404 cũng được, chỉ cần đọc `code` trên thanh địa chỉ).
2. Điền vào `backend/.env` (mẫu ở `.env.example`):

```
SHOPEE_PARTNER_ID=        # Test Partner ID
SHOPEE_PARTNER_KEY=       # Test Partner Key
SHOPEE_REDIRECT_URL=      # trùng URL khai báo trong app
# SHOPEE_HOST=            # mặc định sandbox; nếu console ghi domain khác thì đặt ở đây

LAZADA_APP_KEY=
LAZADA_APP_SECRET=
LAZADA_REDIRECT_URL=
# LAZADA_ACCESS_TOKEN=     # token từ nút Get Token (tài khoản mượn), có thì không cần auth-url, token
# LAZADA_API_URL=         # mặc định https://api.lazada.vn/rest
```

## Shopee (sandbox)

```bash
npm run smoke:shopee -- auth-url                  # in link, mở bằng trình duyệt, đăng nhập shop thử
npm run smoke:shopee -- token <code> <shop_id>    # code, shop_id lấy từ URL quay về; code chỉ dùng được một lần, hạn 10 phút
npm run smoke:shopee -- check                     # get_shop_info, get_item_list, get_order_list
npm run smoke:shopee -- refresh                   # access_token hết hạn sau khoảng 4 giờ
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

## Đọc kết quả

Mỗi bước in `OK` hoặc `LỖI` kèm phản hồi của sàn. Lỗi hay gặp:

| Sàn | Lỗi | Nghĩa |
|---|---|---|
| Shopee | `error_sign` | Sai partner key, hoặc dùng key Live trên host sandbox |
| Shopee | `error_param` ở `auth_partner` | Redirect URL không khớp app, hoặc link quá 5 phút |
| Shopee | `error_auth` / `invalid_access_token` | Token hết hạn, chạy `refresh` |
| Lazada | `IncompleteSignature` | Sai app secret |
| Lazada | `InvalidCode` | Code đã dùng hoặc hết hạn, chạy lại `auth-url` |
| Lazada | `AppWhiteIpLimit` / `InsufficientPermission` | App chưa được duyệt hoặc thiếu quyền API |
| Lazada | `InvalidApiPath` | Gõ sai path, hoặc Git Bash đổi path (xem trên) |
