# Sàn giả lập Lazada (#115)

Tạo các tình huống khó có trên shop thử Lazada: giao thất bại, thất lạc, khách trả hàng, chỉ hoàn tiền, quyết toán lệch, token hết hạn. Dữ liệu demo: **Công ty Thời trang ABC bán áo thun** (shop `Thời trang ABC`, đơn `600000000000001` gồm 2 áo: `ATH-TRANG-M`, `ATH-DEN-L`, mỗi áo 129.000 đ, phí giao 30.000 đ).

## Thành phần

| Thành phần | Ở đâu | Việc |
|---|---|---|
| `lazada-wiremock` | `deploy/compose.yaml`, cổng `127.0.0.1:8091` | WireMock giữ stub có trạng thái (scenario); cổng này là admin API |
| `lazada-mock` | `deploy/compose.yaml`, cổng `127.0.0.1:8090`; code `gate.ts` | Cổng trước WireMock: kiểm chữ ký như Lazada (WireMock không tính được HMAC), giả trang uỷ quyền OAuth `/oauth/authorize`. Chạy trong container Node, không cần Node trên máy |
| `stubs.ts` | thư mục này | Dữ liệu demo và mapping của từng kịch bản |
| `index.ts` | `npm run mock:lazada` | Nạp kịch bản, chuyển bước, gửi push có ký, kiểm adapter |

App ký đúng thì cổng chuyển request nguyên vẹn sang WireMock. Ký sai trả `IncompleteSignature`, sai `app_key` trả `InvalidAppKey`, đường dẫn lạ trả `InvalidApiPath`, cùng dạng lỗi của Lazada (`type`, `code`, `message`, `request_id`, HTTP 200).

## Chạy

```bash
# 1. Bật (chỉ hai container này, không cần Postgres, Kafka)
docker compose -f deploy/compose.yaml --profile lazada-mock up -d lazada-wiremock lazada-mock

# 2. Trỏ app sang sàn giả lập: thêm vào .env rồi chạy lại app
LAZADA_APP_KEY=mock-app-key
LAZADA_APP_SECRET=mock-app-secret
LAZADA_API_URL=http://127.0.0.1:8090/rest
LAZADA_AUTH_URL=http://127.0.0.1:8090

# 3. Nạp một kịch bản, kiểm adapter của app gọi được
npm run mock:lazada -- load giao-thanh-cong
npm run mock:lazada -- check

# Tắt
docker compose -f deploy/compose.yaml --profile lazada-mock down
```

Kết nối gian hàng trên app: trang uỷ quyền giả chuyển ngay về `LAZADA_REDIRECT_URL` kèm `code`, đổi được lấy token `mock-access-token`.

## Lệnh

| Lệnh | Việc |
|---|---|
| `list` | Các kịch bản và các bước |
| `load <kịch bản>` | Xoá mapping cũ, nạp kịch bản, đặt bước đầu |
| `next` | Sang bước sau (đơn trước, rồi yêu cầu trả), gửi push như Lazada báo thay đổi |
| `run <kịch bản>` | `load` rồi `next` tới bước cuối: chạy lại trọn kịch bản bằng một lệnh |
| `state` | Kịch bản đang nạp và bước hiện tại |
| `push [order_status]` | Gửi push của bước hiện tại (hoặc trạng thái chỉ định) cho cả hai dòng đơn |
| `check` | Ký sai bị chặn; adapter của app đổi token, đọc shop, danh mục, SKU, cập nhật giá tồn; đọc đơn |

## Kịch bản

| Kịch bản | Đơn | Yêu cầu trả | Ghi chú |
|---|---|---|---|
| `giao-thanh-cong` | pending → packed → ready_to_ship → shipped → delivered | | Quyết toán khớp khi đã giao |
| `giao-that-bai` | … → shipped → failed_delivery → shipped_back → shipped_back_success | | Hàng hoàn về kho |
| `that-lac` | … → shipped → lost_by_3pl | | |
| `tra-mot-phan` | delivered | RETURN cho áo trắng: REQUEST_INITIATE → AGREE_RETURN → BUYER_RETURN_ITEM → REFUND_SUCCESS | Hoàn xong thì quyết toán có dòng `Reversal Item Price`, `Reversal Commission` |
| `chi-hoan-tien` | delivered | ONLY_REFUND: REQUEST_INITIATE → REFUND_SUCCESS | Khách giữ hàng |
| `quyet-toan-lech` | delivered | | `Commission` 8% thay vì 4%, thêm phí quảng cáo 5.000 đ |
| `token-het-han` | pending | | Mọi API trả `IllegalAccessToken`, làm mới trả `IllegalRefreshToken`; đổi `code` lấy token (kết nối lại) thì hết |

**Bước do app gọi cũng chuyển trạng thái:** `/order/fulfill/pack` (pending → packed), `/order/package/rts` (packed → ready_to_ship), `/order/package/repack` (packed → pending), `/order/reverse/cancel/create` (pending, packed → canceled), `/order/reverse/return/update` (chấp nhận sang bước kế; tham số hoặc body chứa `refuse` thì sang `REQUEST_REJECT`). Gọi sai trạng thái thì nhận lỗi: RTS hay lấy nhãn khi chưa RTS trả `30012 rts package not found` như Lazada thật; pack lại, huỷ đơn đã giao, xử lý yêu cầu trả đã xong trả mã giả `ORDER_STATUS_INVALID`, `CANCEL_NOT_ALLOWED`, `REVERSE_STATUS_INVALID`.

## Push vào webhook của app

`next`, `run`, `push` gửi tin như Lazada Message Service tới `LAZADA_MOCK_WEBHOOK_URL` (mặc định `http://localhost:3000/api/v1/channel/webhooks/lazada`, route của #133), header `Authorization` = `hex(HMAC_SHA256(app_secret, app_key + rawBody))` (`Documents/tich-hop-san/lazada.md` §8). Mỗi dòng đơn một tin. Dùng thử realtime khi chưa có chứng chỉ OV (#135).

## Biến môi trường

| Biến | Mặc định | Dùng ở |
|---|---|---|
| `LAZADA_MOCK_APP_KEY`, `LAZADA_MOCK_APP_SECRET` | `mock-app-key`, `mock-app-secret` | Cổng (compose) và lệnh; phải trùng `LAZADA_APP_KEY`, `LAZADA_APP_SECRET` của app |
| `LAZADA_MOCK_URL` | `http://127.0.0.1:8090` | Lệnh `check` |
| `LAZADA_MOCK_ADMIN_URL` | `http://127.0.0.1:8091` | Lệnh: admin API của WireMock |
| `LAZADA_MOCK_WEBHOOK_URL` | `http://localhost:3000/api/v1/channel/webhooks/lazada` | Push |

## Độ tin cậy của response

- **Khớp code của app:** token, `/seller/get`, danh mục, thuộc tính, ảnh, tạo sản phẩm, `/products/get`, cập nhật giá tồn, ngừng bán. Lấy theo dữ liệu mẫu trong test của adapter (#103, #104), `check` chạy bằng chính adapter.
- **Theo tên trường ở `lazada.md` §7.3–§7.6, chưa đối chiếu response thật:** đơn, món, hành trình, quyết toán, yêu cầu trả. Shop thử không có token trên máy soạn (28/10/2026): khi có, gọi `npm run smoke:lazada -- call GET <path> …` rồi sửa `stubs.ts` cho khớp.
- **Theo API Reference, chưa gọi thật:** pack, RTS, nhãn, huỷ, xử lý yêu cầu trả, lý do, lịch sử trả, đơn vị vận chuyển; `message_type` của push đơn ngược.
- Chưa có: staging (cần manifest trong `deploy/k8s`).
