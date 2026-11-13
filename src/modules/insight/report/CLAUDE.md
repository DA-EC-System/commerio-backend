# src/modules/insight/report/

Báo cáo CEO: tổng quan, lãi theo gian hàng, chuỗi theo ngày, xuất CSV (UC-RP-01, 02; issue #29). Hợp đồng API cũ: `Documents/21` §12.7 (mục 12 đã bỏ), kiểu `ReportFigures`/`ShopFigures` ở §12.8; quyết định D7, D18 (§10.8). Phân hệ tuỳ chọn: công ty tắt Report thì API trả 403 `module_disabled`.

## Bảng dựng sẵn

`report.daily_channel_summary`: một dòng mỗi (công ty, ngày giờ VN, nguồn, gian hàng); `shop_id` trống với hộp thư, đơn tạo tay. Bảng **chỉ là bản tính sẵn**: mọi số dựng lại được từ dữ liệu gốc của module nguồn bất cứ lúc nào (D7), không cộng dồn từ sự kiện.

**#235 gỡ phần tính lại** (`service/recompute.ts`, `background.ts`, `rebuild.ts`, `domain/summary.ts` `buildSummaryRows`): nó đọc hoá đơn, phiếu thu, phiếu chi và phí cổng kiểu cũ (`finance.getDailyFinanceTotals`, `payment.getDailyPaymentFees`), không còn code ghi. Bảng không còn được cập nhật; API vẫn đọc bảng như cũ. Tính báo cáo từ sổ tiền (`finance.ledger_entries`, Documents/21 mục 11 "báo cáo tính từ sổ thu chi mục 21.1") làm ở issue riêng: cần chốt dòng ước tính hay thực tế, ngày nào, "tiền đã thu" lấy gì.

## API (`api/routes.ts`, gắn tại `/api/v1/report`)

`/overview`, `/shops`, `/daily`, `/export?report=overview|shops|daily`. Quyền: `report.dashboard.view` **và** `finance.invoice.view` (Admin có sẵn không xem được); xuất thêm `report.dashboard.export`; `cogs`, `profit` cần `inventory.cost.view`, thiếu thì `null` và CSV bỏ hai cột (đọc quyền từ DB mỗi request). `report.dashboard.view` đứng đầu chuỗi `authorize` để phân hệ tắt ra `module_disabled` trước `forbidden`. Khoảng ngày (`domain/figures.ts` `resolveRange`): mặc định 30 ngày tới hôm nay giờ VN, tối đa 366 ngày. Tên gian hàng lấy qua `channel.getShops`.

CSV (`domain/csv.ts`): UTF-8 có BOM, CRLF, tiêu đề tiếng Việt; ô chữ bắt đầu bằng `= + - @` thêm dấu nháy (chặn công thức Excel).

## Giới hạn đã biết

- Công ty chưa có dòng nào không được vòng quét thấy (không có hàm liệt kê công ty ở platform): sự kiện đầu tiên bị DLQ thì chạy `rebuild.ts`.
- Đảo hoá đơn mà hàng không về kho: giá vốn vẫn bị trừ ngược theo hoá đơn đảo.
- Hoàn tiền cho đơn đã giao mà không đảo hoá đơn chỉ giảm tiền đã thu, không giảm doanh thu.
- Đảo rồi lập lại hoá đơn trong cùng ngày cho hệ số 0: hoá đơn mới chưa đối soát không bật `fees_pending` (chưa có luồng lập lại hoá đơn).
- Danh sách đơn đi thành tham số bind: dựng lại một khoảng có hơn ~65.000 đơn thì chia khoảng nhỏ hơn.
- Hàm nguồn và `channel.getShops` phải gọi trong `withCompany` (ném lỗi nếu không), vì ngoài đó là role chủ bảng.

## Test

`test/integration/insight/report/` (helper riêng `helpers.ts`: `shopOf`, `summaryRow` ghi thẳng dòng bảng dựng sẵn), `test/unit/modules/report/domain/`.
