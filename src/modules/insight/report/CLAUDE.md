# src/modules/insight/report/

Số liệu trang Tổng quan và báo cáo CEO: tổng quan, theo gian hàng, chuỗi theo ngày, xuất CSV (UC-RP-01, 02; #29, #333). Hợp đồng: `Documents/21` §21.5, quyết định D7, D18 (§10.8). Phân hệ tuỳ chọn: công ty tắt Report thì API trả 403 `module_disabled`.

## Nguồn số: sổ tiền, không bảng dựng sẵn (#333)

Mỗi lần gọi gom thẳng `finance.ledger_entries` qua `finance.getDailyLedgerFigures(from, to, scope)` (SQL ở `finance/finance/repository/ledger.ts` `dailyFigures`), trong `withCompany` của người xem. Luật do finance giữ, report không tự đọc bảng của finance:

- chỉ dòng còn hiệu lực (`isReplaced`: dòng ước tính hết tính khi có dòng thực tế thay qua bảng nối hoặc cùng nguồn);
- mốc ngày `occurred_on`, khoảng gồm hai đầu;
- bỏ hẳn `NOT_SALES_PROFIT` (trả NCC, NCC hoàn tiền, chi vận hành, COD tự giao, rút tiền, quảng cáo).

`ReportFigures` (`domain/figures.ts` `sumFigures`, thuần), tiền mang dấu như sổ (khoản ra âm):

| Trường | Là |
|---|---|
| `revenue` | Doanh thu thuần: `revenue` + `customer_refund` |
| `net` | Thực nhận: mọi dòng tiền còn lại, trừ `cogs`, `cogs_reversal` |
| `cogs`, `profit` | Giá vốn (âm), lãi gộp = `net` + `cogs`; `null` khi thiếu `inventory.cost.view` |
| `cashCollected` | Phần `net` từ dòng thực tế |
| `platformFee`, `shippingFee` | Bốn loại `fee_*`; `shipping_cost` + `shipping_income` |
| `paymentFee` | Luôn 0 |
| `estimated` | Còn dòng tiền ước tính; `feesPending` bằng nó, giữ cho bên gọi cũ |

GTGT đầu ra chưa trừ, cùng cách với `/finance/orders/profits` (đổi theo #231). Nguồn: dòng có gian hàng là `marketplace`, không có là `manual`; `inbox` luôn rỗng (sổ không tách đơn hộp thư). Mọi loại dòng còn lại sau khi bỏ `NOT_SALES_PROFIT` đều là khoản của gian hàng, nên thực tế chỉ có `marketplace`.

`asOf`: `created_at` lớn nhất của các dòng trong khoảng; `null` khi không có dòng.

## Bảng cũ `insight.daily_channel_summary`

Không còn đọc, không còn ghi số (#235 gỡ phần tính lại, #333 gỡ phần đọc). Bảng xoá ở một migration sau (`Documents/19` mục 3.6). Còn `deleteShopSummaries(shopId)` (export ở `index.ts`, #398): channel xoá gian hàng gọi qua `ctx.deleteShopSummaries` (`src/wiring.ts`) để dọn dòng cũ, `deleted.reportRows` của response xoá gian hàng đếm số đó. Xoá bảng thì bỏ luôn hàm, trường `ctx` và `reportRows` (hợp đồng #398).

## API (`api/routes.ts`, gắn tại `/api/v1/report`)

`/overview`, `/shops`, `/daily`, `/self-approvals`, `/export?report=overview|shops|daily`. Quyền: chỉ `report.dashboard.view` (CEO, Admin; #333 bỏ `finance.invoice.view`); xuất thêm `report.dashboard.export`; `cogs`, `profit` cần `inventory.cost.view`, thiếu thì `null` và CSV bỏ hai cột (đọc quyền từ DB mỗi request). Khoảng ngày (`domain/figures.ts` `resolveRange`): mặc định 30 ngày tới hôm nay giờ VN, tối đa 366 ngày. Tên gian hàng lấy qua `channel.getShops` (phải gọi trong `withCompany`).

CSV (`domain/csv.ts`): UTF-8 có BOM, CRLF, tiêu đề tiếng Việt; ô chữ bắt đầu bằng `= + - @` thêm dấu nháy (chặn công thức Excel).

## Test

`test/integration/insight/report/` (helper riêng `helpers.ts`: `shopOf`, `ledgerRow`, `replaces` ghi thẳng sổ tiền; `summaryRow` cho bảng cũ), `test/unit/modules/insight/report/domain/`.
