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

## Không có bảng

Bảng cũ `insight.daily_channel_summary` và enum `insight.order_source` đã xoá (migration `*_bo-daily-channel-summary`, #333; `Documents/19` mục 3.6). Response xoá gian hàng (#398) bỏ `reportRows` theo (`Documents/21` mục 18.6.12). Thêm bảng tính sẵn về sau thì phải có lý do đo được (sổ quá lớn), ghi vào Documents trước.

## API (`api/routes.ts`, gắn tại `/api/v1/report`)

`/overview`, `/shops`, `/daily`, `/self-approvals`, `/export?report=overview|shops|daily`. Quyền: chỉ `report.dashboard.view` (CEO, Admin; #333 bỏ `finance.invoice.view`); xuất thêm `report.dashboard.export`; `cogs`, `profit` cần `inventory.cost.view`, thiếu thì `null` và CSV bỏ hai cột (đọc quyền từ DB mỗi request). Khoảng ngày (`domain/figures.ts` `resolveRange`): mặc định 30 ngày tới hôm nay giờ VN, tối đa 366 ngày. Tên gian hàng lấy qua `channel.getShops` (phải gọi trong `withCompany`).

CSV (`domain/csv.ts`): UTF-8 có BOM, CRLF, tiêu đề tiếng Việt; ô chữ bắt đầu bằng `= + - @` thêm dấu nháy (chặn công thức Excel).

## Test

`test/integration/insight/report/` (helper riêng `helpers.ts`: `shopOf`, `ledgerRow`, `replaces` ghi thẳng sổ tiền), `test/unit/modules/insight/report/domain/`.
