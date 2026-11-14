# Spec: Tách kiện trong app (#205)

- **Ngày:** 14/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#205, `Documents/21` §11.1, §18.4, §19.2, `Documents/25` §7.4, §8, §8.1, §8.3, `Documents/19` (bảng `packages`, `package_lines`, `order_lines`), `Documents/27` US-DH-19, `Documents/tich-hop-san/lazada.md` §11.2
- **Trạng thái:** nháp, chờ Khang duyệt
- **Nền:** `main` 15a0f93 (đã có #199 a/b/c, #206, #200, #239, cổng tách TikTok của #221)

---

## 1. Mục tiêu và tiêu chí thành công

1. Kho tách một kiện chưa đóng gói (`reserved`, `backordered`) thành nhiều kiện qua `POST /fulfillment/packages/:id/split`, để gửi phần có hàng trước. Mỗi kiện một mã kiện app; kiện sàn sau đó có mã kiện sàn và vận đơn riêng.
2. Hàng đã giữ đi theo món: kiện `reserved` tách ra thì mọi kiện con vẫn `reserved`. Kiện `backordered` tách ra thì phần đủ hàng sang `reserved` ngay, phần thiếu ở `backordered`.
3. Lượt kéo đơn định kỳ không phá kiện đã tách và không bật cờ "Sàn chia lại kiện" cho cách chia do chính app làm.
4. CSDL tự chặn dữ liệu vi phạm bất biến dòng kiện (`25` §8), không dựa vào bên gọi. Đi hai bước (mục 6): PR 1 chặn món bị nhân đôi, PR 2 siết thành kiểm bằng tuyệt đối.

Đo bằng: AC ở mục 9 đều qua; `npm run check` xanh; trên shop thử Lazada tách trong app rồi đóng gói từng kiện ra hai `package_id`, hai vận đơn.

**Vì sao làm ngay:** #205 chặn phần app của #221 (đơn và kiện TikTok); team test trọn luồng trên staging ngày 15/11/2026.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (15a0f93):**

- `fulfillment/api/routes.ts` chưa có `split`; `src/` chưa có mã lỗi `package_sealed`.
- Máy trạng thái kiện (`domain/package.ts`) không có mũi tên tách; `SEALED = packed, awaiting_pickup`.
- Dòng đơn sàn: mỗi món sàn một `order_line` số lượng 1 (`sales/service/ingest.ts`), nên tách kiện sàn là chuyển nguyên dòng kiện sang kiện khác. Dòng số lượng lớn hơn 1 chỉ có ở đơn tạo tay (chưa thuộc MVP).
- CHECK `package_lines_reserved_whole`: `reserved_qty` là 0 hoặc đủ `quantity`. Kiện `reserved` giữ đủ mọi dòng đã ghép SKU; kiện `backordered` không giữ dòng nào.
- Cổng tồn `reserve(packageId, lines)`, `release(packageId, lines)` của inventory **không ghi theo kiện**: inventory chỉ giữ tổng đang giữ theo SKU (`product/inventory/service/reservation.ts`, tham số `packageId` chỉ dùng trong câu báo lỗi). Chuyển dòng đang giữ từ kiện này sang kiện khác không đổi tổng, nên không cần gọi cổng tồn.
- Phân hàng: `runAllocation(ctx, { variantIds })` (`service/allocation.ts`) tự lấy khoá advisory `fulfillment.allocation:<công ty>`, giữ nguyên kiện, chuyển `backordered → reserved` (mũi tên `hold`), phát `fulfillment.allocation_done`. Thứ tự khoá đã chốt ở spec 199b §5.10: gian hàng → advisory → kiện → dòng tồn → `doc_counters`.
- Đồng bộ kiện sàn (`service/platform-packages.ts`, `syncPlatformPackages`): gom món theo mã kiện sàn (`packageCode ?? ''`), tìm kiện app theo mã, không có thì lấy kiện đang chứa **món đầu tiên** của nhóm. Món trong nhóm thuộc kiện app khác thì `resplit = true`, sales bật Cần xử lý trên đơn với ghi chú "Sàn chia lại kiện khác lần trước" (`sales/service/ingest.ts:243`).
- Món Lazada chưa đóng gói không có `package_id`, nên mọi món chờ của đơn rơi vào nhóm mã rỗng. **Sau khi tách trong app, lượt kéo 5 phút sẽ gom hai kiện app về một nhóm, bật cờ `resplit` và áp trạng thái lên một kiện.** #205 phải sửa chỗ này.
- Cổng `ctx.marketplacePackages.split(companyId, shopId, externalOrderId, groups)` (channel `service/order-actions.ts`, tiêm ở `src/wiring.ts`): đọc thuộc tính tách trước, sàn không cho tách thì 422 `split_not_supported` kèm câu của sàn; trả mã kiện sàn theo thứ tự nhóm. Fulfillment chưa gọi.
- `capabilities.splitLevel` khai theo adapter: Lazada `unit`, TikTok `sku`, còn lại `none` (`channel/domain/shop.ts`). Fulfillment chưa có đường đọc.
- Mã kiện app `KH-000001` cấp từ `order.doc_counters` do sales giữ (`code('KH', 'package')`); fulfillment chưa có đường xin mã.
- Hợp đồng `21` §19.2: body `{ version, parts: { variantId, quantity }[][] }`, trả `Order`. FE `SplitPackageDialog` gửi đúng một phần (`parts: [part]`), lọc bỏ dòng chưa ghép SKU, không dùng thân phản hồi (chỉ tải lại dữ liệu).
- `package_lines` chỉ có index theo `package_id`, `variant_id`; chưa có index theo `order_line_id`.
- Khi sàn huỷ lẻ một món, app **không gỡ món khỏi kiện**: kiện chỉ đổi khi mọi món của nó bị huỷ. `order_lines` không có cột ghi số đã huỷ. "Huỷ dòng" của `25` §8.3 chưa ai làm.

**Ràng buộc:**

- `order` ở lớp 3, không import `channel`. Fulfillment không import sales (sales đã import fulfillment): hàm của sales đi qua `withContext` ở `order/index.ts`, hàm của channel đi qua `src/wiring.ts`.
- Gọi sàn ngoài giao dịch nghiệp vụ, ghi DB sau. Code ngoài adapter rẽ nhánh theo năng lực, không theo mã sàn.
- Module `channel` và `sales` có phần của Thành: đổi `order-actions.ts`, `wiring.ts`, `ingest.ts` thì Thành review.
- Migration sinh ở bước cuối của mỗi PR; trigger viết trong migration `--custom`. Staging là PostgreSQL 17, user không phải superuser.
- Code lệch Documents thì sửa Documents trước (mục 8).

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| D1 | **Bất biến ép ở CSDL tới mức kiểm bằng tuyệt đối** (cách B), đi hai PR (B2). PR 1: tách kiện, sửa đồng bộ, trigger chặn tổng **vượt** số lượng dòng đơn. PR 2: `order_lines.cancelled_qty`, gỡ món huỷ khỏi kiện, `package_lines.pending_drop_qty`, siết trigger thành kiểm **bằng** | Khang chọn B rồi B2 ngày 14/11/2026. Kiểm bằng cần biết "số lượng còn hiệu lực", tức phải làm huỷ dòng và đụng luồng nhận đơn. Tách hai PR để tách kiện kịp buổi test 15/11 và rủi ro của huỷ dòng không đè lên luồng nhận đơn đang chạy. Đã loại: A (chỉ chặn vượt, dừng ở đó); B1 (một PR, không kịp test) |
| D2 | Kiện cũ giữ phần còn lại; mỗi phần tử của `parts` thành một kiện mới. Dòng chưa ghép SKU ở lại kiện cũ | `parts` chỉ theo `variantId` nên không chỉ được dòng chưa ghép; FE cũng đang lọc các dòng đó. Claude đề xuất |
| D3 | Tách không là mũi tên của máy trạng thái. Kiện mới ghi lịch sử `create` (người làm là người bấm, lý do "Tách từ <mã kiện cũ>"). Kiện cũ ghi một dòng lịch sử `split` với `from = to` = trạng thái lúc tách, lý do liệt kê mã các kiện mới. Chuyển `backordered → reserved` sau đó do phân hàng ghi (`hold`) | US-DH-19 ghi "tách kiện chưa là mũi tên trên sơ đồ D2". Lịch sử trên cả hai kiện để truy được nguồn gốc. Claude đề xuất |
| D4 | Phần giữ hàng: kiện `reserved` tách thì dòng mang nguyên `reserved_qty` sang kiện mới, **không gọi cổng tồn**; kiện mới `reserved`, `reserved_at` chép từ kiện cũ. Kiện `backordered` tách thì các kiện con đều `backordered`, rồi gọi `runAllocation(ctx, { variantIds })` cho SKU của các kiện con trong cùng giao dịch | Inventory không ghi phần giữ theo kiện nên chuyển dòng không đổi tổng. Dùng lại lượt phân hàng để có một luật ưu tiên duy nhất (`25` §7.4), một chỗ phát `allocation_done`. Hệ quả: kiện `backordered` của đơn khác cùng SKU có hạn giao sớm hơn có thể được xét trước. Claude đề xuất |
| D5 | Gian hàng đang chờ kiểm kê đầu kỳ vẫn tách được; lượt phân hàng tự bỏ qua kiện của gian hàng đó | Tách chỉ sắp lại dòng, không giữ thêm hàng; `runAllocation` đã lọc gian hàng chờ kiểm kê |
| D6 | Rẽ nhánh theo `splitLevel`, đọc qua hàm mới `ctx.marketplacePackages.splitLevel(companyId, shopId)`. Kiện không có gian hàng (đơn tay) coi như `unit` | Không rẽ theo mã sàn. Đặt trong `marketplacePackages` vì đã là cổng kiện của channel; không thêm trường `ctx` mới |
| D7 | `sku` (TikTok): ba bước như đóng gói (#239 D1), trong khoá phiên theo kiện: (1) giao dịch ngắn đọc và kiểm; (2) gọi sàn tách ngoài giao dịch; (3) giao dịch ghi. Sàn từ chối thì không tách trong app. Ở bước 3, sàn đã tách rồi nên **không so `version`**: khoá lại, kiểm kiện còn `reserved`/`backordered` và còn đủ các dòng định chuyển thì ghi; không thì ném lỗi và log `error` | Sàn đã nhận lệnh tách thì không hoàn tác được; so `version` ở bước 3 sẽ bỏ lỡ lần ghi chỉ vì lượt kéo đơn vừa cập nhật mã vận đơn. Claude đề xuất |
| D8 | `sku`: một SKU không được nằm ở hai kiện. Chuyển một phần số lượng của một `variantId`, hoặc cùng `variantId` ở hai phần, thì 422 `split_not_supported`, không gọi sàn | Đúng `21` §19.2, US-DH-19 dòng 2. Gọi thật 07/11/2026 sàn có nhận tách cùng SKU, nhưng capability vẫn khai `sku` cho chắc (`channel/CLAUDE.md`) |
| D9 | Route trả `Order` đúng hợp đồng: sales tiêm `ctx.orderViewOf(orderId)` (bọc `getOrder` của sales) qua `withContext` ở `order/index.ts`. Mã kiện mới xin qua `ctx.nextPackageCode()` tiêm cùng chỗ | Fulfillment không dựng được `Order` và không giữ bộ đếm mã. Người có `fulfillment.order.process` nhận `Order` của đúng đơn vừa thao tác dù không có `sales.order.view`: hợp đồng đã chốt như vậy |
| D10 | Sửa đồng bộ: nhóm món **không có mã kiện sàn** chia tiếp theo kiện app đang chứa từng món; mỗi nhóm con áp vào kiện của nó, không bật `resplit`. Nhóm có mã kiện sàn giữ nguyên cách xử lý cũ | Món chưa có mã sàn thì sàn chưa nói gì về cách chia, nên cách chia của app là đúng. Món đã có mã sàn mà lệch kiện app vẫn là "sàn chia lại" (#238) |
| D11 | Trigger là constraint trigger `DEFERRABLE INITIALLY DEFERRED`, kiểm lúc commit, chỉ trên dòng đơn có dòng kiện vừa đổi. Hàm trigger **không khoá** dòng `order_lines`, chỉ đọc. Dòng kiện trỏ tới dòng đơn không tồn tại thì bỏ qua | Trong một giao dịch, dòng kiện đi qua trạng thái trung gian nên phải kiểm cuối giao dịch. Không khoá vì luồng nhận đơn khoá `order_lines` (upsert) trước rồi mới khoá kiện, còn tách khoá kiện trước: trigger khoá `order_lines` lúc commit sẽ thành vòng khoá `40P01`, và ở nhánh `sku` nạn nhân là lần ghi sau khi sàn đã tách. Hai giao dịch cùng đổi dòng kiện của một dòng đơn đã bị xếp hàng bằng khoá kiện, nên trigger không cần tự xếp hàng. Test hiện có chèn dòng kiện không có dòng đơn (`constraints.test.ts`). Người soát chỉ ra, Claude chốt |
| D13 | Nhánh `sku`, PR 1 chỉ tách khi kiện đang tách là **kiện chưa huỷ duy nhất** của đơn; đơn đã có từ hai kiện chưa huỷ thì 422 `split_not_supported` ("Đơn đã có nhiều kiện trên sàn, chưa tách tiếp được trong app") | API tách của TikTok theo cả đơn; chưa có căn cứ là sàn nhận danh sách nhóm chỉ phủ một phần món của đơn (lần gọi thật 07/11/2026 tách đơn một kiện). Chặn trước cho tới khi thử thật trên shop thử (mục 10). Nhánh `unit` không bị giới hạn này. Claude chốt, cần Khang biết |
| D15 | Mã kiện mới xin bằng `ctx.nextPackageCode()` trong một giao dịch ngắn riêng, commit ngay, trước Bước 3. `splitLevel` cũng gọi ngoài giao dịch (cổng của channel tự mở `withCompany`) | `doc_counters` là một dòng chung cả công ty. Xin mã trong Bước 3 thì giữ khoá dòng đó rồi mới khoá dòng tồn (lượt phân hàng), ngược thứ tự `dòng tồn → doc_counters` của spec 199b §5.10: lượt kéo đơn đang giữ dòng tồn và chờ bộ đếm để lập kiện thứ hai sẽ deadlock với lần tách. Đổi lại, Bước 3 lỗi thì mất số, dãy `KH-` có lỗ (mã kiện không phải chứng từ kế toán). Claude chốt lúc viết plan |
| D14 | Nhánh `sku`, bước ghi lỗi sau khi sàn đã tách: một giao dịch riêng bật `needs_attention` trên kiện cũ, ghi chú "Sàn đã tách kiện, app chưa ghi được: kiểm lại kiện trên sàn", rồi mới trả lỗi | Lượt kéo đơn **không** tự phát hiện ca này: nhóm mang mã kiện sàn mới rơi về kiện cũ qua món đầu nhóm, `resplit` vẫn false, một kiện app theo dõi hai kiện sàn mà không có cờ nào. Cùng kiểu với cờ `label_error` của `markReady`. Người soát chỉ ra, Claude chốt |
| D12 | Dòng số lượng lớn hơn 1 (đơn tay): chuyển một phần thì giảm `quantity` dòng cũ và chèn dòng mới ở kiện mới | Hợp đồng nhận `quantity`; làm tổng quát ngay rẻ hơn sửa sau. Đơn sàn không đi nhánh này |
| D16 | Xét huỷ dòng **theo kiện**, trước khi gom nhóm theo mã kiện sàn: với mỗi kiện chưa huỷ, chưa rời kho, đếm dòng bị sàn huỷ trên **mọi dòng của kiện**. Một phần thì xử lý huỷ dòng và **loại các món đó khỏi đầu vào gom nhóm**; tất cả thì để đường cũ (`cancelPlatformPackage`) | Món sàn huỷ có thể không còn mang mã kiện sàn, rơi vào nhóm riêng chỉ gồm món huỷ; để nguyên thì nhóm đó huỷ cả kiện dù kiện còn món sống |
| D17 | "Sàn huỷ món" = `status === 'cancelled'` và `cancelKind !== 'failed_delivery'` | Huỷ vì giao không thành là kiện hoàn về (spec 199c D2), không phải huỷ dòng |
| D18 | Sales truyền `alreadyCancelled` cho từng món (dòng đơn đã `cancelled_qty = quantity`); đồng bộ bỏ qua món `alreadyCancelled` mà không còn thuộc kiện nào | Món đã gỡ khỏi kiện ở lượt trước không còn chủ; để nguyên thì lượt kéo sau lập một kiện `cancelled` rác cho nó và tốn một mã `KH-` |
| D19 | Trigger chỉ chạy khi có đổi thật: `packages` chỉ khi trạng thái **qua lại ranh giới `cancelled`**; `order_lines` chỉ khi `quantity` hoặc `cancelled_qty` đổi giá trị. Trigger từ `order_lines` bỏ qua dòng đơn chưa có dòng kiện nào; trigger từ `package_lines` và `packages` luôn kiểm | Đổi trạng thái thường (giữ hàng, đóng gói, bàn giao) không đụng bất biến, không nên trả giá kiểm. Dòng đơn chưa có kiện (món trạng thái lạ) hợp lệ; nhưng xoá dòng kiện cuối cùng mà không ghi `cancelled_qty` phải bị chặn (AC19) |
| D20 | Gỡ dòng khỏi kiện chưa đóng gói ghi một dòng lịch sử `drop_lines` (`from = to`, nguồn `marketplace`, lý do "Sàn huỷ <n> món") và tăng `version` kiện | Kiện đổi nội dung mà không đổi trạng thái; cùng cách với `split` (D3) |
| D21 | Cả kiện đã đóng gói bị huỷ khi kiện đang `needs_open` với `open_purpose = 'edit'` thì nâng thành `'cancel'`. `open` kiện mà mọi dòng đều chờ bỏ đi mũi tên `open_cancel`, **không gọi repack** trên sàn | Sàn đã huỷ gói đó; gọi đóng gói lại một gói đã huỷ chỉ nhận lỗi |
| D22 | Kéo lại dữ liệu cũ chỉ cho đơn còn mở mà dữ liệu gốc có món `cancelled` (không kéo lại mọi đơn mở) | Chỉ các đơn đó cần áp luật huỷ dòng; kéo lại ít đơn thì ít tốn hạn mức gọi sàn |

## 4. Phạm vi

**PR 1 (kịp test 15/11):** route `split`, luật chia, hai nhánh `unit` và `sku`, sửa đồng bộ (D10), index `package_lines(order_line_id)`, trigger chặn vượt, test, OpenAPI, cập nhật `fulfillment/CLAUDE.md`.

**PR 2:** `order_lines.cancelled_qty`, `package_lines.pending_drop_qty`, gỡ món huỷ khỏi kiện lúc đồng bộ, bỏ phần chờ bỏ lúc mở kiện, siết trigger thành kiểm bằng, kéo lại đơn còn mở, test.

**Ngoài phạm vi:**

- Code FE (repo FE): chỉ ghi ảnh hưởng ở mục 7.
- Sàn chia lại kiện đã có mã sàn, `replaces_package_id`, kiện chờ thay (#238).
- Mở kiện `awaiting_pickup`, việc "Dỡ kiện về kệ" trong khung nhắc việc (#238, #209).
- Gộp kiện lại sau khi tách.
- Đơn tạo tay: nhánh D12 có code và unit test, không có đường API tạo đơn để thử trọn luồng.

## 5. Thiết kế

### 5.1 Dữ liệu và migration (PR 1)

1. `schema.ts`: thêm `index().on(t.orderLineId)` cho `package_lines`. Sinh bằng `db:generate`.
2. Migration `--custom`: hàm `"order".check_package_line_total()` và constraint trigger `package_lines_line_total` trên `"order".package_lines`, `AFTER INSERT OR UPDATE OF quantity, package_id, order_line_id`, `DEFERRABLE INITIALLY DEFERRED`, `FOR EACH ROW`.

Hàm trigger, với `NEW.order_line_id`:

- Đọc `quantity` của dòng `"order".order_lines` đó, không khoá (D11). Không có dòng đơn thì thôi, không kiểm.
- Cộng `quantity` của mọi dòng kiện cùng `order_line_id` nằm trong kiện có `status <> 'cancelled'`.
- Tổng lớn hơn `quantity` của dòng đơn thì `RAISE EXCEPTION` với `ERRCODE = '23514'` (check_violation), tên ràng buộc `package_lines_line_total`.

Hàm chạy với quyền người gọi (không `SECURITY DEFINER`): `commerio_app` thấy đúng dòng của công ty mình qua RLS. Không có bảng mới nên không cần bật RLS thêm. Trigger chỉ kiểm dòng bị đụng sau khi có nó, nên không cần sửa dữ liệu cũ.

Kiện chuyển từ `cancelled` về trạng thái khác không có mũi tên nào, nên PR 1 không gắn trigger lên `packages`.

### 5.2 Luật thuần (`domain/split.ts`, mới)

`planSplit(lines, parts, level)`, không I/O:

- Vào: dòng kiện `{ id, orderLineId, variantId, quantity, reservedQty }` đã sắp theo `created_at, id` (như `planLinesOf`); `parts`; `level: 'unit' | 'sku'`.
- Ra: `{ moves: { lineId, quantity }[][] }` (mỗi phần tử ứng một kiện mới, theo thứ tự `parts`), hoặc lỗi theo trường.
- Chọn dòng cho mỗi `{ variantId, quantity }`: lấy lần lượt các dòng của biến thể đó theo thứ tự vào, dòng nào dùng rồi thì bỏ qua; dòng cuối có thể chỉ lấy một phần (D12).
- Lỗi (422 `validation_failed`, khoá `errors` theo đường dẫn Zod):
  - `parts.<i>.<j>.variantId`: biến thể không có trong kiện ("SKU không có trong kiện").
  - `parts.<i>.<j>.quantity`: tổng xin chuyển của biến thể qua mọi phần vượt số trong kiện ("Vượt số lượng trong kiện").
  - `parts`: sau khi chuyển kiện cũ không còn món nào ("Kiện cũ phải còn ít nhất một món"). Dòng chưa ghép SKU ở lại kiện cũ được tính là món.
- `level = 'sku'`: vi phạm D8 thì trả lỗi `split_not_supported` ("Sàn chỉ cho tách theo SKU, không tách đôi cùng một SKU").

Zod của body (`api/schemas.ts`, `SplitBody`): `version` nguyên không âm; `parts` 1–20 phần; mỗi phần 1–200 dòng; `variantId` là UUID, không lặp trong cùng một phần; `quantity` nguyên dương.

### 5.3 Cổng và ngữ cảnh

- **channel** (`service/order-actions.ts`): thêm `marketplaceSplitLevel(companyId, shopId)` trả `'unit' | 'sku' | 'none'` từ `capabilitiesOf` của sàn của gian hàng; gian hàng không có thì `'none'`. Thêm `splitLevel` vào kiểu `MarketplacePackages` và vào `src/wiring.ts`.
- **sales → fulfillment** (`order/index.ts`, `withContext`): thêm vào `FulfillmentContext`
  - `orderViewOf(orderId)`: `Order` đầy đủ của sales, gọi trong `withCompany` của bên gọi.
  - `nextPackageCode()`: mã `KH-…` kế tiếp, gọi trong giao dịch của bên gọi.
  Hai hàm này là hàm của sales; sales export tên rõ nghĩa từ `sales/index.ts`. Thiếu thì ném 500 `internal_error` như `orderRefsLookupOf`.

### 5.4 Luồng `POST /packages/:id/split` (`service/split.ts`, mới)

Quyền `ctx.authorize('fulfillment.order.process')` đặt trước `validate({ params, body })`.

Cả luồng nằm trong `withPackageLock` (khoá phiên theo kiện, như đóng gói).

**Bước 1, kiểm: đọc trong giao dịch ngắn (`withCompany`), không khoá dòng; `splitLevel` gọi ngoài giao dịch (D15):**

1. Kiện có (404 `not_found`, kể cả công ty khác, id sai dạng).
2. Trạng thái: `packed`, `awaiting_pickup` thì 409 `package_sealed` ("Kiện đã đóng gói, dỡ kiện về kệ trước khi tách"); trạng thái khác `reserved`, `backordered` thì 409 `invalid_transition` kèm `current`. Kiểm trước `version`, như bàn giao.
3. `version` lệch thì 409 `version_conflict` kèm `current` (bản `Package`).
4. `splitLevel` (D6): `none` thì 422 `split_not_supported` ("Sàn này không cho tách kiện").
5. `planSplit` (5.2).
6. Nhánh `sku`: đơn còn kiện chưa huỷ nào khác ngoài kiện đang tách thì 422 `split_not_supported` (D13). Dựng `groups` cho sàn gồm nhóm của kiện cũ (phần còn lại) đứng đầu, rồi từng kiện mới theo thứ tự `parts`; mỗi nhóm là `external_line_id` của các dòng đơn tương ứng (đọc bằng cách join `"order".order_lines` như `platformItemsOf`). Dòng thiếu mã món sàn thì 409 `item_not_packable`.

**Bước 2, chỉ nhánh `sku`, ngoài giao dịch:** `marketplacePackages.split(companyId, shopId, externalOrderId, groups)`. Lỗi của cổng (422 `split_not_supported` kèm câu sàn, 503, 409) ném nguyên, app chưa ghi gì. Thành công trả mã kiện sàn theo thứ tự nhóm.

**Bước 2b, mọi nhánh:** xin đủ mã kiện mới (`ctx.nextPackageCode()`, mỗi phần một mã) trong một giao dịch ngắn riêng, commit ngay (D15).

**Bước 3, một giao dịch (`withCompany`), theo thứ tự khoá của spec 199b §5.10:**

1. Lấy khoá advisory phân hàng của công ty (dùng lại hàm `takeAllocationLock`, đưa ra thành hàm dùng chung nếu đang là hàm riêng của `allocation.ts`).
2. `lockOrderPackages(orderId)`: khoá mọi kiện của đơn (cũng là khoá mà lượt kéo đơn dùng).
3. Kiểm lại: nhánh `unit` làm lại các bước 2, 3, 5 của Bước 1 trên dữ liệu vừa khoá. Nhánh `sku` theo D7: không so `version`; kiện còn `reserved`/`backordered` và `planSplit` còn ra đúng các dòng đã gửi sàn thì đi tiếp, không thì ném 409 `version_conflict`. Mọi lỗi của Bước 3 ở nhánh `sku` (kể cả lỗi này, deadlock, lỗi CSDL): log `error` (`packageId`, `orderId`, mã kiện sàn mới), bật cờ theo D14 trong giao dịch riêng, rồi ném lỗi gốc.
4. Nhánh `sku`: ghi `platformPackageCode` của **kiện cũ** = mã sàn của nhóm đầu **trước khi chèn kiện mới**. Lượt kéo đơn chen giữa Bước 2 và Bước 3 có thể đã gắn cho kiện cũ (khi nó chưa có mã) mã của một nhóm khác; chèn kiện mới mang đúng mã đó trước khi sửa kiện cũ sẽ vướng unique `packages_platform_code_order_uq`.
5. Với mỗi kiện mới:
   - `insertPackage` với mã đã xin ở Bước 2b, chép từ kiện cũ: `orderId`, `shopId`, `shipBy`, `status` (bằng trạng thái kiện cũ), bốn trường vận chuyển sàn trả (`shipmentProvider`, `shippingProviderType`, `shippingType`, `promisedShippingAt`). `platformPackageCode`: nhánh `sku` là mã sàn của nhóm; nhánh `unit` để null. `trackingCode`, nhà vận chuyển, mọi cờ để mặc định.
   - Chuyển dòng: dòng lấy nguyên thì đổi `package_id`; dòng lấy một phần thì giảm `quantity` (và `reserved_qty` theo tỉ lệ nguyên dòng) rồi chèn dòng mới. `reserved_qty`, `variant_id`, `order_line_id` giữ nguyên; `packed_qty` luôn 0 ở các trạng thái này.
   - Kiện cũ `reserved`: kiện mới đặt `reserved_at` bằng của kiện cũ.
   - `recordTransition` `create` (`from: null`, `to` = trạng thái, `actorId` người bấm, lý do "Tách từ <mã kiện cũ>"); phát `fulfillment.package_status_changed` (`from: null`).
6. Kiện cũ: `updatePackage` để tăng `version` (nhánh `unit`; nhánh `sku` đã tăng ở bước 4); `recordTransition` `split` (D3).
7. Kiện cũ `backordered`: `runAllocation(ctx, { variantIds })` với SKU đã ghép của mọi kiện con (kiện cũ và các kiện mới). Lượt này tự phát `allocation_done`.
8. Trả `ctx.orderViewOf(orderId)`.

Kiện cũ `reserved` không phát `allocation_done`: số có thể bán không đổi.

### 5.5 Sửa đồng bộ (`service/platform-packages.ts`)

Trong `syncPlatformPackages`, khi gom nhóm: món có `packageCode` rỗng thì khoá nhóm thêm id kiện app đang chứa món đó (tra `owner`); món chưa thuộc kiện nào giữ khoá rỗng như cũ. Kết quả:

- Đơn Lazada đã tách trong app, chưa đóng gói: mỗi kiện app một nhóm con, trạng thái tính riêng, không `resplit`.
- Đóng gói kiện 1 trên sàn: món của kiện 1 mang mã X, nhóm X khớp kiện 1 (qua mã đã lưu lúc `pack`, hoặc qua món đầu nhóm rồi gắn mã); món của kiện 2 vẫn ở nhóm con của kiện 2.
- Sàn gói chung món của hai kiện app dưới một mã (shop đóng gói trên Seller Center): vẫn `resplit` như cũ, để #238 xử lý.

Phần còn lại của hàm không đổi.

### 5.6 Lỗi

| Tình huống | HTTP | `code` |
|---|---|---|
| Thiếu quyền | 403 | `forbidden` |
| Không thấy kiện | 404 | `not_found` |
| Kiện đã đóng gói | 409 | `package_sealed` |
| Kiện ở trạng thái khác | 409 | `invalid_transition` |
| `version` lệch, khoá phiên bận quá 10 giây | 409 | `version_conflict` |
| Body sai dạng, SKU không có, vượt số lượng, kiện cũ hết món | 422 | `validation_failed` |
| Sàn `none`; `sku` mà tách đôi cùng SKU; sàn từ chối tách | 422 | `split_not_supported` |
| Dòng thiếu mã món sàn (nhánh `sku`) | 409 | `item_not_packable` |
| Sàn không gọi được | 503 | `marketplace_unavailable` |

Mọi lỗi qua `AppError`, không tự `res.status`.

### 5.7 Chạy đồng thời và gọi lặp

- Hai người tách cùng kiện: khoá phiên xếp hàng, người sau gặp `version_conflict`.
- Lượt kéo đơn chạy giữa Bước 1 và Bước 3 (nhánh `unit`): Bước 3 kiểm lại `version` dưới khoá, lệch thì 409, chưa ghi gì.
- Nhánh `sku`, lượt kéo đơn chạy giữa Bước 2 và Bước 3: đồng bộ thấy mã kiện mới của sàn mà app chưa có, gán cả các nhóm đó về kiện cũ (món đầu nhóm thuộc kiện cũ), **không bật `resplit`**; kiện cũ chưa có mã sàn thì nhận mã của nhóm gặp trước. Bước 3 vẫn ghi được (D7, và sửa mã kiện cũ trước khi chèn kiện mới), lượt kéo sau khớp theo mã.
- Nhánh `sku`, Bước 3 lỗi sau khi sàn đã tách: app còn một kiện, sàn đã hai, lượt kéo không tự báo. Kiện cũ được bật Cần xử lý (D14); bấm tách lại thì sàn từ chối; xử lý tay tới khi có #238.
- Tách và lượt kéo cùng đơn: lượt kéo khoá đơn, dòng đơn rồi mới khoá kiện; tách khoá kiện và không khoá gì khác của đơn (trigger không khoá dòng đơn, D11), nên không thành vòng khoá.
- Gọi lặp nhánh `unit` với `version` cũ: 409, không tách hai lần.

### 5.8 Phân quyền, hiệu năng

- Chỉ `fulfillment.order.process` (CEO, Nhân viên kho). Admin, Sale 403. Dữ liệu chạy trong `withCompany`, RLS chặn công ty khác.
- Một lần tách: một câu khoá kiện của đơn, một câu đọc dòng, tối đa 20 lần chèn kiện, một câu chuyển dòng cho mỗi kiện mới, một lượt phân hàng khi kiện cũ `backordered`. Trigger chạy một lần cho mỗi dòng kiện đổi, dùng index mới theo `order_line_id`.

### 5.9 Test (PR 1)

Theo `test/CLAUDE.md`.

- **Unit** `test/unit/modules/order/fulfillment/domain/split.test.ts`: chọn dòng theo thứ tự; chuyển một phần dòng số lượng lớn (D12); ba lỗi `validation_failed`; dòng chưa ghép ở lại và được tính là món; luật `sku` (D8).
- **Integration** `test/integration/order/fulfillment/split.test.ts` (cổng tồn thật, cổng sàn giả qua `ctx`):
  - Kiện `reserved` tách: hai kiện `reserved`, `reserved_qty` giữ nguyên, tổng đang giữ của inventory không đổi, không phát `allocation_done`.
  - Kiện `backordered`, một SKU đủ hàng một SKU hết: kiện đủ hàng `reserved` qua `hold`, kiện kia `backordered` (AC1).
  - Lịch sử: kiện mới có `create` kèm người làm, kiện cũ có `split`.
  - Nhánh `sku`: gọi cổng với đúng `groups`; mã kiện sàn ghi lên cả hai kiện; sàn từ chối thì không có kiện mới; đơn đã hai kiện thì 422 (D13); kiện cũ đã bị gắn mã của nhóm khác trước bước ghi thì vẫn ghi được; bước ghi lỗi thì kiện cũ bật Cần xử lý (D14).
  - Nhánh `none`: 422, cổng không được gọi.
  - `package_sealed`, `invalid_transition`, `version_conflict`, công ty khác 404.
- **Integration** `test/integration/order/fulfillment/constraints.test.ts` (thêm ca): chèn dòng kiện làm tổng vượt số lượng dòng đơn thì commit bị chặn với `package_lines_line_total`; cùng dòng đơn ở kiện `cancelled` không tính.
- **Integration** đồng bộ (thêm vào file test kiện sàn sẵn có): đơn hai kiện app không mã sàn, kéo lại không đổi gì và `resplit = false`; sau đó sàn gắn mã cho món của một kiện thì chỉ kiện đó nhận mã và đổi trạng thái.
- **API** `test/api/fulfillment.test.ts` (hoặc file route kiện sẵn có): 403 cho Admin, Sale; thân phản hồi parse được bằng schema `Order`; lỗi Zod của `SplitBody`.

### 5.10 PR 2: huỷ dòng và kiểm bằng

**Dữ liệu:**

- `order_lines.cancelled_qty` (`integer not null default 0`, CHECK `0 <= cancelled_qty <= quantity`).
- `package_lines.pending_drop_qty` (`integer not null default 0`, CHECK `0 <= pending_drop_qty <= quantity`), đúng `19` mục 2.

**Ai ghi `cancelled_qty`:** chỉ luồng nhận đơn của sales, khi sàn báo món huỷ (trạng thái thô `cancelled`, không phải `cancelKind = 'failed_delivery'`) **và** kiện chứa món chưa rời kho. Không suy ngược từ dòng kiện (suy ngược thì bất biến tự đúng, mất tác dụng). `syncPlatformPackages` trả thêm danh sách dòng đơn đã xử lý huỷ để sales ghi trong cùng giao dịch.

**Fulfillment khi sàn báo huỷ một món** (trong `syncPlatformPackages`, kiện đã khoá). Xét **theo từng kiện** trước khi gom nhóm theo mã kiện sàn (D16): "món bị huỷ" theo D17; kiện có một phần món bị huỷ thì xử lý như bảng dưới và các món đó không vào bước gom nhóm; mọi món bị huỷ thì để đường cũ. Món mà sales báo `alreadyCancelled` và không còn thuộc kiện nào thì bỏ qua (D18). Gỡ dòng khỏi kiện chưa đóng gói ghi lịch sử `drop_lines` và tăng `version` kiện (D20).

| Kiện chứa món | Xử lý |
|---|---|
| `backordered`, `reserved`, còn món khác | Xoá dòng kiện đó; dòng đang giữ thì `release` phần của nó; `requestAllocation` cho SKU vừa nhả và các SKU còn lại của kiện (kiện có thể giữ đủ sau khi bớt món). Kiện giữ trạng thái |
| `backordered`, `reserved`, hết món | Đường cũ `cancelPlatformPackage`: kiện `cancelled`, dòng giữ nguyên |
| `packed`, `awaiting_pickup`, còn món khác | `pending_drop_qty = quantity` trên dòng đó; kiện bật `needs_open` với `open_purpose = 'edit'`; kiện vẫn giữ hàng |
| `packed`, `awaiting_pickup`, hết món | Đường cũ (`needs_open`, `open_purpose = 'cancel'`), thêm `pending_drop_qty = quantity` trên mọi dòng; kiện đang `needs_open` với `'edit'` thì nâng lên `'cancel'` (D21) |
| Đã rời kho | Không đổi gì; `cancelled_qty` giữ 0 (`25` E96) |

**Mở kiện** (`openPackage`, chỉ kiện `packed` như hiện nay): dòng có `pending_drop_qty > 0` thì xoá và `release`; mọi dòng đều chờ bỏ thì đi mũi tên `open_cancel` (kiện `cancelled`, nhả hết, đặt `pending_drop_qty` về 0) thay cho `open`, **không gọi repack** trên sàn (D21).

**Trigger siết lại** (thay hàm của PR 1, đổi tên ràng buộc không cần): với dòng đơn bị đụng,

`Σ (quantity − pending_drop_qty)` trên kiện `status <> 'cancelled'` `=` `order_lines.quantity − order_lines.cancelled_qty`.

Gắn thêm vào: `package_lines` `AFTER DELETE`; `package_lines` `UPDATE OF pending_drop_qty`; `packages` `AFTER UPDATE OF status` (kiểm mọi dòng đơn của kiện); `order_lines` `AFTER UPDATE OF quantity, cancelled_qty`. **Không** gắn vào `order_lines` `INSERT`: dòng đơn chưa có kiện (món có trạng thái app chưa biết, hoặc nhóm bị bỏ qua vì `resplit`) không bị kiểm cho tới khi có dòng kiện đầu tiên. Trigger chỉ chạy khi có đổi thật (D19): `packages` khi trạng thái qua lại ranh giới `cancelled`; `order_lines` khi `quantity` hoặc `cancelled_qty` đổi giá trị, bỏ qua dòng đơn chưa có dòng kiện nào; `package_lines` luôn kiểm (xoá dòng kiện cuối mà không ghi `cancelled_qty` vẫn bị chặn). Kiện chờ thay của #238 sẽ thêm điều kiện loại trừ khi #238 làm.

**Dữ liệu cũ:** migration `--custom` chỉ dữ liệu, theo cách của `0018_keo-lai-don-truoc-0017.sql`: (1) dòng đơn mà mọi kiện chứa nó đều `cancelled` thì đặt `cancelled_qty = quantity`; (2) đơn `unpaid`, `processing` mà dữ liệu gốc có món `cancelled` (D22) thì xoá `external_update_time` ở `channel.raw_orders` và `last_order_sync_at` của gian hàng để lượt kéo sau đọc lại và áp luật huỷ dòng mới. Dòng không bị đụng thì trigger không kiểm, nên đơn đã dừng không lỗi.

**Test PR 2:** từng dòng của bảng trên; mở kiện có dòng chờ bỏ; trigger chặn cả hai chiều (thừa và thiếu), gồm ca xoá dòng kiện mà không ghi `cancelled_qty`; tách kiện vẫn qua trigger kiểm bằng; migration dữ liệu trên đơn mẫu.

Kế hoạch PR 2: `docs/superpowers/plans/2026-11-15-205-huy-dong.md` (viết khi PR 1 còn mở; nhánh xếp chồng lên `feature/205-tach-kien`).

## 6. Thứ tự giao

1. **PR 1** `feature/205-tach-kien`: mục 5.1–5.9. Mở trước buổi test 15/11. Thành review phần `order-actions.ts`, `wiring.ts`.
2. **PR Documents** cùng lúc với PR 1 (mục 8).
3. **PR 2** `feature/205-huy-dong`: mục 5.10. Thành review phần `ingest.ts`.
4. Thử thật trên shop thử Lazada sau khi PR 1 lên staging: tách trong app, đóng gói từng kiện, ra hai `package_id`, hai vận đơn.

## 7. Ảnh hưởng tới FE

- `SplitPackageDialog` đã gửi đúng dạng body; cần trỏ sang API thật và ẩn nút khi `shop.capabilities.splitLevel = 'none'`.
- Câu báo cho `split_not_supported` lấy `detail` của BE (câu của sàn khi sàn từ chối).
- Với `sku`, ô số lượng nên chỉ cho 0 hoặc đủ số của SKU (BE vẫn chặn bằng 422).
- Dòng chưa ghép SKU không hiện trong hộp thoại và ở lại kiện cũ: FE đang làm đúng.

## 8. Ảnh hưởng tới Documents

Sửa trong một PR Documents, trước hoặc cùng PR 1:

- `21` §19.2 dòng `split`: thêm "dòng chưa ghép SKU ở lại kiện cũ"; "`sku`: bước ghi sau khi sàn đã tách không so `version`"; mã lỗi 409 `item_not_packable` cho nhánh `sku`.
- `19` mục 2: index `package_lines(order_line_id)`; trigger `package_lines_line_total`; (PR 2) `order_lines.cancelled_qty`.
- `25` §8: ghi rõ CSDL ép bất biến bằng trigger kiểm lúc commit.
- `kiem-thu/ca-theo-so-do.md`: thêm ca D2 cho tách kiện, gắn vào US-DH-19 dòng 1–6.
- `27` US-DH-19: điền cột Ca.

## 9. Acceptance criteria

**PR 1**

| # | Cho | Khi | Thì |
|---|---|---|---|
| AC1 | Kiện `backordered` gồm áo trắng, quần (đủ hàng), áo đỏ (hết hàng) | Tách áo đỏ ra | Kiện cũ `reserved`, kiện mới `backordered`, hai mã kiện khác nhau (US-DH-19 dòng 1) |
| AC2 | Kiện `reserved` ba món | Tách một món ra | Hai kiện `reserved`; tổng đang giữ của từng SKU không đổi |
| AC3 | Gian hàng `splitLevel = 'unit'` | Tách | Cổng sàn không được gọi; kiện mới không có mã kiện sàn |
| AC4 | Gian hàng `splitLevel = 'sku'` | Tách theo SKU | Cổng sàn được gọi một lần; mỗi kiện mang mã kiện sàn của nhóm mình |
| AC5 | Gian hàng `splitLevel = 'sku'` | Tách đôi cùng một SKU | 422 `split_not_supported`, cổng sàn không được gọi |
| AC6 | Gian hàng `splitLevel = 'sku'`, sàn từ chối | Tách | 422 `split_not_supported` kèm câu của sàn; không có kiện mới |
| AC7 | Gian hàng `splitLevel = 'none'` | Tách | 422 `split_not_supported` |
| AC7a | Gian hàng `splitLevel = 'sku'`, đơn đã có hai kiện chưa huỷ | Tách một kiện | 422 `split_not_supported`, cổng sàn không được gọi (D13) |
| AC7b | Gian hàng `splitLevel = 'sku'`, sàn đã tách, bước ghi của app lỗi | Tách | Kiện cũ bật Cần xử lý kèm ghi chú; lỗi gốc trả về (D14) |
| AC8 | Kiện `packed` | Tách | 409 `package_sealed` (dòng 3) |
| AC9 | Chia hết món sang kiện mới | Tách | 422, báo kiện cũ phải còn ít nhất một món (dòng 4) |
| AC10 | Sau khi tách | Đọc chi tiết đơn | Với mỗi dòng đơn, tổng số lượng trên các kiện chưa huỷ bằng số lượng dòng (dòng 5) |
| AC11 | Admin hoặc Sale | Tách | 403 `forbidden` (dòng 6) |
| AC12 | Đơn Lazada đã tách trong app, chưa đóng gói | Lượt kéo đơn chạy | Không kiện nào đổi; đơn không bật Cần xử lý |
| AC13 | Dòng kiện bị chèn trùng làm tổng vượt số lượng dòng đơn | Commit | CSDL từ chối với `package_lines_line_total` |
| AC14 | Kiện mới và kiện cũ | Xem lịch sử | Kiện mới có `create` kèm người tách; kiện cũ có `split` |

**PR 2**

| # | Cho | Khi | Thì |
|---|---|---|---|
| AC15 | Kiện `reserved` ba món | Sàn báo huỷ một món | Dòng kiện đó bị xoá, phần giữ của nó được nhả, `cancelled_qty = 1`, kiện vẫn `reserved` |
| AC16 | Kiện `packed` ba món | Sàn báo huỷ một món | Dòng đó `pending_drop_qty = 1`, kiện `needs_open`, vẫn giữ hàng |
| AC17 | Kiện ở AC16 | Kho mở kiện | Dòng chờ bỏ bị xoá và nhả; kiện `reserved` với hai món |
| AC18 | Kiện đã rời kho | Sàn báo huỷ một món | Không đổi dòng kiện, `cancelled_qty = 0` |
| AC19 | Một dòng kiện bị xoá mà `cancelled_qty` không đổi | Commit | CSDL từ chối |
| AC20 | Đơn còn mở có món huỷ lẻ từ trước PR 2 | Migration chạy rồi lượt kéo sau | Đơn được đọc lại, món huỷ được gỡ khỏi kiện, không lỗi |

## 10. Rủi ro và điểm còn mở

- **Nhánh `sku` lỗi ở bước ghi sau khi sàn đã tách:** app và sàn lệch, phải xử lý tay tới khi #238 xong. Giảm bằng D7; phần còn lại ghi vào "Giới hạn đã biết" của `fulfillment/CLAUDE.md`.
- **Trigger không tự xếp hàng** (D11): nếu sau này có đường ghi dòng kiện không giữ khoá kiện, hai giao dịch commit cùng lúc có thể cùng lọt. Đường mới ghi dòng kiện phải khoá kiện trước; ghi rõ ở `fulfillment/CLAUDE.md`.
- **TikTok, đơn đã nhiều kiện** (D13): PR 1 chặn. Việc cần thử trên shop thử: sàn có nhận `groups` chỉ gồm món của một kiện khi đơn đã có hai kiện không. Nhận thì gỡ D13 ở PR sau; không nhận thì phải gửi kèm nhóm của các kiện anh em và gán lại mã cho chúng.
- **Kiện `backordered` của đơn khác được xét trước** các kiện con vừa tách (D4): đúng luật ưu tiên chung, nhưng kho có thể thấy kiện con chưa giữ được hàng dù vừa có hàng nhả ra.
- **PR 2 đụng luồng nhận đơn:** lỗi ở đây chặn cả lượt kéo của đơn đó (đơn rollback, lượt sau thử lại). Cần test integration đủ các dòng của bảng 5.10 trước khi merge.
- **TikTok chưa thử thật qua app:** cổng tách đã thử bằng smoke (07/11/2026), luồng app qua cổng thì chưa. Thử trên shop thử sau khi PR 1 lên staging.
- **Chưa rõ:** `Order` trả cho người chỉ có quyền kho có lộ trường nào của sales mà kho không nên thấy không (giá, khách). Hợp đồng `21` §19.2 đã chọn trả `Order`; nếu Thành muốn đổi sang `Package[]` thì sửa `21` trước.
