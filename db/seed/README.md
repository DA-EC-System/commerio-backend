# Seed demo qua API thật

Chạy `npm run infra:up`, `npm run db:migrate`, đặt `SEED_PASSWORD` trong môi trường local,
rồi `npm run db:seed`. Node 24. Không cần chạy API riêng; seed mở server loopback trên cổng ngẫu nhiên rồi đóng.
Không tạo refresh token, không gọi dịch vụ sàn, không dùng SQL ghi bảng nghiệp vụ.
Router lấy từ module công khai qua `createApp`, nên vẫn kiểm quyền, Zod, RLS, CHECK, audit và máy trạng thái.

Tài khoản công ty Demo Commerio: `ceo@commerio.dev`, `admin@commerio.dev`,
`sale@commerio.dev`, `kho@commerio.dev`, `mua@commerio.dev`. Công ty Demo Cách Ly chỉ có
`ceo2@commerio.dev`. Tất cả dùng `SEED_PASSWORD`; seed kiểm mật khẩu trước khi dùng tài khoản đã có.
Tên người, NCC, địa chỉ đều gắn nhãn demo/giả lập; MST mới dùng dãy 0 giả lập, không dùng làm chứng từ thật.

## Phần chạy được

- Bật toàn bộ module tùy chọn, cả công ty demo cũ. Assistant nhận consent cho dữ liệu demo theo yêu cầu bật đủ module.
- 12 sản phẩm, 16 SKU; 4 sản phẩm nhiều biến thể, 1 sản phẩm lưu trữ ở lần tạo mới. Nội dung tham khảo mock FE, không import mock.
- 3 ngưỡng nhập lại. Tồn thực vẫn bằng 0; có số đang về từ đề nghị đã đặt NCC.
- 3 NCC, 7 đề nghị: nháp, chờ duyệt, đã duyệt, trả về, từ chối, đã đặt NCC, CEO tự duyệt.
  Đề nghị thường do Mua hàng tạo, CEO duyệt; trường hợp cuối CEO tự tạo và duyệt (`self_approved`).
  Ngày giao dự kiến tính sau ngày chạy 7 ngày. Mã `DN-…` do service cấp, không ép mã FE.
- Công ty thứ hai: 1 CEO, 3 sản phẩm/4 SKU để kiểm RLS.

`npm run db:seed -- --only purchasing` tự tạo tài khoản/module và catalog phụ thuộc.
Các phần hợp lệ: `all`, `catalog`, `inventory`, `purchasing`, `secondary`.
CLI in số đối tượng của bộ demo (gồm dòng đã có), không phải số dòng mới chèn.
Khoá phiên PostgreSQL ngăn hai seed chính cùng chạy. Cần kết nối trực tiếp hoặc session pooler.
Định danh dữ liệu bằng tên `[DEMO]` và note `[DEMO:v1:purchase:N]`; không sửa/xoá bản ghi đã có.
Không đổi các nhãn này nếu muốn chạy lại nhận ra dữ liệu cũ. Seed không tua lại trạng thái đã thao tác bằng tay.
Nếu bị dừng giữa chuỗi thao tác đề nghị, bản đã tạo được giữ ở bước cuối thành công; seed sau bỏ qua bản đó,
có thể hoàn tất bằng Swagger. Không tự duyệt lại một chứng từ mà người dùng có thể đã sửa.

## Phần bị chặn bởi repo hiện tại

| Yêu cầu | Bằng chứng / lý do chưa tạo |
|---|---|
| Hai kho, tồn đầu kỳ, nhận thiếu, trả NCC | `inventory/CLAUDE.md`: chưa có cổng ghi sổ; `stock_levels` chỉ khóa công ty/SKU, không có kho. `purchasing/CLAUDE.md`: phiếu nhận #109 và trả NCC B4 chưa làm. Không INSERT tồn/chứng từ giả. |
| Nháp/đang bán/ngừng bán, bảng giá | Catalog chỉ có tạo/sửa/lưu trữ; vòng đời SKU #110 chưa có. Mô hình 19 D9 đã bỏ bảng giá, `standard_price` chưa có API ghi. Không sửa enum hay ghi giá bằng SQL. |
| Hai gian hàng active không token | Public API nối sàn cần adapter xác minh token; `index.ts` không có cổng tạo shop giả hay tiêm adapter. Không thêm bypass vào code chính hoặc token giả để worker gọi sàn thật. |
| 20 đơn, COD/trả trước, giao/huỷ/trả | Router `sales` và `fulfillment` rỗng; index chỉ có các cổng đọc. Chưa có service tạo/chuyển đơn/kiện. |
| Sổ tiền, profit, tax-warnings có số | Finance có hàm ghi sổ theo sự kiện, nhưng chưa có đơn/kiện hợp lệ làm nguồn. Không phát sự kiện giả với UUID không có chứng từ, không INSERT sổ cái. Vì thế chưa có doanh thu 2–3 tháng. |

Đây là bộ demo cho các chức năng **đã triển khai**, chưa đáp ứng toàn bộ kịch bản end-to-end được yêu cầu.
Không đổi code chính hay mô hình dữ liệu để vượt qua các phần còn thiếu.

## Thử bằng Swagger / FE

Mở `/api/docs`, `POST /api/v1/identity/login`, rồi `POST /api/v1/identity/select-company`.
Dùng accessToken sau chọn công ty trong Authorize. Thử:

- `GET /api/v1/catalog/products` (11 đang hoạt động trên DB mới), `?status=archived` (1).
- `GET /api/v1/inventory/stock` (tồn 0, ngưỡng và đang về có dữ liệu).
- `GET /api/v1/purchasing/requests` (7), `/suppliers` (3).
- Đăng nhập CEO2: 3 sản phẩm, 0 đề nghị; truy cập ID sản phẩm công ty một trả 404.

FE cần dùng BE thật và tắt MSW theo cấu hình của FE; menu Kênh bán được bật nhưng danh sách shop chưa có.

## Kết quả kiểm tra 29/10/2026

- `npm run infra:up`, `npm run db:migrate`, `npm run db:seed` hai lần: thành công trên DB local hiện có.
- Integration seed: 11 test đạt, PostgreSQL container mới tự chạy migration từ DB trống.
  So số dòng mọi bảng có `company_id` của hai công ty trước/sau lần seed hai, gồm audit/outbox/lịch sử.
  Kiểm hai kiểu duyệt, đăng nhập Mua hàng, module bật và truy cập chéo công ty trả 404.
- `npm run check`: 177 file, 1.435 test đạt, 2 TODO có sẵn; lint, typecheck, depcruise đạt.
- Smoke đăng nhập `ceo@commerio.dev`, chọn công ty và gọi ba endpoint HTTP: đều 200, có dữ liệu.
  Không thao tác trực tiếp UI Swagger hoặc chạy FE trong lượt này. DB local có 12 sản phẩm active vì đã chạy
  trước khi thêm mẫu lưu trữ; seed giữ nguyên dữ liệu cũ. DB test mới xác nhận 11 active + 1 archived.
