# Spec: Kiện thất lạc, sàn chia lại kiện, nguồn nhắc, Mở kiện (#238)

- **Ngày:** 15/11/2026; sửa 18/11/2026 (mục 5.6 viết lại cho PR 3)
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#238 (body viết lại 15/11/2026, cập nhật 18/11/2026), `Documents/21` §11.2, §14.1, §14.2, §19.2, `Documents/25` §7.4, §8.1, §8.3, §8.4, §8.5, `Documents/19` (bảng `packages`, `package_lines`), `Documents/27` US-DH-12, US-DH-15, `Documents/kiem-thu/ca-theo-so-do.md` (D2)
- **Trạng thái:** Khang duyệt 15/11/2026. D2 đến D6 Thành chốt 15/11/2026. PR 1 (#331) và PR 2 (#366) đã merge. D22 đến D29 (PR 3, thêm 18/11/2026) Khang duyệt 18/11/2026.
- **Nền:** `main` 7d3ed9d cho PR 1, PR 2. **PR 3 (mục 5.6) đối chiếu lại với `main` eb49bba** (18/11/2026: đã có #329, #330 của #205, #237 PR 1, #358, PR 1 và PR 2 của spec này). Hiện trạng dùng cho PR 3 ở mục 2, đoạn "`main` eb49bba".
- **Phạm vi spec:** Khang chốt 15/11/2026 là **một spec phủ cả 5 phần** của issue. Thi công vẫn nhiều PR (mục 6). Kế hoạch PR 3: `docs/superpowers/plans/2026-11-18-238-pr3-chia-lai-kien.md`.

---

## 1. Mục tiêu và tiêu chí thành công

1. **Thất lạc.** Kho báo một kiện thất lạc kèm mã khiếu nại, người khác xác nhận thì kiện sang `lost`; không ai một mình ghi mất hàng được. Sàn báo mất thì kiện sang `lost` không cần người duyệt. Sàn báo ngược lại một trạng thái do người chuyển tay thì áp theo sàn và bật cờ Cần xử lý. Mọi lần kiện sang `lost` phát `fulfillment.package_lost`.
2. **Sàn chia lại kiện.** Khi danh sách kiện của sàn khác danh sách trong app, app tự xử lý phần chưa đóng gói (huỷ kiện cũ, lập kiện mới, giữ hàng cho kiện mới của đơn trước) và giao việc Dỡ kiện về kệ cho phần đã đóng gói; hàng chỉ trả về số có thể bán khi kho xác nhận đã mở. Hiện tại app chỉ bật cờ Cần xử lý trên đơn và bỏ qua nhóm món đó.
3. **Dỡ kiện không thấy.** Kiện đã đóng gói đang chờ mở mà kho không tìm thấy thì báo, người khác xác nhận, hệ thống ghi bàn giao (trừ tồn một lần) rồi `lost`.
4. **Mở kiện do kiểm kê.** Phiếu kiểm kê đếm thấp hơn hàng đang nằm trong kiện đã đóng thì kiện vào tab Cần mở để kho mở, thay vì chỉ mang cờ Cần xử lý không có thao tác đi kèm.
5. **Nguồn nhắc.** Ba loại việc `package.ship_by`, `package.lost_reported`, `package.needs_open` hiện ở `GET /tasks`.
6. **FE** nối API thật cho các thao tác trên, máy trạng thái FE và BE cùng một bảng.

Đo bằng: AC ở mục 9 đều qua; `npm run check` xanh ở từng PR; ca D2 mới ở `ca-theo-so-do.md` có test mang mã ca.

**Vì sao làm ngay:** issue mang nhãn `priority: urgent`; Thành báo #238 chặn phần app của #221 (chưa rõ phần nào, đã hỏi trên issue).

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (7d3ed9d):**

- `domain/package.ts`: `lose` từ `awaiting_pickup`, `in_transit`, `delivery_failed`, `returning`, `self_delivering` (`needsSecondPerson`, `needsReason`, chưa có `allowSelfApproval`); `found` từ `lost`. Chưa có mũi tên nào của sàn cho `lost`.
- Chưa có route `report-lost`, `confirm-lost`. Route `found` đã có (`service/delivery.ts`, `foundPackage`).
- `repository/schema.ts`: có `lost_reported_by/at`, `lost_claim_code`, `lost_confirmed_by`; CHECK `packages_lost_second_person` (người xác nhận khác người báo, chưa có vế tự duyệt), `packages_lost_report` (người báo và mã khiếu nại cùng null hoặc cùng có). Chưa có `lost_self_approved`, `lost_source`, `replaces_package_id`.
- `service/views.ts`: cờ `lost_reported` đã suy ra; `lostReport` luôn `null`.
- **Sàn báo mất đang đi nhờ mũi tên `lose`.** Lazada ánh xạ `lost`, `lost_by_3pl`, `damaged_by_3pl`, `package_scrapped` → `lost`. `applyStatus` (`service/platform-packages.ts`) thấy có mũi tên `in_transit → lost` thì áp, lịch sử ghi `action = 'lose'`, `source = 'marketplace'`; không ghi cột nào trên kiện, không phát `package_lost`. Vì `lose` đang gồm `awaiting_pickup`, kiện `awaiting_pickup` mà sàn báo `lost` cũng được áp và **có trừ tồn** (`changeStatus` → `settleHandover`); kiện `backordered`, `reserved`, `packed` mà sàn báo `lost` thì chỉ bật cờ Cần xử lý (`fulfillment/CLAUDE.md` đang ghi gộp là "vẫn cờ Cần xử lý", sai với `awaiting_pickup`).
- Mũi tên `return` của người dùng bị chặn với kiện sàn (`carrierOnly`), và chỉ kiện sàn mới được đồng bộ: hiện không có đường nào để một kiện sàn ở `returning` do người chuyển tay.
- Đơn sàn: mỗi món sàn là một `order_line` số lượng 1 (`sales/service/ingest.ts`, spec 205 §2). Sàn chia lại kiện vì vậy luôn chuyển **nguyên dòng**, không chia số lượng của một dòng ra hai mã kiện.
- Sàn báo `in_transit` hoặc `delivered` cho kiện đang `lost`/`returning`: `platformUpdate` trả `invalid`, kiện bật Cần xử lý, trạng thái giữ nguyên.
- Sàn chia lại: `syncPlatformPackages` đặt `resplit = true` và bỏ qua nhóm; `sales/service/ingest.ts` bật Cần xử lý trên đơn với ghi chú "Sàn chia lại kiện khác lần trước". Sàn đổi mã gói mà tập món không đổi: kiện tìm được qua dòng đơn nhưng mã kiện sàn cũ không được cập nhật (chỉ gắn khi đang null).
- Kiểm kê: `onStocktakePosted` (`service/allocation.ts`) nghe `inventory.stocktake_posted`; kiện đã đóng đang giữ SKU bị đếm thiếu thì bật `needs_attention` với `DISMANTLE_NOTE`, ghi chú trong code "chưa có khung việc #209".
- `GET /tasks` chưa có trên `main` (#209 còn mở).
- Enum `open_purpose`: `cancel`, `edit`, `resplit`.

**`main` eb49bba (18/11/2026), nền của PR 3:** đã có #329, #330 của #205, #237 PR 1, #358, PR 1 và PR 2 của spec này.

- `package_lines.pending_drop_qty` (dòng chờ bỏ). Ba constraint trigger kiểm bằng lúc commit: tổng `quantity − pending_drop_qty` của một dòng đơn trên các kiện chưa huỷ bằng `order_lines.quantity − cancelled_qty` (`db/CLAUDE.md`). Mọi đường ghi dòng kiện phải khoá kiện trước.
- `openPackage` (`service/packing.ts`): mọi dòng chờ bỏ thì `open_cancel` (rồi `settleCancelledOrder` của sales ở giao dịch riêng); còn lại `open`, xoá dòng chờ bỏ, nhả phần giữ của chúng, **luôn gọi `repack`** khi kiện có gian hàng và mã kiện sàn (Lazada `repacked` thì xoá mã kiện, vận đơn, ĐVVC); `stocktake` gỡ cờ và xếp lượt phân hàng. Kiện `awaiting_pickup` trả 409 `invalid_transition` ("dỡ kiện về kệ qua việc của kho (#238)"), dù máy trạng thái đã cho `open`/`open_cancel` từ `SEALED`.
- `packPackage` gọi `pack` của sàn (Lazada trả luôn mã kiện và **mã vận đơn** ngay lúc đóng gói), rồi ghi `carrier_*` theo kết quả (null khi sàn không trả). `markReady` gọi `readyToShip` khi kiện có gian hàng và mã kiện sàn.
- `syncPlatformPackages`: huỷ dòng xét theo kiện trước (`planLineCancel`); món chưa có mã kiện sàn theo kiện app đang chứa nó (spec 205 D10); món có mã sàn gom theo mã. Mỗi nhóm tìm kiện bằng `existing.find(mã) || owner.get(món đầu)`: nhóm mã mới mà món còn trong kiện cũ thì **gán về kiện cũ, không đổi gì** (kiện cũ giữ mã cũ đã mất trên sàn: ca TikTok `it.skip` "sàn tách kiện theo SKU" của #221 ở `test/integration/channel/channel/tiktok-order-pull.test.ts`); nhóm có món của hai kiện app thì `resplit = true` và bỏ qua nhóm. Kiện tạm mang mã khi đang null; mã đã có thì không gắn lại. `owner` gồm cả dòng của kiện đã huỷ.
- Unique `packages_platform_code_order_uq` (gian hàng, mã kiện sàn, đơn) **không lọc trạng thái**: kiện đã huỷ vẫn giữ mã của nó; hai kiện của một đơn không thể đổi mã cho nhau trong một câu.
- `createPackage` (đường sàn): kiện lần đầu thấy, thử giữ hàng khi sàn còn ở `pending`/`packed`/`awaiting_pickup` và mọi dòng đã ghép; kiện chỉ toàn dòng "không quản tồn" coi như giữ được (#237 D10). Kiện lần đầu thấy đã rời kho đi luật mốc kéo đơn (`store_only`/`deduct`/`defer`).
- `markWholePendingDrop`: sàn huỷ cả kiện đã đóng đang chờ mở vì `edit`/`stocktake` thì mục đích thành `cancel`; `resplit` chưa được nâng.
- `updatePackage`: `stocktakeFlagRules` gỡ cờ `stocktake` khi kiện rời nhóm đã đóng; cờ `cancel`, `edit`, `resplit` thì treo (`fulfillment/CLAUDE.md` ghi "để PR 3"). Kiện đang `needs_open` vẫn báo sẵn sàng giao và quét bàn giao được.
- Lượt phân hàng (`repository/allocation.ts`, `candidateWhere`): ứng viên là kiện `backordered` và kiện đã đóng chưa giữ hàng, mọi dòng đã ghép, không `needs_open` (trừ `stocktake` tự gỡ được). Thứ tự: kiện đã đóng trước, `ship_by`, đơn về trước, mã kiện. Bước giữ hàng nằm trong `runAllocation`, chưa tách thành hàm dùng lại.
- Sales (`service/ingest.ts`): `resplit` bật Cần xử lý trên đơn, note "Sàn chia lại kiện khác lần trước". Hai test khẳng định hành vi này: `split-sync.test.ts` ("món của hai kiện app về chung một mã sàn vẫn bật Sàn chia lại kiện"), `ingest.test.ts` ("cùng lượt sàn chia lại kiện").
- Cổng tồn `reserve`/`release` chỉ giữ tổng theo SKU, không ghi theo kiện (spec 205 §2): chuyển dòng đang giữ từ kiện này sang kiện khác không cần gọi cổng tồn.
- #237 PR 2 (đổi ghép đã dùng, áp lại khi mở kiện) chưa làm, cũng sẽ sửa `openPackage`.

**Ràng buộc:**

- Thứ tự khoá đã chốt ở spec 199b §5.10: gian hàng → advisory `fulfillment.allocation:<công ty>` → kiện → dòng tồn → `doc_counters`. Lượt kéo đơn khoá đơn trước kiện.
- Luật ranh giới của repo: fulfillment không import sales; đọc lịch sử trạng thái qua hàm của `core`.
- Mỗi PR sinh migration ở bước cuối; PR khác có migration merge trước thì `npm run db:regen`.
- Thêm loại sự kiện là PR riêng. Spec này **không thêm loại sự kiện nào** (`fulfillment.package_lost` đã có từ #288).

## 3. Quyết định

Đánh dấu **(Khang)** là Khang chốt trong buổi soạn; **(đề xuất)** là Claude đề xuất, Khang chưa bác; **(Thành)** là Thành chốt trên issue hoặc trong review.

| # | Quyết định | Nguồn |
|---|---|---|
| D1 | Một spec cho cả 5 phần của issue | Khang |
| D2 | Tên thao tác theo máy FE và bộ ca: `lose_on_unload`, `platform_in_transit`, `platform_deliver`. Sửa `21` §19.2 (đang ghi `lose_unfound`, `platform_revive`) | Thành (15/11) |
| D3 | Thêm `platform_lost` vào máy FE và BE, sinh ca D2 mới | Thành (15/11) |
| D4 | Bỏ `awaiting_pickup` khỏi `lose` (theo `25` §8.3). Kiện đã đóng mà mất đi `lose_on_unload`, từ cả `packed` và `awaiting_pickup` | Thành (15/11) |
| D5 | Cờ `cod_unconfirmed` ngoài phạm vi #238 (đơn COD tay chưa có nguồn) | Thành (15/11) |
| D6 | Bảng `21` §14.2: ba dòng `package.*` đổi `#106` thành `#238` | Thành (15/11) |
| D7 | Phần 2 theo cách A: lập kế hoạch thuần (`domain/resplit.ts`) rồi thi hành; kiện cũ đã đóng dùng lại dòng chờ bỏ của #205, **không sửa trigger kiểm bằng** | Khang |
| D8 | Hệ quả của D7: dòng chờ bỏ của kiện cũ không tính vào bất biến, dòng của kiện mới tính. `25` §8.1 đang viết kiện chờ thay "không tính vào bất biến": sửa câu chữ ở `25` | đề xuất |
| D9 | "Kiện chờ thay" là **suy ra**, không lưu cờ: kiện có ít nhất một dòng mà cùng `order_line_id` đang có dòng chờ bỏ ở kiện khác **đang đóng** (`packed`, `awaiting_pickup`). `replaces_package_id` chỉ để truy vết | đề xuất |
| D10 | `lose_on_unload` dùng chung hai route `report-lost`, `confirm-lost`; chỉ nhận kiện đã đóng **đang có cờ `needs_open`**. `claimCode` vẫn bắt buộc (kiện chưa rời kho thì kho ghi ghi chú, vd "Không thấy kiện khi dỡ") | đề xuất |
| D11 | `lose_on_unload` làm chung PR với thất lạc (PR 1), không chờ #330: nó chỉ cần cờ `needs_open` đã có trên `main` | đề xuất |
| D12 | Không chặn "quá 14 ngày" ở BE khi báo thất lạc (`25` §8.5 là mốc nhắc; `21` §19.2 không có mã lỗi cho việc này). FE chỉ gợi ý | đề xuất |
| D13 | Luật "kiện tự giao: người xác nhận khác người đi giao" **chưa làm**: route `self-deliver` chưa có nên chưa có dữ liệu người đi giao. Ghi ở mục 10 | đề xuất |
| D14 | Kiện rời khỏi vùng báo mất được (sang `delivered`, `returned`, `cancelled`, `reserved`) thì xoá báo cáo thất lạc đang treo (`lost_reported_by/at`, `lost_claim_code`). Kiện rời `lost` (sàn kéo lại, hoặc `found`) thì xoá mọi cột `lost_*`: các cột này chỉ có nghĩa khi kiện đang chờ xác nhận hoặc đang `lost`; hồ sơ (ai xác nhận, mã khiếu nại, tự duyệt) nằm ở lịch sử trạng thái. Một luật theo trạng thái đích, đặt trong `updatePackage` (sửa 15/11/2026 khi lập kế hoạch: bản đầu giữ cột khi `found`, phải thêm ngoại lệ theo thao tác) | đề xuất |
| D15 | Kiểm kê đếm thiếu: kiện đã đóng bật `needs_open` với `openPurpose` mới `stocktake` thay cho `needs_attention` + `DISMANTLE_NOTE` | đề xuất |
| D16 | Mốc của nguồn nhắc `package.needs_open` lấy `packages.updated_at` (fulfillment không join được `core.state_transitions`). Sửa `21` §14.2 thành "lần cập nhật gần nhất" | đề xuất |
| D17 | "Bắt buộc phiếu kiểm kê sau bàn giao bắt buộc" không làm nguồn nhắc riêng: kiện bàn giao bắt buộc đã mang `needs_attention` nên nằm trong `package.needs_open` | đề xuất |
| D18 | Kiện **trước bàn giao** (`backordered`, `reserved`, `packed`, `awaiting_pickup`) mà sàn báo `lost`: coi là nhảy cóc, bù bàn giao (trừ tồn một lần) rồi `lost`, như đã làm với `delivery_failed`, `returning` (spec 199c D5). Lý do: sàn báo ĐVVC làm mất nghĩa là kiện đã rời kho; chỉ bật cờ thì tồn còn tính hàng không còn. Đổi hành vi so với `main` cho `backordered`, `reserved`, `packed` (đang chỉ bật cờ); giữ hành vi cho `awaiting_pickup` | đề xuất |
| D19 | `platform_in_transit`, `platform_deliver` giữ `returning` trong tập `from` cho khớp máy FE và ca D2-34, D2-36, dù với kiện sàn nhánh này chưa tới được (xem mục 2). Chỉ test ở mức luật thuần | đề xuất |
| D20 | Kiện cũ đã đóng đang chờ mở để chia lại mà bị xác nhận mất (`lose_on_unload`): bàn giao trừ **mọi** dòng của kiện, kể cả dòng chờ bỏ (hàng nằm trong hộp đã mất); dòng chờ bỏ giữ nguyên để kiểm bằng không vỡ. Kiện thay hết "chờ thay" (D9 chỉ xét kiện đang đóng) và thành kiện `backordered` thường, chờ hàng khác | đề xuất |
| D21 | Cờ `needs_open` của kiện đã đóng bị gỡ mà kiện không đổi trạng thái thì xoá luôn báo cáo thất lạc đang treo, để kiện không kẹt giữa `already_reported` và `not_awaiting_open`. **Kiểm kê tự gỡ (mục 5.5) không áp vào kiện có báo thất lạc chờ xác nhận**: lượt phân hàng bỏ qua kiện đó, cờ và báo cáo còn tới khi người thứ hai xác nhận hoặc kho mở kiện | luật xoá cột: đề xuất; ngoại lệ kiểm kê: Thành chốt (review #366, 17/11) |
| D22 | Lập kế hoạch chia lại theo ba bước (mục 5.6): (1) **khớp theo tập** dòng sống (dòng đơn, số lượng) với mọi kiện chưa huỷ, khớp thì chỉ gắn lại mã (kiện đã bàn giao thì không gắn); (2) nhóm mang mã của một kiện sống mà tập nhóm nằm trọn trong kiện đó thì **kiện đó giữ nhóm** (sàn giữ mã cũ cho phần còn lại); (3) nhóm còn lại có món thuộc kiện app thì lập kiện mới. **Không lập kế hoạch** (giữ nguyên, Cần xử lý, như `main`) khi: một dòng đơn ở hai nhóm, hoặc nhóm mang mã của kiện sống mà có món ngoài kiện đó (sàn gộp món vào mã kiện cũ). Mã đang nằm ở kiện đã huỷ thì gỡ khỏi kiện đó trước. Nhóm không món nào thuộc kiện app, nhóm không mã, nhóm trạng thái `cancelled` hay lạ: đi đường cũ | Khang (18/11) |
| D23 | Kiện mới do chia lại lập ở `backordered` (thử giữ ngay; dòng có chủ cũ là kiện đã đóng thì chờ thay, dòng khác vẫn giữ ngay: Thành chốt ở review #393) rồi vòng áp trạng thái áp trạng thái sàn như kiện đã có (nhảy cóc, bàn giao bù). **Không** đi luật "kiện lần đầu thấy" (`store_only`, mốc kéo đơn): hàng của nó đã nằm trong kho, đã giữ ở kiện cũ. Khác `createPackage` của đơn mới | Khang (18/11) |
| D24 | Mục đích mở: `resplit` **thắng** `edit` và `stocktake` (mở `resplit` mà mọi món đã chuyển đi thì `open_cancel`, không gọi `repack`; còn món thì gói cũ còn trên sàn với phần còn lại nên gọi `repack` như `edit`, trừ kiện giữ vận đơn theo D25; Khang chốt lại 18/11 sau soát, trước ghi "không gọi `repack` vì sàn đã tự chia lại" làm lần đóng gói sau gọi `pack` của sàn trên gói đã đóng; dòng chờ bỏ của `edit` vẫn bỏ khi mở; kiện mang `stocktake` mở xong vẫn xếp lượt phân hàng cho dòng còn lại). `cancel` thắng `resplit`: sàn huỷ cả kiện đang chờ mở để chia lại thì `markWholePendingDrop` nâng `resplit` lên `cancel` | Khang (18/11) |
| D25 | Mở kiện `awaiting_pickup` có cờ Cần mở (mọi mục đích) **không gọi `repack`**, giữ mã kiện sàn, vận đơn, ĐVVC (`25` §8.3 "giữ vận đơn"). Còn món thì kiện về `reserved` với cột mới `waybill_kept = true`; đóng gói lại và báo sẵn sàng lại **không gọi sàn** khi cột này bật (báo sẵn sàng xong thì tắt). Sửa câu cũ của mục 5.6 ("kiện đã có `tracking_code` và mã kiện sàn thì không gọi `readyToShip`"): sai với Lazada vì `pack` đã trả mã vận đơn trước bước báo sẵn sàng | Khang (18/11) |
| D26 | Kho mở kiện cũ đang chờ mở để chia lại: giao dịch ghi lấy khoá advisory phân hàng trước khoá kiện; sau khi nhả dòng chờ bỏ thì **giữ hàng ngay cho kiện của cùng đơn** vừa hết chờ thay (dùng chung bước giữ hàng của lượt phân hàng, chỉ ứng viên của đơn đó), rồi mới xếp lượt cho phần dư (`25` §8.1 bước 3) | Khang (18/11) |
| D27 | Kiện rời nhóm đã đóng khi còn cờ Cần mở (sau D28 chỉ còn đường sàn báo rời kho): gỡ cờ; mục đích `cancel`, `edit`, `resplit` thì bật Cần xử lý "Sàn báo kiện rời kho khi còn chờ dỡ kiện về kệ"; `stocktake` gỡ im như PR 2. Bàn giao trừ mọi dòng của kiện, kể cả dòng chờ bỏ (hàng còn trong hộp, `25` §8.3 "đi theo sàn"); kiện thay hết chờ thay và đi phân hàng như kiện `backordered` thường | Khang (18/11) |
| D28 | Chặn `ready` và quét bàn giao kiện đang có cờ Cần mở, và kiện chờ thay (thêm sau review #393: hàng của nó còn trong kiện cũ, quét trước rồi sàn báo rời kho làm kẹt số đang giữ): 409 `awaiting_open` (`hand-over` trả trong `failed[].code`). Kiểm ở service, không là guard của máy trạng thái (bàn giao không nạp `record`) | Khang (18/11) |
| D29 | `resplit` của kết quả đồng bộ chỉ còn nghĩa "có phần sàn chia lại mà app không tự xử lý" (kiện đã bàn giao, chia lạ ở D22); note đơn đổi thành "Sàn chia lại kiện, app chưa tự xử lý được"; kiện đã bàn giao bị chia khác mang Cần xử lý "Sàn chia lại kiện đã bàn giao". Chia lại xử lý được thì `changed = true`, không bật cờ đơn | Khang (18/11) |

## 4. Phạm vi

**Trong phạm vi:** route `report-lost`, `confirm-lost`; mũi tên `platform_lost`, `platform_in_transit`, `platform_deliver`, `lose_on_unload`; cột và CHECK thất lạc; phát `package_lost`; xử lý sàn chia lại kiện (chưa đóng, đã đóng, chờ thay bị lấy trước, đã bàn giao); mở kiện `awaiting_pickup` giữ vận đơn (D25); chặn báo sẵn sàng và quét bàn giao kiện đang chờ mở (D28); gỡ cờ Cần mở khi sàn báo kiện rời kho (D27); kiểm kê → `needs_open`; ba nguồn nhắc; FE nối API; sửa Documents.

**Ngoài phạm vi:** cờ `cod_unconfirmed` (D5); luật người đi giao của kiện tự giao (D13); route `self-deliver`; gộp kiện; ghi bồi thường khi kiện mất (`21` §11.2: finance không nghe `package_lost`); consumer thông báo cho `package_lost` (module `notification`, issue khác); khung `GET /tasks` (#209).

## 5. Thiết kế

### 5.1 Dữ liệu và migration

**PR 1 (thất lạc), migration `that-lac`:**

- `packages.lost_self_approved boolean not null default false`.
- `packages.lost_source text null`, CHECK `lost_source in ('user', 'marketplace')`.
- Backfill trước khi thêm CHECK: `update "order".packages set lost_source = 'marketplace' where status = 'lost' and lost_confirmed_by is null`. Trên `main` chưa có đường nào để người dùng đưa kiện sang `lost`, nên mọi kiện `lost` hiện có là do sàn.
- Thay CHECK `packages_lost_second_person` bằng: `lost_confirmed_by is null or lost_confirmed_by is distinct from lost_reported_by or lost_self_approved`.
- Thêm CHECK `packages_lost_confirmed`: `status <> 'lost' or lost_source is not distinct from 'marketplace' or lost_confirmed_by is not null`. Phải dùng `is not distinct from`: với `lost_source` null, `lost_source = 'marketplace'` ra NULL, cả biểu thức ra NULL và CHECK cho qua kiện `lost` thiếu nguồn (bắt được khi thi công PR 1, test AC10).
- Giữ CHECK `packages_lost_report`.
- Ba file, sinh ở bước cuối của PR theo thứ tự: `that-lac-cot` (drizzle sinh: hai cột), `that-lac-du-lieu` (`--custom`: câu backfill), `that-lac-rang-buoc` (drizzle sinh: thay và thêm CHECK). Tách vì CHECK mới phải đứng sau backfill, mà backfill phải đứng sau cột.
- An toàn migration: thêm cột `boolean not null default false` và cột `text null` không viết lại bảng (PostgreSQL 11+). `ADD CONSTRAINT … CHECK` quét bảng dưới khoá `ACCESS EXCLUSIVE`; `packages` trên staging là dữ liệu demo, ít dòng (cùng lập luận với migration của #329). Không dùng `NOT VALID` rồi `VALIDATE`: migrator của drizzle chạy mọi migration đang chờ trong **một** giao dịch (`db/CLAUDE.md`), nên tách hai bước không rút ngắn thời gian giữ khoá, mà snapshot của drizzle lại lệch `schema.ts`. Bảng lớn lên thì phải làm lại theo hai lần deploy.
- Lùi: `alter table "order".packages drop constraint packages_lost_confirmed; drop constraint packages_lost_second_person; add constraint packages_lost_second_person check (lost_confirmed_by is null or lost_confirmed_by is distinct from lost_reported_by); drop column lost_source; drop column lost_self_approved;` (kiện tự duyệt, nếu có, phải xoá `lost_confirmed_by` trước khi thêm lại CHECK cũ). Bản app cũ chạy song song: đường sàn báo mất của bản cũ không ghi `lost_source` nên vi phạm CHECK mới → deploy app trước hay migration trước đều có một quãng lệch; chấp nhận vì lượt kéo đơn lỗi sẽ chạy lại ở nhịp sau (ghi trong mô tả PR).

**PR 2 (kiểm kê → Cần mở), migration `mo-kien-kiem-ke`:** `alter type "order".open_purpose add value 'stocktake'`. PostgreSQL không cho **dùng** giá trị enum mới trong chính giao dịch thêm nó, và drizzle chạy mọi migration đang chờ trong một giao dịch: migration này **không được** kèm câu `update` nào dùng `'stocktake'`, kể cả ở file khác cùng PR.

**PR 3 (chia lại kiện), migration `chia-lai-kien`:** một file drizzle sinh, không câu ghi dữ liệu.

- `packages.replaces_package_id uuid null`, khoá ngoại về `"order".packages(id)` (`on delete no action`: kiện không bao giờ bị xoá). Drizzle: `.references((): AnyPgColumn => packages.id)` (tự tham chiếu phải khai kiểu trả về). Index một phần `where replaces_package_id is not null` (khoá ngoại phía con cần index; chỉ kiện thay mới có giá trị).
- `packages.waybill_kept boolean not null default false` (D25) và CHECK `packages_waybill_kept`: `not waybill_kept or (platform_package_code is not null and tracking_code is not null)`.
- Không đổi trigger kiểm bằng (D7). Không thêm giá trị enum (`replaced` là chuỗi trong `core.state_transitions.action`).
- An toàn: hai cột thêm không viết lại bảng (PostgreSQL 11+, mặc định hằng). `ADD CONSTRAINT … FOREIGN KEY` và `CHECK` quét bảng dưới khoá; cột mới toàn null/false nên quét rẻ, `packages` trên staging ít dòng (cùng lập luận mục 5.1 PR 1: migrator chạy một giao dịch, không dùng `CONCURRENTLY`/`NOT VALID`). Lùi: `drop constraint packages_waybill_kept; drop column waybill_kept; drop column replaces_package_id;` (index và khoá ngoại đi theo cột). Bản app cũ chạy song song không ghi hai cột mới: vô hại.

### 5.2 Máy trạng thái (`domain/package.ts`)

| Thao tác | Từ | Đến | Ai | Ghi chú |
|---|---|---|---|---|
| `lose` (sửa) | `in_transit`, `delivery_failed`, `returning`, `self_delivering` | `lost` | `fulfillment.order.process` | `needsSecondPerson`, `allowSelfApproval`, `needsReason`. Bỏ `awaiting_pickup` (D4) |
| `lose_on_unload` (mới) | `packed`, `awaiting_pickup` | `lost` | `fulfillment.order.process` | như `lose`; guard `not_awaiting_open` khi kiện không có cờ `needs_open` |
| `platform_lost` (mới) | `in_transit`, `self_delivering`, `delivery_failed`, `returning` | `lost` | hệ thống | |
| `platform_in_transit` (mới) | `lost`, `returning` | `in_transit` | hệ thống | guard `status_from_platform` khi trạng thái hiện tại không do người chuyển tay |
| `platform_deliver` (mới) | `lost`, `returning` | `delivered` | hệ thống | như trên |
| `replaced` (mới, PR 3) | `packed`, `awaiting_pickup` | `cancelled` | hệ thống | kiện cũ hết dòng vì kiện thay đã được ĐVVC lấy (mục 5.6); đứng sau `open_cancel` để `arrowAction` không đổi |

- `PackageRecord` thêm `needsOpen: boolean` và `statusSource: 'user' | 'marketplace' | 'system'` (nguồn của lần chuyển gần nhất vào trạng thái hiện tại; bên gọi nạp từ lịch sử trạng thái qua hàm của `core`, chỉ nạp khi cần xét hai mũi tên `platform_in_transit`, `platform_deliver`).
- `arrowAction(from, to)` hiện trả mũi tên đầu tiên khớp, nên `in_transit → lost` ra `lose`. Thêm tham số để đường sàn ưu tiên mũi tên `system`; đường sàn không bao giờ ghi `action = 'lose'` nữa.
- `platformUpdate`: `lost`/`returning` → `in_transit`/`delivered` là `direct` khi guard qua, `invalid` khi không (giữ hành vi hiện tại: Cần xử lý). Kiện trước bàn giao (`PRE_HANDOVER`) → `lost` là `jump` (D18), cùng dòng luật với `delivery_failed`, `returning`.
- `domain/handover.ts` `pickupUnconfirmed`: trả `false` cho kiện `lost` (kiện `lose_on_unload` mang `handover_source = 'scan'`, không có sàn nào xác nhận lấy).

### 5.3 Thất lạc do người dùng (`service/lost.ts`, mới)

Hợp đồng theo `21` §19.2, không đổi: `POST /packages/:id/report-lost { version, claimCode }` (1 đến 100 ký tự sau khi cắt khoảng trắng), `POST /packages/:id/confirm-lost { version }`; quyền `fulfillment.order.process`; trả `Package`.

**`report-lost`**, một giao dịch, khoá kiện:

1. Kiện không có (kể cả công ty khác, id sai dạng) → 404.
2. Kiện không ở trạng thái báo mất được → 409 `invalid_transition` (kèm `current`). Báo mất được: tập `from` của `lose`; hoặc tập `from` của `lose_on_unload` **và** `needs_open` (D10; kiện đã đóng không có cờ → 409 `not_awaiting_open`).
3. `lost_reported_by` đã có → 409 `already_reported`.
4. `version` lệch → 409 `version_conflict` kèm `current`.
5. Ghi `lost_reported_by`, `lost_reported_at` (giờ DB), `lost_claim_code`. Trạng thái giữ nguyên, không ghi `state_transitions`; ghi một dòng nhật ký thao tác (`entityType = 'order.packages'`, nhãn là mã kiện).

**`confirm-lost`**, một giao dịch, khoá kiện:

1. 404 như trên.
2. Chưa báo → 409 `not_reported`.
3. Chọn thao tác theo trạng thái: `lose` hoặc `lose_on_unload`. `assertTransition` với `record.createdBy = lost_reported_by`, `reason = 'Mã khiếu nại ' + lost_claim_code`, `canSelfApprove` của `staff` (cách truyền như các module đã dùng `allowSelfApproval`). Lỗi: `invalid_transition` 409, `forbidden` 403, `second_person_required` 409, `not_awaiting_open` 409.
4. `version` lệch → 409 `version_conflict`.
5. Riêng `lose_on_unload`: ghi **bàn giao kiện** trước, qua `settleHandover` (một chỗ thi hành trừ tồn, `service/handover-stock.ts`) với `actorId` là người xác nhận; `mode` chọn như bàn giao tay ở `service/handover.ts` (gian hàng chờ kiểm kê thì `defer`). Ghi `handed_over_at` = giờ DB, `handover_source = 'scan'`, `pickup_confirmed_at` để null. Không phát `fulfillment.package_shipped` hai lần: `settleHandover` đã phát.
6. Ghi `status = 'lost'`, `lost_confirmed_by`, `lost_source = 'user'`, `lost_self_approved`; `needs_open = false`, `open_purpose = null` (CHECK `packages_open`); dòng chờ bỏ (#330) giữ nguyên, không xoá dòng (kiện đã mất nguyên hộp). Bàn giao ở bước 5 trừ mọi dòng đã ghép SKU của kiện, kể cả dòng chờ bỏ (D20).
7. `recordTransition` (`selfApproved` lấy từ `assertTransition`, `audit = { entityType: 'order.packages', label: mã kiện }`), phát `fulfillment.package_status_changed` và `fulfillment.package_lost { packageId, orderId, claimCode }`.

Thứ tự kiểm (404 → trạng thái → `version`) theo `receiveBackPackage` hiện có. Không cần khoá idempotency: khoá dòng, trạng thái và `version` chặn lần hai.

**View (`service/views.ts`):** `lostReport = { by, at, claimCode }` khi kiện có `lost_reported_by` (dạng `by` theo `FE/src/types/fulfillment.ts`). Schema `Package` trên `main` chưa có `availableActions`, nên PR 1 không thêm. Còn thiếu sau PR 1: chi tiết đơn của sales (`sales/service/orders.ts`) dựng kiện mà không truyền bảng tên, nên `lostReport.by.name` ở đó rỗng.

**Xoá cột thất lạc (D14, D21):** một luật trong `updatePackage` (`repository/packages.ts`), theo trạng thái đích của lần ghi, không rải điều kiện ở từng service:

- Ghi `status` khác `lost` → `lost_confirmed_by`, `lost_source` về null, `lost_self_approved` về false.
- Ghi `status` không còn báo mất được (ngoài tập `from` của `lose`, `lose_on_unload`) và khác `lost` → ba cột báo cáo về null.
- Ghi `needs_open = false` mà không ghi `status` → ba cột báo cáo về null (D21).

**Quan sát:** `logger.info` khi xác nhận mất (`packageId`, thao tác, `selfApproved`); `logger.warn` khi sàn kéo lại kiện do người chuyển tay và khi sàn báo mất kiện chưa bàn giao (D18). Không thêm metric: route đi qua số liệu HTTP chung, đường sàn đi qua số liệu lượt kéo đơn.

### 5.4 Thất lạc và kéo ngược do sàn (`service/platform-packages.ts`)

- **`platform_lost`:** `applyStatus` gặp sàn báo `lost` cho kiện đang ở tập `from` → `changeStatus` với `action = 'platform_lost'`, ghi thêm `lost_source = 'marketplace'`, phát `fulfillment.package_lost` (`claimCode` = `lost_claim_code` nếu kho đã báo trước, không thì `null`). Báo cáo của kho (nếu có) giữ nguyên. Kiện lần đầu thấy đã `lost` (`createPackage`): cũng ghi `lost_source = 'marketplace'`; **không** phát `package_lost` cho kiện rời kho trước mốc bắt đầu lấy đơn (`store_only`), các trường hợp khác có phát.
- **Kiện trước bàn giao mà sàn báo `lost`** (D18): nhảy cóc. `changeStatus` bù bàn giao qua `settleHandover` (giữ được thì trừ thường, không thì bàn giao bắt buộc như mọi kiện nhảy cóc), ghi `lost_source = 'marketplace'`, `action = 'platform_sync'`, phát `package_lost`. Kiện đang chờ mở thì gỡ `needs_open`.
- **`platform_in_transit`, `platform_deliver`:** kiện đang `lost` hoặc `returning`, sàn báo `in_transit` hoặc `delivered`:
  - Trạng thái hiện tại do người chuyển tay (`statusSource = 'user'`): áp theo sàn; bật `needs_attention`, `flag_note = 'Sàn báo <trạng thái> sau khi người dùng chuyển <trạng thái cũ>'`; các cột `lost_*` tự xoá theo luật D14. Sang `delivered` thì `reportDelivered` như mọi kiện giao xong. Tồn không đổi (đã trừ lúc bàn giao).
  - Trạng thái hiện tại do sàn hoặc hệ thống: giữ nguyên, Cần xử lý (như hiện tại).
  - Kết quả đồng bộ thêm `revived: boolean`; `sales/service/ingest.ts` bật Cần xử lý trên đơn với ghi chú "Sàn báo lại kiện đã thất lạc hoặc đang hoàn". Đơn đã `completed` giữ nguyên trạng thái (`25` §8.3).
- `MAIN_PATH` và luật nhảy cóc không đổi.

### 5.5 Mở kiện do kiểm kê (`service/allocation.ts`)

Hiện có hai loại kiện đã đóng bị gắn `DISMANTLE_NOTE`, cả hai đổi sang `needs_open = true`, `open_purpose = 'stocktake'` (kiện đang chờ mở vì lý do khác thì giữ mục đích cũ):

- **Kiện đang giữ hàng** mà phiếu kiểm kê đếm thấp hơn đang giữ (`lockSealedHolders`). Trên `main` cờ của loại này không có chỗ nào gỡ.
  - Kho mở kiện (`openPackage`): về `reserved`, gỡ cờ, rồi `requestAllocation` cho các SKU của kiện; lượt phân hàng lấy lại phần giữ nếu tồn thực vẫn nhỏ hơn đang giữ (`reclaim`, kiện về `backordered`).
  - Tự gỡ: lượt phân hàng nào chạy qua SKU của kiện mà thấy tồn thực đã không còn nhỏ hơn đang giữ cho mọi SKU của kiện thì gỡ cờ (đặt ở chỗ `runAllocation` đã có số tồn).
- **Kiện chưa giữ hàng** sau phiếu đầu kỳ (ứng viên giữ hàng). Chỗ gỡ cờ khi giữ lại được (`allocation.ts`, đang so `flagNote === DISMANTLE_NOTE`) đổi thành gỡ `needs_open` khi `open_purpose = 'stocktake'`. `candidateWhere` (`repository/allocation.ts`) đang loại mọi kiện `needs_open`: kiện mang `open_purpose = 'stocktake'` **vẫn là ứng viên**, nếu không cờ không bao giờ gỡ. Kho mở kiện loại này: như hiện tại (giữ lại phần thiếu, thiếu hàng thì 422 `insufficient_stock`).
- Kiện có báo thất lạc chờ người thứ hai xác nhận thì **không** tự gỡ cờ (cả hai đường trên: không xét ở bước tự gỡ, không là ứng viên giữ hàng). Lý do (Thành, review #366): gỡ cờ thì luật D21 xoá người báo và mã khiếu nại, tức hệ thống tự bỏ qua bước duyệt, khiếu nại với sàn mất dấu và kiện có thể đã mất thật quay lại luồng giao. Cờ và báo cáo còn tới khi người thứ hai `confirm-lost` (kiện ra `lost`) hoặc kho mở kiện.
- **Quãng giữa PR 2 và PR 3:** `openPackage` trên `main` chưa nhận kiện `awaiting_pickup` (PR 3 mới mở). Trong quãng đó kiện `awaiting_pickup` bị kiểm kê gắn cờ nằm trong tab Cần mở mà chưa mở được; chấp nhận, vì hiện tại nó cũng chỉ mang cờ không có thao tác.
- Dữ liệu cũ: **không chuyển bằng migration** (xem mục 5.1: giá trị enum mới chưa dùng được trong giao dịch migration). Kiện đang mang `needs_attention` với `DISMANTLE_NOTE` giữ nguyên cờ cũ; chỗ gỡ cờ trong `allocation.ts` nhận cả hai dạng (ghi chú cũ và `open_purpose = 'stocktake'`) cho tới khi không còn kiện nào mang ghi chú cũ. Lượt kiểm kê sau gắn cờ theo dạng mới.
- FE: thêm nhãn `stocktake: 'Kiểm kê thiếu hàng'` vào `OPEN_PURPOSE_LABELS`; `21` §19.2 thêm giá trị.

### 5.6 Sàn chia lại kiện (PR 3, viết lại 18/11/2026 trên `main` eb49bba)

Bản đầu (15/11) viết trên nhánh của #330; đối chiếu lại với `main` (mục 2, đoạn "`main` eb49bba") thì phải thêm: khớp theo tập trước khi tìm theo mã (ca TikTok của #221), giữ mã cũ cho phần còn lại, mã nằm ở kiện đã huỷ, kiện mới không đi luật "lần đầu thấy", thứ tự mục đích mở, giữ vận đơn khi mở kiện `awaiting_pickup` (câu cũ về `readyToShip` sai với Lazada), kiện rời kho khi còn chờ mở. Quyết định ở D22 đến D29.

**Từ ngữ.** *Kiện sống*: kiện khác `cancelled`. *Dòng sống*: dòng kiện có `pending_drop_qty = 0`. *Chủ* của một dòng đơn: kiện sống có dòng sống của dòng đơn đó (đơn sàn mỗi món một dòng đơn số lượng 1, trigger kiểm bằng giữ tối đa một chủ). *Nhóm xét chia lại*: nhóm có mã kiện sàn, `groupStatus` biết và khác `cancelled`, có ít nhất một món có chủ. Nhóm không mã (theo kiện app, spec 205 D10), nhóm `cancelled`, nhóm trạng thái lạ (`unknown`) và nhóm không món nào có chủ (đơn mới, món mới) đi đường cũ của `syncPlatformPackages`.

**Luật thuần `domain/resplit.ts` (mới).** `planResplit(packages, groups)` nhận mọi kiện của đơn (kể cả đã huỷ, cần cho mã) và các nhóm xét chia lại; trả `{ targets, steps, resplit }`: `targets` là khoá nhóm → id kiện đã có nhận nhóm đó; `steps` theo thứ tự thi hành; `resplit` là có phần app không tự xử lý (D29).

0. Một dòng đơn ở hai nhóm xét chia lại → không lập cho đơn: `targets`, `steps` rỗng, `resplit = true` (service log `warn`).
1. **Khớp theo tập** (`25` §8.1 "Khớp kiện"): nhóm có tập (dòng đơn, số lượng) bằng tập dòng sống của một kiện sống → `targets`. Kiện chưa bàn giao mà mã khác mã nhóm (kể cả null) → bước `relabel`. Kiện đã bàn giao khớp tập thì nhận nhóm, không gắn lại mã.
2. Nhóm chưa khớp, xét theo mã nhóm tăng dần:
   1. Có món mà chủ đã bàn giao (`HANDED_OVER`) → bước `flag` cho chủ đó (một lần mỗi kiện), nhóm bỏ qua, `resplit = true` (`25` §8.1 "Kiện đã bàn giao không chia lại được").
   2. Có kiện sống mang mã nhóm (*holder*) chưa khớp ở bước 1: tập nhóm nằm trọn trong dòng sống của holder → `targets` (sàn giữ mã cũ cho phần còn lại; các dòng khác của holder đi theo nhóm của chúng ở bước 3). Không nằm trọn (sàn gộp món vào mã của kiện cũ) → không lập cho đơn, như bước 0. Holder đã khớp nhóm khác ở bước 1 thì sẽ đổi mã: coi như không có holder.
   3. Kiện đã huỷ mang mã nhóm → bước `clear_code` cho kiện đó (unique không lọc trạng thái).
   4. Còn lại → bước `create`: `replaces` là kiện chứa nhiều món của nhóm nhất (hoà thì mã kiện app nhỏ hơn), `awaitingOrderLineIds` là các dòng đơn mà chủ là kiện đã đóng (có thì kiện mới là *kiện chờ thay*, D9).
3. Mỗi kiện sống chưa bàn giao có dòng sống thuộc nhóm `create` (dòng *chuyển đi*):
   - chưa đóng (`backordered`, `reserved`): mọi dòng sống chuyển đi → `cancel_open`; còn dòng → `move_out`;
   - đã đóng (`packed`, `awaiting_pickup`) → `mark_drop`.
4. Thứ tự: `clear_code`, `relabel`, `flag`, `cancel_open`, `move_out`, `mark_drop`, `create`.

Chạy lại trên dữ liệu sau khi áp: mọi nhóm khớp ở bước 1, `steps` rỗng (gọi lặp không đổi gì).

`replacementPairs(packages, packageId)`: mỗi dòng sống của kiện ghép với dòng chờ bỏ cùng `order_line_id` ở một kiện khác **đang đóng**. Kiện có cặp là kiện chờ thay (D9, suy ra, không lưu cờ).

**Khoá (`service/platform-packages.ts`).** Đọc kiện của đơn không khoá, dựng nhóm và kế hoạch bằng cùng các hàm thuần (`groupsOf` trong `platform-packages.ts`, `planResplit`); kế hoạch có bước thì `takeAllocationLock` **trước** `lockOrderPackages` (thứ tự khoá mục 2: đơn → advisory → kiện). Sau khi khoá và xử lý huỷ dòng, lập lại kế hoạch trên dữ liệu đã khoá. Có bước mà lượt chưa lấy advisory (dữ liệu đổi giữa hai lần đọc): không thi hành, nhóm xét chia lại chưa khớp bỏ qua, không bật cờ, log `warn`; lượt kéo sau làm. Không có bước thì không lấy advisory (lượt kéo thường không đụng khoá phân hàng).

**Thi hành (`service/resplit.ts`, mới).** Trong giao dịch kéo đơn, kiện đã khoá:

- `clear_code`, `relabel`: hai pha, ghi `platform_package_code = null` cho mọi kiện của hai loại bước rồi mới ghi mã mới (hai kiện đổi mã cho nhau không vấp unique). Kiện đổi hay mất mã thì tắt `waybill_kept` cùng câu (vận đơn giữ lại theo D25 không còn là vận đơn của gói trên sàn; CHECK `packages_waybill_kept` cần mã).
- `flag`: `needs_attention`, note "Sàn chia lại kiện đã bàn giao"; kiện đã có cờ thì không ghi (không tăng `version`).
- `cancel_open`: nhả phần đang giữ thật (`reserved_qty`), `setReserved(false)`, `cancelled`; lịch sử `cancel`, lý do "Sàn chia lại kiện", nguồn `marketplace`; `package_status_changed`.
- `move_out`: nhả phần giữ của dòng chuyển đi, xoá dòng, `version` tăng; lịch sử `drop_lines` (`from = to`), lý do "Sàn chia lại kiện: chuyển <n> món"; kiện `backordered` còn dòng thì xếp lượt phân hàng cho SKU còn lại.
- `mark_drop`: `pending_drop_qty = quantity` trên dòng chuyển đi (vẫn giữ hàng); cờ theo D24: chưa chờ mở → `needs_open`, `resplit`; đang `edit`, `stocktake` → `resplit`; `cancel`, `resplit` giữ. Không ghi lịch sử (như `markPendingDrop` của #205), log `info`.
- `create`: `createPackage` nhận thêm `resplit: { replacesPackageId, replacesCode, awaiting }` (`awaiting` = `awaitingOrderLineIds`): kiện vào `backordered` (D23) bất kể trạng thái sàn; dòng ngoài `awaiting` (từ kiện chưa đóng vừa nhả, món mới) giữ ngay khi mọi dòng đã ghép và gian hàng không chờ kiểm kê đầu kỳ, dòng trong `awaiting` chờ thay (nhận phần giữ khi kho mở kiện cũ hoặc khi ĐVVC lấy kiện thay); kiện sang `reserved` chỉ khi không còn dòng chờ thay (kiện toàn dòng "không quản tồn" coi như giữ được). Nhóm lẫn nguồn (món của kiện đã đóng và kiện chưa đóng): trước review #393 cả kiện không giữ lúc lập, đơn khác có thể giành phần vừa nhả; Thành chốt giữ ngay phần từ kiện chưa đóng. Ứng viên phân hàng chỉ giữ dòng chưa giữ (không giữ trùng); sàn huỷ kiện chưa đóng nhả đúng `reserved_qty`; ghi `replaces_package_id`; lịch sử `create` lý do "Sàn chia lại kiện <mã cũ>". Vì lượt đang giữ advisory, kiện mới của đơn lấy phần vừa nhả trước mọi kiện `backordered` khác (`25` §8.1 bước 3).
- Sau cùng: `requestAllocation` cho SKU đã nhả (phần dư cho kiện khác, chạy sau commit).
- Kiểm bằng: mỗi bước giữ tổng theo dòng đơn lúc commit (dòng chuyển đi bị xoá, chờ bỏ, hoặc thuộc kiện vừa huỷ; dòng mới đủ số lượng).
- Vòng áp trạng thái: nhóm xét chia lại dùng `targets` hoặc kiện vừa lập; trạng thái sàn áp bằng `applyStatus` như kiện đã có. Kết quả đồng bộ: `changed = true` khi có bước; `resplit` theo D29.

**Kiện chờ thay được ĐVVC lấy trước khi kho dỡ** (`25` §8.1). Vòng áp trạng thái, trước `applyStatus` của kiện có `replacementPairs` mà trạng thái sàn rời kho:

1. Mỗi cặp: dòng mới nhận `reserved_qty` của dòng cũ, xoá dòng cũ. Không gọi cổng tồn (tổng đang giữ theo SKU không đổi). Dòng mới đã trừ tồn hay đã tự giữ (kiện thay bị quét bàn giao trước khi có chặn ở D28): nhả phần giữ của dòng cũ qua cổng tồn rồi xoá, xếp lượt phân hàng cho SKU đó (review #393).
2. Kiện cũ hết dòng → mũi tên `replaced` (`cancelled`), gỡ cờ Cần mở; lịch sử nguồn `marketplace`, lý do "Kiện thay <mã> đã được lấy"; `package_status_changed`. Còn dòng mà hết dòng chờ bỏ và mục đích `resplit` → gỡ cờ.
3. `applyStatus` kiện mới như thường (nhảy cóc, `settleHandover`): dòng đã giữ thì trừ thường; dòng chưa giữ (chuyển từ kiện chưa đóng) thì thử giữ, không được mới bắt buộc. Kiện cũ không bao giờ tự ghi bàn giao phần đã có kiện thay.

**Phân hàng (`repository/allocation.ts`, `service/allocation.ts`).** `candidateWhere` thêm `not exists` dòng chờ bỏ cùng `order_line_id` ở kiện khác đang `packed`/`awaiting_pickup` (D9; tra theo index `package_lines(order_line_id)`). Kiện cũ mở xong, bị xác nhận mất (D20), hay bị sàn báo rời kho (D27) thì kiện thay tự thành ứng viên. Bước giữ hàng của `runAllocation` tách thành `holdCandidates` dùng chung cho D26; `lockAllocationCandidates` nhận thêm lọc theo đơn.

**Mở kiện (`service/packing.ts`).**

- `open`, `open_cancel` nhận kiện `awaiting_pickup` **khi có cờ Cần mở**; không có cờ vẫn 409 `invalid_transition`.
- Không gọi `repack` khi kiện đang `awaiting_pickup` hoặc đang `waybill_kept` (D25). Mục đích `resplit` còn món thì gọi `repack` như `edit` (D24, sửa sau soát 18/11).
- Mục đích `resplit`: giao dịch ghi lấy advisory trước khi khoá kiện; sau khi nhả dòng chờ bỏ thì giữ ngay cho kiện của cùng đơn vừa hết chờ thay (D26), rồi xếp lượt cho phần dư; `open_cancel` không gọi `settleCancelledOrder` (đơn không huỷ).
- Kết quả theo `25` §8.3: mọi dòng chờ bỏ → `open_cancel`; còn dòng → `open` (về `reserved`, xoá dòng chờ bỏ). Mục đích `resplit`, `stocktake`: xếp lượt cho SKU của dòng còn lại (D24).
- Kiện `awaiting_pickup` hoặc `waybill_kept` còn món: giữ `platform_package_code`, `tracking_code`, `carrier_*`, đặt `waybill_kept = true` (D25).
- `pack` khi `waybill_kept`: không gọi `pack` của sàn, không ghi đè mã, vận đơn, ĐVVC. `ready` khi `waybill_kept`: không gọi `readyToShip`, chỉ `packed → awaiting_pickup`. `updatePackage` tự tắt `waybill_kept` khi kiện sang trạng thái ngoài `backordered`, `reserved`, `packed`.

**Xác nhận mất kiện cũ** (`lose_on_unload`, D20): sau khi ghi `lost`, xếp lượt phân hàng cho SKU của các dòng chờ bỏ (kiện thay hết chờ thay, AC 11c).

**Rời kho khi còn cờ (D27), chặn báo sẵn sàng và quét bàn giao (D28).** `updatePackage` thay `stocktakeFlagRules` bằng `openFlagRules`: ghi `status` ngoài nhóm đã đóng mà không ghi cờ thì gỡ `needs_open`/`open_purpose` (giá trị cũ là bất kỳ), mục đích cũ khác `stocktake` thì bật `needs_attention` và note (đã có cờ thì giữ note cũ). `markReady` và `handOverPackages` kiểm `needs_open` → 409 `awaiting_open`.

**View.** `Package.replaces: { id, code, status } | null`, gắn trong `attachViewLines` (một câu cho mọi kiện có `replaces_package_id`; mọi đường dựng `PackageViewRow` đi qua hàm này). FE hiện "Chờ mở kiện <mã>" khi `replaces.status` là `packed`/`awaiting_pickup`. Kiện chờ thay ở tab `backordered`.

**Sales (`service/ingest.ts`).** D29: note "Sàn chia lại kiện, app chưa tự xử lý được".

### 5.7 Nguồn nhắc (PR 4, sau #209)

Khai trong trường `tasks` của `ModuleDefinition` fulfillment theo khuôn #209 (`{ kind, permission, collect(now) }`, mỗi nguồn một câu SQL, ngưỡng là hằng trong module). Tên kiểu, cách trả `title`/`detail` và giới hạn số dòng theo đúng code #209 khi nó lên `main`. Cả ba: `group = 'Giao vận'`, quyền `fulfillment.order.process`, `ref.type = 'package'`.

| `kind` | Có việc khi | Mốc | Thời hạn |
|---|---|---|---|
| `package.ship_by` | Kiện `backordered`, `reserved`, `packed`, `awaiting_pickup`; `ship_by` không null; đơn chưa huỷ | `created_at` của kiện | tới `ship_by` |
| `package.lost_reported` | `lost_reported_by` không null, kiện chưa `lost` | `lost_reported_at` | 24 giờ |
| `package.needs_open` | `needs_open` hoặc `needs_attention`; kiện chưa dừng (`STOPPED`) trừ khi còn `needs_attention` | `updated_at` (D16) | 24 giờ |

### 5.8 Lỗi

| Mã | HTTP | Khi |
|---|---|---|
| `already_reported` | 409 | `report-lost` cho kiện đã có báo cáo |
| `not_reported` | 409 | `confirm-lost` cho kiện chưa báo |
| `second_person_required` | 409 | người xác nhận là người báo, không thuộc ngoại lệ tự duyệt |
| `not_awaiting_open` | 409 | báo hoặc xác nhận mất cho kiện đã đóng không có cờ `needs_open` |
| `invalid_transition` | 409 | trạng thái không có mũi tên; kèm `current` |
| `version_conflict` | 409 | `version` lệch; kèm `current` |
| `forbidden` | 403 | thiếu `fulfillment.order.process` |
| `validation_failed` | 422 | `claimCode` rỗng hoặc quá 100 ký tự |
| `awaiting_open` | 409 | (PR 3, D28) `ready` cho kiện đang có cờ Cần mở; `hand-over` trả trong `failed[].code` |

Mọi lỗi ném `AppError`, trả Problem Details. `not_awaiting_open` (PR 1) và `awaiting_open` (PR 3) là mã mới: thêm vào `21` §19.2. Route `open` không thêm mã: kiện `awaiting_pickup` không có cờ Cần mở vẫn `invalid_transition`.

### 5.9 Chạy đồng thời và gọi lặp

- Hai người cùng `confirm-lost`: khoá dòng kiện; người sau gặp `invalid_transition` (kiện đã `lost`).
- `report-lost` lặp: `already_reported`.
- Sàn báo `lost` giữa lúc kho đã báo, chưa xác nhận: `platform_lost` áp, `confirm-lost` sau đó trả `invalid_transition`; việc `package.lost_reported` tự hết vì kiện đã `lost`.
- Sàn báo đã lấy giữa lúc chờ xác nhận `lose_on_unload`: kiện sang `in_transit` theo sàn (`25` §8.3 "đi theo sàn"), báo cáo vẫn treo; người xác nhận sau đó đi mũi tên `lose` thường. Chấp nhận.
- Lượt kéo đơn lặp sau khi đã chia lại: tập món khớp → không bước nào, không đổi gì, không tăng `version` (idempotent). Test bắt buộc. Lượt lặp của ca không tự xử lý được (D22 bước 0, 2.2; kiện đã bàn giao): không ghi lại cờ đã có.
- Chia lại và phân hàng: khoá advisory tuần tự hoá; thứ tự khoá đơn → advisory → kiện → dòng tồn (cùng `remapPackageLines` của #237). Lượt kéo không có bước chia lại thì không lấy advisory.
- Dữ liệu đổi giữa lần đọc không khoá và lần khoá (kế hoạch mới có bước mà chưa lấy advisory): không thi hành, lượt sau làm. Không lấy advisory sau khi đã khoá kiện (ngược thứ tự, khoá chết với lượt phân hàng).
- Chia lại và `openPackage` cùng lúc: cả hai khoá kiện; `version` của kiện tăng ở bước `mark_drop` nên lần mở đang dở gặp `version_conflict`. Mở kiện `resplit` lấy advisory trước khoá kiện nên không đan xen với lượt kéo đang chia lại cùng đơn.
- Kiện chờ thay được lấy và kho mở kiện cũ cùng lúc: lượt kéo khoá mọi kiện của đơn trước; mở kiện gặp `version_conflict` (dòng chờ bỏ đã chuyển) hoặc chờ tới khi lượt kéo commit rồi thấy kiện cũ đã `cancelled` (`invalid_transition`).
- Kho quét bàn giao kiện đang chờ mở: 409 `awaiting_open` (D28); sàn báo rời kho thì theo D27.

### 5.10 Test

Theo `test/CLAUDE.md` (đọc trước khi viết). Tên test mang mã ca D2 khi có.

- **Unit** `test/unit/modules/order/fulfillment/domain/`: `package.test.ts` (mũi tên mới, guard, `arrowAction` ưu tiên hệ thống, `platformUpdate`), `resplit.test.ts` (khớp và gắn lại mã; hai kiện đổi mã cho nhau; chia một kiện thành hai; sàn giữ mã cũ cho phần còn lại; gộp hai kiện vào mã mới; gộp vào mã kiện cũ và một món hai nhóm thì không lập; mã nằm ở kiện đã huỷ; kiện cũ chưa đóng, đã đóng, đã bàn giao, lẫn lộn; món chưa có mã sàn; gọi lại ra kế hoạch rỗng; `replacementPairs`).
- **PR 3, sửa test hiện có:** bỏ `it.skip` ca "sàn tách kiện theo SKU" ở `test/integration/channel/channel/tiktok-order-pull.test.ts` (đọc kiện chưa huỷ; kiện cũ `PK-1` thành `cancelled`); `split-sync.test.ts` ca "món của hai kiện app về chung một mã sàn" và `ingest.test.ts` ca "cùng lượt sàn chia lại kiện" đổi theo D22, D29 (gộp vào mã mới thì app tự xử lý; ca giữ cờ dùng gộp vào mã kiện cũ).
- **API** `test/api/`: quyền, validate, mã lỗi của hai route.
- **Integration** `test/integration/order/fulfillment/`:
  - `lost.test.ts`: báo, xác nhận bởi người khác, tự xác nhận (409 và ngoại lệ tự duyệt ghi `lost_self_approved`), `lose_on_unload` trừ tồn đúng một lần, sự kiện `package_lost`, CHECK DB chặn ghi tay `status = 'lost'` thiếu nguồn.
  - `platform-lost.test.ts`: sàn báo mất; sàn kéo lại kiện do người chuyển tay và do sàn chuyển; đơn `completed`.
  - `resplit-sync.test.ts`: từng ca ở mục 5.6, kể cả chờ thay bị lấy trước, mở kiện cũ rồi kiện mới giữ được hàng trước kiện `backordered` khác, kiểm bằng không vỡ lúc commit.
  - `stocktake-open.test.ts`: kiểm kê thiếu → `needs_open`/`stocktake`; giữ lại được thì gỡ cờ.
  - `tasks.test.ts` (PR 4): ba nguồn, mức `severity` ở ranh giới.
- Sửa test hiện có đang dựa vào `lose` từ `awaiting_pickup`, vào `action = 'lose'` của đường sàn, vào `DISMANTLE_NOTE`, vào `resplit` bật cờ đơn.

## 6. Thứ tự giao

| PR | Nội dung | Phụ thuộc |
|---|---|---|
| Docs | Sửa `21`, `25`, `19`, ca D2, `27` theo mục 8 | Đã merge cho PR 1 (Documents#121), PR 2 (Documents#130); PR 3 có PR Documents riêng |
| PR 1 | Thất lạc: mục 5.1 (PR 1), 5.2 (trừ `replaced`), 5.3, 5.4 | **Đã merge** (#331, 15/11) |
| PR 2 | Kiểm kê → Cần mở: mục 5.5 | **Đã merge** (#366, 17/11) |
| PR 3 | Sàn chia lại kiện: mục 5.1 (PR 3), 5.6, mũi tên `replaced`, D22 đến D29. Kế hoạch `docs/superpowers/plans/2026-11-18-238-pr3-chia-lai-kien.md` | D22 đến D29 đã duyệt; nên trước #237 PR 2 (cùng sửa `openPackage`) |
| PR 4 | Nguồn nhắc: mục 5.7 | #209 (Bình) đã merge; nội dung đầy đủ khi PR 1 đến 3 đã merge |
| FE | Mục 7, theo dõi ở FE#284 (Khoa) | PR 1 (thất lạc), PR 3 (chờ thay) |

Mỗi PR cập nhật `src/modules/order/fulfillment/CLAUDE.md` và chạy `graphify update .`. Body issue #238 đã sửa theo spec (15/11, 18/11).

## 7. Ảnh hưởng tới FE

FE đã có mock cho `report-lost`, `confirm-lost`, nút Báo/Xác nhận thất lạc ở `PackageDetailPage.tsx`, và hai nguồn nhắc mock. Việc còn lại:

- `src/lib/machines/order.ts`: bỏ `awaiting_pickup` khỏi `lose`; `lose_on_unload` thêm `awaiting_pickup` và guard `needs_open`; thêm `platform_lost`. Sinh lại `ca-theo-so-do.md` (mã ca có thể đổi số: cập nhật tham chiếu ở `27`).
- Tắt mock, nối API thật cho hai route; xử lý mã lỗi mục 5.8.
- `OpenPurpose` thêm `stocktake`; `Package` thêm `replaces: { id, code, status } | null`; hiện "Chờ mở kiện <mã>" cho kiện chờ thay (khi `replaces.status` là `packed`/`awaiting_pickup`).
- Mở kiện `awaiting_pickup` có cờ Cần mở: bật nút. Máy `order.ts` thêm mũi tên `replaced` (hệ thống, `SEALED → cancelled`).
- Nút Báo sẵn sàng, Quét bàn giao: tắt khi kiện có cờ Cần mở; xử lý 409 `awaiting_open` (D28).
- E2E Playwright cho luồng báo và xác nhận thất lạc (`e2e/mock/pN/`, thêm `e2e/be/pN/` khi nối API thật).

## 8. Ảnh hưởng tới Documents

- `21` §19.2: đổi tên `lose_unfound` → `lose_on_unload`, tách `platform_revive` thành `platform_in_transit`, `platform_deliver`; `lose` ghi rõ không từ `awaiting_pickup`; thêm mã `not_awaiting_open`; `openPurpose` thêm `stocktake`; `Package` thêm `replaces`; bỏ `cod_unconfirmed` khỏi phạm vi #238 (ghi "chưa có nguồn").
- `21` §14.2: ba dòng `package.*` đổi `#106` → `#238`; mốc của `package.needs_open` thành "lần cập nhật gần nhất".
- `25` §8.1: câu về kiện chờ thay và bất biến (D8); khớp kiện giữ mã cũ cho phần còn lại, sàn gộp món vào mã kiện cũ thì Cần xử lý (D22); thứ tự mục đích mở (D24).
- `25` §8.3: kiện rời kho khi còn chờ dỡ kiện về kệ (D27); không báo sẵn sàng, không quét bàn giao kiện đang chờ dỡ (D28).
- `21` §19.2 (PR 3): `open` nhận `awaiting_pickup` có cờ Cần mở, không gọi `repack` khi giữ vận đơn; `pack`, `ready` không gọi sàn khi dùng lại vận đơn; mã `awaiting_open`; `Package.replaces`; máy D2 thêm `replaced`.
- `19` mục 2: `lost_source` đã có trong tài liệu, không đổi; ghi `open_purpose` thêm `stocktake`; (PR 3) `packages.replaces_package_id`, `packages.waybill_kept`.
- `kiem-thu/ca-theo-so-do.md`: sinh lại từ máy FE; thêm ca cho `platform_lost`, `lose_on_unload` từ `awaiting_pickup`, `replaced`.
- `27`: US-DH-12, US-DH-15 cập nhật mã ca.

## 9. Acceptance criteria

**Thất lạc (PR 1)**

1. Kho A báo thất lạc kiện `in_transit` kèm mã khiếu nại: kiện giữ `in_transit`, có cờ `lost_reported`, `lostReport` trả đủ người, giờ, mã.
2. Kho B xác nhận: kiện `lost`, `lost_source = 'user'`, tồn không đổi, phát `package_lost` kèm `claimCode`.
3. Kho A tự xác nhận, công ty nhiều người, A không phải CEO: 409 `second_person_required`. CEO tự xác nhận: qua, `lost_self_approved = true`, có dòng nhật ký tự duyệt.
4. Báo lần hai: 409 `already_reported`. Xác nhận khi chưa báo: 409 `not_reported`. Admin, Sale: 403.
5. Báo thất lạc kiện `awaiting_pickup` không có cờ Cần mở: 409 `not_awaiting_open`.
6. Kiện `packed` đang chờ mở, kho A báo, kho B xác nhận: tồn thực và đang giữ giảm đúng số món trong kiện một lần, kiện `lost`, `handover_source = 'scan'`, không mang cờ `pickup_unconfirmed`.
7. Sàn báo `lost` cho kiện `in_transit`: kiện `lost`, `lost_source = 'marketplace'`, lịch sử ghi `platform_lost`, phát `package_lost` với `claimCode` null.
8. Kiện `lost` do người xác nhận, sàn báo `delivered`: kiện `delivered`, có cờ Cần xử lý, các cột `lost_*` về null, đơn bật Cần xử lý.
9. Kiện `lost` do sàn báo, sàn báo `in_transit`: trạng thái giữ nguyên, cờ Cần xử lý.
10. Migration chạy trên DB có kiện `lost` cũ không lỗi; sau migration, ghi tay `status = 'lost'` thiếu nguồn bị DB chặn.

**Kiểm kê (PR 2)**

11. Phiếu kiểm kê đếm thấp hơn hàng trong kiện `packed` đang giữ: kiện có cờ `needs_open`, `openPurpose = 'stocktake'`, nằm trong tab Cần mở. Kho mở: kiện về `reserved`, cờ gỡ, lượt phân hàng sau đó đưa kiện về `backordered` nếu tồn vẫn thiếu. Không mở mà hàng về đủ: lượt phân hàng kế tự gỡ cờ.
11a. Kiện `packed` chưa giữ hàng sau phiếu đầu kỳ: có cờ như trên, vẫn được xét giữ hàng; giữ được thì cờ tự gỡ.
11b. (PR 1) Kiện `reserved` mà sàn báo `lost`: kiện `lost`, tồn trừ đúng một lần, `lost_source = 'marketplace'`, phát `package_lost`.
11c. (PR 3) Kiện cũ `packed` đang chờ mở để chia lại bị xác nhận mất: tồn trừ theo mọi món trong hộp; các kiện thay được xét giữ hàng như kiện `backordered` thường; kiểm bằng không vỡ.

**Chia lại kiện (PR 3)**

12. Sàn đổi mã gói, tập món không đổi: chỉ mã kiện sàn đổi (kể cả hai kiện của đơn đổi mã cho nhau), không kiện nào huỷ hay lập, đơn không bật cờ.
13. Kiện `reserved` 2 món, sàn chia thành 2 mã mới: kiện cũ `cancelled`, 2 kiện mới `reserved` có `replaces` trỏ kiện cũ, số có thể bán trước và sau bằng nhau, đơn không bật cờ.
13a. Kiện `reserved` 2 món, sàn giữ mã cũ cho món 1 và đưa món 2 sang mã mới: kiện cũ ở `reserved` với 1 món, kiện mới `reserved` 1 món, không kiện nào huỷ.
13b. (#221, TikTok) Đơn có kiện `backordered` mã `PK-1` (một món chưa ghép SKU), sàn tách thành `PK-A`, `PK-B`: kiện chưa huỷ của đơn mang đúng `PK-A`, `PK-B`; `PK-1` thành `cancelled`. Ca `it.skip` ở `tiktok-order-pull.test.ts` chạy lại.
14. Như 13 nhưng có kiện `backordered` của đơn khác chờ cùng SKU: kiện mới của đơn này giữ được hàng, kiện kia vẫn `backordered`.
14a. Hai kiện app chưa đóng (đã tách trong app) về chung một mã sàn mới: hai kiện cũ `cancelled`, một kiện mới giữ hàng, đơn không bật cờ. Sàn gộp món của kiện kia vào mã của một kiện cũ: không đổi gì, đơn bật Cần xử lý "Sàn chia lại kiện, app chưa tự xử lý được".
15. Kiện `packed`, sàn chia thành 2 mã, món về chờ đóng gói (`pending`): kiện cũ giữ `packed`, vẫn giữ hàng, cờ Cần mở với `openPurpose = 'resplit'`; 2 kiện mới `backordered`, có `replaces`, không được phân hàng dù kho còn hàng (sàn báo nhóm mới đã đóng gói thì kiện mới theo trạng thái sàn như kiện đã có, D23, vẫn chờ thay, không giữ hàng). Kho mở: kiện cũ `cancelled`, 2 kiện mới `reserved` trước kiện `backordered` của đơn khác. Không gọi `repack`, đơn không bị khép. Sàn giữ mã cũ cho phần còn lại: mở kiện cũ gọi `repack` một lần (như `edit`), kiện về `reserved` với phần còn lại.
15a. Kiện đã đóng đang chờ mở vì `edit` hoặc `stocktake` bị sàn chia lại: mục đích thành `resplit`; đang `cancel` thì giữ `cancel`. Sàn huỷ cả kiện đang chờ mở để chia lại: mục đích thành `cancel` (D24). Mọi món của kiện cũ đã sang kiện thay rồi sàn huỷ cả đơn (kiện cũ không còn nhóm nào trên sàn): kiện thay `cancelled`, kiện cũ mục đích `cancel`, đơn `processing` với `cancelling` tới khi kho mở kiện cũ (`open_cancel` khép đơn), không `cancelled` ngay (soát PR 3, 18/11).
16. Như 15, sàn báo một kiện mới đã `in_transit` trước khi kho mở: kiện mới `in_transit`, tồn trừ đúng một lần, `handover_source = 'marketplace'` (không `forced`), kiện cũ mất các món đó; kiện cũ hết món thì `cancelled` với lịch sử `replaced`.
17. Kiện `in_transit`, sàn báo chia khác: không đổi gì, kiện và đơn bật Cần xử lý.
18. Kéo đơn lại sau mỗi ca 12 đến 17: không đổi gì, `version` các kiện không đổi.
19. Kiện `awaiting_pickup` có cờ Cần mở (mọi mục đích), mở xong còn món: về `reserved`, giữ mã kiện sàn, vận đơn, ĐVVC, không gọi `repack`; đóng gói và báo sẵn sàng lại không gọi `pack`, `readyToShip` của sàn, kiện về `awaiting_pickup` với vận đơn cũ. Kiện `awaiting_pickup` không có cờ: `open` vẫn 409 `invalid_transition`.
19a. (D28) `ready` kiện có cờ Cần mở: 409 `awaiting_open`; quét bàn giao kiện đó: `failed[].code = 'awaiting_open'`, kiện không đổi.
19c. (D28, review #393) Kiện chờ thay bị sàn đẩy sang `packed`/`awaiting_pickup`: `ready` 409 `awaiting_open`, quét bàn giao `failed[].code = 'awaiting_open'`, kiện và tồn không đổi. Kiện thay đã bị quét bàn giao (dữ liệu trước khi chặn) rồi sàn báo `in_transit`: phần giữ của dòng chờ bỏ được nhả, không chuyển sang dòng đã trừ; mở kiện cũ xong số đang giữ đúng.
19b. (D27) Sàn báo kiện `packed` đang chờ mở để chia lại đã `in_transit`: kiện `in_transit`, trừ mọi dòng một lần (kể cả dòng chờ bỏ), cờ Cần mở gỡ, bật Cần xử lý; kiện thay thành ứng viên phân hàng.

**Nguồn nhắc (PR 4)**

20. `GET /tasks` trả đúng ba loại việc theo bảng mục 5.7, lọc theo quyền; kiện báo mất đã được xác nhận thì việc `package.lost_reported` hết.

## 10. Rủi ro và điểm còn mở

- ~~D2 đến D6 chờ Thành~~: Thành chốt 15/11/2026.
- ~~D22 đến D29 chờ Khang~~: Khang duyệt 18/11/2026.
- ~~Kiện thay gom món từ kiện đã đóng lẫn kiện chưa đóng không giữ lúc lập~~: Thành chốt ở review #393 (18/11), giữ ngay phần từ kiện chưa đóng (D23, mục 5.6 bước `create`).
- **Kiện tự giao** (D13): hiện người đi giao cũng xác nhận mất được. Phải vá khi làm route `self-deliver`.
- ~~Đơn đang huỷ có kiện `lose_on_unload`~~: đã sửa ở sales cùng PR 1 (#331): gỡ `cancelling` khi không còn kiện chờ mở, tự hoàn tất.
- ~~Mở kiện `stocktake` rồi sàn huỷ đơn~~: đã làm ở PR 2 (`markWholePendingDrop`). PR 3 thêm `resplit` vào cùng luật (D24).
- ~~Phần 2 viết trên code chưa merge~~: mục 5.6 đã đối chiếu lại với `main` eb49bba (18/11/2026).
- **#237 PR 2 cũng sửa `openPackage`** (áp lại ghép khi mở kiện, cờ dỡ kiện): làm sau PR 3, hoặc người merge sau gộp lại nhánh `resplit`/`waybill_kept`.
- **Sàn thật.** Chia lại kiện và `lost` chưa gặp trên shop thử Lazada (trace 13/11/2026 chỉ tới `delivered`); kiểm bằng fixture. TikTok: gọi thật 07/11/2026 (đơn 587022741397144586) cho thấy tách kiện làm `line_items[].package_id` đổi và `update_time` tăng (ca `it.skip` của #221); chưa rõ sàn có giữ `package_id` cũ cho một phần không, nên D22 bước 2.2 lo cả hai.
- **Dùng lại vận đơn sau khi mở kiện `awaiting_pickup`** (AC 19, D25) dựa trên `25` §8.3; chưa thử thật việc sàn còn giữ vận đơn và chấp nhận in lại nhãn khi không gọi `pack`, `readyToShip`. Sàn đã bỏ mã thì kiện cũ đi nhánh `open_cancel`, không tới bước này. Sàn báo vận đơn đã huỷ: chưa có tín hiệu, kho xử lý tay (mở lại rồi chờ lượt kéo).
- **Kiện cũ giữ mã bị sàn báo rời kho khi còn dòng chờ bỏ** (D27): trừ cả dòng chờ bỏ, kiện thay đi phân hàng nên có thể xuất thêm một lần nữa. Đúng nếu hộp rời kho còn nguyên món; sai một lần nếu kho đã gỡ món ra mà chưa bấm mở. Cờ Cần xử lý để người xem, lệch thì phiếu kiểm kê.
- **Kiện chờ thay lập từ dòng của kiện chưa đóng** (một nhóm gồm món của kiện đã đóng và kiện chưa đóng): cả kiện không giữ lúc lập; dòng từ kiện chưa đóng đã nhả về số có thể bán, lúc kiện thay được lấy thì giữ lại hoặc bàn giao bắt buộc. Hiếm, chấp nhận.
- **Mã ca D2 đổi số** khi sinh lại từ máy FE: tham chiếu ở `27` và tên test hiện có phải cập nhật cùng PR Docs/FE.
- **Khung #209** có thể khác khuôn đã ghi trong issue; mục 5.7 chỉ cố định dữ liệu (điều kiện, mốc, thời hạn), không cố định kiểu.
