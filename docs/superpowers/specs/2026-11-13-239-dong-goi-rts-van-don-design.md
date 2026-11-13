# Spec: Đóng gói, báo sàn sẵn sàng giao, in vận đơn, danh sách nhặt (#239)

- **Ngày:** 13/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#239, `Documents/21` §1.1 (R7, R8, R10), §19.2, §19.3, `Documents/25` §8.1, §8.3, `Documents/19` (bảng `packages`), `Documents/27` US-DH-06, US-DH-07, `Documents/kiem-thu/ca-theo-so-do.md` §D2 (D2-03, D2-04), `Documents/tich-hop-san/lazada.md` §7.4, §11.2
- **Trạng thái:** nháp, chờ Khang duyệt
- **Nền:** `main` f30412b. Coi như PR #300 (#199 phần c) đã merge trước khi PR fulfillment của #239 merge (Khang xác nhận 13/11/2026). #300 sửa cùng các file `domain/package.ts`, `repository/schema.ts`, `api/routes.ts`, `service/platform-packages.ts`, nên nhánh #239 gộp `main` sau khi #300 merge rồi mới sinh migration.

---

## 1. Mục tiêu và tiêu chí thành công

1. Kho làm trọn `reserved → packed → awaiting_pickup` ngay trong app cho kiện đơn Lazada, TikTok và đơn tay: danh sách nhặt, quét đóng gói, báo sàn sẵn sàng giao.
2. Kho in vận đơn cho 1–50 kiện thành **một tệp PDF**, cả kiện Lazada lẫn TikTok, lẫn nhiều gian hàng trong một lần in.
3. App không bao giờ ghi `packed` hay `awaiting_pickup` cho kiện sàn khi sàn đã từ chối. Sàn đã nhận lệnh mà app chưa kịp ghi thì lượt kéo đơn kế tiếp (tối đa 5 phút) tự khớp.
4. Kho mở lại được kiện đóng nhầm khi chưa báo sàn sẵn sàng giao (`open` từ `packed`): gọi đóng gói lại (repack) phía sàn khi sàn có API đó, kiện về `reserved` và vẫn giữ đủ hàng.

Đo bằng: AC ở mục 9 đều qua; body trả về parse được bằng schema Zod khai trong OpenAPI; `npm run check` xanh. Trên shop thử Lazada: pack → RTS → in ra PDF thật. Trên shop thử TikTok: ship → in ra PDF thật.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (f30412b):**
- Máy trạng thái kiện (`fulfillment/domain/package.ts:84-104`) đã có `pack` (`reserved → packed`, guard `order_not_processing`), `mark_ready` (`packed → awaiting_pickup`, guard `self_delivery`), `open` (`packed`, `awaiting_pickup → reserved`), `open_cancel`.
- Bảng `packages` đã có `packed_by`, `packed_at`, `platform_package_code`, `tracking_code`, `shipment_provider` (sàn trả, #260); `package_lines.packed_qty` (CHECK `0..quantity`). Chưa có cột nhà vận chuyển, chưa có `label_error` (`Documents/19` có ghi `label_error`).
- Route của fulfillment hiện có: `GET /packages`, `GET /packages/:id`, `POST /packages/hand-over`, `POST /packages/:id/undo-handover`. Schema `PackageSummary` đã có trường `carrier`, nhưng `toPackageSummary` luôn trả `null` (`service/views.ts:80`); `PACKAGE_FLAGS` chưa có `label_error`.
- Cổng `ctx.marketplacePackages` (channel tiêm vào fulfillment ở `src/wiring.ts:49`, kiểu `MarketplacePackages` ở `fulfillment/service/packages.ts`) có `splitAttributes`, `split`, `ship`; fulfillment chưa gọi hàm nào.
- Adapter Lazada (`channel/service/marketplaces/lazada.ts`) chưa có hàm đóng gói, RTS, repack, vận đơn, nhà vận chuyển. Adapter TikTok có `shipPackage` (`tiktok-orders.ts`; gọi lại khi kiện đã giao thì coi là xong, mã 11006021), chưa có vận đơn.
- Mỗi `order_line` của đơn Lazada ứng với đúng một `order_item_id` (`sales/service/ingest.ts:211`); `package_lines.order_line_id` → `order_lines.external_line_id`. Repository của fulfillment được join bảng của sales vì cùng schema `order` (luật ranh giới 2; `repository/package-list.ts` đã dùng SQL thô trên `"order".orders`).
- Kiện sàn lập và cập nhật ở `syncPlatformPackages` (`service/platform-packages.ts`): kiện chưa có mã kiện sàn được gắn mã khi sàn trả (dòng 295–299); sàn báo `packed` khi app còn `reserved` thì áp thẳng (`platformUpdate` = `direct`), ghi lịch sử với `actor_id` null.
- Sàn giả lập đã có stub `/order/fulfill/pack`, `/order/package/repack`, `/order/package/rts`, `/order/document/get` (API cũ), `/order/shipment/providers/get` (`scripts/lazada-mock/stubs.ts:308-387`).
- FE (`main` eaad409) đã dựng giao diện trên mock: `PackageQueuePage`, `PackScanPage`, `pickList`, `usePackageCommand` (`pack`, `ready`, `open`), `usePackageCarriers`, `usePrintPackageDocuments` (nhận blob, mở tab mới). Chưa có spec E2E nào cho kiện.

**Gọi thật ngày 13/11/2026** (shop thử Lazada VN, chỉ đọc, `MSYS_NO_PATHCONV=1 npm run smoke:lazada -- call …`):
- `GET /order/package/document/get` với `getDocumentReq={"doc_type":"PDF","packages":[{"package_id":"FP070211655588924"}]}` (đơn 531094362680318, `ready_to_ship`): `result.success = true`, `result.data.pdf_url` là URL ký của OSS (`Expires`, `OSSAccessKeyId`, `Signature`; còn hạn khoảng 14 ngày), `result.data.file` là base64 của một `<iframe src=…>`. Tải `pdf_url` không cần đăng nhập: HTTP 200, `application/pdf`, 156 855 byte, mở đầu `%PDF-1.4`. request_id `0b803a6517945323507881094`.
- `GET /order/document/get` (API cũ trong `lazada.md` §7.4) với `doc_type=shippingLabel`, `order_item_ids=[531094362780318]`: `data.document.mime_type = text/html`. request_id `0baf58d017945323488813116`. Không dùng.

**TikTok** (docv2 `get-package-shipping-document-202309`, tra 13/11/2026): `GET /fulfillment/202309/packages/{package_id}/shipping_documents`, `document_type` (`SHIPPING_LABEL` …), `document_size` (`A6` mặc định, `A5`), `document_format` (`PDF` mặc định). Trả `doc_url` (còn hạn 24 giờ) và `tracking_number`. Điều kiện: kiện đã Ship Package, chưa bị ĐVVC lấy, chưa huỷ; mỗi lần gọi một kiện. Mã lỗi đáng chú ý: 21042104 (in trước khi giao kiện), 21023035 (chưa arrange), 11034037 (ĐVVC đang tạo tệp), 21042102 (đã lấy hàng, không in được), 21023059 (kiện đã huỷ), 21011001 (không thấy kiện).

**Ràng buộc:**
- `order` ở lớp 3, không import `channel` (lớp 5). Mọi thao tác trên sàn đi qua `ctx.marketplacePackages`, dựng ở `src/wiring.ts`.
- Gọi sàn ngoài giao dịch nghiệp vụ, ghi DB sau (`channel/CLAUDE.md`).
- Code ngoài adapter không rẽ nhánh theo mã sàn: fulfillment không biết Lazada hay TikTok; cổng của channel quyết định dựa vào việc adapter có hàm đó hay không.
- Module `channel` là của Thành: đổi interface `MarketplaceAdapter`, `lazada.ts`, `tiktok-orders.ts`, `order-actions.ts` thì Thành review.
- `Documents/21` R7: thao tác trả bản chi tiết mới nhất (`Package`). R8: lỗi sàn đổi sang mã app, giữ `platformCode`, `platformMessage`. R10: route trả tệp thì trả nhị phân, có `Content-Type` và `Content-Disposition: attachment; filename="…"`; lỗi vẫn là Problem Details JSON.
- Code lệch Documents thì sửa Documents trước (mục 8).

## 3. Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| D1 | **Gọi sàn đồng bộ trong request, ba bước**: (1) giao dịch ngắn đọc và kiểm; (2) gọi sàn ngoài giao dịch; (3) giao dịch ghi theo `version`. Cả ba bước nằm trong khoá phiên theo kiện | Request trả `Package` mới ngay (R7), FE hiện tại dùng được luôn; cách này giống cổng huỷ đơn (#105) và tách kiện (#221). Đã loại: **B** xếp việc nền gọi sàn rồi trả 202 (lệch R7, cần trạng thái "đang báo sàn" ngoài máy trạng thái, FE phải hỏi lại liên tục vì SSE #216 chưa có, trong khi kho đứng ở bàn đóng gói cần biết kết quả ngay); **C** không gọi sàn lúc đóng gói, gộp Lazada pack + RTS vào `ready` (trái §19.3 đặt `carrierCode` ở `pack`, trái US-DH-06 dòng 5 đòi 409 `item_not_packable` lúc đóng gói). Khang chọn A ngày 13/11/2026 |
| D2 | In vận đơn TikTok làm trong #239 | Kho in được vận đơn cả hai sàn trong app khi go-live. Khang chọn 13/11/2026 |
| D3 | Vận đơn luôn là PDF. Lazada dùng `/order/package/document/get` (`doc_type: PDF`), TikTok dùng `shipping_documents`. Adapter tải tệp về; fulfillment gộp mọi tệp thành một PDF bằng `pdf-lib` | TikTok mỗi lần chỉ trả một kiện, nên in nhiều kiện kiểu gì cũng phải gộp; hai sàn cùng ra PDF nên gộp được. `pdf-lib` là thư viện JS thuần, không cần binary hệ thống. Thêm một dòng vào bảng thư viện `Documents/17` §6. Claude đề xuất 13/11/2026 sau lần gọi thật ở mục 2 |
| D4 | Thêm `packages.carrier_code`, `packages.carrier_name`, `packages.label_error` | `Package.carrier` (§19.3) cần chỗ lưu; `label_error` đã có trong `Documents/19` nhưng bảng chưa có. Hai cột nhà vận chuyển chưa có trong `19`: sửa `19` cùng PR Documents. Claude đề xuất, Khang không phản đối (13/11/2026) |
| D5 | **Nhóm gói** (`25` §8.1): nhóm là các kiện chưa huỷ có cùng `(shop_id, platform_package_code)` thuộc từ hai đơn trở lên. `pack` từng kiện, nhưng chặn khi một kiện khác trong nhóm không ở `reserved`/`packed` hoặc đơn của nó chưa `processing`. `ready` đòi cả nhóm đã `packed`, gọi sàn **một lần**, chuyển cả nhóm trong một giao dịch. In vận đơn bỏ trùng mã kiện sàn. Bị chặn thì 409 `package_group_not_ready` (mã mới) kèm `detail` liệt kê mã kiện | Đúng `25` §8.1 ("chỉ đóng gói khi mọi kiện trong nhóm `reserved`…", "báo sàn, lấy vận đơn… áp cho cả nhóm"); chặn theo `reserved`/`packed` (không chỉ `reserved`) để kiện thứ hai của nhóm vẫn đóng được sau kiện thứ nhất. Claude đề xuất, Khang không phản đối |
| D6 | Route `POST /packages/:id/open` làm ở #239 nhưng **chỉ cho kiện `packed`** (cả kiện về `reserved`). Kiện có mã kiện sàn thì gọi repack trước (sàn chưa nhận báo sẵn sàng giao nên còn cho đóng gói lại). Kiện `awaiting_pickup` thì 409 `invalid_transition`, để #238 xử lý theo "Dỡ kiện về kệ" của `25` §8.3 (giữ vận đơn, đóng lại không báo sàn lần nữa, E115). Kiện chưa giữ đủ hàng thì thử giữ cả kiện lúc mở; không đủ thì 422 `insufficient_stock`; gian hàng đang chờ kiểm kê đầu kỳ thì 409 `shop_awaiting_stocktake`. Dỡ một phần (`pending_drop_qty`), `open_cancel`, cờ `needs_open`, mở kiện `awaiting_pickup` để #238. Sửa `21` §19.3 ("`open` kiện sàn đã có mã kiện sàn thì gọi repack") cho khớp `25` §8.3 | `21` §19.3 và `25` §8.3 nói khác nhau với kiện `awaiting_pickup`; người soát spec chỉ ra: mở kiện `awaiting_pickup` mà sàn không huỷ được báo sẵn sàng (TikTok không có API, Lazada có thể từ chối) thì lượt kéo đơn đẩy kiện về `awaiting_pickup` ngay (`platformUpdate` = `jump`), và nhóm gói TikTok bị kẹt. Kiện đã đóng mà không giữ hàng có thật (sàn báo đã đóng khi SKU chưa ghép, gian hàng chờ kiểm kê, `reserve` không đủ; nhảy `backordered → packed`): về `reserved` mà không giữ gì là trái bất biến "`reserved` = giữ đủ cả kiện" và phân hàng không bao giờ xét lại. Khang chọn cách B ngày 13/11/2026 |
| D7 | Cổng `pack` trả `null` khi sàn không có bước đóng gói (TikTok); `repack` trả `'not_supported'` khi sàn không có API repack (TikTok: kiện `packed` chưa có lệnh nào trên sàn nên không cần gọi); `readyToShip`, `shippingDocuments` thiếu hàm thì 422 `marketplace_unsupported` | Fulfillment không rẽ nhánh theo sàn; mỗi sàn khai hàm nào thì cổng đi theo hàm đó |
| D8 | Lỗi sàn đổi sang mã app ở cổng của channel (bảng ở mục 5.3), theo `21` §19.3 và mã tương ứng của TikTok. Lỗi theo món của Lazada (`item_err_code` khác `"0"` trong phản hồi `code: "0"`) adapter đổi thành `MarketplaceError('rejected', <mã món>, <câu của sàn>)` | Một chỗ đổi mã, giống `onSplit`; FE đã có câu báo cho các mã ở §19.3 |
| D9 | **Cờ Lỗi lấy vận đơn**: `ready` lỗi ở bước gọi sàn (mọi lỗi từ cổng, không tính lỗi kiểm ở bước 1) thì một giao dịch riêng bật `label_error`, kiện ở lại `packed`, rồi trả lỗi. `ready` thành công thì xoá cờ. In vận đơn lỗi không bật cờ | Đúng US-DH-07 dòng 4 ("kiện ở lại Đã đóng gói, cờ Lỗi lấy vận đơn, thử lại được"); lúc in, kiện đã `awaiting_pickup`, bấm in lại là đủ |
| D10 | So số quét: gộp theo `variantId` trên các dòng đã ghép SKU. Dòng chưa ghép (kể cả SKU "không quản tồn") không quét, không chặn đóng gói; Lazada vẫn đóng gói đủ món vì mã món lấy từ dòng đơn. Danh sách nhặt gộp dòng chưa ghép theo `sku`, `variantId: null` | Dòng chưa ghép không có `variantId` để quét; chặn thì kiện có SKU "không quản tồn" không bao giờ đóng được |
| D11 | Nhà vận chuyển: Lazada `TFS` (sàn tự chọn; shop thử là `TFS`) thì danh sách rỗng, `pack` không cần `carrierCode`, `carrier` lưu `null`. Lazada `NTFS` thì danh sách lấy từ `shipment_providers`, `isDefault` theo `platform_default`, `pack` bắt buộc `carrierCode` có trong danh sách. TikTok và đơn tay thì danh sách rỗng. Gửi `carrierCode` khi danh sách rỗng thì bỏ qua, không lỗi | Khớp logic mock của FE (danh sách rỗng thì không bắt chọn). Adapter Lazada phải gọi providers trước khi pack để biết `TFS`/`NTFS` (tham số bắt buộc của `/order/fulfill/pack`) |
| D12 | Route `ready` nhận một kiện (đúng hợp đồng). Hàm adapter `readyToShip` nhận nhiều mã kiện, Lazada tự chia lô 20 | Để sau này báo sẵn sàng theo lô không phải sửa adapter |
| D13 | Hai PR BE: **PR1 channel** (adapter, cổng, đổi lỗi; Thành review), **PR2 fulfillment** (route, migration). PR3 FE. PR2 viết và test được với cổng giả, nhưng merge sau PR1 | Tách đúng chủ module; migration chỉ có ở PR2, sinh ở bước cuối |

## 4. Phạm vi

**Trong #239:**
- Migration: `carrier_code`, `carrier_name`, `label_error` trên `packages`.
- Route: `GET /fulfillment/pick-list`, `GET /fulfillment/packages/:id/carriers`, `POST /fulfillment/packages/:id/pack`, `POST /fulfillment/packages/:id/ready`, `POST /fulfillment/packages/:id/open` (chỉ từ `packed`, D6), `GET /fulfillment/packages/documents?kind=awb`. Zod và OpenAPI cho cả sáu route.
- `Package`: `carrier` đọc từ cột; `flags` thêm `label_error`.
- Adapter Lazada: nhà vận chuyển, đóng gói, RTS, repack, vận đơn PDF. Adapter TikTok: `readyToShip` (gọi `shipPackage`), vận đơn PDF.
- Cổng `MarketplacePackages` mở rộng, bảng đổi lỗi, nối ở `src/wiring.ts`.
- Nhóm gói (D5), cờ Lỗi lấy vận đơn (D9).
- Sàn giả lập: stub `/order/package/document/get` (trả `pdf_url` trỏ về một PDF tĩnh của mock), stub providers `NTFS` (một kịch bản), sửa stub cũ nếu tham số khác.
- FE: chuyển sang API thật, spec E2E `e2e/be/pN/`.
- Documents (mục 8).

**Ngoài #239:**
- Mở kiện `awaiting_pickup` (giữ vận đơn, `25` §8.3, E115), dỡ một phần, `open_cancel`, cờ `needs_open`, sàn chia lại kiện, thất lạc: #238.
- Tách kiện: #205. #239 đóng gói đúng các món của kiện, nên kiện tách ra đóng gói riêng được ngay.
- Chọn cách giao TikTok (`PICKUP`/`DROP_OFF`): không gửi, dùng mặc định của gian hàng.
- Phiếu đóng gói (packing slip) và loại tệp khác `awb`.
- Báo sẵn sàng theo lô (route nhiều kiện).
- Đẩy trạng thái qua SSE (#216).
- Lazada hàng shop tự giao (`/order/package/sof/delivered`), route `self-deliver`.

## 5. Thiết kế

### 5.1 Dữ liệu và migration

`order.packages` thêm:

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `carrier_code` | `text` null | Mã nhà vận chuyển người dùng chọn lúc đóng gói (Lazada `NTFS`) |
| `carrier_name` | `text` null | Tên hiển thị lúc chọn |
| `label_error` | `boolean not null default false` | Cờ Lỗi lấy vận đơn (D9) |

CHECK `packages_carrier`: `(carrier_code is null) = (carrier_name is null)`. Không thêm index.

Migration sinh ở bước cuối PR2, sau khi gộp `main` có #300: `npm run db:generate -- --name dong-goi-rts`.

`updatePackage` (`repository/packages.ts`) nhận thêm `carrierCode`, `carrierName`, `labelError`, `packedBy`, `packedAt`, và `platformPackageCode` nhận cả `null` (open sau repack). Hàm này đã tự tăng `version`.

### 5.2 Luật thuần (`domain/packing.ts`, mới)

- `scanMismatch(lines, scanned)`: `lines` là dòng kiện `{ variantId: string | null, quantity }`, `scanned` là body `lines` (đã kiểm `variantId` không trùng bằng Zod). Gộp dòng đã ghép theo `variantId` rồi so với số quét. Trả `null` khi khớp, không thì một map `"lines.<variantId>" → câu báo`. Ba loại lệch: quét thiếu ("Kiện cần 3, đã quét 2"), quét thừa, quét món không có trong kiện.
- `packGroupBlockers(others)`: `others` là các kiện **khác** trong nhóm `{ code, status, orderStatus }`. Trả mã các kiện có `status ∉ {reserved, packed}` hoặc `orderStatus ≠ processing`.
- `readyGroupBlockers(members)`: `members` là cả nhóm, gồm chính kiện đang bấm. Trả mã các kiện chưa `packed` (trừ chính kiện đang bấm, bước 1 đã kiểm nó bằng `assertTransition`).
- `buildPickList(rows)`: `rows` là dòng kiện kèm `sku`, `productName`, `attributesLabel`. Gộp theo `variantId`, dòng chưa ghép thì theo `sku` với `variantId: null`. Mỗi dòng ra: `{ variantId, sku, productName, attributesLabel, quantity, packageCount }` (`packageCount` là số kiện khác nhau có món đó), sắp theo `sku`.

Unit test ở `test/unit/modules/order/fulfillment/domain/packing.test.ts`.

### 5.3 Cổng sàn và adapter (channel, PR1)

**Interface `MarketplaceAdapter` thêm năng lực tuỳ chọn** (`common.ts`):

```ts
/** Tham chiếu các món của một kiện trên sàn. */
interface PackageItemsRef { externalOrderId: string; externalLineIds: readonly string[] }

shipmentProviders?(accessToken: string, ref: PackageItemsRef): Promise<{ platformChooses: boolean; items: { code: string; name: string; isDefault: boolean }[] }>;
packItems?(accessToken: string, ref: PackageItemsRef & { carrierCode?: string }): Promise<{ packageCode: string; trackingCode: string | null; carrier: { code: string; name: string } | null }>;
readyToShip?(accessToken: string, packageCodes: readonly string[]): Promise<void>;
repackPackage?(accessToken: string, packageCode: string): Promise<void>;
/** Tệp PDF vận đơn của các kiện; một phần tử là một tệp (Lazada có thể gộp nhiều kiện vào một tệp). */
shippingDocuments?(accessToken: string, packageCodes: readonly string[]): Promise<Uint8Array[]>;
```

`withTokenRefresh` gọi lại sau khi làm mới token; `packItems`, `readyToShip`, `repackPackage` là hàm ghi, phải vào `NO_RETRY` (`channel/CLAUDE.md` mục Token: hàm ghi không gọi lại, chỉ làm mới cho lần sau).

**Lazada** (`lazada.ts`):
- `shipmentProviders`: `GET /order/shipment/providers/get`, `getShipmentProvidersReq={"orders":[{"order_id","order_item_ids":[…]}]}`. `shipping_allocate_type = TFS` thì `platformChooses: true`, `items: []`; không thì `items` lấy từ `shipment_providers[]`, `isDefault` khi trùng `platform_default`. Shop thử trả danh sách rỗng nên chưa biết tên trường của từng phần tử: builder tra tài liệu GetShipmentProvider, viết theo tài liệu, thêm kịch bản `NTFS` vào sàn giả lập.
- `packItems`: gọi `shipmentProviders` trước. `NTFS` mà thiếu `carrierCode` hoặc `carrierCode` không có trong danh sách thì ném `MarketplaceError('rejected', 'carrier_required', …)`, không gọi pack. Rồi `POST /order/fulfill/pack`, `packReq={"pack_order_list":[{"order_id","order_item_list":[…]}],"delivery_type":"dropship","shipping_allocate_type":"TFS"|"NTFS"}`, kèm `shipment_provider_code` khi `NTFS`. Phản hồi theo món (`pack_order_list[].order_item_list[]`: `order_item_id`, `package_id`, `tracking_number`, `shipment_provider`, `item_err_code`, `msg`). Món có `item_err_code ≠ "0"` thì ném `rejected` với mã và câu của món đầu tiên lỗi. Thiếu món hoặc các món ra nhiều `package_id` thì ném `rejected` `unexpected_response`. `carrier` là `null` khi `TFS`, là mục đã chọn trong danh sách khi `NTFS`.
- `readyToShip`: `POST /order/package/rts`, `readyToShipReq={"packages":[{"package_id"}…]}`, lô 20. Kiện có `item_err_code ≠ "0"` thì ném `rejected` với mã đó (30012 `rts package not found`…).
- `repackPackage`: `POST /order/package/repack` theo tài liệu RePack (builder xác nhận tên tham số; stub hiện tại không kiểm tham số).
- `shippingDocuments`: `GET /order/package/document/get`, `getDocumentReq={"doc_type":"PDF","packages":[{"package_id"}…]}`. Mỗi lời gọi tối đa N kiện (builder tra tài liệu; chưa rõ thì lấy 20), đọc `result.data.pdf_url` rồi tải. `result.success` khác `true` thì ném `rejected` với mã và câu của sàn.
- Mã `30012`, `700000`, `700026` là số nên `lazadaError` đã xếp vào `rejected`, giữ nguyên.

**TikTok** (`tiktok-orders.ts`):
- `readyToShip`: gọi `shipPackage` cho từng mã (đã coi 11006021 là xong).
- `shippingDocuments`: mỗi mã một `GET /fulfillment/202309/packages/{id}/shipping_documents` (`document_type=SHIPPING_LABEL`, `document_size=A6`, `document_format=PDF`), rồi tải `doc_url`. Tối đa 5 lời gọi cùng lúc (vẫn qua bộ giãn đọc 5 req/s). Kiện lỗi thì ném `rejected` với mã của sàn, câu của sàn có kèm mã kiện sàn.
- Không khai `shipmentProviders`, `packItems`, `repackPackage`.

**Tải tệp** (dùng chung cho hai sàn): mở rộng phần tải có ghim địa chỉ ở `marketplaces/image-source.ts` (kiểm host công khai, ghim địa chỉ qua `lookup`, kiểm lại mỗi lần chuyển hướng) để nhận được `application/pdf`: chỉ `https`, ≤ 10 MB mỗi tệp, 15 giây, tệp phải mở đầu bằng `%PDF-`. Không log URL ký (có chữ ký OSS hoặc token).

**Cổng cho fulfillment** (`order-actions.ts`; kiểu `MarketplacePackages` ở `fulfillment/service/packages.ts` thêm):

```ts
carriers(companyId, shopId, ref: PackageItemsRef): Promise<{ code: string; name: string; isDefault: boolean }[]>; // [] khi sàn tự chọn hoặc adapter không có hàm
pack(companyId, shopId, ref: PackageItemsRef & { carrierCode?: string }): Promise<{ packageCode: string; trackingCode: string | null; carrier: { code: string; name: string } | null } | null>; // null: sàn không có bước đóng gói
readyToShip(companyId, shopId, packageCode: string): Promise<void>;          // không có hàm: 422 marketplace_unsupported
repack(companyId, shopId, packageCode: string): Promise<'repacked' | 'not_supported'>;
shippingDocuments(companyId, shopId, packageCodes: readonly string[]): Promise<Uint8Array[]>; // không có hàm: 422 marketplace_unsupported
```

Mỗi hàm mở `shopSession` trong `withCompany` (như `marketplaceShipPackage`), gọi sàn ngoài giao dịch. Lỗi đi qua `onPackageAction` (giống `onSplit`), mọi mã app giữ `platformCode`, `platformMessage`:

| Nguồn | `platformCode` | Mã app |
|---|---|---|
| Lazada | `700000` | 409 `package_status_not_allowed` |
| Lazada | `700026` | 409 `item_not_packable` |
| Lazada | `30012` | 409 `rts_package_not_found` |
| TikTok | `21042104`, `21023035`, `11034037` | 409 `document_not_ready` |
| TikTok | `21023059`, `21042102` | 409 `package_status_not_allowed` |
| adapter | `carrier_required` | 422 `validation_failed`, `errors.carrierCode` |
| còn lại | | như `onMarketplace`: 503 `marketplace_unavailable`, 409 `marketplace_unauthorized`, 409 `marketplace_rejected`, 422 `marketplace_unsupported` |

`src/wiring.ts` nối thêm năm hàm vào `marketplacePackages`.

### 5.4 Route và luồng (fulfillment, PR2)

Router khai `GET /pick-list` và `GET /packages/documents` **trước** `GET /packages/:id`, vì Express sẽ khớp `documents` vào `:id`. Mọi route `ctx.authorize('fulfillment.order.process')` rồi `validate(...)`.

Repository thêm:
- `lockPackage` trả thêm `source` (đọc từ đơn), `selfDelivery`, `platformPackageCode`, `trackingCode`.
- `packageGroupOf(shopId, platformPackageCode)`: các kiện chưa huỷ cùng mã kiện sàn, `{ id, code, orderId, status, version }`, sắp theo `id`.
- `platformItemsOf(packageId)`: `{ externalOrderId, externalLineIds }`, join `package_lines` → `"order".order_lines` → `"order".orders` (SQL thô như `package-list.ts`).
- `setLinesPacked(packageId, packed: boolean)`: `packed_qty = quantity` hoặc `0`.
- `pickListRows(filter)`: dòng kiện của các kiện được chọn, kèm `sku`, `productName`, `attributesLabel` của dòng đơn.

**Khoá phiên.** `pack`, `ready`, `open` chạy cả ba bước trong `withSessionLock('fulfillment.package:<id>', fn, { waitMs: 10_000 })` (`shared/db/client.ts`). Hai lần bấm cùng lúc trên một kiện thì không gọi sàn hai lần: lần sau chờ khoá, rồi thấy `version` đã đổi. Không lấy được khoá sau 10 giây thì 409 `version_conflict` kèm `current`. Lượt kéo đơn không lấy khoá này (xem 5.6).

**`GET /fulfillment/pick-list?ids=`**
- `ids` tuỳ chọn: chuỗi UUID cách nhau bằng dấu phẩy, 1–200 mã, không trùng (lỗi thì 422 `errors.ids`).
- Có `ids`: các kiện của công ty có trong `ids`, không lọc trạng thái (FE chọn từ tab). Mã không có (hay của công ty khác) thì bỏ qua.
- Không `ids`: các kiện của tab `reserved` (kiện `reserved`, đơn `processing`), tối đa 500 kiện theo thứ tự của tab (`ship_by` tăng, null cuối, rồi mã).
- Trả `{ items: PickListLine[], packageCount: number, truncated: boolean }`, trong đó `PickListLine` = `{ variantId: uuid | null, sku, productName, attributesLabel, quantity, packageCount }`. `truncated` là `true` khi bị cắt ở 500.

**`GET /fulfillment/packages/:id/carriers`**
- Kiện không thấy thì 404. Kiện không có `shopId` (đơn tay, inbox) thì `{ items: [] }`.
- Không thì `ctx.marketplacePackages.carriers(companyId, shopId, platformItemsOf(id))` → `{ items }`. Lỗi sàn theo bảng 5.3.

**`POST /fulfillment/packages/:id/pack`**, body `{ version, lines: { variantId: uuid, quantity: int 1..10000 }[] (0..200, variantId không trùng), carrierCode?: string 1..100 }`:
1. **Kiểm** (`withCompany`, không khoá dòng): đọc kiện và đơn (`ctx.orderRefsOf`); sai `version` thì 409 `version_conflict` kèm `current`. `assertTransition(packageMachine, status, 'pack', { actor, record: { source, selfDelivery, orderStatus } })` (409 `invalid_transition`, 409 `order_not_processing`). `scanMismatch` lệch thì 422 `scan_mismatch` với `errors`. Kiện có mã kiện sàn thì xét nhóm: `packGroupBlockers` có mã thì 409 `package_group_not_ready`. Đọc `platformItemsOf`.
2. **Gọi sàn** (ngoài giao dịch): kiện có `shopId` thì `result = pack(companyId, shopId, { ...items, carrierCode })`, không thì `result = null`. Lỗi thì ném, không ghi gì.
3. **Ghi** (`withCompany`, `lockPackage`):
   - `version` đã đổi: nếu kiện đã `packed` và (`result` là `null` hoặc `platformPackageCode = result.packageCode`) thì trả `getPackage` (lượt kéo đơn đã áp kết quả của chính lệnh này); không thì 409 `version_conflict` kèm `current`.
   - Chạy lại `assertTransition` trên trạng thái mới đọc. Ghi `status = packed`, `packed_by`, `packed_at`, `carrier_code`/`carrier_name` từ `result.carrier`, `platform_package_code` (đang null thì lấy `result.packageCode`; đang khác thì ghi đè và log `warn`), `tracking_code` (`result.trackingCode` nếu có), `label_error = false`; `setLinesPacked(id, true)`; `recordTransition(… action: 'pack', actorId)`; phát `fulfillment.package_status_changed`.
   - Bước 3 lỗi sau khi sàn đã nhận lệnh thì log `error` (mã kiện, mã kiện sàn, câu "sàn đã đóng gói, app chưa ghi; lượt kéo đơn sẽ khớp") rồi ném tiếp.
4. Trả `getPackage(ctx, id)`.

**`POST /fulfillment/packages/:id/ready`**, body `{ version }`:
1. **Kiểm**: `version`; `assertTransition(…, 'mark_ready', …)` (409 `self_delivery`). Kiện có mã kiện sàn thì đọc nhóm; `readyGroupBlockers` có mã thì 409 `package_group_not_ready`. Kiện có `shopId` mà không có mã kiện sàn thì 409 `rts_package_not_found`.
2. **Gọi sàn**: kiện có `shopId` thì `readyToShip(companyId, shopId, platformPackageCode)`. Lỗi thì sang bước 2b.
   - **2b** (`withCompany`, `lockPackage`): kiện còn `packed` thì `label_error = true` (tăng `version`), rồi ném lỗi gốc.
3. **Ghi** (`withCompany`): khoá chính kiện đang bấm và các kiện còn lại của nhóm theo `id` tăng dần.
   - Kiện đang bấm sai `version`: đã `awaiting_pickup` thì trả `getPackage` như `pack`; không thì 409 `version_conflict`.
   - Mỗi kiện của nhóm đang `packed` thì chuyển `awaiting_pickup`, `label_error = false`, ghi lịch sử `mark_ready` với `actorId` người bấm, phát sự kiện. Kiện của nhóm không còn `packed` (vừa bị mở) thì bỏ qua và log `warn` (sàn đã nhận lệnh cho cả gói).
4. Trả `getPackage`. Kiện TikTok chưa có `trackingCode` ngay: mã về ở lượt kéo đơn sau.

Đơn tay (không `shopId`): không gọi sàn ở `pack` lẫn `ready`, chỉ chuyển trạng thái.

**`POST /fulfillment/packages/:id/open`**, body `{ version }` (chỉ từ `packed`, D6):
1. **Kiểm và giữ hàng** (`withCompany`): kiện có `shopId` thì khoá dòng gian hàng `FOR SHARE` qua `ctx.stockHoldOf(..., { lock: true })` trước khi khoá kiện (cùng thứ tự với `hand-over`), rồi `lockPackage`.
   - Sai `version` thì 409 `version_conflict` kèm `current`. `assertTransition(…, 'open', …)` (409 `invalid_transition` khi sai trạng thái). Kiện `awaiting_pickup` thì 409 `invalid_transition`, `detail` "Kiện đã báo sàn sẵn sàng giao: dỡ kiện về kệ qua việc của kho (#238)".
   - Kiện còn dòng đã ghép SKU mà chưa giữ (`reserved_qty < quantity`): gian hàng đang chờ kiểm kê đầu kỳ thì 409 `shop_awaiting_stocktake`. Không thì `stockPort().reserve(id, <các dòng đó>)`. `reserved: false` thì 422 `insufficient_stock`, `detail` "Không đủ hàng để giữ lại cả kiện, chờ hàng về rồi mở"; `true` thì đánh dấu dòng đã giữ, ghi `reserved_at`, và phát `fulfillment.allocation_done { variantIds }` cho SKU của kiện (như kiện mới giữ được hàng, `fulfillment/CLAUDE.md`), để channel đẩy lại tồn. Giao dịch commit ở đây: kiện vẫn `packed`, nay đã giữ hàng, là trạng thái hợp lệ dù bước sau lỗi.
2. **Gọi sàn**: kiện có `shopId` và mã kiện sàn thì `outcome = repack(...)`; không thì `outcome = null`. Lỗi thì ném, không ghi thêm.
3. **Ghi** (`withCompany`, `lockPackage`): sai `version` so với cuối bước 1 thì 409 `version_conflict` (không có ca "đã ở đích"). Chuyển `reserved`, `setLinesPacked(id, false)`, `packed_by = packed_at = null`, `label_error = false`. `outcome = 'repacked'` thì xoá `platform_package_code`, `tracking_code`, `carrier_code`, `carrier_name` (gói Lazada cũ không còn; đóng gói lại sẽ ra mã mới). `outcome = 'not_supported'` (TikTok) thì giữ mã kiện sàn: trên sàn kiện vẫn chờ đóng gói, chưa có lệnh nào phải huỷ. Ghi lịch sử `open`, phát `fulfillment.package_status_changed`.
4. Trả `getPackage`.

**`GET /fulfillment/packages/documents?ids=&kind=awb`**
- `ids`: 1–50 UUID không trùng (422 `errors.ids`). `kind`: `awb`, mặc định `awb`.
- Đọc kiện (`findPackagesByIds`, RLS). Thiếu kiện nào thì 404 `not_found`. Kiện không có `shopId` hoặc không có mã kiện sàn thì 409 `document_not_ready`, `detail` liệt kê mã kiện ("Kiện KH-000012, KH-000013 chưa có mã kiện sàn").
- Gom theo gian hàng (theo thứ tự xuất hiện trong `ids`), bỏ trùng mã kiện sàn, gọi `shippingDocuments` cho từng gian hàng (ngoài giao dịch, tối đa 3 gian hàng cùng lúc).
- Gộp mọi tệp bằng `pdf-lib` (`PDFDocument.create`, `copyPages`) theo thứ tự gian hàng, trong mỗi gian hàng theo thứ tự sàn trả. Tổng tệp tải về quá 50 MB thì 422 `errors.ids` ("Chọn ít kiện hơn").
- Trả 200, `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="van-don-<YYYYMMDD-HHmm>.pdf"` (giờ VN; tên trong ngoặc kép như route báo cáo CSV). Mọi lỗi ném trước khi gửi header nên vẫn ra Problem Details JSON.
- Gộp PDF đặt ở `service/documents.ts` của fulfillment; `pdf-lib` là dependency của gói (thêm vào `package.json`).

**`Package`** (`views.ts`, `api/schemas.ts`): `carrier` = `{ code, name }` khi có `carrier_code`, không thì `null`. `PACKAGE_FLAGS` thêm `label_error`; `flags` có `label_error` khi `label_error = true`.

OpenAPI (`api/openapi.ts`): khai sáu route kèm schema `PickList`, `CarrierList`, `PackBody`, `ReadyBody`, `OpenBody`, `PackageDocumentsQuery`. Response của `documents` là `application/pdf`, dạng nhị phân.

### 5.5 Lỗi

| Route | Mã | Khi nào |
|---|---|---|
| mọi route | 403 `forbidden` | Thiếu `fulfillment.order.process` (Admin, Sale) |
| route có `:id`, `documents` | 404 `not_found` | Không thấy kiện (kể cả công ty khác, `id` sai định dạng) |
| `pack`, `ready`, `open` | 409 `version_conflict` kèm `current` | Sai `version`, hoặc khoá phiên bận quá 10 giây |
| `pack`, `ready`, `open` | 409 `invalid_transition` | Sai trạng thái; `open` kiện `awaiting_pickup` (D6) |
| `open` | 422 `insufficient_stock` | Kiện chưa giữ đủ hàng và giữ lại không đủ |
| `open` | 409 `shop_awaiting_stocktake` | Kiện chưa giữ đủ hàng, gian hàng đang chờ kiểm kê đầu kỳ |
| `pack` | 409 `order_not_processing` | Đơn chưa `processing` |
| `pack` | 422 `scan_mismatch`, `errors["lines.<variantId>"]` | Số quét lệch |
| `pack` | 422 `validation_failed`, `errors.carrierCode` | Lazada `NTFS` thiếu hoặc sai nhà vận chuyển |
| `pack`, `ready` | 409 `package_group_not_ready`, `detail` liệt kê mã kiện | Nhóm gói chưa đủ điều kiện (D5) |
| `ready` | 409 `self_delivery` | Kiện tự giao |
| `ready` | 409 `rts_package_not_found` | Kiện sàn chưa có mã kiện sàn, hoặc Lazada 30012 |
| `pack`, `ready`, `open`, `carriers`, `documents` | theo bảng 5.3 | Lỗi sàn |
| `documents` | 409 `document_not_ready` | Kiện chưa có mã kiện sàn, hoặc TikTok chưa giao kiện / ĐVVC đang tạo tệp |
| `documents`, `pick-list` | 422 `errors.ids` | `ids` sai định dạng, trùng, vượt giới hạn; tổng tệp quá 50 MB |

### 5.6 Chạy đồng thời và gọi lặp

- Khoá phiên theo kiện (5.4) chặn hai lần bấm gọi sàn hai lần.
- Lượt kéo đơn có thể áp `packed`/`awaiting_pickup` từ dữ liệu sàn giữa bước 2 và bước 3. Bước 3 nhận ra "kiện đã ở trạng thái đích, cùng mã kiện sàn" và trả thành công, không ghi lại, không ghi thêm dòng lịch sử. Hệ quả: lịch sử ghi lần chuyển đó là do sàn (`actor_id` null), không phải người bấm. Chấp nhận.
- Sàn đã nhận lệnh mà bước 3 lỗi (DB, mất kết nối): lượt kéo đơn tiếp theo (tối đa 5 phút) áp trạng thái sàn (`pack`: gắn mã kiện và `reserved → packed`; `ready`: `packed → awaiting_pickup`). Người dùng bấm lại trước đó: Lazada trả 700000 → 409 `package_status_not_allowed` ("tải lại để xem trạng thái mới"); TikTok giao kiện lần hai trả 11006021, adapter coi là xong, bước 3 ghi bình thường.
- Lỗi tạm của sàn (503) không thử lại trong request; người dùng bấm lại. Adapter Lazada đã tự chờ và gọi lại một lần khi gặp `SellerCallLimit`.
- Lượt kéo đơn đưa kiện ra khỏi `packed` (sàn báo đã sẵn sàng giao hay đã lấy) thì xoá `label_error`: sửa chỗ đổi trạng thái của `syncPlatformPackages` (`changeStatus` ở `platform-packages.ts`) trong PR2, để cờ không treo khi người dùng đã báo sẵn sàng trên Seller Center.
- Sau repack Lazada, lượt kéo đơn có thể còn thấy mã kiện cũ trên món trong một lúc. Chỗ gắn mã của `syncPlatformPackages` chỉ gắn khi kiện chưa có mã, nên kiện vừa mở (mã đã xoá) có thể được gắn lại mã cũ; lần `pack` sau nhận mã mới và ghi đè (5.4, kèm log `warn`). Chấp nhận, không sửa đồng bộ đơn.
- `withSessionLock` cần kết nối giữ phiên (PostgreSQL trực tiếp hoặc Session pooler), đã dùng cho làm mới token nên môi trường đáp ứng.

### 5.7 Phân quyền, bảo mật

- Mọi route: `ctx.authorize('fulfillment.order.process')` trước `validate()`; dữ liệu đọc ghi trong `withCompany` (RLS).
- Tải tệp vận đơn: chỉ `https`, địa chỉ công khai có ghim, kiểm lại mỗi lần chuyển hướng, `application/pdf`, ≤ 10 MB mỗi tệp, 15 giây. Không trả URL ký cho FE, không log URL.
- Không lưu tệp vận đơn; in lại thì gọi sàn lại.
- Log chỉ ghi mã kiện, mã kiện sàn, mã lỗi sàn; không ghi token.

### 5.8 Hiệu năng

- In 50 kiện TikTok: 50 lời gọi cộng 50 lần tải, bộ giãn đọc 5 req/s, khoảng 10–20 giây. Lazada: một lời gọi cho mỗi lô kiện của một gian hàng. Nằm trong hạn chờ của proxy hiện tại; FE hiện trạng thái đang tải.
- Danh sách nhặt: một câu truy vấn, tối đa 500 kiện.
- Mỗi lần `pack` Lazada tốn hai lời gọi (providers + pack), tính vào hạn mức ngày `LAZADA_DAILY_CALL_LIMIT`.

### 5.9 Test

**Unit:**
- `domain/packing.ts`: `scanMismatch` (khớp, thiếu, thừa, món ngoài kiện, dòng chưa ghép bỏ qua), `packGroupBlockers`, `readyGroupBlockers`, `buildPickList`.
- Adapter Lazada (fetch giả): hình request của providers, pack (`TFS`, `NTFS`, `carrier_required`), RTS (chia lô 20), repack, vận đơn; `item_err_code` → `rejected`; nhiều `package_id` → `unexpected_response`. Thêm ca năng lực tuỳ chọn vào `adapter-contract.ts` nếu hợp.
- Adapter TikTok: `shippingDocuments` gọi từng kiện, mã lỗi giữ nguyên; `readyToShip` gọi `shipPackage`.
- `onPackageAction`: bảng đổi lỗi ở 5.3.
- Tải PDF: từ chối `http`, sai `content-type`, vượt 10 MB, không mở đầu `%PDF-`.

**Integration** (`test/integration/order/fulfillment/packing.test.ts`, PostgreSQL thật, cổng sàn giả qua `ctx.marketplacePackages`):
- **D2-03:** `reserved`, đơn `processing`, quét đủ → `packed`; `packed_qty`, nhà vận chuyển, mã kiện sàn, vận đơn, lịch sử, sự kiện.
- **D2-03g:** `order_not_processing`; `scan_mismatch` (ba loại); `carrier_required` → 422 `errors.carrierCode`; cổng ném `item_not_packable` → 409, kiện vẫn `reserved`.
- **D2-04:** `ready` kiện sàn → `awaiting_pickup`. **D2-04g:** `self_delivery`. Cổng lỗi → kiện `packed`, có `label_error`; `ready` lại thành công → cờ được xoá.
- **Đua:** cổng giả gọi `syncPlatformPackages` (sàn báo `packed`) giữa bước 2 và bước 3 → `pack` vẫn trả thành công, lịch sử chỉ một dòng.
- **Nhóm gói:** hai đơn chung mã kiện TikTok: `pack` bị chặn khi đơn kia chưa `processing`; `pack` kiện thứ hai sau khi kiện thứ nhất đã `packed` vẫn được; `ready` gọi cổng đúng một lần, cả nhóm sang `awaiting_pickup`.
- **open:** kiện `packed` Lazada, cổng trả `repacked` → `reserved`, xoá mã kiện sàn, vận đơn, nhà vận chuyển, vẫn giữ hàng; TikTok `not_supported` → `reserved`, giữ mã kiện sàn; kiện `awaiting_pickup` → 409 `invalid_transition`, không gọi cổng; kiện `packed` chưa giữ hàng, đủ hàng → giữ cả kiện, phát `allocation_done`, rồi `reserved`; không đủ hàng → 422 `insufficient_stock`, kiện vẫn `packed`, không gọi cổng; gian hàng chờ kiểm kê → 409 `shop_awaiting_stocktake`.
- **label_error:** lượt kéo đơn đưa kiện `packed` có cờ sang `awaiting_pickup` → cờ được xoá.
- **documents:** 409 `document_not_ready` liệt kê mã kiện; hai gian hàng, ba kiện (hai kiện chung mã nhóm) → cổng gọi đúng hai lần, ra một PDF có đủ trang; `Content-Type`, `Content-Disposition`.
- **pick-list:** gộp theo biến thể, `packageCount`, dòng chưa ghép gộp theo `sku`, mặc định tab `reserved`, `truncated`.

**API** (`test/api/fulfillment.test.ts`): **D2-03q**, **D2-04q** (Admin, Sale nhận 403); 422 của Zod (`ids` quá 50, `variantId` trùng trong `lines`, `kind` lạ).

**Smoke (tay, shop thử, ghi `request_id` vào `channel/CLAUDE.md` và `tich-hop-san`):**
- Lazada (một đơn thử mới): providers → pack → RTS → vận đơn PDF; một đơn khác: pack → repack.
- TikTok: ship → shipping_documents ra PDF.

**E2E FE:** spec `e2e/be/pN/` cho luồng danh sách nhặt → quét → sẵn sàng giao → in.

## 6. Thứ tự giao

1. **PR Documents** (mục 8).
2. **PR1 channel:** interface, adapter Lazada, TikTok, tải PDF, cổng, đổi lỗi, `wiring.ts`, sàn giả lập, smoke. Thành review.
3. **PR2 fulfillment:** domain, repository, route, OpenAPI, test; gộp `main` sau khi #300 và PR1 merge; sinh migration ở bước cuối.
4. **PR3 FE:** nối API thật, câu báo mã mới, E2E.

PR1 và phần code của PR2 viết song song được (PR2 dùng cổng giả trong test).

## 7. Ảnh hưởng tới FE

- `GET /pick-list` trả `{ items, packageCount, truncated }` thay cho mảng trần như mock hiện tại: sửa `usePickList` và handler mock. `variantId` của dòng nhặt có thể `null`.
- Lazada `TFS` trả danh sách nhà vận chuyển rỗng: FE không bắt chọn (đúng logic mock hiện có).
- Kiện TikTok sau `ready` chưa có `trackingCode` ngay. In vận đơn TikTok ngay sau `ready` có thể nhận 409 `document_not_ready` (ĐVVC đang tạo tệp): báo "thử lại sau ít phút".
- Mã mới `package_group_not_ready`: thêm câu báo.
- Cờ `label_error`: hiện nhãn "Lỗi lấy vận đơn" (FE đã có trong danh sách cờ của `Documents/21`).
- Nút "Dỡ kiện về kệ" chỉ hiện cho kiện `packed` tới khi có #238; kiện `awaiting_pickup` gọi `open` nhận 409 `invalid_transition`. `open` có thể trả 422 `insufficient_stock` hoặc 409 `shop_awaiting_stocktake`: thêm câu báo.
- Spec E2E `e2e/be/pN/`.

## 8. Ảnh hưởng tới Documents

- `21` §19.2: hình trả về của `GET /pick-list` (`items`, `packageCount`, `truncated`; `ids` 1–200; mặc định tối đa 500 kiện); mã `package_group_not_ready`; route `open`: tới khi có #238 chỉ nhận kiện `packed`, kiện chưa giữ đủ hàng thì giữ lại lúc mở (422 `insufficient_stock`, 409 `shop_awaiting_stocktake`).
- `21` §19.3: sửa gạch "`open` kiện sàn đã có `platformPackageCode` thì BE gọi repack" thành: chỉ kiện `packed` (chưa báo sẵn sàng giao) mới gọi repack; kiện `awaiting_pickup` giữ vận đơn theo `25` §8.3 (E115). `documents` luôn trả PDF, gộp nhiều gian hàng và nhiều sàn; `document_not_ready` cả khi TikTok chưa giao kiện hoặc ĐVVC đang tạo tệp; thêm mã TikTok vào bảng đổi lỗi; nhà vận chuyển rỗng khi sàn tự chọn (`TFS`).
- `19` mục 2: `packages.carrier_code`, `packages.carrier_name` (CHECK cùng null).
- `17` §6: thêm dòng `pdf-lib` (gộp vận đơn PDF, commerio-backend#239).
- `tich-hop-san/lazada.md` §7.4: dùng `/order/package/document/get` (`doc_type: PDF`), kèm kết quả gọi thật 13/11/2026 ở mục 2; sau smoke thì ghi kết quả pack, RTS, repack.
- `tich-hop-san/tiktok.md`: vận đơn `shipping_documents`.

## 9. Acceptance criteria

| # | Cho | Khi | Thì | Ca |
|---|---|---|---|---|
| 1 | Nhiều kiện Cần đóng gói | `GET /pick-list` không `ids` | Gộp theo biến thể, mỗi dòng có tổng số và số kiện | US-DH-06 #1 |
| 2 | Kiện `reserved`, đơn `processing`, Lazada `TFS` | Quét đủ, `pack` | `packed`, có mã kiện sàn và vận đơn từ sàn, `carrier` null | US-DH-06 #2, D2-03 |
| 3 | Như 2 | Quét lệch một dòng | 422 `scan_mismatch`, `errors["lines.<variantId>"]` đúng dòng | US-DH-06 #3 |
| 4 | Lazada `NTFS` | `pack` thiếu `carrierCode` | 422 `errors.carrierCode`, không gọi pack | US-DH-06 #4 |
| 5 | Lazada: món đã huỷ hoặc đang xin huỷ | `pack` | 409 `item_not_packable`, kiện vẫn `reserved` | US-DH-06 #5 |
| 6 | Đăng nhập Admin hoặc Sale | `pack`, `ready` | 403 `forbidden` | US-DH-06 #6, D2-03q, D2-04q |
| 7 | Lazada, kiện `packed` | `ready` | Gọi RTS, kiện `awaiting_pickup` | US-DH-07 #1, D2-04 |
| 8 | 1–50 kiện đã có mã kiện sàn, Lazada và TikTok, hai gian hàng | `documents` | Một tệp PDF in được, đủ vận đơn | US-DH-07 #2 |
| 9 | Có kiện chưa có mã kiện sàn | `documents` | 409 `document_not_ready`, liệt kê mã kiện | US-DH-07 #3 |
| 10 | Sàn lỗi khi `ready` | `ready` | Kiện ở lại `packed`, cờ `label_error`; bấm lại thành công thì hết cờ | US-DH-07 #4 |
| 11 | Kiện tự giao | `ready` | 409 `self_delivery` | US-DH-07 #5, D2-04g |
| 12 | Lượt kéo đơn áp `packed` trong lúc gọi sàn | `pack` | Trả `Package` `packed`, không 409 | 5.6 |
| 13 | Nhóm gói TikTok hai đơn, một đơn chưa `processing` | `pack` kiện còn lại | 409 `package_group_not_ready` | D5 |
| 14 | Nhóm gói TikTok, cả nhóm `packed` | `ready` một kiện | Gọi sàn một lần, cả nhóm `awaiting_pickup` | D5 |
| 15 | Kiện Lazada `packed` có mã kiện sàn | `open` | Gọi repack, kiện `reserved`, mất mã kiện sàn, vẫn giữ hàng | D6 |
| 16 | TikTok, kiện `packed` | `ready` | Gọi giao kiện, kiện `awaiting_pickup`; vận đơn về ở lượt kéo đơn sau | D7 |
| 17 | Kiện `awaiting_pickup` | `open` | 409 `invalid_transition`, không gọi sàn | D6 |
| 18 | Kiện `packed` chưa giữ hàng (sàn báo đã đóng trước khi app giữ) | `open`, đủ hàng | Giữ cả kiện, kiện `reserved`; thiếu hàng thì 422 `insufficient_stock`, kiện vẫn `packed` | D6 |

## 10. Rủi ro và điểm còn mở

- Pack, RTS, repack, vận đơn chưa được gọi ghi từ code lên shop thử Lazada (pack, RTS mới gọi qua API Explorer, `lazada.md` §11.1). Shop thử dùng chung, mỗi ngày tạo tối đa 10 đơn thử: dự trù lượt cho smoke.
- Lazada `NTFS` chưa gặp (shop thử là `TFS`): tên trường trong `shipment_providers[]` theo tài liệu, chưa đối chiếu dữ liệu thật.
- Tham số của `/order/package/repack` và số kiện tối đa mỗi lời gọi `/order/package/document/get` chưa xác nhận: builder tra tài liệu, smoke xác nhận.
- Host của `doc_url` TikTok chưa biết: phần tải nhận mọi host công khai qua `https`.
- Lịch sử ghi lần chuyển là do sàn khi lượt kéo đơn thắng đua (5.6).
- Kho đóng nhầm mà đã báo sẵn sàng giao thì chưa sửa được trong app tới khi có #238 (D6); làm trên Seller Center.
- #300 sửa cùng file: gộp `main` và `db:regen` khi #300 merge.

**Để builder tự quyết:** tên hàm, tên file trong repository; cách dựng test fixture; câu chữ thông báo lỗi (tiếng Việt, theo giọng các câu đã có); chi tiết bộ giãn khi tải nhiều PDF TikTok; số kiện mỗi lời gọi vận đơn Lazada khi tài liệu không ghi; tham số của `/order/package/repack` (tra tài liệu, smoke xác nhận).
