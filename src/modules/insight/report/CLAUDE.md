# src/modules/insight/report/

Báo cáo CEO: tổng quan, lãi theo gian hàng, chuỗi theo ngày, xuất CSV (UC-RP-01, 02; issue #29). Hợp đồng API: `Documents/21` §12.7, kiểu `ReportFigures`/`ShopFigures` ở §12.8; quyết định D7, D18 (§10.8). Phân hệ tuỳ chọn: công ty tắt Report thì API trả 403 `module_disabled`.

## Bảng dựng sẵn

`report.daily_channel_summary`: một dòng mỗi (công ty, ngày giờ VN, nguồn, gian hàng); `shop_id` trống với hộp thư, đơn tạo tay. Bảng **chỉ là bản tính sẵn**: mọi số dựng lại được từ dữ liệu gốc của module nguồn bất cứ lúc nào (D7), không cộng dồn từ sự kiện.

`service/recompute.ts` `recompute(companyId, from, to)`: trong một `withCompany`, khoá công ty (`pg_advisory_xact_lock`), gọi bốn hàm nguồn cho cả khoảng, dựng dòng ở `domain/summary.ts`, xoá rồi chèn lại mọi dòng của khoảng. Gọi lặp, gọi song song cùng công ty đều cho cùng kết quả.

## Cách tính (plan #29 A1, A2, A12)

| Thành phần | Nguồn (`index.ts`) | Ngày |
|---|---|---|
| Doanh thu | `finance.getDailyFinanceTotals`: hoá đơn gốc và đảo (cả gốc đã `reversed`) | ngày ghi hoá đơn; đảo trừ vào ngày đảo |
| Tiền đã thu | phiếu thu có đơn − phiếu chi hoàn tiền khách không nháp | ngày phiếu thu / `paid_on` |
| Phí cổng | `payment.getDailyPaymentFees`: giao dịch `succeeded` có `fee` (hiện chưa cổng nào trả phí → 0) | ngày giao dịch |
| Giá vốn | `inventory.getOrderCogs` × hệ số hoá đơn ròng của (ngày, đơn) | ngày hoá đơn |
| Phí sàn, vận chuyển sàn | Σ `fees`, `shipping_cost` mọi dòng đối soát `kind = order` của đơn × hệ số hoá đơn ròng | ngày hoá đơn |
| Nguồn, gian hàng | `sales.getOrderChannels` | — |

Hệ số hoá đơn ròng = số hoá đơn gốc − số hoá đơn đảo của đơn trong ngày (đếm theo `reversal_of_id`). Lãi = doanh thu − giá vốn − phí sàn − phí cổng − vận chuyển. Mỗi thành phần làm tròn tới đồng (nửa lên, số âm ra xa 0) **một lần trên từng dòng bảng** lúc tính lại; API chỉ cộng số nguyên nên tổng luôn bằng tổng các dòng. `fees_pending`: đơn sàn có hoá đơn ròng dương mà chưa có dòng đối soát. Chứng từ không có đơn (hoàn khoản thu chưa khớp, điều chỉnh của sàn) không vào báo cáo.

## Khi nào tính lại (`service/background.ts`, chạy trong worker)

- Consumer `report-daily-summary` nghe `finance.invoice_posted` (ngày `issuedAt`), `finance.receipt_posted` (`postedAt`), `finance.voucher_posted` (`paidOn`): tính lại đúng ngày đó. Không nghe `payment.succeeded` (luôn đi cùng `receipt_posted`).
- Vòng quét mỗi 15 phút: mọi công ty đã có dòng trong bảng, 60 ngày gần nhất. Bắt thay đổi không có sự kiện (dòng đối soát của #30, giao dịch cổng qua nửa đêm).
- Dựng lại tay (đổi công thức, công ty chưa có dòng nào):

  ```bash
  node --env-file=.env src/modules/insight/report/service/rebuild.ts <companyId> <from YYYY-MM-DD> [to YYYY-MM-DD]
  ```

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

`test/integration/report/` (helper riêng `helpers.ts`: chứng từ, chứng từ đảo, dòng đối soát, giao dịch cổng ghi bằng SQL trong `withCompany`; phiếu xuất bằng hàm của inventory), `test/unit/modules/report/domain/`.
