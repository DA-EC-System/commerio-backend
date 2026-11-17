# Spec: Ghép SKU áp lên đơn đã về (#237)

- **Ngày:** 17/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#237 và bình luận 14/11/2026 trên issue, `Documents/25` §7.4, §8.1, §8.4 quy tắc 3, §11, E41, E42, E107; `Documents/21` §11.1, §11.2, §18.3, §18.6.5, §19.1; `Documents/27` US-DH-05
- **Trạng thái:** nháp, chờ Khang duyệt
- **Nền:** `main` cc10cb4 (đã có #220 ghép SKU tay, #206 cổng tồn, #199 a/b/c, #205, #238 PR 1, #239)
- **Nhánh:** `feature/237-ghep-sku-dong-don`

---

## 1. Mục tiêu và tiêu chí thành công

1. Ghép một SKU sàn (từ dòng đơn có cờ Chưa ghép, hay từ trang gian hàng) thì **mọi đơn đã về** của gian hàng mang SKU sàn đó được áp ghép ngay trong cùng giao dịch: dòng đơn và dòng kiện có biến thể, cờ `unmapped_sku` tắt (US-DH-05 dòng 1).
2. Kiện xử lý theo trạng thái lúc ghép: chưa rời kho thì thử giữ hàng; đã rời kho thì trừ tồn bù **đúng một lần**, chốt giá vốn lúc đó (`25` §8.4 quy tắc 3); kiện đã giao đang hoãn báo finance thì báo.
3. Ghép "không quản tồn" (đã duyệt) làm dòng hết cờ Chưa ghép mà không giữ, không trừ tồn; đơn về sau cũng vậy (US-DH-05 dòng 2, E41).
4. Đổi một ghép đã có đơn dùng: dòng đang giữ ở kiện chưa đóng nhả theo SKU cũ, giữ lại theo SKU mới trong một giao dịch; kiện đã đóng bật Cần xử lý "dỡ kiện về kệ"; kiện đã rời kho không đổi (E107, US-DH-05 dòng 3).

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

## 3. Phạm vi

**Trong phạm vi (BE):**

- Áp ghép lên đơn đã về khi ghép có hiệu lực (ghép ngay, CEO tự duyệt, CEO duyệt ghép chờ).
- Cột phân biệt "không quản tồn" trên dòng đơn và dòng kiện; đơn về sau của SKU "không quản tồn" mang cột này.
- Đổi ghép đã dùng: nhả/giữ lại, cờ dỡ kiện, áp lại ghép khi mở kiện.
- `OrderLine` API thêm trường `untracked`.

**Ngoài phạm vi:**

- FE (nút ghép, hộp thoại trên trang chi tiết đơn, E2E): DA-EC-System/FE#129, FE#130. BE không thêm route mới cho FE.
- Báo cáo "xuất hàng không trừ tồn" (`25` §8.1 "hiện trên báo cáo"): hiện chỉ lần CEO tự duyệt hiện ở `GET /report/self-approvals`. Báo cáo riêng là issue của `insight`.
- Việc "Dỡ kiện về kệ" trong khung #209: dùng cờ Cần xử lý kèm ghi chú như spec 199b D9.
- Mở kiện `awaiting_pickup` (#238).
- Phiếu `KT` của kiện đã `returned` có dòng ghép muộn, phần bán lại của yêu cầu trả có dòng ghép muộn (`25` §7 dòng 563, 565): không cộng bù.
- Phát bù `package_delivered` cho kiện đã phát trước khi ghép.

**Không được xảy ra:**

- Một dòng kiện bị trừ tồn hai lần, hoặc đã gán biến thể trên kiện đã rời kho mà không trừ (trừ các ca `before_cutoff`, `returned`, gian hàng chờ kiểm kê).
- Ghép chờ CEO duyệt (202) mà đã đổi đơn.
- Kiện đã rời kho bị đổi biến thể theo ghép mới.
- Đơn về giữa lúc ghép lọt khỏi cả hai đường (không được áp ghép mới lúc ingest, cũng không được áp bù).

## 4. Các cách đã xét

| Cách | Nội dung | Được | Mất |
|---|---|---|---|
| **A (chọn, Khang chốt 17/11/2026)** | Không thêm route. `listings/match` và `mapping/approve` của channel, khi ghép có hiệu lực, gọi một hàm mới của `order` trong cùng giao dịch để áp lên đơn đã về | Một đường ghép; CEO duyệt từ trang gian hàng cũng áp; đúng chiều lớp; khoá gian hàng sẵn có chặn đua với lượt kéo đơn | Giao dịch ghép dài hơn (giữ khoá gian hàng trong lúc xử lý kiện) |
| B | Route `POST /sales/orders/:id/lines/:lineId/match` như issue ghi | Khớp chữ của issue | `order` gọi ngược `channel` qua `ctx`; phải sửa `21`; nhánh CEO duyệt vẫn cần đường của A, thành hai đường vào |
| C | Channel phát sự kiện `channel.sku_mapped`, `order` nghe rồi áp | Giao dịch ghép ngắn | Áp trễ, không cùng giao dịch: đơn về giữa chừng khó chốt; thêm loại sự kiện dùng chung; lỗi áp rơi vào DLQ thay vì báo người bấm |

Issue ghi "Route ghép từ dòng đơn" trong `sales`: theo cách A dòng đó được hiểu là FE gọi route của channel; sửa lại chữ trên issue khi mở PR.

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

1. Đọc dòng đơn của các đơn thuộc `shopId` có `external_sku = sellerSku` mà trạng thái ghép hiện tại khác `to`. Dòng đang có biến thể hoặc `stock_untracked` (tức là đổi ghép) của đơn `completed`, `cancelled` thì bỏ: kiện của chúng đã dừng, không có gì đổi. Dòng **chưa ghép** thì lấy ở mọi trạng thái đơn (cờ phải tắt ở mọi đơn; kiện bàn giao bắt buộc của đơn đã hoàn tất vẫn phải trừ).
2. Gọi `remapPackageLines(changes, { actorId, holdStock, orderCutoffAt })` của fulfillment với `changes = { orderLineId, to }[]`. Nhận về kết quả theo dòng đơn: `applied`, `kept`, `needs_unload`.
3. Ghi dòng đơn có kết quả `applied`, và dòng đơn không có dòng kiện nào: `variant_id`, `stock_untracked`, `sku` (= `external_sku` khi có biến thể, như ingest; null khi không). Dòng `kept`, `needs_unload` giữ nguyên.
4. Đơn `unpaid`, `processing` có cờ `unmapped_sku` vừa đổi: phát `sales.order_status_changed` kèm cờ mới như ingest phát khi cờ đổi (FE tải lại qua SSE).
5. Log `info` một dòng: gian hàng, SKU người bán, số dòng, số đơn, số kiện cần dỡ.

Idempotent: gọi lại khi mọi dòng đã đúng `to` thì bước 1 rỗng, không ghi, không phát.

Dòng đơn mà các dòng kiện của nó ra kết quả khác nhau (chỉ đơn tay, số lượng > 1 nằm ở nhiều kiện; đơn sàn mỗi món một dòng): dòng đơn chỉ đổi khi mọi dòng kiện chưa huỷ của nó `applied`.

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
| Đã rời kho trước `orderCutoffAt` (D11, chờ Khang chốt) | Ghi dòng, **không trừ**: kiện rời kho trước lúc đếm của phiếu đầu kỳ, phiếu đã không đếm món đó. Xảy ra khi kiện rời kho lúc gian hàng chờ kiểm kê mà mọi dòng còn chưa ghép: `lockDeferredPackages` chỉ chọn kiện có dòng đã ghép nên hàm bù chưa đánh `before_cutoff` cho nó | `applied` |
| Đã rời kho, `holdStock = false` | Ghi dòng, không trừ: `settleDeferredHandovers` trừ khi phiếu đầu kỳ ghi sổ | `applied` |
| `returned` | Ghi dòng, không trừ (hàng đã về kệ) | `applied` |

Nhánh `reportDelivered` ở bảng 1 là phòng thủ: kiện giao xong còn dòng **chưa ghép** đã phát `package_delivered` ngay lúc giao với `unitCost: null` (`21` §11.2 D6; `deferred` chỉ tính dòng đã ghép chưa trừ), nên luồng thường rơi vào ca "đã phát, không phát bù". Giữ lời gọi vì bình luận 14/11 trên issue đòi; test dựng trạng thái `delivery_posted_at` null bằng tay.

**Bảng 2. Cũ là biến thể A (đổi ghép):**

| Kiện | Việc | Kết quả |
|---|---|---|
| `cancelled`, đã rời kho, `returned` | Không đổi | `kept` |
| `backordered` | Ghi dòng; `requestAllocation([A, biến thể mới])` | `applied` |
| `reserved` | `release` phần đang giữ của dòng theo A; ghi dòng (`reserved_qty = 0`); mới là biến thể thì **giữ dòng mới**; `requestAllocation([A])` | `applied` |
| `packed`, `awaiting_pickup` | Không đổi dòng. Bật `needs_attention` với `REMAP_UNLOAD_NOTE` = "Đổi ghép SKU: dỡ kiện về kệ để áp ghép mới" (kiện đã có Cần xử lý thì giữ ghi chú cũ). Dòng kiện đã bằng `to` (đổi A → B rồi về A khi kiện còn đóng) mà kiện mang `REMAP_UNLOAD_NOTE` và không còn dòng nào lệch ghép: gỡ cờ | `needs_unload` |

**Bảng 3. Cũ là `untracked`, mới là biến thể:** như bảng 1 cho kiện chưa rời kho (chưa có gì được giữ hay quét theo biến thể); kiện đã rời kho, `returned`, `cancelled` thì `kept` (hàng đã xuất không trừ tồn theo ghép cũ, `25` §8.1 "kiện đã bàn giao không đổi tồn theo ánh xạ mới").

**Giữ dòng mới** (kiện `reserved` hoặc đã đóng, dòng vừa có biến thể, `holdStock`):

- Gọi `reserve(pkg.id, [dòng])`. Được: `reserved_qty = quantity`, kiện giữ trạng thái.
- Không được, kiện `reserved`: `release` mọi dòng còn giữ của kiện, kiện về `backordered` qua mũi tên `reclaim` (ghi lịch sử, phát `package_status_changed`), `requestAllocation` cho mọi biến thể của kiện.
- Không được, kiện đã đóng: giữ nguyên trạng thái, dòng chưa giữ; lõi bàn giao (`settleHandover`) sẽ thử giữ lại rồi bàn giao bắt buộc nếu vẫn thiếu. `requestAllocation([biến thể mới])`.
- `holdStock = false`: không gọi `reserve`; kiện `reserved` có dòng chưa giữ thì về `backordered` như trên nhưng không `requestAllocation` (lượt phiếu đầu kỳ `{ all: true }` sẽ giữ).

Mỗi kiện có dòng đổi mà không đổi trạng thái: ghi một dòng lịch sử `remap` (`from = to`, người làm `actorId`, lý do "Ghép SKU <SKU người bán>"), `version` tăng, như `drop_lines` của #205. `remap` không là mũi tên của máy trạng thái.

### 5.6 Áp lại ghép khi mở kiện (PR 2)

**Mọi** kiện `packed` của đơn sàn được kho mở (`openPackage`, kiện về `reserved`), không chỉ kiện mang `REMAP_UNLOAD_NOTE` (ghi chú Cần xử lý bị các luồng khác ghi đè, không dùng làm dấu): ở bước ghi, sau khi kiện sang `reserved`, đọc ghép hiện hành cho các dòng của kiện qua `ctx.skuMappingOf(shopId, sellerSkus)` (channel tiêm ở `src/wiring.ts`; `external_sku` đọc bằng join `order_lines` cùng schema), rồi chạy lại `remapPackageLines` cho các dòng lệch với trạng thái kiện đã là `reserved` (bảng 2 dòng `reserved`), ghi dòng đơn tương ứng qua một hàm sales tiêm bằng `withContext` ở `order/index.ts`, gỡ cờ nếu ghi chú là `REMAP_UNLOAD_NOTE`. Thiếu `ctx.skuMappingOf` (test không tiêm) thì bỏ qua bước này.

Kiện bị bàn giao khi còn cờ: không đổi gì (dòng giữ biến thể cũ, đã trừ theo biến thể cũ), đúng "kiện đã bàn giao không đổi".

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
| **1** | Mục 5.2, 5.3, 5.4, 5.5 bảng 1, 5.7, 5.9, 5.10. Đổi ghép đã dùng (bảng 2, 3) trong PR này trả `kept` cho mọi kiện: đơn đã về giữ ghép cũ như hiện nay | Có |
| **2** | Bảng 2, bảng 3, mục 5.6 | Không |

PR 1 đủ DoD của issue trừ gạch "đổi ánh xạ của dòng đang giữ". Mỗi PR cập nhật `CLAUDE.md` của `order/sales`, `order/fulfillment`, `channel/channel`.

## 7. Quyết định

Khang chốt: **D1** cách A (mục 4).

Claude đề xuất, Khang xem khi duyệt spec:

- **D2** Phân biệt "không quản tồn" bằng cột `stock_untracked` trên cả dòng đơn và dòng kiện (không join ngược lên listing): đơn cũ không đổi khi listing đổi hay gỡ; luật thuần của fulfillment không cần đọc bảng khác.
- **D3** Ghép lần đầu áp cho dòng chưa ghép ở **mọi** trạng thái đơn, kể cả đơn đã hoàn tất có kiện bàn giao bắt buộc (trừ tồn bù lúc ghép, `25` §8.4 quy tắc 3). Đổi ghép chỉ xét đơn còn mở.
- **D4** Kiện đã đóng khi đổi ghép: không đổi cả dòng đơn lẫn dòng kiện, chỉ bật cờ; ghép mới áp khi mở kiện. Lý do: không để dòng đơn và dòng kiện lệch biến thể trong lúc chờ, và kiện bị bàn giao luôn thì vẫn nhất quán.
- **D5** Dòng mới không giữ được trên kiện `reserved`: nhả cả kiện về `backordered` (giữ luật "nguyên kiện" của phân hàng), không để kiện `reserved` giữ thiếu.
- **D6** Bấm ghép lại đúng ghép hiện tại là đường chạy bù; không script di trú.
- **D7** Lịch sử kiện ghi hành động `remap` (`from = to`), không thêm mũi tên máy trạng thái.
- **D8** Gian hàng chờ kiểm kê đầu kỳ: chỉ ghi biến thể, không giữ, không trừ.
- **D9** Chia hai PR như mục 6.
- **D10** Kiện không còn gì để giữ vào `reserved` không qua cổng tồn (mục 5.2).
- **D11 (chờ Khang chốt)** Ghép muộn trên kiện rời kho trước `order_cutoff_at` của gian hàng thì không trừ. Kiện rời kho trước một phiếu kiểm kê **thường** (#208) vẫn trừ theo `25` §8.4 quy tắc 3: nếu phiếu đó đã điều chỉnh mất món này thì tồn bị trừ hai lần, sửa bằng phiếu kiểm kê sau (ghi ở mục 10). Lý do không chặn: không có mốc kiểm kê theo SKU ở fulfillment, và `25` không nêu ngoại lệ.
- **D12** `to` lấy theo dòng listing thắng của SKU người bán, không theo dòng vừa bấm (mục 5.3).
- **D13** Mở kiện luôn so ghép hiện hành, không dựa vào ghi chú (mục 5.6).
- **D14** Kéo lại đơn dùng ghép đã lưu trên dòng đơn cho dòng kiện lập mới (mục 5.7).

## 8. Documents cần sửa (PR riêng ở repo Documents, trước hoặc cùng PR 1)

- `21` §18.3 hai dòng `listings/match`, `mapping/:action`: bỏ câu "tới lúc đó đơn đã nhận giữ biến thể cũ"; ghi luật áp lên đơn đã nhận (mục 5.5).
- `21` §19.1 `OrderLine`: thêm `untracked`; định nghĩa lại cờ `unmapped_sku`.
- `19`: hai cột `stock_untracked` và hai CHECK.
- `27` US-DH-05 và `kiem-thu/ca-theo-so-do.md`: cấp mã ca cho ba dòng AC (hiện "(chưa có ca)"); test của PR mang mã đó.
- Issue #237: sửa gạch "Route ghép từ dòng đơn" theo D1; bỏ dòng tham chiếu `finance/service/boundary.ts:41`.

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

**PR 2**

| # | Cho | Khi | Thì |
|---|---|---|---|
| 17 | Kiện `reserved` giữ A; B đủ tồn | CEO đổi ghép A → B | `release` A, `reserve` B, kiện vẫn `reserved`; dòng đơn và dòng kiện là B; có `requestAllocation([A])` |
| 18 | Như 17, B không đủ | Đổi ghép | Mọi dòng của kiện nhả; kiện `backordered` (lịch sử `reclaim`); dòng là B |
| 19 | Kiện `packed` giữ A | Đổi ghép | Dòng đơn, dòng kiện vẫn A; kiện `needs_attention` với `REMAP_UNLOAD_NOTE`; kết quả `needsUnload = 1` |
| 20 | Kiện ở 19 | Kho mở kiện | Kiện `reserved`; dòng thành B theo 17/18; cờ gỡ |
| 20a | Kiện ở 19 nhưng ghi chú Cần xử lý đã bị luồng khác ghi đè | Kho mở kiện | Dòng vẫn thành B; cờ và ghi chú của luồng kia giữ nguyên |
| 20b | Kiện ở 19 | CEO đổi ghép về lại A | Cờ gỡ, dòng giữ A |
| 21 | Kiện ở 19 bị bàn giao khi còn cờ | Bàn giao | Trừ theo A; dòng giữ A |
| 22 | Kiện `in_transit` đã trừ A | Đổi ghép | Không đổi gì |
| 23 | Kiện `reserved` giữ A | CEO ghép sang "không quản tồn" | `release` A; dòng `stock_untracked`; kiện vẫn `reserved` |
| 24 | Dòng `stock_untracked` ở kiện `backordered` | CEO ghép sang biến thể | Dòng có biến thể; vào lượt phân hàng |

## 10. Giới hạn đã biết

- Giao dịch ghép giữ khoá gian hàng suốt lúc xử lý kiện: SKU có rất nhiều đơn đã về thì lượt kéo đơn của gian hàng chờ. Số đơn của đồ án nhỏ; không chia lô.
- Câu tìm dòng đơn theo `(shop, external_sku)` chưa có index riêng (join `orders.shop_id`); thêm index khi đo thấy chậm.
- Kiện bàn giao bắt buộc rời kho trước một phiếu kiểm kê thường, ghép sau phiếu đó: trừ tồn lần nữa (D11); sửa bằng phiếu kiểm kê.
- Kiện `awaiting_pickup` mang `REMAP_UNLOAD_NOTE` chưa mở được (chờ #238): ghép mới chưa áp tới khi có đường dỡ.
- Kiện đã đóng có dòng vừa ghép mà không giữ được: tới bàn giao mới bàn giao bắt buộc (tồn có thể âm), không báo sớm.
- Kiện `returned`, yêu cầu trả có dòng ghép muộn: phiếu `KT`, phần bán lại không cộng bù.
- Kiện đã phát `package_delivered` trước khi ghép: giá vốn dòng đó không tới finance.
- Chưa có báo cáo riêng cho xuất hàng "không quản tồn".
- Ghép lại listing đã gỡ, đẩy sản phẩm mới trùng SKU người bán: không gọi áp (chỉ `match` và `approve` gọi).

## 11. Để người làm tự quyết

- Tên hàm, tên file con, hình dạng chính xác của `planRemap`.
- Cách đọc theo lô để tránh N+1 khi nhiều kiện (một lần `planLinesOf` cho mọi kiện đã khoá).
- `sales.order_status_changed` cho đơn có cờ đổi: dùng lại đúng hàm dựng payload của ingest; nếu schema sự kiện không nhận `from = to` thì bỏ phát và ghi vào giới hạn.
- Có gộp lịch sử `remap` của nhiều dòng trong một kiện thành một dòng hay không (mặc định: một dòng mỗi kiện mỗi lần áp).
