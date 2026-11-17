# Spec: Kiện thất lạc, sàn chia lại kiện, nguồn nhắc, Mở kiện (#238)

- **Ngày:** 15/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#238 (body viết lại 15/11/2026), `Documents/21` §11.2, §14.1, §14.2, §19.2, `Documents/25` §7.4, §8.1, §8.3, §8.4, §8.5, `Documents/19` (bảng `packages`, `package_lines`), `Documents/27` US-DH-12, US-DH-15, `Documents/kiem-thu/ca-theo-so-do.md` (D2)
- **Trạng thái:** Khang duyệt 15/11/2026. D2 đến D6 còn chờ Thành xác nhận trên issue
- **Nền:** `main` 7d3ed9d (đã có #199 a/b/c, #206, #239, #303). Phần 2 viết trên nền **sau khi PR #329 và #330 của #205 merge** (nhánh `feature/205-huy-dong`); chỗ nào dựa vào code của hai PR đó có ghi "(#330)".
- **Phạm vi spec:** Khang chốt 15/11/2026 là **một spec phủ cả 5 phần** của issue. Thi công vẫn nhiều PR (mục 6).

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

**Sau #329, #330 (nhánh `feature/205-huy-dong`):**

- `package_lines.pending_drop_qty` (dòng chờ bỏ). Ba constraint trigger kiểm bằng lúc commit: tổng `quantity − pending_drop_qty` của một dòng đơn trên các kiện chưa huỷ bằng `order_lines.quantity − cancelled_qty` (`db/CLAUDE.md`).
- `openPackage` (`service/packing.ts`): mọi dòng chờ bỏ thì `open_cancel`; còn lại `open`, xoá dòng chờ bỏ, nhả phần giữ của chúng, gọi `repack` trên sàn; kiện `awaiting_pickup` trả 409 `invalid_transition` ("dỡ kiện về kệ qua việc của kho (#238)").
- `syncPlatformPackages`: món chưa có mã kiện sàn theo kiện app đang chứa nó (cách chia của app); món có mã sàn gom theo mã.
- Cổng tồn `reserve`/`release` chỉ giữ tổng theo SKU, không ghi theo kiện (spec 205 §2): chuyển dòng đang giữ từ kiện này sang kiện khác không cần gọi cổng tồn.

**Ràng buộc:**

- Thứ tự khoá đã chốt ở spec 199b §5.10: gian hàng → advisory `fulfillment.allocation:<công ty>` → kiện → dòng tồn → `doc_counters`. Lượt kéo đơn khoá đơn trước kiện.
- Luật ranh giới của repo: fulfillment không import sales; đọc lịch sử trạng thái qua hàm của `core`.
- Mỗi PR sinh migration ở bước cuối; PR khác có migration merge trước thì `npm run db:regen`.
- Thêm loại sự kiện là PR riêng. Spec này **không thêm loại sự kiện nào** (`fulfillment.package_lost` đã có từ #288).

## 3. Quyết định

Đánh dấu **(Khang)** là Khang chốt trong buổi soạn; **(đề xuất)** là Claude đề xuất, Khang chưa bác; **(chờ Thành)** là Khang đồng ý tạm, còn chờ Thành xác nhận trên issue.

| # | Quyết định | Nguồn |
|---|---|---|
| D1 | Một spec cho cả 5 phần của issue | Khang |
| D2 | Tên thao tác theo máy FE và bộ ca: `lose_on_unload`, `platform_in_transit`, `platform_deliver`. Sửa `21` §19.2 (đang ghi `lose_unfound`, `platform_revive`) | chờ Thành |
| D3 | Thêm `platform_lost` vào máy FE và BE, sinh ca D2 mới | chờ Thành |
| D4 | Bỏ `awaiting_pickup` khỏi `lose` (theo `25` §8.3). Kiện đã đóng mà mất đi `lose_on_unload`, từ cả `packed` và `awaiting_pickup` | chờ Thành |
| D5 | Cờ `cod_unconfirmed` ngoài phạm vi #238 (đơn COD tay chưa có nguồn) | chờ Thành |
| D6 | Bảng `21` §14.2: ba dòng `package.*` đổi `#106` thành `#238` | chờ Thành |
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

## 4. Phạm vi

**Trong phạm vi:** route `report-lost`, `confirm-lost`; mũi tên `platform_lost`, `platform_in_transit`, `platform_deliver`, `lose_on_unload`; cột và CHECK thất lạc; phát `package_lost`; xử lý sàn chia lại kiện (chưa đóng, đã đóng, chờ thay bị lấy trước, đã bàn giao); mở kiện `awaiting_pickup`; kiểm kê → `needs_open`; ba nguồn nhắc; FE nối API; sửa Documents.

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

**PR 3 (chia lại kiện), migration `chia-lai-kien`:** `packages.replaces_package_id uuid null references "order".packages(id)`, index. Không đổi trigger kiểm bằng (D7).

### 5.2 Máy trạng thái (`domain/package.ts`)

| Thao tác | Từ | Đến | Ai | Ghi chú |
|---|---|---|---|---|
| `lose` (sửa) | `in_transit`, `delivery_failed`, `returning`, `self_delivering` | `lost` | `fulfillment.order.process` | `needsSecondPerson`, `allowSelfApproval`, `needsReason`. Bỏ `awaiting_pickup` (D4) |
| `lose_on_unload` (mới) | `packed`, `awaiting_pickup` | `lost` | `fulfillment.order.process` | như `lose`; guard `not_awaiting_open` khi kiện không có cờ `needs_open` |
| `platform_lost` (mới) | `in_transit`, `self_delivering`, `delivery_failed`, `returning` | `lost` | hệ thống | |
| `platform_in_transit` (mới) | `lost`, `returning` | `in_transit` | hệ thống | guard `status_from_platform` khi trạng thái hiện tại không do người chuyển tay |
| `platform_deliver` (mới) | `lost`, `returning` | `delivered` | hệ thống | như trên |
| `replaced` (mới, PR 3) | `packed`, `awaiting_pickup` | `cancelled` | hệ thống | kiện cũ bị kiện thay lấy hết món (mục 5.6) |

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

### 5.6 Sàn chia lại kiện (PR 3, trên nền #330)

**Luật thuần `domain/resplit.ts` (mới).** Vào: kiện chưa huỷ của đơn (`id`, `status`, `platformPackageCode`, dòng `{ orderLineId, quantity, pendingDropQty }`) và các nhóm món theo mã kiện sàn (`code`, dòng `{ orderLineId, quantity }`), chỉ gồm nhóm có mã sàn (món chưa có mã theo kiện app, spec 205 D10). Ra: danh sách bước, theo thứ tự thi hành. So tập theo dòng **không chờ bỏ**. Luật làm việc trên **nguyên dòng**: món sàn là dòng đơn số lượng 1 (mục 2) nên một dòng đơn chỉ nằm trong một nhóm; gặp một dòng đơn xuất hiện ở hai nhóm thì không lập kế hoạch cho đơn đó, `resplit = true` (Cần xử lý) và log `warn`.

1. **Khớp** (`25` §8.1 "Khớp kiện"): nhóm có tập (dòng đơn, số lượng) trùng đúng một kiện chưa bàn giao → bước `relabel` khi mã khác (kể cả đang null). Không đổi gì khác.
2. Nhóm còn lại là **chia lại**. Với mỗi nhóm, xét các kiện đang chứa món của nhóm:
   - Có kiện **đã bàn giao** → bước `flag` cho kiện đó ("Sàn chia lại kiện đã bàn giao"), nhóm không được lập; đơn bật Cần xử lý (`resplit = true` như hiện tại).
   - Ngược lại nhóm được lập thành kiện mới (bước `create`, kèm `replaces` = kiện cũ chứa nhiều món của nhóm nhất, hoà thì mã kiện nhỏ hơn).
3. Với mỗi kiện cũ **chưa đóng** (`backordered`, `reserved`) có món bị chuyển đi:
   - Mọi món đều chuyển đi → bước `cancel_open` (nhả phần giữ, `cancelled`).
   - Còn món ở lại (sàn giữ mã cũ cho phần còn lại, hoặc món chưa có mã sàn) → bước `move_out` cho các dòng chuyển đi (xoá dòng khỏi kiện cũ, nhả phần giữ của chúng); kiện cũ giữ trạng thái.
4. Với mỗi kiện cũ **đã đóng** (`packed`, `awaiting_pickup`) có món bị chuyển đi → bước `mark_drop` cho các dòng chuyển đi (chờ bỏ) và bật `needs_open` với `openPurpose = 'resplit'` (đang chờ mở vì `cancel` thì giữ `cancel`). Kiện mới nhận các món đó là **kiện chờ thay** (D9).
5. Nhóm có trạng thái sàn lạ (`groupStatus` null) không lập, `unknown = true` như hiện tại.

**Thi hành (`service/platform-packages.ts`).** Chạy sau bước huỷ dòng của #330, trước vòng áp trạng thái:

- Đọc kiện không khoá để biết có bước chia lại nào không. Có thì lấy khoá advisory phân hàng **trước** khi khoá kiện (đúng thứ tự khoá ở mục 2), rồi lập kế hoạch lại trên dữ liệu đã khoá. Không có thì đi đường cũ, không lấy advisory.
- Thứ tự: `relabel` → `cancel_open`, `move_out` (nhả hàng) → `mark_drop` → `create`. `create` dùng `createPackage` hiện có, vốn thử giữ hàng ngay lúc lập: vì đang giữ khoá advisory nên kiện mới của đơn lấy được phần vừa nhả trước mọi kiện `backordered` khác (`25` §8.1 bước 3, cùng giao dịch). Kiện mới nào không giữ đủ thì `backordered`.
- **Kiện chờ thay không giữ hàng lúc lập** (hàng còn nằm trong kiện cũ): `createPackage` nhận cờ bỏ qua bước giữ, kiện ở `backordered`, ghi `replaces_package_id`.
- Sau khi xong, phần hàng nhả còn dư: `requestAllocation` cho các SKU liên quan (chạy sau commit, như hiện tại).
- Lịch sử: kiện cũ ghi `action = 'cancel'` hoặc `drop_lines` (đã có ở #330) với `reason = 'Sàn chia lại kiện'`, `source = 'marketplace'`.
- Kiểm bằng: mỗi bước giữ tổng theo dòng đơn không đổi lúc commit (dòng chuyển đi bị xoá hoặc chờ bỏ, dòng mới thêm đúng số lượng). Mọi bước ghi dòng kiện đều sau khi đã khoá kiện (yêu cầu của trigger, `db/CLAUDE.md`).

**Phân hàng (`repository/allocation.ts`).** `candidateWhere` thêm điều kiện loại kiện chờ thay (D9): không tồn tại dòng chờ bỏ ở kiện khác đang `packed`/`awaiting_pickup` cùng `order_line_id` với một dòng của kiện. Kiện cũ mở xong (dòng chờ bỏ bị xoá), hoặc kiện cũ bị xác nhận mất (D20), thì kiện mới tự thành ứng viên. Bước chuyển phần giữ ở "lấy trước" bên dưới cũng chỉ lấy từ kiện cũ đang đóng.

**Mở kiện cũ (`service/packing.ts`, `openPackage`).**

- Cho phép kiện `awaiting_pickup` khi kiện có cờ `needs_open` (bỏ câu 409 trỏ sang #238). Kiện `awaiting_pickup` không có cờ vẫn 409 `invalid_transition`.
- `openPurpose = 'resplit'`: **không gọi `repack`** (sàn đã tự chia), **không khép đơn** (`settleCancelledOrder` chỉ dành cho `openPurpose = 'cancel'`).
- Kết quả theo `25` §8.3: mọi dòng chờ bỏ → `open_cancel` (kiện cũ `cancelled`); còn món → `open` (về `reserved`, xoá dòng chờ bỏ).
- Kiện `awaiting_pickup` còn món sau khi mở: giữ `platform_package_code`, `tracking_code`, `carrier_*`. `markReady` cho kiện đã có `tracking_code` và mã kiện sàn thì **không gọi `readyToShip` lần nữa**, chỉ chuyển `packed → awaiting_pickup` (dùng lại vận đơn, in lại nhãn; `25` §8.3).
- Trong giao dịch ghi của lần mở có `openPurpose = 'resplit'`: lấy khoá advisory phân hàng ở đầu giao dịch (trước khoá kiện), và sau khi nhả hàng thì thử giữ ngay cho các kiện chờ thay của cùng đơn vừa hết chờ (theo `ship_by`, mã kiện), trước khi `requestAllocation` cho phần dư.

**Kiện chờ thay được ĐVVC lấy trước khi kho dỡ** (`25` §8.1). Vòng áp trạng thái gặp kiện chờ thay mà sàn báo trạng thái đã rời kho:

1. Với từng dòng của kiện mới: tìm dòng chờ bỏ cùng `order_line_id` ở kiện cũ; đặt `reserved_qty` của dòng mới bằng `reserved_qty` của dòng cũ, xoá dòng cũ. Không gọi cổng tồn (tổng đang giữ theo SKU không đổi).
2. Kiện cũ hết dòng → mũi tên `replaced` (`cancelled`), gỡ `needs_open`. Còn dòng → gỡ `needs_open` nếu không còn dòng chờ bỏ.
3. Áp trạng thái sàn cho kiện mới như thường (`changeStatus` → `settleHandover`): dòng đã giữ thì trừ thường, **không** bàn giao bắt buộc. Kiện cũ không bao giờ tự ghi bàn giao.

**View.** `Package` thêm `replaces: { id, code } | null`. Kiện chờ thay hiện ở tab `backordered`; FE hiện dòng "Chờ mở kiện <mã kiện cũ>".

**Sales (`service/ingest.ts`).** `resplit` giờ chỉ còn nghĩa "có phần sàn chia lại mà app không tự xử lý được" (kiện đã bàn giao); ghi chú đổi thành "Sàn chia lại kiện đã bàn giao". Chia lại xử lý được thì `changed = true`, không bật cờ đơn.

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

Mọi lỗi ném `AppError`, trả Problem Details. `not_awaiting_open` là mã mới: thêm vào `21` §19.2.

### 5.9 Chạy đồng thời và gọi lặp

- Hai người cùng `confirm-lost`: khoá dòng kiện; người sau gặp `invalid_transition` (kiện đã `lost`).
- `report-lost` lặp: `already_reported`.
- Sàn báo `lost` giữa lúc kho đã báo, chưa xác nhận: `platform_lost` áp, `confirm-lost` sau đó trả `invalid_transition`; việc `package.lost_reported` tự hết vì kiện đã `lost`.
- Sàn báo đã lấy giữa lúc chờ xác nhận `lose_on_unload`: kiện sang `in_transit` theo sàn (`25` §8.3 "đi theo sàn"), báo cáo vẫn treo; người xác nhận sau đó đi mũi tên `lose` thường. Chấp nhận.
- Lượt kéo đơn lặp sau khi đã chia lại: tập món khớp → không bước nào, không đổi gì (idempotent). Test bắt buộc.
- Chia lại và phân hàng: khoá advisory tuần tự hoá; thứ tự khoá theo mục 2.
- Chia lại và `openPackage` cùng lúc: cả hai khoá kiện; `version` của kiện tăng ở bước `mark_drop` nên lần mở đang dở gặp `version_conflict`.

### 5.10 Test

Theo `test/CLAUDE.md` (đọc trước khi viết). Tên test mang mã ca D2 khi có.

- **Unit** `test/unit/modules/order/fulfillment/domain/`: `package.test.ts` (mũi tên mới, guard, `arrowAction` ưu tiên hệ thống, `platformUpdate`), `resplit.test.ts` (khớp và gắn lại mã; chia một kiện thành hai; gộp hai kiện thành một; kiện cũ chưa đóng, đã đóng, đã bàn giao, lẫn lộn; món chưa có mã sàn; gọi lại ra kế hoạch rỗng).
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
| Docs | Sửa `21`, `25`, `19`, ca D2, `27` theo mục 8. Merge trước hoặc cùng PR 1 | Thành xác nhận D2 đến D6 |
| PR 1 | Thất lạc: mục 5.1 (PR 1), 5.2 (trừ `replaced`), 5.3, 5.4 | không |
| PR 2 | Kiểm kê → Cần mở: mục 5.5 | không; nên sau PR 1 để khỏi regen migration |
| PR 3 | Sàn chia lại kiện: mục 5.6, mũi tên `replaced` | #329, #330 đã merge |
| PR 4 | Nguồn nhắc: mục 5.7 | #209 đã merge; nội dung đầy đủ khi PR 1 đến 3 đã merge |
| FE | Mục 7 | PR 1 (thất lạc), PR 3 (chờ thay) |

Mỗi PR cập nhật `src/modules/order/fulfillment/CLAUDE.md` và chạy `graphify update .`. Sau khi spec được duyệt, sửa body issue #238: `lose_on_unload` chuyển sang Phần 1 (D11); Phần 4 không còn chờ #208 (sự kiện là `inventory.stocktake_posted`, đã có).

## 7. Ảnh hưởng tới FE

FE đã có mock cho `report-lost`, `confirm-lost`, nút Báo/Xác nhận thất lạc ở `PackageDetailPage.tsx`, và hai nguồn nhắc mock. Việc còn lại:

- `src/lib/machines/order.ts`: bỏ `awaiting_pickup` khỏi `lose`; `lose_on_unload` thêm `awaiting_pickup` và guard `needs_open`; thêm `platform_lost`. Sinh lại `ca-theo-so-do.md` (mã ca có thể đổi số: cập nhật tham chiếu ở `27`).
- Tắt mock, nối API thật cho hai route; xử lý mã lỗi mục 5.8.
- `OpenPurpose` thêm `stocktake`; `Package` thêm `replaces`; hiện "Chờ mở kiện <mã>" cho kiện chờ thay.
- Mở kiện `awaiting_pickup` có cờ Cần mở: bật nút.
- E2E Playwright cho luồng báo và xác nhận thất lạc (`e2e/mock/pN/`, thêm `e2e/be/pN/` khi nối API thật).

## 8. Ảnh hưởng tới Documents

- `21` §19.2: đổi tên `lose_unfound` → `lose_on_unload`, tách `platform_revive` thành `platform_in_transit`, `platform_deliver`; `lose` ghi rõ không từ `awaiting_pickup`; thêm mã `not_awaiting_open`; `openPurpose` thêm `stocktake`; `Package` thêm `replaces`; bỏ `cod_unconfirmed` khỏi phạm vi #238 (ghi "chưa có nguồn").
- `21` §14.2: ba dòng `package.*` đổi `#106` → `#238`; mốc của `package.needs_open` thành "lần cập nhật gần nhất".
- `25` §8.1: câu về kiện chờ thay và bất biến (D8).
- `19` mục 2: `lost_source` đã có trong tài liệu, không đổi; ghi `open_purpose` thêm `stocktake`.
- `kiem-thu/ca-theo-so-do.md`: sinh lại từ máy FE; thêm ca cho `platform_lost`, `lose_on_unload` từ `awaiting_pickup`.
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

12. Sàn đổi mã gói, tập món không đổi: chỉ mã kiện sàn đổi, không kiện nào huỷ hay lập.
13. Kiện `reserved` 2 món, sàn chia thành 2 mã: kiện cũ `cancelled`, 2 kiện mới `reserved`, số có thể bán trước và sau bằng nhau, đơn không bật cờ.
14. Như 13 nhưng có kiện `backordered` của đơn khác chờ cùng SKU: kiện mới của đơn này giữ được hàng, kiện kia vẫn `backordered`.
15. Kiện `packed`, sàn chia thành 2 mã: kiện cũ giữ `packed`, vẫn giữ hàng, cờ Cần mở với `openPurpose = 'resplit'`; 2 kiện mới `backordered`, có `replaces`, không được phân hàng. Kho mở: kiện cũ `cancelled`, 2 kiện mới `reserved`. Không gọi `repack`, đơn không bị khép.
16. Như 15, sàn báo một kiện mới đã `in_transit` trước khi kho mở: kiện mới `in_transit`, tồn trừ đúng một lần, `handover_source = 'marketplace'` (không `forced`), kiện cũ mất các món đó.
17. Kiện `in_transit`, sàn báo chia khác: không đổi gì, kiện và đơn bật Cần xử lý.
18. Kéo đơn lại sau mỗi ca 12 đến 17: không đổi gì.
19. Kiện `awaiting_pickup` có cờ Cần mở, mở xong còn món: về `reserved`, giữ mã vận đơn; đóng gói và báo sẵn sàng lại không gọi sàn lần hai.

**Nguồn nhắc (PR 4)**

20. `GET /tasks` trả đúng ba loại việc theo bảng mục 5.7, lọc theo quyền; kiện báo mất đã được xác nhận thì việc `package.lost_reported` hết.

## 10. Rủi ro và điểm còn mở

- **D2 đến D6 chờ Thành.** Thành chốt khác thì sửa mục 5.2 và mục 8 trước khi code PR 1.
- **Kiện tự giao** (D13): hiện người đi giao cũng xác nhận mất được. Phải vá khi làm route `self-deliver`.
- **Đơn đang huỷ có kiện `lose_on_unload` (đã kiểm ở PR 1, còn mở, chờ Khang quyết):** kiện sang `lost`, tồn trừ một lần, đơn ở lại `processing` (đúng `25` §8.2). Nhưng cờ `cancelling` của đơn không bao giờ được gỡ: lượt kéo sau bật `platform_cancelled` mà `cancelling` vẫn `true`, nên `sales/service/complete.ts` bỏ qua đơn và đơn không tự hoàn tất. Sửa nằm ở sales (gỡ `cancelling` khi không còn kiện nào chờ mở), ngoài phạm vi PR 1.
- **Mở kiện `stocktake` rồi sàn huỷ đơn (PR 2):** kiện đang chờ mở vì kiểm kê mà sàn huỷ thì mục đích mở phải đổi sang `cancel` (huỷ thắng), nếu không kho mở ra kiện lại về `reserved`.
- **Phần 2 viết trên code chưa merge.** #329, #330 đổi khi review thì đối chiếu lại mục 5.6 trước khi làm PR 3.
- **Sàn thật.** Chia lại kiện và `lost` chưa gặp trên shop thử Lazada (trace 13/11/2026 chỉ tới `delivered`); kiểm bằng fixture. TikTok: hành vi `package_id` khi sàn chia lại cần Thành xác nhận từ #221.
- **Dùng lại vận đơn sau khi mở kiện `awaiting_pickup`** (AC 19) dựa trên `25` §8.3; chưa thử thật việc sàn còn giữ vận đơn sau khi chia lại. Sàn đã bỏ mã thì kiện cũ đi nhánh `open_cancel`, không tới bước này.
- **Mã ca D2 đổi số** khi sinh lại từ máy FE: tham chiếu ở `27` và tên test hiện có phải cập nhật cùng PR Docs/FE.
- **Khung #209** có thể khác khuôn đã ghi trong issue; mục 5.7 chỉ cố định dữ liệu (điều kiện, mốc, thời hạn), không cố định kiểu.
