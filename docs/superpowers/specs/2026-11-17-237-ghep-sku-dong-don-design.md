# Spec: Ghép SKU áp lên đơn đã về (#237)

- **Ngày:** 17/11/2026. Viết lại phần PR 2 ngày 19/11/2026 theo cách Cần mở (mục 1 ý 4, 3, 5.4, 5.5 bảng 2 và 3, 5.6, 6, 7 từ D15, 8, 9 phần PR 2, 10, 11)
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#237 và bình luận 14/11/2026 trên issue, `Documents/25` §7.4, §8.1, §8.4 quy tắc 3, §11, E41, E42, E107; `Documents/21` §11.1, §11.2, §18.3, §18.6.5, §19.1, §19.2; `Documents/27` US-DH-05, US-DH-15
- **Trạng thái:** PR 1 đã merge (#383, 17/11/2026). Phần PR 2 Khang duyệt 19/11/2026. PR 3 (báo cáo) viết thêm sau khi PR 2 merge
- **Nền:** PR 1: `main` cc10cb4 (đã có #220 ghép SKU tay, #206 cổng tồn, #199 a/b/c, #205, #238 PR 1, #239). PR 2: viết trên `main` d98ce34b (thêm PR 1 #383, #238 PR 2 và PR 3 #393, #205 PR 2), soát lại trên `main` fdd0af01 ngày 19/11/2026 (thêm #236 PR 3, #398, #417, #415, #216, a3f8dcd2: `openPackage`, `service/remap.ts`, `domain/remap.ts`, `service/resplit.ts`, `repository/allocation.ts` không đổi; `PackageSummary.lines[]` đã có `untracked`)
- **Nhánh:** PR 1 `feature/237-ghep-sku-dong-don`; PR 2 `feature/237-doi-ghep-da-dung`

---

## 1. Mục tiêu và tiêu chí thành công

1. Ghép một SKU sàn (từ dòng đơn có cờ Chưa ghép, hay từ trang gian hàng) thì **mọi đơn đã về** của gian hàng mang SKU sàn đó được áp ghép ngay trong cùng giao dịch: dòng đơn và dòng kiện có biến thể, cờ `unmapped_sku` tắt (US-DH-05 dòng 1).
2. Kiện xử lý theo trạng thái lúc ghép: chưa rời kho thì thử giữ hàng; đã rời kho thì trừ tồn bù **đúng một lần**, chốt giá vốn lúc đó (`25` §8.4 quy tắc 3); kiện đã giao đang hoãn báo finance thì báo.
3. Ghép "không quản tồn" (đã duyệt) làm dòng hết cờ Chưa ghép mà không giữ, không trừ tồn; đơn về sau cũng vậy (US-DH-05 dòng 2, E41).
4. Đổi một ghép đã có đơn dùng: dòng đang giữ ở kiện chưa đóng nhả theo SKU cũ, giữ lại theo SKU mới trong một giao dịch; kiện đã đóng bật **Cần mở** với mục đích `remap`, không báo sẵn sàng giao, không quét bàn giao được tới khi kho mở kiện, mở ra thì áp ghép mới; kiện đã rời kho không đổi (E107, US-DH-05 dòng 3, US-DH-15).
5. Báo cáo các lần ghép "không quản tồn" và đổi ghép đã dùng, kèm số món đã xuất theo ghép đó (`25` §8.1, US-DH-05 dòng 2): PR 3 (mục 6).

Đo bằng: AC ở mục 9 đều qua; `npm run check` xanh.

**Vì sao:** hiện ghép xong chỉ đơn kéo về sau mới có biến thể. Đơn đã về giữ cờ Chưa ghép mãi, kiện của nó không giữ được hàng, kiện bàn giao bắt buộc không bao giờ trừ tồn, kiện đã giao có dòng đã ghép chưa trừ không bao giờ phát `package_delivered`.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (cc10cb4):**

- Bảng ghép là `channel.listings`. `matchListing` và `decideMapping` (`channel/channel/service/mapping.ts`) lo luật CEO duyệt, 200/202, `pendingMapping`. Cả hai **không đụng đơn đã nhận**. `matchListing` khoá dòng gian hàng (`lockShopRow`) trước khi kiểm "đã có đơn"; `decide` chưa khoá.
- Lượt kéo đơn tra biến thể bằng `variantsBySellerSku(shopId, sellerSkus)` (`repository/raw-orders.ts`): trả `Map<sellerSku, variantId | null>`, không phân biệt "chưa ghép" với "không quản tồn đã duyệt".
- `order.order_lines`: `variant_id` (null = chưa ghép), `external_sku` = SKU người bán trên sàn (`ingest.ts` ghi `externalSku: l.sellerSku`), `sku` = `sellerSku` khi đã ghép. Cờ `unmapped_sku` suy ra lúc đọc từ `variant_id is null` ở bốn chỗ: `repository/order-views.ts` (lọc, tóm tắt), `repository/orders.ts` `hasUnmappedLines`, `service/ingest.ts` (hai chỗ dựng cờ cho sự kiện).
- `order.package_lines`: `variant_id`, `reserved_qty` (0 hoặc đủ), `stock_deducted`, `unit_cost`. CHECK `package_lines_unmapped`: dòng chưa ghép thì `reserved_qty = 0`.
- Fulfillment coi "dòng chưa ghép" là `variant_id is null` ở: ứng viên phân hàng (`repository/allocation.ts:25`), lúc lập kiện (`platform-packages.ts` `mapped`), `shipPlan` (`domain/handover.ts`), `lockDeferredPackages`, `deliveryStateOf.deferred`.
- Đã có sẵn cho issue này (`fulfillment/index.ts`): `shipLateMappedLines(packageId)` (kiện đã rời kho, không `before_cutoff`: trừ dòng đã ghép chưa trừ, phiếu `XK` mới), `requestAllocation(variantIds)`. `reportDelivered` chưa export nhưng cùng module.
- Cổng tồn `reserve(packageId, lines)`, `release(packageId, lines)` nhận danh sách dòng tuỳ ý; inventory chỉ giữ tổng theo SKU (spec 205 §2).
- Máy trạng thái kiện: `hold` (`backordered → reserved`), `reclaim` (`reserved → backordered`), `open` (`SEALED → reserved`); `openPackage` chỉ nhận `packed` (`awaiting_pickup` chờ #238).
- Hợp đồng `21` §18.3 không có route ghép dưới `/sales`. `OrderLine` (§19.1) đã trả `externalSkuId`, `externalSku`; `Order` có `shopId`. FE đủ dữ liệu để gọi `POST /channel/shops/:id/listings/match` từ trang chi tiết đơn.
- Dòng tham chiếu `finance/service/boundary.ts:41` (409 `unmapped_sku`) trong issue đã cũ: `main` không còn file và mã lỗi đó trong `finance`.

**Ràng buộc:**

- Chiều lớp: `channel` (lớp 5) gọi `order` (lớp 3) trực tiếp; `order` cần dữ liệu của `channel` thì nhận qua `ModuleContext` (`src/wiring.ts`).
- Inventory là nơi duy nhất đổi tồn; fulfillment là nơi duy nhất gọi cổng tồn theo kiện. Sales không gọi cổng tồn.
- Thứ tự khoá đã chốt (spec 199b §5.10): gian hàng → advisory phân hàng → kiện → dòng tồn.
- Trigger `package_lines_line_total` (spec 205 D11): đường ghi dòng kiện phải khoá kiện trước. Spec này không đổi `quantity`, chỉ đổi `variant_id`, `reserved_qty`.
- Bốn ràng buộc từ #300 (bình luận 14/11 trên issue): kiện `delivered` đang hoãn thì gọi `reportDelivered` sau khi trừ; gán `variant_id` trên kiện đã rời kho luôn đi kèm trừ tồn cùng giao dịch; kiện `returned` không trừ; kiện đã phát `package_delivered` không phát bù.
- Gian hàng đang chờ kiểm kê đầu kỳ: không giữ, không trừ; hàm bù `settleDeferredHandovers` lo (`fulfillment/CLAUDE.md`).

**Hiện trạng cho PR 2** (`main` d98ce34b, 19/11/2026):

- PR 1 (#383): `planRemap` trả `kept` cho dòng kiện đã ghép khác `to`; `applySkuMapping` chỉ chọn dòng chưa ghép (`lockUnmappedLinesOfShopSku`). Channel đã gọi `applyToOrders` ở mọi nhánh ghép có hiệu lực, kể cả đổi ghép (CEO tự duyệt, CEO duyệt ghép chờ), nên PR 2 không sửa luồng của channel, chỉ export thêm `skuMappingOf`.
- Cờ Cần mở (#205, #238): `packages.needs_open` cùng `open_purpose` (`cancel`, `edit`, `resplit`, `stocktake`; CHECK `packages_open`: cờ bật thì có mục đích). Kiện có cờ: vào tab `needs_open`; `ready` 409 `awaiting_open`, quét bàn giao `failed[].code = 'awaiting_open'` (#238 D28); `open` nhận `awaiting_pickup` chỉ khi có cờ, giữ vận đơn (#238 D25); `report-lost`, `lose_on_unload` cần cờ; lượt phân hàng không lấy kiện có cờ làm ứng viên, trừ `stocktake` (`repository/allocation.ts`).
- Ai bật mục đích nào: kiện chưa có cờ thì mục đích mới; `resplit` thay `edit`, `stocktake` (`mark_drop` ở `service/resplit.ts`); `cancel` thay `edit`, `stocktake`, `resplit` (`markWholePendingDrop`); `edit` (`markPendingDrop`) và `stocktake` (`planDismantle`) không thay mục đích đang có.
- Gỡ cờ mà kiện vẫn đóng (không qua mở): lượt phân hàng gỡ `stocktake` khi tồn đủ (`stocktakeAutoClearable`); kiện thay được lấy mà kiện cũ hết dòng chờ bỏ thì gỡ `resplit` (`takeOverReplaced`). Kiện rời nhóm đã đóng thì `updatePackage` (`openFlagRules`) gỡ; `cancel`, `edit`, `resplit` bật thêm Cần xử lý `LEFT_WHILE_AWAITING_OPEN_NOTE`, `stocktake` gỡ im.
- `openPackage` (`service/packing.ts`): bước kiểm (giao dịch ngắn, khoá gian hàng `FOR SHARE`, giữ lại dòng có biến thể chưa giữ đủ, thiếu thì 422 `insufficient_stock`) → `repack` của sàn ngoài giao dịch (trừ kiện giữ vận đơn) → bước ghi (chỉ mục đích `resplit` lấy khoá phân hàng trước khi khoá kiện). Mở kiện không đọc ghép hiện hành.
- `open_purpose` là enum PostgreSQL: thêm giá trị bằng migration; không migration nào trong cùng lượt được dùng giá trị đó, kể cả trong CHECK (`db/CLAUDE.md`). Khoá advisory theo giao dịch xin lại trong cùng phiên thì được ngay (tài liệu PostgreSQL 18, mục 13.3.5), nên hàm đổi ghép xin lại khoá phân hàng mà bên gọi đã giữ không tự chặn.

## 3. Phạm vi

**Trong phạm vi (BE):**

- Áp ghép lên đơn đã về khi ghép có hiệu lực (ghép ngay, CEO tự duyệt, CEO duyệt ghép chờ).
- Cột phân biệt "không quản tồn" trên dòng đơn và dòng kiện; đơn về sau của SKU "không quản tồn" mang cột này.
- Đổi ghép đã dùng (PR 2): nhả/giữ lại ở kiện chưa đóng, Cần mở `remap` ở kiện đã đóng, mở kiện áp lại ghép hiện hành.
- `OrderLine` API thêm trường `untracked` (PR 1); `Package` thêm mục đích `remap`, `lines[].remapPending`, `lines[].untracked` (PR 2).
- Báo cáo xuất hàng "không quản tồn" và đổi ghép đã dùng (`25` §8.1 "hiện trên báo cáo"): PR 3, chốt 19/11/2026. Hiện chỉ lần CEO tự duyệt hiện ở `GET /report/self-approvals`.

**Ngoài phạm vi:**

- FE (nút ghép, hộp thoại trên trang chi tiết đơn, E2E): DA-EC-System/FE#283 (FE#129, FE#130 đã đóng; FE PR #328 đã merge 19/11/2026). BE không thêm route mới cho FE. Nhãn mục đích `remap`, dấu `remapPending` và bỏ cách đọc `REMAP_UNLOAD_NOTE` của FE#328: DA-EC-System/FE#359. Hộp Đổi ghép khoá nút khi chọn lại đúng ghép (chặn đường chạy bù D6): DA-EC-System/FE#358.
- Nhắc việc kho trong khung #209 (`package.needs_open`, #238 PR 4): PR 2 chỉ bật cờ Cần mở; nguồn nhắc đi chung với các mục đích khác khi #209 có.
- Phiếu `KT` của kiện đã `returned` có dòng ghép muộn, phần bán lại của yêu cầu trả có dòng ghép muộn (`25` §7 dòng 563, 565): không cộng bù.
- Phát bù `package_delivered` cho kiện đã phát trước khi ghép.

**Không được xảy ra:**

- Một dòng kiện bị trừ tồn hai lần, hoặc đã gán biến thể trên kiện đã rời kho mà không trừ (trừ các ca `before_cutoff`, `returned`, gian hàng chờ kiểm kê).
- Ghép chờ CEO duyệt (202) mà đã đổi đơn.
- Kiện đã rời kho bị đổi biến thể theo ghép mới.
- Đơn về giữa lúc ghép lọt khỏi cả hai đường (không được áp ghép mới lúc ingest, cũng không được áp bù).
- (PR 2) Kiện đã đóng chứa món theo ghép cũ mà ghép đã đổi lại báo sẵn sàng giao hay quét bàn giao được (sàn tự báo rời kho thì đành theo sàn, mục 5.6).
- (PR 2) Việc đổi ghép của một kiện đã đóng bị mất khi mục đích mở khác được gỡ mà kiện chưa mở.
- (PR 2) Kiện mở xong (về `reserved`) mà dòng sống còn mang ghép khác ghép hiện hành của SKU sàn.

## 4. Các cách đã xét

| Cách | Nội dung | Được | Mất |
|---|---|---|---|
| **A (chọn, Khang chốt 17/11/2026)** | Không thêm route. `listings/match` và `mapping/approve` của channel, khi ghép có hiệu lực, gọi một hàm mới của `order` trong cùng giao dịch để áp lên đơn đã về | Một đường ghép; CEO duyệt từ trang gian hàng cũng áp; đúng chiều lớp; khoá gian hàng sẵn có chặn đua với lượt kéo đơn | Giao dịch ghép dài hơn (giữ khoá gian hàng trong lúc xử lý kiện) |
| B | Route `POST /sales/orders/:id/lines/:lineId/match` như issue ghi | Khớp chữ của issue | `order` gọi ngược `channel` qua `ctx`; phải sửa `21`; nhánh CEO duyệt vẫn cần đường của A, thành hai đường vào |
| C | Channel phát sự kiện `channel.sku_mapped`, `order` nghe rồi áp | Giao dịch ghép ngắn | Áp trễ, không cùng giao dịch: đơn về giữa chừng khó chốt; thêm loại sự kiện dùng chung; lỗi áp rơi vào DLQ thay vì báo người bấm |

Issue ghi "Route ghép từ dòng đơn" trong `sales`: theo cách A dòng đó được hiểu là FE gọi route của channel; sửa lại chữ trên issue khi mở PR.

**Kiện đã đóng khi đổi ghép (PR 2, xét lại 19/11/2026):**

| Cách | Nội dung | Được | Mất |
|---|---|---|---|
| Bản 17/11 | Cần xử lý kèm ghi chú `REMAP_UNLOAD_NOTE` | Không migration | Sau #238 kiện `awaiting_pickup` không mở được khi thiếu Cần mở; ghi chú không chặn báo sẵn sàng giao, quét bàn giao, nên hộp món cũ vẫn đi được |
| **Cần mở `remap` kèm dấu theo dòng (chọn, hướng Cần mở chốt 19/11/2026)** | Mục đích mở mới; dấu `remap_pending` trên dòng giữ việc đổi ghép | Dùng sẵn mọi đường của Cần mở (tab, chặn #238 D28, mở `awaiting_pickup`, báo mất khi dỡ); không mất việc khi mục đích khác bị gỡ; biết khi nào gỡ cờ lúc đổi về như cũ | Một migration (giá trị enum, một cột) |
| Cần mở `remap`, không dấu | Chỉ xếp hạng mục đích | Migration chỉ thêm giá trị enum | Gỡ `resplit` ở `takeOverReplaced` làm mất việc đổi ghép; đổi ghép về như cũ không biết kiện còn dòng nào lệch |
| Đổi dòng đơn ngay, suy lệch từ dòng đơn so với dòng kiện | Không cột mới | Không dấu | Ngược D4: dòng đơn và dòng kiện lệch trong lúc chờ; kiện bị bàn giao thì dòng đơn nói B mà hàng đã xuất A |

## 5. Thiết kế

### 5.1 Luồng

```
FE (chi tiết đơn hoặc trang gian hàng)
  └─ POST /channel/shops/:id/listings/match  |  .../mapping/approve
       channel/service/mapping.ts   (giao dịch, đã khoá dòng gian hàng)
         1. ghi listing (như #220)
         2. ghép có hiệu lực → order.applySkuMapping({ shopId, sellerSku, to, actorId, holdStock })
              sales/service/sku-mapping.ts
                a. tìm dòng đơn của gian hàng có external_sku = sellerSku cần đổi
                b. fulfillment.remapPackageLines(...)   ← mọi việc trên kiện và tồn
                c. ghi dòng đơn theo kết quả, phát sự kiện đơn
```

Trạng thái ghép của một dòng dùng chung ba giá trị (kiểu `LineSku`, khai ở `fulfillment/domain/remap.ts`, sales và channel dùng qua `index.ts`):

```ts
type LineSku = { kind: 'variant'; variantId: string } | { kind: 'untracked' } | { kind: 'unmapped' };
```

### 5.2 Dữ liệu

Hai cột mới, một migration (sinh ở bước cuối, `npm run db:generate -- --name ghep-sku-dong-don`):

| Bảng | Cột | Ràng buộc |
|---|---|---|
| `order.order_lines` | `stock_untracked boolean not null default false` | CHECK `order_lines_untracked`: `not stock_untracked or variant_id is null` |
| `order.package_lines` | `stock_untracked boolean not null default false` | CHECK `package_lines_untracked`: `not stock_untracked or (variant_id is null and reserved_qty = 0 and not stock_deducted)` |

- "Chưa ghép" từ nay là `variant_id is null and not stock_untracked`. Sửa đủ các chỗ ở mục 2 (bốn chỗ của sales, năm chỗ của fulfillment). Dòng `stock_untracked` không giữ, không trừ, `unit_cost` null, không chặn phân hàng của kiện, không vào danh sách nhặt/so quét theo biến thể.
- **Kiện không còn gì để giữ** (không dòng chờ ghép, mọi dòng có biến thể đã giữ; gồm cả kiện mà mọi dòng đều `stock_untracked`): coi là đã giữ đủ, không gọi cổng tồn. Lúc lập kiện (`platform-packages.ts`) kiện như vậy vào thẳng `reserved` kể cả khi gian hàng chờ kiểm kê (không có tồn nào liên quan); trong `remapPackageLines`, kiện `backordered` thành như vậy sau khi ghi dòng thì sang `reserved` qua mũi tên `hold` ngay trong giao dịch. Lý do: lượt phân hàng chỉ tìm kiện theo biến thể (`hasVariant`, `variantsInPlay`), kiện toàn dòng `stock_untracked` sẽ kẹt ở `backordered` và kho không đóng gói được.
- Danh sách nhặt và đóng gói: dòng `stock_untracked` hiện như dòng không biến thể hiện nay (theo SKU người bán, không so quét).
- Thêm cột có mặc định hằng: không viết lại bảng (PostgreSQL 18). Không cần điền dữ liệu cũ: trước spec này dòng của SKU "không quản tồn" là "chưa ghép", và sẽ được áp ở lần chạy bù (mục 5.9).
- `package_delivered`: dòng `stock_untracked` mang `variantId: null`, `unitCost: null` như `21` §11.2 đã ghi cho "ghép không quản tồn". Không đổi schema sự kiện.

### 5.3 Channel

- **Điểm gọi:** `matchListing` nhánh áp ngay (sau `updateListing`/`insertListing` thành công, trước `return`) và `decide` nhánh `approve`. Nhánh lưu ghép chờ (202), `reject`, gỡ listing: không gọi.
- Tham số: `sellerSku` của dòng listing vừa ghi (null thì bỏ qua); `to` = ghép **của dòng thắng** theo SKU người bán, đọc lại bằng `skuMappingOf` sau khi ghi listing (gian hàng có thể có hai listing trùng SKU người bán, `listings` không unique theo cột này; lượt kéo đơn cũng tra theo dòng thắng, nên đơn đã về và đơn về sau luôn cùng một ghép); dòng thắng ra `unmapped` thì không gọi; `orderCutoffAt` của gian hàng (mục 5.5); `actorId` = người làm bước có hiệu lực (người ghép, hoặc CEO duyệt), `holdStock` = gian hàng không chờ kiểm kê đầu kỳ (`openingStocktakeId === null`, đọc dưới khoá).
- `decide` thêm `lockShopRow(shop.id)` đầu giao dịch (như `matchListing`): chặn lượt kéo đơn chen giữa lúc duyệt và lúc áp.
- `matchListing` gặp ghép đã đúng (nhánh trả sớm hiện có): **vẫn gọi** `applySkuMapping`. Hàm idempotent (mục 5.4), nên bấm ghép lại là cách chạy bù cho đơn về trước khi có spec này và cho lần áp lỗi.
- `variantsBySellerSku` đổi kiểu trả thành `Map<sellerSku, LineSku>`: dòng thắng `mapped` → `variant`; `unmanaged` đã có `approved_by` → `untracked`; còn lại (không có dòng, `unmanaged` chỉ chờ duyệt) → `unmapped`. `order-pull.ts` truyền `variantId` và `untracked` xuống `ingestMarketplaceOrder`.
- Export thêm `skuMappingOf(shopId, sellerSkus): Promise<Map<string, LineSku>>` (bọc `variantsBySellerSku`) cho mục 5.6.

### 5.4 Sales: `applySkuMapping`

`sales/service/sku-mapping.ts`, export qua `order/index.ts`. Chạy trong `withCompany` và giao dịch của bên gọi.

```ts
applySkuMapping(input: { shopId: string; sellerSku: string; to: LineSku /* không 'unmapped' */; actorId: string; holdStock: boolean; orderCutoffAt: Date | null })
  : Promise<{ lines: number; orders: number; needsUnload: number }>
```

1. Đọc và khoá (`FOR UPDATE`, theo id) dòng đơn của các đơn thuộc `shopId` có `external_sku = sellerSku` mà trạng thái ghép hiện tại khác `to`. Dòng đang có biến thể hoặc `stock_untracked` (tức là đổi ghép) chỉ lấy ở đơn `unpaid`, `processing`: đơn `completed`, `cancelled` có kiện đã dừng, không có gì đổi. Dòng **chưa ghép** thì lấy ở mọi trạng thái đơn (cờ phải tắt ở mọi đơn; kiện bàn giao bắt buộc của đơn đã hoàn tất vẫn phải trừ). Cộng thêm dòng đơn của đơn `unpaid`, `processing` có dòng kiện mang dấu `remap_pending` (mục 5.6), **kể cả khi dòng đơn đã bằng `to`**: dòng đơn của kiện chờ dỡ vẫn giữ ghép cũ (D4), nên đổi ghép về như cũ (20b) mà chỉ chọn theo dòng đơn thì không bao giờ tới được dấu để xoá. PR 1 chỉ chọn dòng chưa ghép (P1); PR 2 mở thêm hai nhóm này.
2. Gọi `remapPackageLines(changes, { actorId, holdStock, orderCutoffAt })` của fulfillment với `changes = { orderLineId, to }[]`. Nhận về kết quả theo dòng đơn: `applied`, `kept`, `needs_unload`.
3. Ghi dòng đơn có kết quả `applied`, và dòng đơn không có dòng kiện nào: `variant_id`, `stock_untracked`, `sku` (= `external_sku` khi có biến thể, như ingest; null khi không). Dòng `kept`, `needs_unload` giữ nguyên.
4. Đơn `unpaid`, `processing` có cờ `unmapped_sku` vừa đổi: phát `sales.order_status_changed` kèm cờ mới như ingest phát khi cờ đổi (FE tải lại qua SSE).
5. Log `info` một dòng: gian hàng, SKU người bán, số dòng, số đơn, số kiện cần dỡ.

Idempotent: gọi lại khi mọi dòng đã đúng `to` thì bước 1 rỗng, không ghi, không phát.

Dòng đơn mà các dòng kiện của nó ra kết quả khác nhau (chỉ đơn tay, số lượng > 1 nằm ở nhiều kiện; đơn sàn mỗi món một dòng): dòng đơn chỉ đổi khi mọi dòng kiện **tính kết quả** của nó `applied`. Từ PR 2, dòng kiện của kiện `cancelled` và dòng chờ bỏ (`pending_drop_qty > 0`) không tính (bảng 2 trả `kept` cho kiện huỷ, nên nếu tính thì đơn từng có kiện huỷ, hay đơn có dòng ở kiện cũ chờ chia lại, không bao giờ đổi được dòng đơn). PR 1 vẫn đúng với luật này vì bảng 1 trả `applied` cho kiện huỷ.

### 5.5 Fulfillment: `remapPackageLines`

Luật thuần ở `domain/remap.ts` (`planRemap(pkg, lineChanges)` → danh sách bước), thi hành ở `service/remap.ts`, export qua `fulfillment/index.ts`. Thứ tự trong giao dịch: khoá advisory phân hàng (`takeAllocationLock`) → khoá các kiện chứa dòng liên quan theo id tăng dần (`lockPackage`) → xử lý từng kiện.

Với mỗi dòng kiện, "cũ" là trạng thái ghép hiện tại của dòng kiện, "mới" là `to`. Cũ đã bằng mới: bỏ qua, kết quả `applied`.

**Bảng 1. Cũ là `unmapped` (ghép lần đầu):**

| Kiện | Việc | Kết quả |
|---|---|---|
| `cancelled` | Ghi dòng, không tồn | `applied` |
| `backordered` | Ghi dòng; `requestAllocation` cho mọi biến thể của kiện (kiện có thể vừa đủ điều kiện giữ) | `applied` |
| `reserved`, `packed`, `awaiting_pickup` | Ghi dòng; mới là biến thể thì **giữ dòng mới** (dưới) | `applied` |
| Đã rời kho, không `returned`, `handed_over_at` từ `orderCutoffAt` trở đi (hoặc mốc null) | Ghi dòng; mới là biến thể và `holdStock` thì `shipLateMappedLines(pkg.id)` (kiện `before_cutoff` hàm tự bỏ qua); sau đó kiện `delivered` mà `delivery_posted_at` null thì `reportDelivered(pkg.id)` | `applied` |
| Đã rời kho trước `orderCutoffAt` (D11) | Ghi dòng, **không trừ**: kiện rời kho trước lúc đếm của phiếu đầu kỳ, phiếu đã không đếm món đó. Xảy ra khi kiện rời kho lúc gian hàng chờ kiểm kê mà mọi dòng còn chưa ghép: `lockDeferredPackages` chỉ chọn kiện có dòng đã ghép nên hàm bù chưa đánh `before_cutoff` cho nó | `applied` |
| Đã rời kho, `holdStock = false` | Ghi dòng, không trừ: `settleDeferredHandovers` trừ khi phiếu đầu kỳ ghi sổ | `applied` |
| `returned` | Ghi dòng, không trừ (hàng đã về kệ) | `applied` |

Nhánh `reportDelivered` ở bảng 1 là phòng thủ: kiện giao xong còn dòng **chưa ghép** đã phát `package_delivered` ngay lúc giao với `unitCost: null` (`21` §11.2 D6; `deferred` chỉ tính dòng đã ghép chưa trừ), nên luồng thường rơi vào ca "đã phát, không phát bù". Giữ lời gọi vì bình luận 14/11 trên issue đòi; test dựng trạng thái `delivery_posted_at` null bằng tay.

**Bảng 2 (PR 2, viết lại 19/11/2026). Cũ là biến thể A, mới là biến thể B hoặc "không quản tồn" (đổi ghép):**

Chỉ dòng kiện **sống** (`pending_drop_qty = 0`) được xét. Dòng chờ bỏ không ghi, không đánh dấu, không tính vào kết quả của dòng đơn (mục 5.4): nó rời kiện khi kho mở.

| Kiện | Việc | Kết quả |
|---|---|---|
| `cancelled`, đã rời kho (gồm `returned`, `lost`) | Không đổi | `kept` |
| `backordered` | `release` phần đang giữ của dòng nếu có (dòng không chờ thay của kiện thay được giữ ngay lúc lập, #238; dòng chờ thay thì `kept`, D26); ghi dòng (`reserved_qty = 0`); kiện không còn gì để giữ thì `hold` (D10), không thì `requestAllocation([A] ∪ biến thể của kiện)` | `applied` |
| `reserved` | `release` phần đang giữ của dòng theo A; ghi dòng (`reserved_qty = 0`); mới là biến thể thì **giữ dòng mới** (dưới); `requestAllocation([A])` | `applied` |
| `packed`, `awaiting_pickup` | Không đổi dòng, không đổi tồn. Đánh dấu `remap_pending` trên dòng; bật Cần mở `remap` theo luật ở mục 5.6 | `needs_unload` |

- Dòng kiện đã mang đúng `to` (`applied`, không ghi biến thể) mà đang có dấu `remap_pending` (đổi A → B rồi về A): xoá dấu (kiện đã rời kho thì không cần, dấu nằm im). Kiện đã đóng có mục đích `remap` mà không còn dòng nào có dấu: **không gỡ thẳng** mà chuyển mục đích sang `stocktake` và `requestAllocation` cho biến thể của kiện (D24). Lượt phân hàng gỡ cờ đó khi đủ điều kiện như mọi kiện kiểm kê (`stocktakeAutoClearable`): kiện đang giữ mà tồn đủ, hoặc kiện chưa giữ được giữ lại; kiện có dòng chờ bỏ hay báo thất lạc chờ xác nhận thì cờ còn tới khi mở hay xác nhận. Gỡ thẳng thì mất ba việc: hộp còn món đã bị sàn huỷ (dòng chờ bỏ, vì `edit` không thay `remap`), báo thất lạc chờ người thứ hai (gỡ `needs_open` thì luật D21 của #238 xoá báo cáo, #366 đã chặn), và việc kiểm kê mà `remap` đã thay (bảng ở mục 5.6).
- **Dòng chờ thay của kiện thay** (#238: kiện `backordered` có dòng mà cùng dòng đơn còn dòng chờ bỏ ở kiện đã đóng khác, `replacementPairs`): giữ ghép cũ, kết quả `kept`, ở bảng 1, 2, 3 đều vậy; kiện chờ thay không `hold` (D10) trong lúc áp. Lý do: phần đang giữ của dòng chờ bỏ (theo A) sẽ chuyển sang dòng chờ thay khi kiện thay được lấy (`moveReservations`, so theo dòng đơn, không so biến thể), hoặc giữ lại cho nó khi mở kiện cũ (`holdOrderReplacements` theo biến thể vừa nhả); dòng chờ thay mang B thì B được coi như đã giữ mà kho không giữ B, phần giữ A không ai nhả. Ghép mới áp cho kiện thay khi bấm ghép lại sau khi nó hết chờ (D6, mục 10).
- Idempotent: dòng đã có dấu và kiện đã có Cần mở với mục đích khác `stocktake` thì không ghi, không lịch sử, kết quả vẫn `needs_unload`. Mọi lần có ghi trên kiện đã đóng (đánh dấu, xoá dấu, đổi hay gỡ cờ) thì `version` tăng: bước kiểm của mở kiện dựa vào điều này (mục 5.6).
- Chờ kiểm kê (`holdStock = false`): không gọi cổng tồn (kiện của gian hàng chờ kiểm kê không giữ gì); kiện `reserved` có dòng mới là biến thể thì `reclaim`, không xếp lượt (như bảng 1); kiện đã đóng vẫn đánh dấu và bật Cần mở (hộp vẫn chứa món cũ).

**Bảng 3 (PR 2). Cũ là "không quản tồn", mới là biến thể B:**

| Kiện | Việc | Kết quả |
|---|---|---|
| `cancelled`, đã rời kho | Không đổi: hàng đã xuất không trừ tồn theo ghép cũ (`25` §8.1 "kiện đã bàn giao không đổi tồn theo ánh xạ mới") | `kept` |
| `backordered`, `reserved`, `packed`, `awaiting_pickup` | Như bảng 1: ghi dòng; `hold`, xếp lượt, hoặc giữ dòng mới | `applied` |

Kiện đã đóng ở bảng 3 không phải dỡ: dòng "không quản tồn" được nhặt, đóng gói theo SKU người bán (từ a3f8dcd2 kho đếm đủ theo từng dòng qua `pack.untrackedLines`, không theo biến thể app), nên món trong hộp đã là món của SKU sàn. Ghép sang B chỉ bắt đầu giữ, trừ tồn theo B.

**Giữ dòng mới** (kiện `reserved` hoặc đã đóng, dòng vừa có biến thể, `holdStock`):

- Gọi `reserve(pkg.id, [dòng])`. Được: `reserved_qty = quantity`, kiện giữ trạng thái.
- Không được, kiện `reserved`: `release` mọi dòng còn giữ của kiện, kiện về `backordered` qua mũi tên `reclaim` (ghi lịch sử, phát `package_status_changed`), `requestAllocation` cho mọi biến thể của kiện.
- Không được, kiện đã đóng: giữ nguyên trạng thái, dòng chưa giữ; lõi bàn giao (`settleHandover`) sẽ thử giữ lại rồi bàn giao bắt buộc nếu vẫn thiếu. `requestAllocation([biến thể mới])`.
- `holdStock = false`: không gọi `reserve`; kiện `reserved` có dòng chưa giữ thì về `backordered` như trên nhưng không `requestAllocation` (lượt phiếu đầu kỳ `{ all: true }` sẽ giữ).

Mỗi kiện có dòng đổi mà không đổi trạng thái: ghi một dòng lịch sử `remap` (`from = to`, người làm `actorId`, lý do "Ghép SKU <SKU người bán>"), `version` tăng, như `drop_lines` của #205. `remap` không là mũi tên của máy trạng thái. Từ PR 2, kiện đã đóng có ghi (mục trên) cũng ghi một dòng `remap`, lý do "Ghép SKU <SKU người bán>: chờ dỡ kiện" khi đánh dấu, và log `info` "kiện đã đóng chờ dỡ để đổi ghép" kèm `packageId`, `sellerSku`.

### 5.6 Kiện đã đóng khi đổi ghép: Cần mở `remap` (PR 2, viết lại 19/11/2026)

Bản 17/11 dùng Cần xử lý kèm ghi chú `REMAP_UNLOAD_NOTE`. Bỏ, vì sau #238: kiện `awaiting_pickup` chỉ mở được khi có Cần mở (#238 D25), và chỉ Cần mở chặn báo sẵn sàng giao, quét bàn giao (#238 D28). Hộp chứa món theo ghép cũ thì không được đi (`25` §8.1 "Kiện đã đóng thì phải qua Dỡ kiện về kệ trước, vì trong hộp là món cũ đã quét"). Quyết định ở D15 đến D27.

#### Dấu trên dòng

Cột `package_lines.remap_pending` (mục "Dữ liệu và API của PR 2" bên dưới): dòng sống của kiện đã đóng đang chờ áp ghép mới. Chỉ có nghĩa khi kiện còn đóng (`packed`, `awaiting_pickup`): view chỉ trả `true` khi kiện còn đóng. Kiện huỷ hay rời kho thì dấu nằm im, không đường nào đọc. Kiện mang cờ chỉ rời kho được qua đường sàn báo (kho quét bị chặn, #238 D28), mà kiện sàn báo rời kho thì không đảo bàn giao được (409 `handover_confirmed_by_platform`), nên dấu trên kiện đã rời kho không bao giờ được đọc lại (D25). Mở kiện (`open`, `open_cancel`) xoá mọi dấu của kiện trong cùng câu ghi.

#### Bật cờ (bảng 2, dòng kiện đã đóng)

| Kiện đang | Sau khi đánh dấu |
|---|---|
| Không có Cần mở | `needs_open = true`, `open_purpose = 'remap'` |
| Cần mở `stocktake` | Mục đích thành `remap`: mở kiện `remap` cũng xếp lượt phân hàng cho các dòng còn lại như `stocktake` (mục dưới), nên không mất việc của kiểm kê; và lượt phân hàng chỉ tự gỡ `stocktake`, nên cờ không bị gỡ khi hộp còn món cũ |
| Cần mở `cancel`, `edit`, `resplit` | Giữ mục đích: mở vì lý do nào cũng áp lại ghép (D20). Dấu giữ việc đổi ghép nếu mục đích đó bị gỡ trước khi mở (dưới) |

**Thứ tự mục đích** (D17): `cancel` thắng mọi mục đích; `resplit` thắng `edit`, `remap`, `stocktake`; `remap` thắng `stocktake`; `edit` và `stocktake` không thay mục đích đang có (như nay). Sửa hai chỗ: `mark_drop` ở `service/resplit.ts` thêm `remap` vào nhóm được thay bằng `resplit`; `markWholePendingDrop` thêm `remap` vào nhóm được thay bằng `cancel`.

**Gỡ cờ khi kiện còn đóng** (D18): chỗ nào gỡ Cần mở mà kiện vẫn đóng, nếu kiện còn dòng có dấu thì không gỡ mà đổi mục đích sang `remap`. Hiện chỉ một chỗ phải sửa: `takeOverReplaced` gỡ `resplit` khi kiện cũ hết dòng chờ bỏ. Lượt phân hàng chỉ gỡ `stocktake`, mà kiện có dấu đã ở `remap` hay mục đích cao hơn, nên không phải sửa. Viết luật thành một hàm thuần ở `domain/` để các chỗ gỡ sau này dùng lại. Ngược lại, gỡ `remap` khi hết dấu (đổi ghép về như cũ) không gỡ thẳng mà chuyển sang `stocktake` (bảng 2, D24).

**Kiện có cờ thì** (đều có sẵn từ #238, không sửa): vào tab `needs_open`; `ready` 409 `awaiting_open`; quét bàn giao `failed[].code = 'awaiting_open'`; `open` nhận cả `awaiting_pickup` (giữ vận đơn, không `repack`); `report-lost`, `confirm-lost` (`lose_on_unload`) dùng được; lượt phân hàng không lấy kiện làm ứng viên (không giữ B cho hộp còn món A).

**Sàn báo rời kho khi còn cờ** (D19): `openFlagRules` gỡ cờ như nay và thêm `remap` vào nhóm bật Cần xử lý `LEFT_WHILE_AWAITING_OPEN_NOTE` (hộp đi với món mà app nay coi là sai, cần người xem). Lõi bàn giao trừ theo A; dòng đơn, dòng kiện giữ A (`25` §8.1 "kiện đã bàn giao không đổi tồn theo ánh xạ mới"); lệch thì phiếu kiểm kê.

#### Mở kiện áp lại ghép (D20, thay D13)

Mọi lần `open` (không phải `open_cancel`) kiện của đơn sàn, có cờ hay không, mục đích nào cũng vậy: so dòng sống với ghép hiện hành và áp phần lệch. Không dựa vào dấu hay cờ, nên kiện đóng trước PR 2 mà ghép đã đổi (PR 1 trả `kept`) cũng được áp.

- **Ghép hiện hành**: `ctx.skuMappingOf(shopId, sellerSkus)` (channel tiêm ở `src/wiring.ts`, bọc `variantsBySellerSku`, dòng thắng D12, chạy trong `withCompany` và giao dịch của bên gọi); `external_sku` đọc bằng join `order_lines` (cùng schema). SKU mà ghép hiện hành là `unmapped` (listing đã gỡ, hay chỉ chờ duyệt) thì bỏ qua dòng đó, không gỡ ghép. Thiếu `ctx.skuMappingOf` (test không tiêm) thì bỏ cả bước.
- **Bước kiểm** (giao dịch đầu, như nay): đọc ghép hiện hành; dòng lệch không vào phần "giữ lại dòng chưa giữ đủ". Không thì kiện chưa giữ A (lập lúc còn dòng chưa ghép, P2) mà A hết hàng sẽ 422 `insufficient_stock` mãi, dù dòng sắp sang B.
- **Bước ghi**, thứ tự khoá: gian hàng `FOR SHARE` (`ctx.stockHoldOf(..., { lock: true })`, đồng thời cho `holdStock`) → đọc lại ghép hiện hành → khoá dòng đơn của các dòng kiện theo id (sales, qua `ctx`; id dòng đơn đọc từ dòng kiện không khoá, dòng kiện đổi thì `version` của kiện đổi) → khoá phân hàng (`takeAllocationLock`, cho mọi kiện đơn sàn, không chỉ `resplit`; D21) → khoá kiện → kiểm `version` như nay. Dòng đơn phải khoá **trước** khoá phân hàng: lượt nhận đơn (đơn → khoá phân hàng → kiện, #238) và `applySkuMapping` (dòng đơn → khoá phân hàng → kiện, P4) cùng thứ tự đó; mở kiện mà lấy khoá phân hàng trước rồi mới khoá dòng đơn thì có thể khoá chéo với lượt nhận đơn, vì cả hai chỉ giữ gian hàng `FOR SHARE`. Khớp thứ tự gian hàng → khoá phân hàng → kiện của spec 199b §5.10. Giao dịch ghép của channel khoá gian hàng `FOR UPDATE`, nên đổi ghép và bước ghi của mở kiện nối nhau, không chen. Đổi ghép xảy ra giữa bước kiểm và bước ghi mà làm đổi tập dòng lệch của kiện (đánh dấu dòng mới, xoá dấu) thì `version` của kiện đã tăng (bảng 2), bước ghi trả 409 `version_conflict` như mọi lần sửa đua; không đổi tập dòng có dấu (vd A → B rồi → C, hay dòng lệch từ trước PR 2 không mang dấu mà ghép đổi về khớp) thì bước ghi đọc lại ghép, áp ghép mới nhất, và giữ bù dòng mà bước kiểm đã bỏ qua (gạch "Áp" dưới).
- **Áp**: sau các việc mở hiện có (mũi tên `open`, bỏ dòng chờ bỏ, gỡ cờ), chạy luật đổi ghép **chỉ trên kiện vừa mở**, kiện đã ở `reserved`: bảng 2 dòng `reserved`, bảng 3, và bảng 1 cho dòng còn chưa ghép mà nay đã có ghép. Sau khi áp, dòng sống có biến thể nào còn chưa giữ đủ (dòng vừa đổi, và dòng bước kiểm đã bỏ qua vì lệch mà ghép đã đổi về khớp giữa hai bước, không làm tăng `version`) thì giữ như "giữ dòng mới"; không giữ được thì kiện về `backordered` (D5), mở vẫn thành công, không 422. Dòng đơn tương ứng ghi theo kết quả (mục 5.4 bước 3) qua một hàm sales tiêm bằng `withContext` ở `order/index.ts` (fulfillment không import sales).
- **Cờ và dấu**: cùng câu ghi mở, gỡ cờ khi mục đích là `remap` (thêm vào nhóm `stocktake`, `resplit`, có dòng chờ bỏ) và xoá mọi dấu của kiện.
- **Xếp lượt phân hàng**: mục đích `remap` cộng biến thể của các dòng còn lại như `stocktake`, `resplit`, cộng các biến thể vừa nhả khi áp.
- **Lịch sử, log**: lần áp ghi một dòng `remap` (lý do "Mở kiện: áp ghép SKU <các SKU người bán>") sau dòng `open`; log `info` "mở kiện áp lại ghép SKU" kèm `packageId`, số dòng đổi.
- `repack` của sàn đi như mở thường: đổi ghép không đổi món trên sàn.

#### Dữ liệu và API của PR 2

Một migration `*_doi-ghep-da-dung`, sinh ở bước cuối (`npm run db:generate -- --name doi-ghep-da-dung`):

| Thay đổi | Ghi chú |
|---|---|
| `ALTER TYPE "order"."open_purpose" ADD VALUE 'remap'` | Không CHECK, không câu nào trong lượt migration dùng `'remap'`. Không lùi được (PostgreSQL không có `DROP VALUE`); lùi code thì giá trị thừa vô hại, kiện đang mang nó phải gỡ tay như `stocktake` |
| `order.package_lines.remap_pending boolean not null default false` | Mặc định hằng: không viết lại bảng |
| CHECK `package_lines_remap_pending`: `not remap_pending or variant_id is not null or stock_untracked` | Chỉ dòng đã ghép mới chờ đổi ghép (dòng chưa ghép đi bảng 1). Không dùng giá trị enum mới |

API (`Documents/21` §19.2), không route mới, không mã lỗi mới:

- `Package.openPurpose` thêm `remap` ("Đổi ghép SKU: dỡ kiện, mở ra là áp ghép mới").
- `Package.lines[]` thêm `remapPending: boolean` (true chỉ khi kiện còn đóng, cho kho biết món nào phải đổi). `lines[].untracked` đã có trên `main` (a3f8dcd2, 19/11/2026, cùng `id`, `externalSku`), không làm ở PR 2 (D22).
- Thao tác `open`: mở kiện đơn sàn áp ghép hiện hành; dòng mới không giữ được thì kiện về `backordered`.
- `listings/match`, `mapping/:action` (§18.3): đổi ghép đã có đơn áp lên dòng đã ghép của đơn còn mở theo bảng 2, 3; bỏ câu "dòng đã ghép giữ ghép cũ, đổi ghép áp cho đơn kéo về sau" mà PR 1 ghi.

### 5.7 Đơn về sau

`PlatformOrder.lines[]` thêm `untracked: boolean`. Ingest ghi `stock_untracked` lên dòng đơn; `syncPlatformPackages` nhận và ghi lên dòng kiện lúc lập. Kéo lại đơn đã có: dòng đơn không đổi biến thể và `stock_untracked` (như hiện nay với `variant_id`); việc đó là của `applySkuMapping`. Hiện `ingest.ts` truyền biến thể channel vừa tra xuống `syncPlatformPackages` và dựng cờ sự kiện từ kết quả tra, kể cả cho dòng đơn đã có: sửa để với **dòng đơn đã có**, trạng thái ghép truyền xuống fulfillment (dòng kiện lập mới khi sàn chia lại, gắn mã) và cờ `unmapped_sku` của sự kiện lấy từ **dòng đơn đã lưu**; chỉ dòng đơn mới chèn mới dùng kết quả tra. Không thì dòng đơn giữ A mà dòng kiện mới mang B.

### 5.8 Khoá và đua

- Khoá gian hàng `FOR UPDATE` của giao dịch ghép chặn khoá `FOR SHARE` của lượt kéo đơn và của route bàn giao: trong lúc áp không có đơn mới, không có kiện của gian hàng rời kho. Đơn ingest sau khi giao dịch ghép commit tra ra ghép mới.
- Thứ tự: gian hàng → advisory phân hàng → kiện (id tăng) → dòng tồn. Khớp spec 199b §5.10.
- Lỗi bất kỳ trong lúc áp (kể cả `40P01`): cả giao dịch rollback, listing không đổi, người bấm nhận lỗi và bấm lại.

### 5.9 Chạy bù

Đơn đã về trước khi PR merge mà SKU sàn đã ghép từ trước: không tự áp. Cách bù là bấm ghép lại đúng ghép hiện tại (mục 5.3 nhánh trả sớm vẫn gọi áp). Không viết script di trú: staging là dữ liệu demo.

### 5.10 API và lỗi

- Không route mới, không mã lỗi mới. `listings/match`, `mapping/approve` giữ nguyên thân phản hồi (`ChannelListing`).
- `OrderLine` thêm `untracked: boolean` (mô tả: ghép "không quản tồn", không giữ và không trừ tồn). `variantId: null` kèm `untracked: false` mới là chưa ghép.
- OpenAPI: sửa mô tả hai route channel ("áp lên đơn đã nhận") và schema `OrderLine`.

## 6. Chia PR

| PR | Nội dung | Migration |
|---|---|---|
| **1** (#383, đã merge) | Mục 5.2, 5.3, 5.4, 5.5 bảng 1, 5.7, 5.9, 5.10. Đổi ghép đã dùng (bảng 2, 3) trong PR này trả `kept` cho mọi kiện: đơn đã về giữ ghép cũ như hiện nay | Có |
| **2** | Mục 5.4 (chọn cả dòng đã ghép, luật dòng kiện tính kết quả), 5.5 bảng 2 và 3, 5.6 (Cần mở `remap`, mở kiện áp lại ghép, dữ liệu và API) | Có (`*_doi-ghep-da-dung`) |
| **3** | Báo cáo các lần ghép "không quản tồn" và đổi ghép đã dùng, kèm số món đã xuất theo ghép đó (`25` §8.1, US-DH-05 dòng 2). Thiết kế chi tiết viết thêm vào spec này khi bắt đầu PR 3, sau khi PR 2 merge | Chưa biết |

PR 1 đủ DoD của issue trừ gạch "đổi ánh xạ của dòng đang giữ" và gạch báo cáo. PR 2 xong gạch đổi ánh xạ (US-DH-05 dòng 3); PR 3 xong gạch báo cáo và đóng issue. Mỗi PR cập nhật `CLAUDE.md` của các module đụng tới (`order/sales`, `order/fulfillment`, `channel/channel`; PR 3 thêm `insight/report`).

## 7. Quyết định

Khang chốt: **D1** cách A (mục 4).

Claude đề xuất, Khang xem khi duyệt spec:

- **D2** Phân biệt "không quản tồn" bằng cột `stock_untracked` trên cả dòng đơn và dòng kiện (không join ngược lên listing): đơn cũ không đổi khi listing đổi hay gỡ; luật thuần của fulfillment không cần đọc bảng khác.
- **D3** Ghép lần đầu áp cho dòng chưa ghép ở **mọi** trạng thái đơn, kể cả đơn đã hoàn tất có kiện bàn giao bắt buộc (trừ tồn bù lúc ghép, `25` §8.4 quy tắc 3). Đổi ghép chỉ xét đơn còn mở.
- **D4** (sửa 19/11/2026) Kiện đã đóng khi đổi ghép: không đổi cả dòng đơn lẫn dòng kiện, chỉ đánh dấu dòng và bật Cần mở `remap` (D15); ghép mới áp khi mở kiện. Lý do: không để dòng đơn và dòng kiện lệch biến thể trong lúc chờ, và kiện bị bàn giao luôn thì vẫn nhất quán.
- **D5** Dòng mới không giữ được trên kiện `reserved`: nhả cả kiện về `backordered` (giữ luật "nguyên kiện" của phân hàng), không để kiện `reserved` giữ thiếu.
- **D6** Bấm ghép lại đúng ghép hiện tại là đường chạy bù; không script di trú.
- **D7** Lịch sử kiện ghi hành động `remap` (`from = to`), không thêm mũi tên máy trạng thái.
- **D8** Gian hàng chờ kiểm kê đầu kỳ: chỉ ghi biến thể, không giữ, không trừ.
- **D9** Chia hai PR như mục 6.
- **D10** Kiện không còn gì để giữ vào `reserved` không qua cổng tồn (mục 5.2).
- **D11** (Khang chốt 19/11/2026: giữ như PR 1 đã làm) Ghép muộn trên kiện rời kho trước `order_cutoff_at` của gian hàng thì không trừ. Kiện rời kho trước một phiếu kiểm kê **thường** (#208) vẫn trừ theo `25` §8.4 quy tắc 3: nếu phiếu đó đã điều chỉnh mất món này thì tồn bị trừ hai lần, sửa bằng phiếu kiểm kê sau (ghi ở mục 10). Lý do không chặn: không có mốc kiểm kê theo SKU ở fulfillment, và `25` không nêu ngoại lệ.
- **D12** `to` lấy theo dòng listing thắng của SKU người bán, không theo dòng vừa bấm (mục 5.3).
- **D13** (thay bằng D20 ngày 19/11/2026) Mở kiện luôn so ghép hiện hành, không dựa vào ghi chú.
- **D14** Kéo lại đơn dùng ghép đã lưu trên dòng đơn cho dòng kiện lập mới (mục 5.7).

Phần PR 2, Claude đề xuất ngày 19/11/2026 theo hướng Cần mở (người duyệt spec xem):

- **D15** Kiện đã đóng chờ đổi ghép dùng cờ Cần mở với mục đích mới `remap`, không dùng Cần xử lý kèm ghi chú như bản 17/11. Lý do: sau #238, kiện `awaiting_pickup` chỉ mở được khi có Cần mở (#238 D25), và chỉ Cần mở chặn báo sẵn sàng giao, quét bàn giao (#238 D28); hộp chứa món theo ghép cũ không được đi. Giá: một migration thêm giá trị enum (bản 17/11 ghi PR 2 không có migration).
- **D16** Dấu `remap_pending` theo dòng kiện. Một kiện chỉ mang một mục đích mở; dấu giữ việc đổi ghép khi mục đích khác bị gỡ mà kiện chưa mở (D18), cho biết khi nào gỡ được cờ lúc đổi ghép về như cũ (20b, 20c), và cho kho biết món nào phải đổi. Cách khác đã xét: chỉ xếp hạng mục đích, không dấu. Không đủ: gỡ `resplit` ở `takeOverReplaced` làm mất việc đổi ghép, và lúc đổi ghép về như cũ không biết kiện còn dòng nào lệch nếu không đọc ghép của mọi SKU trong kiện.
- **D17** Thứ tự mục đích: `cancel` > `resplit` > `remap` > `stocktake`; `edit` không thay mục đích đang có và không bị `remap` thay (mục 5.6). `remap` thắng `stocktake` để lượt phân hàng (chỉ tự gỡ `stocktake`) không gỡ cờ khi hộp còn món cũ.
- **D18** Gỡ Cần mở khi kiện còn đóng mà kiện còn dòng có dấu: đổi mục đích sang `remap`, không gỡ.
- **D19** Sàn báo rời kho khi kiện còn `remap`: bật Cần xử lý như `cancel`, `edit`, `resplit` (hộp đi với món mà app nay coi là sai), không gỡ im như `stocktake`.
- **D20** (thay D13) Mọi lần mở kiện đơn sàn (trừ `open_cancel`) so dòng sống với ghép hiện hành và áp phần lệch, chỉ trên kiện vừa mở. Dòng lệch không vào phần giữ lại của bước kiểm. Dòng mới không giữ được thì kiện về `backordered`, mở vẫn thành công.
- **D21** Bước ghi của mở kiện đơn sàn luôn khoá theo thứ tự gian hàng `FOR SHARE` → dòng đơn → khoá phân hàng → kiện (trước đây chỉ `resplit` lấy khoá phân hàng, không khoá gian hàng, dòng đơn): luật đổi ghép cần khoá phân hàng trước khoá kiện, ghi dòng đơn cần khoá dòng đơn trước khoá phân hàng như lượt nhận đơn. Giá: mở kiện chờ lượt phân hàng đang chạy của công ty.
- **D22** (bỏ 19/11/2026) `Package.lines[].untracked` đã lên `main` ở a3f8dcd2 (Thành, sửa lỗi test đêm 18/11), PR 2 chỉ thêm `remapPending`.
- **D23** Báo cáo (`25` §8.1, US-DH-05 dòng 2) là PR 3 của #237, không tách sang issue của `insight` (chốt 19/11/2026).

Thêm sau khi soát spec (builder check, 19/11/2026):

- **D24** Kiện mục đích `remap` hết dấu (đổi ghép về như cũ) chuyển sang `stocktake` và xếp lượt phân hàng, không gỡ thẳng. Lượt phân hàng đã có đủ luật khi nào được gỡ (`stocktakeAutoClearable`: tồn đủ, không dòng chờ bỏ, không báo thất lạc chờ xác nhận; kiện chưa giữ thì giữ được mới gỡ), nên không mất việc kiểm kê mà `remap` đã thay, không thả hộp còn món đã huỷ, không xoá báo thất lạc. Giá: nhãn "kiểm kê" hiện một lúc tới khi lượt phân hàng chạy; kiện chưa giữ (P2) mà tồn thiếu thì cờ còn, chặn báo sẵn sàng giao tới khi có hàng hay kho mở.
- **D25** Không bật lại cờ khi đảo bàn giao. Kiện mang cờ chỉ rời kho qua đường sàn báo (#238 D28 chặn kho quét), và kiện sàn báo rời kho không đảo được, nên kiện từng mang `remap` không bao giờ về lại kho qua đảo bàn giao. Ca còn lại (kho quét trước, đổi ghép sau, rồi CEO đảo) ghi ở mục 10.
- **D26** Dòng chờ thay của kiện thay (#238) giữ ghép cũ (`kept`) tới khi hết chờ; kiện chờ thay không `hold` trong lúc áp (gồm cả bảng 1 của PR 1: dòng chờ thay sang "không quản tồn" từng có thể đưa kiện thay vào `reserved` khi còn chờ). Đường chuyển phần giữ của #238 (`moveReservations`, `holdOrderReplacements`) so theo dòng đơn và biến thể cũ; đổi biến thể của dòng chờ thay làm hai đường đó giữ sai.
- **D27** Chọn dòng đơn để áp (mục 5.4) gồm cả dòng đơn có dòng kiện mang dấu, kể cả khi dòng đơn đã bằng `to`.

## 8. Documents cần sửa (PR riêng ở repo Documents, trước hoặc cùng PR của backend)

**PR 1** (đã làm ở Documents#142):

- `21` §18.3 hai dòng `listings/match`, `mapping/:action`: bỏ câu "tới lúc đó đơn đã nhận giữ biến thể cũ"; ghi luật áp lên đơn đã nhận (mục 5.5).
- `21` §19.1 `OrderLine`: thêm `untracked`; định nghĩa lại cờ `unmapped_sku`.
- `19`: hai cột `stock_untracked` và hai CHECK.
- `27` US-DH-05 và `kiem-thu/ca-theo-so-do.md`: cấp mã ca cho ba dòng AC (hiện "(chưa có ca)"); test của PR mang mã đó.
- Issue #237: sửa gạch "Route ghép từ dòng đơn" theo D1; bỏ dòng tham chiếu `finance/service/boundary.ts:41`.

**PR 2:**

- `21` §19.2 `Package`: `openPurpose` thêm `remap`; `lines[]` thêm `remapPending` (`untracked` đã có từ a3f8dcd2). Dòng `open` của bảng thao tác: mở kiện đơn sàn áp ghép hiện hành, dòng mới không giữ được thì kiện về `backordered`. Mục Cần mở: thứ tự mục đích (D17), sàn báo rời kho khi còn `remap` (D19).
- `21` §18.3 `listings/match`, `mapping/:action`: đổi ghép đã có đơn áp lên dòng đã ghép của đơn còn mở theo bảng 2, 3; bỏ câu "dòng đã ghép giữ ghép cũ, đổi ghép áp cho đơn kéo về sau".
- `19`: giá trị `remap` của enum `open_purpose`, cột `package_lines.remap_pending`, CHECK `package_lines_remap_pending`.
- `26` §3.2: ca `D2-G10` trở đi cho bảng PR 2 ở mục 9 (bỏ câu "Đổi ghép đã dùng … là PR 2, chưa có ca"); `27` US-DH-05 dòng 3 ghi mã ca; US-DH-15 thêm "đổi ghép SKU" vào các lý do mở kiện.
- FE#359 (đã mở 19/11/2026): nhãn mục đích `remap`, hiện `remapPending` trên trang kiện, bỏ `REMAP_UNLOAD_NOTE`.
- Issue #237: tick các gạch PR 1 đã xong, sửa mục "Đối chiếu code (02/11/2026)", ghi PR 3 cho gạch báo cáo.

## 9. Tiêu chí chấp nhận và test

Đọc `test/CLAUDE.md` trước khi viết. Unit: `test/unit/modules/order/fulfillment/domain/remap.test.ts` (`planRemap` đủ ba bảng). Integration (PostgreSQL thật, cổng tồn thật trừ khi ghi khác): `test/integration/order/fulfillment/remap.test.ts`, `test/integration/channel/channel/listing-match-orders.test.ts`.

**PR 1**

| # | Cho | Khi | Thì |
|---|---|---|---|
| 1 | Hai đơn của một gian hàng có dòng chưa ghép cùng SKU sàn, kiện `backordered`, đủ tồn | Sale ghép với biến thể (200) | Cả hai dòng đơn và dòng kiện có biến thể; cờ `unmapped_sku` tắt; có việc `fulfillment.allocation`; chạy việc thì kiện `reserved` |
| 2 | Như 1 nhưng đơn thuộc gian hàng khác cùng SKU người bán | Ghép ở gian hàng thứ nhất | Đơn gian hàng khác không đổi |
| 3 | Kiện bàn giao bắt buộc (`in_transit`, `forced`) có dòng chưa ghép | Ghép | Một phiếu `XK` mới chỉ gồm dòng đó; `stock_deducted`, `unit_cost` = bình quân lúc ghép; ghép lại lần nữa không thêm phiếu |
| 4 | Kiện `delivered`, `delivery_posted_at` null, còn dòng chưa ghép và một dòng khác đã trừ | Ghép dòng cuối | Trừ tồn rồi phát `package_delivered` đúng một lần, dòng mang `unitCost` thật |
| 5 | Kiện `delivered` đã phát `package_delivered` trước khi ghép | Ghép | Trừ tồn; không phát `package_delivered` lần hai |
| 6 | Kiện `returned` có dòng chưa ghép | Ghép | Dòng có biến thể, không phiếu `XK`, tồn không đổi |
| 7 | Kiện `before_cutoff` | Ghép | Dòng có biến thể, không trừ |
| 8 | Gian hàng chờ kiểm kê đầu kỳ, kiện `backordered` và kiện `in_transit` | Ghép | Dòng có biến thể; không `reserve`, không `ship`; sau `settleDeferredHandovers` kiện `in_transit` được trừ |
| 9 | Sale ghép sang "không quản tồn" | 202 | Đơn không đổi; cờ còn |
| 10 | CEO duyệt ghép chờ ở 9 | `mapping/approve` | Dòng đơn, dòng kiện `stock_untracked`; cờ tắt; không `reserve`, không `ship`; kiện `backordered` chỉ còn dòng đã ghép khác thì vào lượt phân hàng |
| 11 | Listing "không quản tồn" đã duyệt | Đơn mới về có SKU đó | Dòng `stock_untracked`, không cờ; kiện giữ hàng cho các dòng còn lại; `package_delivered` mang `variantId: null`, `unitCost: null` cho dòng đó |
| 12 | SKU sàn chỉ có ghép chờ "không quản tồn" chưa duyệt | Đơn mới về | Dòng chưa ghép, có cờ |
| 13 | Ghép đã đúng, đơn cũ còn dòng chưa ghép (dữ liệu trước PR) | Bấm ghép lại cùng biến thể | Đơn cũ được áp; bấm lần ba không ghi gì |
| 14 | Cổng tồn ném lỗi giữa lúc áp | Ghép | Rollback: listing và đơn không đổi |
| 15 | `GET /sales/orders/:id` | | `lines[].untracked` đúng; `flags` không có `unmapped_sku` khi mọi dòng trống biến thể đều `untracked` |
| 16 | Đổi ghép A → B đã có đơn (CEO) | Ghép | Đơn đã về giữ A (PR 1); đơn về sau theo B |
| 16a | Đơn một món, kiện `backordered`, dòng chưa ghép | CEO ghép "không quản tồn" | Kiện sang `reserved` (lịch sử `hold`), không gọi cổng tồn; đóng gói được |
| 16b | Listing "không quản tồn" đã duyệt | Đơn mới về chỉ có SKU đó, kể cả gian hàng chờ kiểm kê | Kiện lập ra ở `reserved` |
| 16c | Kiện `in_transit` rời kho trước `order_cutoff_at`, chưa mang `before_cutoff`, dòng chưa ghép | Ghép | Dòng có biến thể, không phiếu `XK` |
| 16d | Đơn đã về giữ A (ở 16), sàn gắn mã kiện mới làm app lập kiện mới | Kéo lại đơn | Dòng kiện mới mang A; cờ sự kiện theo dòng đơn đã lưu |
| 16e | Hai listing chưa gỡ trùng SKU người bán, ghép khác nhau | Ghép lại dòng không thắng | Đơn đã về theo ghép của dòng thắng, không đổi |

**PR 2** (viết lại 19/11/2026). "Đổi ghép" là CEO đổi ghép đã có đơn (tự duyệt, hoặc duyệt ghép chờ), qua `listings/match` hay `mapping/approve`. Unit: `planRemap` đủ bảng 2, 3 và luật mục đích, gỡ cờ (D17, D18) ở `test/unit/modules/order/fulfillment/domain/`. Integration: mở rộng `remap.test.ts` (17 đến 19e, 20b, 20c, 21 đến 24a), file mới cho mở kiện áp lại ghép (20 đến 20e, 26), `listing-match-orders.test.ts` cho 17, 19 và 25 qua API; 19c, 19d đặt cạnh test chia lại kiện của #238. 20e dựng đua bằng `raceBehindLock` (`test/CLAUDE.md`).

| # | Cho | Khi | Thì |
|---|---|---|---|
| 17 | Kiện `reserved` giữ A; B đủ tồn | Đổi ghép A → B (200) | `release` A, `reserve` B, kiện vẫn `reserved`; dòng đơn, dòng kiện là B; có việc phân hàng gồm A; lịch sử `remap` |
| 18 | Như 17, B không đủ | Đổi ghép | Mọi dòng của kiện nhả; kiện `backordered` (lịch sử `reclaim`); dòng là B; việc phân hàng gồm A, B |
| 18a | Kiện `backordered` giữ một phần A (dòng không chờ thay) | Đổi ghép | Nhả phần đang giữ; dòng là B; xếp lượt |
| 18b | Kiện thay `backordered` có dòng chờ thay A (dòng chờ bỏ A ở kiện cũ `packed`) | Đổi ghép, rồi kiện thay được lấy | Dòng chờ thay giữ A (`kept`), kiện thay không sang `reserved`; khi được lấy, phần giữ A chuyển sang đúng dòng A |
| 19 | Kiện `packed` giữ A | Đổi ghép | Dòng đơn, dòng kiện vẫn A; dòng có `remap_pending`; kiện `needs_open`, `openPurpose = remap`, `version` tăng, lịch sử `remap`; `needsUnload = 1`; `ready` 409 `awaiting_open`; quét bàn giao `awaiting_open`; lượt phân hàng không lấy kiện |
| 19a | Kiện `awaiting_pickup` giữ A | Đổi ghép, rồi kho mở kiện | Như 19; mở được, giữ vận đơn, không gọi `repack`; dòng thành B |
| 19b | Kiện `packed` đang Cần mở `stocktake` | Đổi ghép, rồi lượt phân hàng chạy khi tồn đủ | Mục đích thành `remap`; lượt phân hàng không gỡ cờ |
| 19c | Kiện `packed` đang Cần mở `resplit`, có dòng A sống | Đổi ghép, rồi kiện thay được lấy (kiện cũ hết dòng chờ bỏ) | Mục đích giữ `resplit`, dòng có dấu; sau khi kiện thay được lấy: cờ thành `remap`, không gỡ |
| 19d | Kiện mang `remap` | Sàn chia lại kiện; hoặc sàn huỷ cả kiện | Mục đích thành `resplit`; hoặc `cancel` (mở ra là `open_cancel`, dấu xoá) |
| 19e | Kiện ở 19 | Bấm đổi ghép lại cùng B | Không ghi, không lịch sử mới, `version` giữ; `needsUnload = 1` |
| 19f | Kiện ở 19, sau đó sàn huỷ một món khác của kiện (dòng chờ bỏ, mục đích giữ `remap`) | CEO đổi ghép về A | Dấu xoá; mục đích thành `stocktake`; lượt phân hàng không gỡ cờ (còn dòng chờ bỏ) |
| 20 | Kiện ở 19 | Kho mở kiện | Kiện `reserved`; dòng đơn, dòng kiện B (giữ B như 17, thiếu thì như 18); cờ gỡ, dấu xoá; lịch sử `open` rồi `remap` |
| 20a | Kiện `packed` giữ A, ghép đã sang B trước PR 2 (không dấu, không cờ) | Kho mở kiện vì lý do khác (vd `edit`) | Dòng sống thành B; dòng chờ bỏ bỏ ra như nay |
| 20b | Kiện ở 19 (đang giữ A, tồn A đủ) | CEO đổi ghép về lại A | Dấu xoá, mục đích thành `stocktake`, có việc phân hàng; chạy việc thì cờ gỡ; dòng giữ A, lịch sử `remap` |
| 20c | Kiện `packed` có hai dòng của hai SKU sàn cùng chờ đổi | Đổi một SKU về như cũ | Dấu dòng đó xoá; cờ `remap` còn |
| 20f | Kiện ở 19 có báo thất lạc chờ xác nhận | CEO đổi ghép về A, rồi lượt phân hàng chạy | Mục đích `stocktake`, cờ và báo cáo còn |
| 20d | Kiện `packed` chưa giữ A (lập lúc còn dòng chưa ghép, P2), A hết hàng, ghép đã sang B | Kho mở kiện | Không 422; dòng thành B; B đủ thì `reserved`, thiếu thì `backordered` |
| 20e | Kiện ở 19 | Mở kiện và đổi ghép cùng lúc | Hoặc đổi ghép thấy kiện đã `reserved` (bảng 2), hoặc mở áp ghép mới, hoặc mở trả 409 `version_conflict`; không kiện nào ở `reserved` mang A khi ghép là B |
| 21 | Kiện ở 19 | Sàn báo rời kho | Trừ theo A (một phiếu `XK`); dòng giữ A; cờ Cần mở gỡ; Cần xử lý `LEFT_WHILE_AWAITING_OPEN_NOTE` |
| 22 | Kiện `in_transit` đã trừ A | Đổi ghép | Không đổi gì, không phiếu; dòng đơn giữ A |
| 22a | Đơn có kiện `cancelled` mang A và kiện `reserved` mang A cho cùng dòng đơn | Đổi ghép | Dòng đơn thành B (kiện huỷ không chặn); dòng của kiện huỷ giữ A |
| 22b | Đơn `completed`, `cancelled` có dòng A | Đổi ghép | Không đổi |
| 23 | Kiện `reserved` giữ A | CEO ghép sang "không quản tồn" | `release` A; dòng `stock_untracked`; kiện vẫn `reserved` |
| 24 | Dòng `stock_untracked` ở kiện `backordered` | CEO ghép sang biến thể | Dòng có biến thể; xếp lượt |
| 24a | Dòng `stock_untracked` ở kiện `packed` | CEO ghép sang biến thể | Dòng có biến thể, không Cần mở; giữ B, thiếu B thì kiện giữ nguyên và xếp lượt |
| 25 | Cổng tồn ném lỗi giữa lúc đổi ghép | Đổi ghép | 500; listing, dòng đơn, dòng kiện, cờ không đổi |
| 26 | Kiện ở 19 | `GET /fulfillment/packages/:id` | `openPurpose = remap`; `lines[].remapPending` đúng; `lines[].untracked` đúng |

## 10. Giới hạn đã biết

- Giao dịch ghép giữ khoá gian hàng suốt lúc xử lý kiện: SKU có rất nhiều đơn đã về thì lượt kéo đơn của gian hàng chờ. Số đơn của đồ án nhỏ; không chia lô.
- Câu tìm dòng đơn theo `(shop, external_sku)` chưa có index riêng (join `orders.shop_id`); thêm index khi đo thấy chậm.
- Kiện bàn giao bắt buộc rời kho trước một phiếu kiểm kê thường, ghép sau phiếu đó: trừ tồn lần nữa (D11); sửa bằng phiếu kiểm kê.
- Kiện đã đóng có dòng vừa ghép mà không giữ được: tới bàn giao mới bàn giao bắt buộc (tồn có thể âm), không báo sớm.
- Kiện `returned`, yêu cầu trả có dòng ghép muộn: phiếu `KT`, phần bán lại không cộng bù.
- Kiện đã phát `package_delivered` trước khi ghép: giá vốn dòng đó không tới finance.
- Báo cáo xuất hàng "không quản tồn" và đổi ghép đã dùng: PR 3.
- Ghép lại listing đã gỡ, đẩy sản phẩm mới trùng SKU người bán: không gọi áp (chỉ `match` và `approve` gọi).

PR 2:

- Sàn chia lại kiện đang chờ `remap`: dòng của kiện thay lập mới lấy ghép đã lưu trên dòng đơn, vẫn A (D14, dòng đơn chưa đổi vì D4). Kiện thay chưa đóng nên bấm ghép lại (D6) áp B cho nó; không tự áp.
- Kho quét bàn giao kiện (sàn chưa xác nhận lấy), rồi CEO đổi ghép (kiện đã rời kho: `kept`, không dấu), rồi CEO đảo bàn giao: kiện về `awaiting_pickup` với món A, không cờ, nên báo sẵn sàng, quét bàn giao lại được với món theo ghép cũ, và không mở được (kiện `awaiting_pickup` không cờ). Cần ba bước tay trong vài giờ trước khi sàn xác nhận lấy. Cách gỡ: bấm ghép lại (D6), lúc này kiện đã đóng nên được đánh dấu và bật cờ.
- Dòng chờ thay của kiện thay giữ ghép cũ tới khi kiện cũ được mở hay kiện thay được lấy (D26); sau đó bấm ghép lại (D6) áp ghép mới cho kiện thay, không tự áp.
- Kiện chờ `remap` không là ứng viên phân hàng: B chỉ được giữ khi kho mở kiện.
- Bước ghi của mở kiện đơn sàn chờ lượt phân hàng đang chạy của công ty (D21). Mở kiện là thao tác tay, lượt phân hàng ngắn.
- Triển khai cuốn chiếu: lúc bản cũ và bản mới cùng chạy, bản cũ đọc kiện mang `remap` thì schema phản hồi (`openPurpose` không có `remap`) báo lỗi 500. Chỉ trong vài phút đổi bản.
- CHECK `package_lines_remap_pending` thêm thẳng, không `NOT VALID`: cột mới mặc định `false` nên mọi dòng qua; bảng nhỏ ở staging (như PR 1).
- Dòng chờ bỏ của kiện đã đóng không đánh dấu: dòng đó rời kiện khi mở. Nếu sàn bỏ huỷ món (không có đường này hiện nay) thì dòng giữ ghép cũ tới lần mở sau.

## 11. Để người làm tự quyết

- Tên hàm, tên file con, hình dạng chính xác của `planRemap`.
- Cách đọc theo lô để tránh N+1 khi nhiều kiện (một lần `planLinesOf` cho mọi kiện đã khoá).
- `sales.order_status_changed` cho đơn có cờ đổi: dùng lại đúng hàm dựng payload của ingest; nếu schema sự kiện không nhận `from = to` thì bỏ phát và ghi vào giới hạn.
- Có gộp lịch sử `remap` của nhiều dòng trong một kiện thành một dòng hay không (mặc định: một dòng mỗi kiện mỗi lần áp).

PR 2:

- Hình dạng phần đánh dấu, xoá dấu, đổi cờ trong `planRemap` (thêm trường vào `RemapPlan` hay hàm thuần riêng), tên hàm thuần của luật gỡ cờ (D18).
- Tên, chữ ký hàm sales tiêm cho mở kiện (khoá dòng đơn theo id, ghi ghép), và hàm `remapPackageLines` nhận giới hạn "chỉ kiện này" hay tách lõi theo một kiện đã khoá.
- Gộp hay không hai lần đọc ghép hiện hành (bước kiểm, bước ghi) thành một hàm đọc của fulfillment.
- Thứ tự gọi cổng tồn trong một kiện nhiều dòng đổi: nhả hết rồi giữ một lần (mặc định), miễn đúng D5.
