# Smoke test sàn: Lazada, TikTok Shop

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

## TikTok Shop

`scripts/smoke/tiktok.ts` chạy chính adapter của app (`service/marketplaces/tiktok.ts`), không ký riêng. Lệnh ghi (#226, #219) chỉ chạy trên shop thử SANDBOX của nhóm và đặt lại giá trị cũ sau khi thử; mỗi lời gọi Open API in path, `code`, `request_id`. Cần `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET` (app Custom, Partner Center), thêm `TIKTOK_SERVICE_ID` cho `link`. Token lưu ở `.smoke-tokens.json` khoá `tiktok`: `accessToken`, `refreshToken` (token thô của sàn), `accessExpiresAt`, `refreshExpiresAt` (mốc Unix, giây), `shops[]` (`id`, `name`, `region`, `cipher`). Màn hình chỉ in 6 ký tự đầu của token, cipher.

```bash
npm run smoke:tiktok -- link                      # link uỷ quyền, mở bằng trình duyệt đã đăng nhập test seller
npm run smoke:tiktok -- token "<URL callback>"    # hoặc token <code>; code hạn 30 phút, dùng một lần: đổi ngay
npm run smoke:tiktok -- shops                     # /authorization/202309/shops, cập nhật cipher
npm run smoke:tiktok -- refresh                   # làm mới, lưu cặp token mới ngay (token cũ có thể mất hiệu lực)
npm run smoke:tiktok -- products [shopId]          # mọi SKU như bước ghép ở thiết lập: số sản phẩm, số SKU, tiêu đề kèm nhãn biến thể (#282)
npm run smoke:tiktok -- skus [shopId] [sellerSku ...]   # listSkus, hoặc getSkus khi có sellerSku
npm run smoke:tiktok -- returns [ngày]            # listReturns: yêu cầu trả cập nhật trong N ngày (mặc định 30), #227
npm run smoke:tiktok -- cancellations [ngày]      # listCancellations: lần huỷ cập nhật trong N ngày
npm run smoke:tiktok -- cancel-reasons <orderId>  # lý do người bán huỷ được đơn; chỉ đọc, không huỷ
npm run smoke:tiktok -- warehouses                # /logistics/202309/warehouses
npm run smoke:tiktok -- categories [từ khoá]      # danh mục lá AVAILABLE (cây v2)
npm run smoke:tiktok -- attrs <categoryId>        # thuộc tính bắt buộc
npm run smoke:tiktok -- push-stock <sellerSku> <qty>     # ghi: tồn, in trước/sau
npm run smoke:tiktok -- push-price <sellerSku> <giá>     # ghi: giá VND
npm run smoke:tiktok -- deactivate|activate <sellerSku>  # ghi: tắt, bật cả sản phẩm (bật lại vào duyệt)
npm run smoke:tiktok -- upload-image <URL ảnh>
npm run smoke:tiktok -- create-product <categoryId> <URL ảnh> [mãThuộcTính=giáTrị ...]  # ghi: tạo sản phẩm CM-TEST-…
```

Đã chạy 06/11/2026 với shop thử `7495013067939481105` (VN, LOCAL): `shops`, `skus` (3 SKU), `skus CM-TEST-MUG-DEN`, `refresh` (cipher giữ nguyên, refresh hạn tới 2125) đều OK. Lệnh ghi chạy 07/11/2026, kết quả ở mục TikTok của `src/modules/channel/channel/CLAUDE.md`.

| Mã TikTok | Nghĩa |
|---|---|
| `36009005` | Access token sai (`The 'access_token' header is invalid`) |
| `105002` | Access token hết hạn, chạy `refresh` |
| `106001` | Sai chữ ký (sai app secret) |
| `36004004` | Code đã dùng hoặc hết hạn, chạy lại `link` |
| `36004005` | Refresh token sai (`can not find related auth record`) |
| `105005` | App hoặc token thiếu scope (app Public đang Draft gặp lỗi này với mọi API) |

## Đọc kết quả

Mỗi bước in `OK` hoặc `LỖI` kèm phản hồi của sàn. Lỗi hay gặp:

| Sàn | Lỗi | Nghĩa |
|---|---|---|
| Lazada | `IncompleteSignature` | Sai app secret |
| Lazada | `InvalidCode` | Code đã dùng hoặc hết hạn, chạy lại `auth-url` |
| Lazada | `AppWhiteIpLimit` / `InsufficientPermission` | App chưa được duyệt hoặc thiếu quyền API |
| Lazada | `InvalidApiPath` | Gõ sai path, hoặc Git Bash đổi path (xem trên) |

## Kho tệp Cloudflare R2 (#212)

`npm run smoke:r2 [origin FE ...]` chạy đúng hàm ký URL của module `files` vào bucket thật: kiểm CORS cho từng origin (mặc định `http://localhost:5173`), PUT sai cỡ hoặc sai kiểu đã khai phải bị từ chối, PUT ảnh vào bucket công khai rồi xem lại qua `S3_PUBLIC_URL`, PUT PDF vào bucket riêng, hỏi kho bằng `HeadObject` (cách gắn tệp xác nhận đã PUT xong) và mở link tải ký sẵn (PDF tải về dạng tệp). Xong thì xoá tệp thử (xoá không tốn phí). Cần các biến `S3_*` trong `backend/.env` (mẫu ở `.env.example`).

```bash
npm run smoke:r2 -- http://localhost:5173 https://<tên miền staging>
```

| Bước hỏng | Thường do |
|---|---|
| CORS | Bucket chưa có CORS Policy cho origin đó (`AllowedMethods` có `PUT`, `AllowedHeaders` có `content-type`) |
| PUT ảnh trả 403 | Sai khoá, hoặc token không có quyền Object Read & Write trên bucket |
| Xem ảnh công khai trả 404 | Tên miền riêng chưa gắn vào bucket công khai, hoặc `S3_PUBLIC_URL` sai |
