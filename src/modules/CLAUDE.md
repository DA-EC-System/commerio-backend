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
| `identity` | Mật khẩu băm, liên kết Google, refresh token | |
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
| `report` | Bảng dựng từ sự kiện | Dựng lại bằng cách tính lại từ dữ liệu gốc, không phát lại Kafka (Documents/21 D7) |

## Lớp module: ai được gọi ai

Đồ thị gọi giữa module phải không vòng. Module chỉ import `index.ts` của module **cùng lớp hoặc lớp thấp hơn** (bảng dưới, trên xuống là thấp lên cao). `npm run depcruise` kiểm bằng hằng `LAYERS` trong `.dependency-cruiser.cjs`; đổi bảng này thì đổi cả hằng đó.

| Lớp | Module |
|---|---|
| 1 | `platform`, `staff`, `access`, `audit`, `files` (trong lớp: `staff` gọi `access`, `access` không gọi `staff`) |
| 2 | `catalog` |
| 3 | `pricing` |
| 4 | `identity` (đăng ký gọi `pricing` tạo bảng giá chuẩn, V13) |
| 5 | `inventory` |
| 6 | `sales` |
| 7 | `payment` |
| 8 | `finance` |
| 9 | `fulfillment` |
| 10 | `channel`, `report`, `notification`, `purchasing`, `inbox`, `assistant` |

Chỗ cần gọi ngược lớp (vd catalog lấy giá chuẩn của pricing, webhook của payment giao cho finance) đi qua `ModuleContext`: module khai trường mình cần trong kiểu tham số của `router(ctx)`/`startBackground(ctx)`, `src/wiring.ts` truyền hàm của module kia vào. Không dùng biến toàn cục kiểu `configure…`.

## Router và quyền

`router` của module là hàm `(ctx: ModuleContext) => Router`; `app.ts` gắn tại `/api/v1/<tên>`. Mọi module đã có `api/routes.ts` và `api/openapi.ts` rỗng: thêm route vào đó, không cần sửa `index.ts`. Router của `access` và `staff` gắn dưới `/api/v1/identity` (`/identity/roles`, `/identity/permissions`, `/identity/staff`); `notification` chỉ có `openapi` (stream `/api/v1/notification/stream` do tiến trình realtime phục vụ).

```ts
router.post('/products', ctx.authorize('catalog.product.manage'), validate({ body: CreateProductBody }), async (_req, res) => {
  const { companyId } = getAuth(res);
  res.status(201).json(await withCompany(companyId!, () => createProduct(body(res))));
});
```

## Sự kiện giữa module

Phát bằng `publishEvent({ type, aggregateId, payload })` trong giao dịch nghiệp vụ, nghe bằng `registerConsumer(type, handler, { consumer })`, cả hai export từ `platform/index.ts` (thân do #38 viết). Danh mục loại sự kiện và schema Zod của payload ở `platform/domain/events.ts`; tiền trong payload là chuỗi thập phân. Topic `<KAFKA_TOPIC_PREFIX>.<module phát>`, key là `aggregateId`. Thêm loại sự kiện là sửa file dùng chung: PR riêng, báo bên nghe.

Việc nền của module (consumer, tra cứu định kỳ) khai ở `startBackground` của `ModuleDefinition`; `worker` gọi lúc khởi động và dừng khi tắt.

## Thêm nghiệp vụ vào module

1. Khai bảng trong `repository/schema.ts` bằng `<tên>Schema.table(...)`, rồi `npm run db:generate`.
2. Viết `domain` và `service`, kèm unit test ở `test/unit/modules/<tên>/...` (không đặt trong `src/`, xem `test/CLAUDE.md`).
3. Viết `api/` (router + Zod) trong `api/routes.ts` đã có sẵn; `app.ts` tự mount tại `/api/v1/<tên>`.
   Khai Swagger trong `api/openapi.ts` (đã gắn vào `openapi` của `ModuleDefinition`). Dùng **chính schema Zod** đã truyền cho `validate()`, đặt `.meta({ id: 'TenSchema' })` cho schema dùng lại; đường dẫn viết tương đối, giữ `:id` như Express:

   ```ts
   export function registerCatalogOpenApi(registry: OpenAPIRegistry) {
     registry.registerPath({
       method: 'get',
       path: '/products/:productId',
       summary: 'Xem một sản phẩm',
       request: { params: ProductParams },
       responses: {
         200: { description: 'Sản phẩm', content: { 'application/json': { schema: ProductSchema } } },
         404: problemResponse('Không tìm thấy sản phẩm'),
       },
     });
   }
   ```
4. Viết `CLAUDE.md` cho module: nghiệp vụ, bất biến, sự kiện phát và nghe, module nào gọi vào.
