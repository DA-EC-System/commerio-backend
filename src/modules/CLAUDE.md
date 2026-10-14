# src/modules/

19 module nghiệp vụ (`docs/17` mục 2). Tên module trùng tên schema PostgreSQL. `registry.ts` liệt kê đủ 19 module cho `app.ts`.

## Cấu trúc một module

```
<tên>/
├─ index.ts        API công khai: ModuleDefinition, hàm cho module khác gọi, kiểu dữ liệu được phép lộ ra
├─ api/            routes, controller, schema Zod cho request/response. Chỉ lớp này biết Express
├─ service/        nghiệp vụ, mở transaction, gọi module khác qua index.ts của module đó
├─ domain/         entity, State Machine, luật thuần. Không I/O, không import lớp nào khác
└─ repository/     schema.ts (bảng Drizzle trong pgSchema của module) và các hàm truy vấn
```

Luồng gọi: `api` → `service` → (`domain`, `repository`). Lớp dưới không gọi ngược lên lớp trên. Repository lấy kết nối bằng `getDb()` để tự đi chung transaction của bên gọi.

## Bảng module

| Module | Dữ liệu | Ghi chú |
|---|---|---|
| `platform` | Công ty, phân hệ đang bật, khoá công ty | Các công ty dùng hệ thống |
| `auth` | Mật khẩu băm, liên kết Google, refresh token | |
| `staff` | Nhân viên, thư mời, khoá tài khoản | |
| `access` | Vai trò có sẵn và tuỳ biến, quyền chi tiết | Mọi module kiểm quyền qua đây |
| `audit` | Nhật ký thao tác | |
| `files` | Thông tin tệp | Nội dung tệp ở SeaweedFS/S3 |
| `catalog` | Danh mục, thuộc tính, sản phẩm, biến thể, quy tắc SKU | Đọc nhiều, sẽ có cache Redis |
| `pricing` | Bảng giá chuẩn, giá theo kênh | |
| `inventory` | Tồn, giữ hàng, phiếu nhập/xuất/nhập hoàn, giá vốn, ngưỡng tồn | **Nơi duy nhất đổi số tồn** |
| `purchasing` | Nhà cung cấp, đơn mua, đợt nhận hàng | |
| `sales` | Đơn hàng, kênh nguồn, hồ sơ khách hàng | |
| `fulfillment` | State Machine duyệt đơn, lịch sử chuyển trạng thái, lô nhặt/đóng gói | Mỗi lần chuyển trạng thái phải ghi lịch sử |
| `finance` | Hoá đơn, phiếu thu, phiếu chi, khoản thu chưa khớp, đối soát | Chứng từ đã ghi sổ không sửa, chỉ lập phiếu đảo |
| `payment` | Mã thanh toán, giao dịch, cấu hình cổng | VNPay, MoMo, ZaloPay, VietQR, chỉ sandbox |
| `channel` | Gian hàng sàn, token, ghép SKU, dữ liệu gốc sàn | Chỉ đọc số tồn khả dụng, không đổi tồn |
| `inbox` | Hội thoại, tin nhắn, nhãn, ghi chú | |
| `notification` | Không có bảng | Đẩy thông báo qua `realtime`, không có `repository/schema.ts` |
| `assistant` | Tài liệu nội bộ, vector | pgvector |
| `report` | Bảng dựng từ sự kiện | Dựng lại được bằng cách phát lại Kafka |

## Thêm nghiệp vụ vào module

1. Khai bảng trong `repository/schema.ts` bằng `<tên>Schema.table(...)`, rồi `npm run db:generate`.
2. Viết `domain` và `service`, kèm unit test đặt cạnh file.
3. Viết `api/` (router + Zod), gắn router vào `ModuleDefinition` trong `index.ts`; `app.ts` tự mount tại `/api/v1/<tên>`.
4. Viết `CLAUDE.md` cho module: nghiệp vụ, bất biến, sự kiện phát và nghe, module nào gọi vào.
