# Spec: Sự kiện realtime (SSE) cho đơn, kiện, yêu cầu trả, gian hàng (#216)

- **Ngày:** 19/11/2026
- **Người soạn:** Khang (cùng Claude), theo issue commerio-backend#216 và bình luận rà issue 17/11/2026; `Documents/21` §11.2, §13, D11
- **Trạng thái:** Khang duyệt 19/11/2026
- **Nền:** `main` 8d9c7542 (đã có #199, #202, #219, #236, #238 PR 1–2, #240 một phần)
- **Nhánh:** BE `feature/216-su-kien-realtime`; Documents `docs/216-su-kien-realtime` (worktree `D:\DA-TMDT\Documents-216`)
- **Skill đã chạy trước khi viết:** `backend-design` (think-before-coding, idempotency-and-side-effects, query-discipline, error-handling-as-design, observability-by-default, testing-with-discernment), `supabase-postgres-best-practices` (data-batch-inserts, lock-deadlock-prevention), context7 Drizzle 0.45.4 (`returning` nhận biểu thức `sql`; `update().from()` có từ 0.36.3). Kết quả ghi ở mục 5.6, 5.7, 7. Một người đọc độc lập đã rà bản nháp (19/11/2026); sửa theo đó ở mục 2, 5.3, 5.5, 5.6, 7, 9, 10.

---

## 1. Mục tiêu và tiêu chí thành công

1. Màn đơn, kiện, yêu cầu trả, gian hàng và listing trên FE tự làm mới khi trạng thái đổi, dù do sàn (lượt kéo 5 phút), việc nền hay người khác đổi. FE đã viết sẵn phần nghe (`FE/src/hooks/useRealtime.ts`, FE#81): BE chỉ cần phát đúng hợp đồng `21` §13.2.
2. Người xử lý kiện và người xem đơn nhận toast "kiện giao không thành công", "kiện thất lạc".
3. Luật thông báo không còn sự kiện của mô hình cũ (`fulfillment.order_status_changed`, `payment.succeeded`).

Đo bằng: AC ở mục 9 đều qua; `npm run check` xanh; Definition of Done của issue.

**Vì sao:** đơn kéo từ sàn mỗi 5 phút, không dùng webhook (Thành chốt 04/11/2026). Không có SSE thì người dùng phải tải lại trang mới thấy đơn, kiện, yêu cầu trả đổi do sàn.

## 2. Bối cảnh và ràng buộc

**Hiện trạng `main` (8d9c7542):**

| Sự kiện | Khai báo `platform/domain/events.ts` | Đang phát | Luật SSE `notification/domain/rules.ts` |
|---|---|---|---|
| `sales.order_status_changed` | có | có (ingest, cancel, complete, sku-mapping, package-reopened) | chưa |
| `fulfillment.package_status_changed` | có | có (khoảng 12 chỗ ở fulfillment) | chưa |
| `fulfillment.package_delivery_failed` | có | có | chưa |
| `fulfillment.package_lost` | có | có | chưa |
| `sales.return_status_changed` | chưa | chưa | chưa |
| `channel.shop_status_changed` | chưa | chưa | chưa |
| `channel.listing_sync_changed` | chưa | chưa | chưa |
| `fulfillment.order_status_changed` (cũ) | có | không chỗ nào phát | có |
| `payment.succeeded` (cũ) | có | `finance/service/order-receipt.ts:31` | có |

- Consumer `notification-sse` (`notification/service/consumer.ts`) đăng ký theo `NOTIFIED_TYPES = Object.keys(RULES)`, scope `instance`: thêm luật là realtime tự nghe, không sửa consumer.
- Yêu cầu trả: mọi bước của máy trạng thái đi qua `applyReturnStep` (`sales/service/returns.ts:152`): thao tác người dùng (`returns.ts:270`), sàn báo (`return-ingest.ts:185`), kho nhận (`return-receive.ts:79`), đóng sau kiểm hàng hoàn (`return-ingest.ts:214`). Tạo mới ở `return-ingest.ts:134` (`insertReturn`, `onConflictDoNothing`), luôn `requested`. Các `updateReturnAt` khác chỉ đổi cờ Cần xử lý hay trường của sàn, không đổi `status`.
- Gian hàng: `status` chỉ đổi qua `insertShop` và `updateShop`, ở bốn đường, đều đi kèm `recordTransition`: kết nối mới, `reconnect`, `resume_setup` (`channel/service/shops.ts:607–640`); `finish_setup` (`setup.ts:316–334`); `lose_auth` (`shop-tokens.ts:49–51`, việc nền, trong `withCompany`); `disconnect` (`shops.ts:678–705`).
- Listing: mọi câu ghi vào `channel.listings` nằm trong `repository/listings.ts` (`insertListing`, `updateListing`, `markStockPendingIds`, `markStockPendingRows`, `deleteListing`, `markCreateAttempted`, `setListingCategory`) và `repository/shops.ts` (`delistForDisconnect`, `failPushingForDisconnect`, xoá theo gian hàng ở dòng 325). Các hàm này được gọi từ khoảng 25 chỗ trong 9 file service (`listing-sync`, `listing-push`, `listings`, `mapping`, `outside-change`, `pending-prices`, `remote-title`, `setup`, `shops`), có cả câu UPDATE nhiều dòng. Ngoài ra `repository/remote-skus.ts:86`, `:90` (`refreshRemoteTitleFlags`) UPDATE thô các cột tên trên sàn, không đụng `status`, `stock_sync`, `price_sync`.
- `stockPending()` (`repository/listings.ts`) giữ `error` khi listing đang Lệch tồn, các trạng thái khác về `pending`, và luôn tăng `version`.
- Vai trò có sẵn (`core/access/domain/catalog.ts`): CEO có mọi quyền; Admin có `sales.order.view`, `sales.return.view`, `channel.shop.view` (không có `fulfillment.order.process`); Sale như Admin về các quyền này; Nhân viên kho có `sales.return.view`, `fulfillment.order.process` (không có `sales.order.view`, `channel.shop.view`).

**Ràng buộc:**

- **Staging là PostgreSQL 17** (`db/CLAUDE.md`): không dùng tính năng chỉ có ở PG18. CI chạy `pgvector/pgvector:pg18`, nên test xanh trên CI không chứng minh chạy được trên staging; chạy thử PG17 bằng `TEST_PG_IMAGE=pgvector/pgvector:pg17 npx vitest run --project integration`.
- `publishEvent` chỉ chạy trong giao dịch `withCompany` (ném lỗi nếu không), ghi outbox cùng giao dịch nghiệp vụ: giao dịch rollback thì sự kiện mất theo.
- Payload SSE chỉ mang id, `from`/`to` và cờ (`21` §13.2); FE gọi lại `GET`, không dựng màn hình từ payload. `from` là `null` khi bản ghi mới tạo. Đổi tên sự kiện hay trường là đổi hợp đồng: sửa `Documents/21` trước.
- Luồng gọi `api → service → (domain, repository)` (`src/modules/CLAUDE.md`): service phát sự kiện, repository không gọi `publishEvent` (hiện chưa repository nào gọi).
- `src/modules/CLAUDE.md` ghi "thêm loại sự kiện là sửa file dùng chung: PR riêng, báo bên nghe". Ba loại mới chỉ `notification` nghe, nằm cùng PR, nên giữ trong PR BE (D5); mô tả PR ghi rõ.
- Không có migration.

## 3. Phạm vi

**Trong phạm vi:**

- Documents: `21` §13 (bảng §13.2, ghi chú đầu mục, §13.4), D11.
- BE: khai ba schema sự kiện mới; luật SSE cho bảy sự kiện, bỏ hai luật cũ; phát `sales.return_status_changed`, `channel.shop_status_changed`, `channel.listing_sync_changed`; lớp ghi listing (cách A); luật dependency-cruiser cho lớp đó; CLAUDE.md của `notification`, `sales`, `channel`; test.

**Ngoài phạm vi:**

- Bỏ chỗ phát và schema `payment.succeeded`: sau PR này không còn ai nghe, nhưng dọn là việc của finance và các test Kafka dùng nó làm mẫu. Mở issue riêng (D2).
- Xoá schema `fulfillment.order_status_changed` khỏi `events.ts` (D3).
- FE: đã xong ở FE#81.
- Bước thiết lập gian hàng (chờ kiểm kê, chờ phân hàng): không phải `status` của gian hàng, không phát `shop_status_changed`.
- Listing đổi thứ ngoài `status`, `stockSync`, `priceSync` (nội dung lỗi đồng bộ khi vẫn `error`, phát hiện đổi ngoài app trên listing đã ẩn, cờ tên trên sàn): không phát (D11).
- Listing gỡ hay chuyển `push_failed` lúc ngắt gian hàng: không phát (D12).
- Xoá listing, xoá gian hàng: không phát (D9).
- FE gộp lượt làm mới khi nhiều message tới liền (FE hiện làm mới nhóm query mỗi message): ghi gợi ý trong mô tả PR BE, không chặn #216.
- Lưu lịch sử thông báo, phát lại khi mất kết nối (D11 cũ giữ nguyên).

**Không được xảy ra:**

- Trạng thái yêu cầu trả, gian hàng, hay bộ ba (`status`, `stockSync`, `priceSync`) của listing đổi mà không có sự kiện trong cùng giao dịch (trừ listing lúc ngắt gian hàng, D12).
- Sự kiện phát khi không có gì đổi (sàn báo lại cùng trạng thái, kéo lại, `pending` đè lên `error`).
- Message SSE mang trường ngoài hợp đồng, hay tới người không có quyền tương ứng (kể cả quyền của phân hệ đang tắt).
- Đường ghi listing mới về sau gọi thẳng các hàm ghi của repository mà bỏ qua lớp phát sự kiện (luật dependency-cruiser chặn; SQL thô mới ghi bộ ba ở repository khác thì chỉ chặn được bằng review và ghi chú trong `channel/channel/CLAUDE.md`).

## 4. Các cách đã xét (phát `channel.listing_sync_changed`)

Yêu cầu trả và gian hàng chỉ có một cách hợp lý (phát cạnh `recordTransition` ở các chỗ đã kể). Listing có nhiều chỗ ghi nên phải chọn:

| Cách | Nội dung | Được | Mất |
|---|---|---|---|
| **A (chọn, Khang chốt 19/11/2026)** | Lớp service mới `channel/service/listing-writes.ts` bọc mọi hàm ghi listing; mỗi câu ghi trả trạng thái trước và sau; chỉ phát khi bộ ba đổi. Các service đổi import sang lớp này | Đúng chiều lớp; không sót, kể cả UPDATE nhiều dòng; một chỗ để đọc luật phát | Thêm một lớp; sửa import ở 9 file |
| B | Phát ngay trong các hàm repository | Ít sửa nhất | Repository gọi `publishEvent`, lệch luồng `api → service → repository` |
| C | Gọi `publishEvent` tại khoảng 25 chỗ gọi | Rõ ở từng chỗ | Dễ sót; PR sau thêm chỗ ghi mới dễ quên |
| D (loại) | Trigger PostgreSQL ghi thẳng `core.outbox_messages` | Không sót tuyệt đối | Vượt ranh giới schema `channel` → `core`; viết lại định dạng envelope bằng SQL; cần migration |

## 5. Thiết kế

### 5.1 Danh mục sự kiện (`core/platform/domain/events.ts`)

Thêm ba schema, đặt cạnh nhóm của module phát:

```ts
const returnStatus = z.enum(['requested', 'rejected', 'refund_only', 'awaiting_return', 'received', 'closed']);
const shopStatus = z.enum(['connecting', 'active', 'needs_reauth', 'disconnected']);
const listingStatus = z.enum(['pushing', 'push_failed', 'under_review', 'rejected', 'live', 'hidden', 'platform_hold', 'delisted']);
const syncState = z.enum(['synced', 'pending', 'error']);

'sales.return_status_changed': z.object({ returnId: id, orderId: id, from: returnStatus.nullable(), to: returnStatus }),
'channel.shop_status_changed': z.object({ shopId: id, from: shopStatus.nullable(), to: shopStatus }),
'channel.listing_sync_changed': z.object({ shopId: id, listingId: id, stockSync: syncState, priceSync: syncState, status: listingStatus }),
```

Giá trị enum chép đúng `RETURN_STATUSES` (`sales/domain/return.ts`), `shop_status`, `listing_status`, `sync_state` (`channel/channel/repository/schema.ts`). Không import chéo từ module khác vào `platform` (platform ở lớp thấp nhất). Có test so khớp (AC12).

`channel.listing_sync_changed` mang trạng thái **sau khi đổi**, không có `from` (đúng `21` §13.2).

### 5.2 Luật thông báo (`core/notification/domain/rules.ts`)

| Sự kiện | Quyền (có một) | `fields` (đúng các trường này, không hơn) |
|---|---|---|
| `sales.order_status_changed` | `sales.order.view` | `orderId`, `code`, `from`, `to`, `flags` |
| `fulfillment.package_status_changed` | `sales.order.view`, `fulfillment.order.process` | `packageId`, `orderId`, `from`, `to` |
| `fulfillment.package_delivery_failed` | `sales.order.view`, `fulfillment.order.process` (D1) | `packageId`, `orderId`, `reason` |
| `fulfillment.package_lost` | `sales.order.view`, `fulfillment.order.process` (D1) | `packageId`, `orderId`, `claimCode` |
| `sales.return_status_changed` | `sales.return.view` | `returnId`, `orderId`, `from`, `to` |
| `channel.shop_status_changed` | `channel.shop.view` | `shopId`, `from`, `to` |
| `channel.listing_sync_changed` | `channel.shop.view` | `shopId`, `listingId`, `stockSync`, `priceSync`, `status` |

Bỏ luật `fulfillment.order_status_changed` và `payment.succeeded` (bỏ luôn hàm `dong` nếu không còn luật nào dùng tiền: `sales.order_created` vẫn dùng, nên giữ).

Ma trận vai trò có sẵn sau thay đổi:

| | CEO | Admin | Sale | Nhân viên kho |
|---|---|---|---|---|
| đơn (`order_created`, `order_status_changed`) | ✓ | ✓ | ✓ | |
| kiện (`package_status_changed`, `package_delivery_failed`, `package_lost`) | ✓ | ✓ | ✓ | ✓ |
| yêu cầu trả | ✓ | ✓ | ✓ | ✓ |
| gian hàng, listing | ✓ | ✓ | ✓ | |

### 5.3 Yêu cầu trả (`sales`)

- `applyReturnStep`: ngay sau `recordTransition`, phát `sales.return_status_changed` `{ returnId: row.id, orderId: row.orderId, from: row.status, to: step.to }`. Đặt trước khối `return_refunded` để thứ tự trong outbox theo đúng diễn biến. `applyReturnStep` trả `false` khi UPDATE không trúng dòng: không phát.
- `createRequest` (`return-ingest.ts:134`): khi `created` khác `undefined`, phát `{ returnId: created.id, orderId, from: null, to: created.status }`. Trùng (`onConflictDoNothing`) thì không phát. Yêu cầu sàn báo ở trạng thái khác `requested` được tạo ở `requested` rồi `syncExisting` ngay (`return-ingest.ts:76`): ra hai sự kiện trong cùng giao dịch (`null → requested`, `requested → X`), khớp lịch sử trạng thái cũng ghi hai bước. FE chỉ làm mới, hai sự kiện vô hại.
- **Đổi mà trạng thái giữ nguyên** (D8, như đơn phát `from = to` khi chỉ cờ đổi): phát `{ from: row.status, to: row.status }` khi một lần ghi đổi cờ Cần xử lý (`needsAttention`) hoặc trường sàn hiện trên màn (danh sách `shown` của `syncExisting`: `rawMarketplaceStatus`, `ofcStatus`, `disputeInProgress`, `returnTo`, `returnTrackingCode`, `refundAmount`). Bốn chỗ ghi như vậy, đều qua `updateReturnAt`:
  - `syncExisting` nhánh xung đột (`return-ingest.ts:181`): bật Cần xử lý.
  - `syncExisting` nhánh chỉ đổi trường (`return-ingest.ts:194`): phát khi `diff` có khoá trong `shown` hoặc `needsAttention`. Không có thì không phát (vd chỉ `externalUpdatedAt` đổi).
  - `markReturnConfirmed` (`return-confirm.ts:40`): gỡ cờ báo sàn.
  - `return-receive.ts:99`: bật cờ khi báo sàn đã nhận lỗi.

  Chỉ phát khi `updateReturnAt` trúng dòng. Người làm có thể gom bốn chỗ vào một hàm ghi kèm phát.
- `aggregateId` = `orderId`, như `sales.return_refunded`: sự kiện trả và sự kiện đơn của cùng đơn đi cùng partition, giữ thứ tự.

### 5.4 Gian hàng (`channel`)

- Hàm mới trong service channel (vd `service/shop-transition.ts`, tên do người làm chọn): `recordShopTransition({ shopId, from, to, action, actorId, reason? })` gọi `recordTransition({ entityType: 'shops', ... })` rồi `publishEvent('channel.shop_status_changed', { shopId, from, to })`, `aggregateId` = `shopId`.
- Thay bốn chỗ `recordTransition` của gian hàng bằng hàm này: kết nối mới (`from: null`, `to: 'connecting'`), `reconnect`/`resume_setup` (chỉ khi `action` khác null, như hiện tại), `finish_setup`, `lose_auth`, `disconnect`.
- Nhật ký `recordTransition` của listing (`entityType: 'listings'`) không đổi.

### 5.5 Listing: lớp ghi (cách A)

**Repository.** Tách các hàm ghi có thể đổi bộ ba sang file mới `channel/channel/repository/listing-writes.ts`: `insertListing`, `updateListing`, `markStockPendingIds`, `markStockPendingRows` (từ `listings.ts`), `delistForDisconnect`, `failPushingForDisconnect` (từ `shops.ts`). Hàm ghi không đổi bộ ba (`markCreateAttempted`, `setListingCategory`) và hàm xoá (`deleteListing`, xoá theo gian hàng) ở nguyên chỗ cũ.

Mỗi hàm ghi trả thêm bộ ba **trước** và **sau** của từng dòng bị ghi. **Không dùng `RETURNING old.*`** (chỉ có từ PG18, staging là PG17). Cách chạy được trên PG17: khoá và đọc bộ ba trước bằng `SELECT … FOR UPDATE … ORDER BY id` cùng điều kiện với câu UPDATE, rồi UPDATE `RETURNING` giá trị sau, trong cùng hàm repository (cùng giao dịch của bên gọi):

- Gộp một câu `UPDATE listings l SET … FROM (SELECT id, status, stock_sync, price_sync FROM listings WHERE … ORDER BY id FOR UPDATE) old WHERE l.id = old.id RETURNING l.*, old.status, old.stock_sync, old.price_sync` nếu Drizzle viết gọn được (`update().from(subquery)`, hoặc `sql` thô); không thì hai câu. Hai cách cho cùng kết quả: dòng đã khoá thì không ai đổi được giữa lúc đọc và lúc ghi.
- `updateListing`: câu đọc mang điều kiện `id`, `version` (và `status` nếu có) như câu UPDATE; không trúng dòng thì trả `undefined` như hiện tại.
- `insertListing` không có "trước".
- `delistForDisconnect`, `failPushingForDisconnect` chuyển sang file này (để luật dependency-cruiser bao cả hai) nhưng **không phát** (D12) nên không cần bộ ba trước, SQL giữ nguyên. Hàm bọc ở service ghi chú lý do: `channel.shop_status_changed` của cùng giao dịch ngắt đã làm FE tải lại nhóm `shops`, phát thêm hàng trăm sự kiện listing chỉ làm FE gọi lại API hàng trăm lần.
- Đưa lên lại sau khi nối lại (`relistAfterReconnect`, `insertListing` mỗi dòng một giao dịch, sau commit của lần nối) **vẫn phát**: chạy sau sự kiện gian hàng nên không có sự kiện nào báo thay.

**Service.** `channel/channel/service/listing-writes.ts` export cùng tên, cùng chữ ký trả về như hiện tại (bên gọi không phải đổi logic, chỉ đổi đường import). Mỗi hàm gọi repository, rồi với từng dòng có bộ ba trước khác bộ ba sau (hoặc dòng mới chèn) gọi `publishEvent('channel.listing_sync_changed', { shopId, listingId, stockSync, priceSync, status })` theo giá trị sau, `aggregateId` = `shopId`.

**Chặn đường vòng.** Thêm luật vào `.dependency-cruiser.cjs`: chỉ `channel/channel/service/listing-writes.ts` được import `channel/channel/repository/listing-writes.ts`. Luật chỉ chặn việc gọi thẳng các hàm ghi; một câu SQL mới ghi bộ ba ở repository khác (như `remote-skus.ts` đang ghi cột tên) thì luật không thấy. Ghi vào `channel/channel/CLAUDE.md`: "`status`, `stock_sync`, `price_sync` của listing chỉ ghi qua `service/listing-writes.ts`". Không thêm test quét mã nguồn (giòn, đổi tên là vỡ).

**Không phát:** `pending` đè lên `error` (`stockPending()` giữ `error`); cập nhật không đổi bộ ba (sửa tiêu đề, giá, nội dung lỗi, `outsideChange` trên listing đã ẩn, `version`; D11); hai hàm của ngắt gian hàng (D12); xoá dòng.

### 5.6 Lỗi, đồng thời, trùng lặp

- **Ngữ cảnh:** phát trong giao dịch của route đồng bộ (thao tác người dùng), việc nền pg-boss (đẩy, đồng bộ listing, làm mới token) và consumer Kafka (`allocation_done`, `return_inspected`). Không thêm đường chạy mới.
- **`publishEvent` ném** (payload sai schema, gọi ngoài `withCompany`): là lỗi lập trình, cả giao dịch rollback. Rủi ro thật là một đường ghi listing đang chạy ngoài `withCompany` sẽ bắt đầu ném sau PR này. Chặn bằng test tích hợp đi qua từng đường thật (AC6–AC9), không bằng `try/catch`.
- **Chạy lại:** sự kiện gắn với thay đổi thật (trước ≠ sau, hoặc dòng vừa tạo), nên kéo lại, consumer nhận lại sự kiện cũ, việc nền thử lại không phát thêm. Kafka giao ít nhất một lần nên SSE có thể trùng: FE bỏ trùng theo `eventId` và chỉ làm mới dữ liệu, vô hại.
- **Đồng thời:** bộ ba trước đọc dưới khoá dòng ngay trước UPDATE, nên hai lượt ghi đua nhau mỗi lượt thấy đúng phần mình đổi (lượt sau chờ khoá, đọc giá trị lượt trước đã ghi). Điều kiện `version` hiện có giữ nguyên.
- **Thứ tự:** FE gọi lại `GET` nên tới đảo thứ tự vẫn ra dữ liệu mới nhất. Không cần sắp xếp.
- **Khối lượng** (supabase `data-batch-inserts`): `publishEvent` ghi một dòng outbox mỗi sự kiện. Câu UPDATE nhiều dòng thành N lần INSERT outbox trong cùng giao dịch. `markStockPendingRows` chạm listing của vài biến thể mỗi lượt phân hàng (mỗi listing hai sự kiện mỗi lượt: `pending` rồi `synced`). Ngắt gian hàng (vài trăm listing) không phát (D12). Nối lại phát một sự kiện mỗi listing đưa lên lại, mỗi dòng một giao dịch, nối lại hiếm. Chấp nhận ở quy mô hiện tại; không thêm API phát theo lô. Đo trên staging, ồn thì mở issue riêng.
- **Khoá** (supabase `lock-deadlock-prevention`): khoá vẫn là khoá dòng `listings` mà UPDATE vốn giữ, chỉ lấy sớm hơn một câu, cùng giao dịch, không thêm bảng nào. Câu nhiều dòng có phát (`markStockPendingRows`, `markStockPendingIds`) khoá theo `ORDER BY id`, nên hai lượt chạm cùng tập listing không khoá chéo nhau (hiện UPDATE nhiều dòng khoá theo thứ tự quét, không bảo đảm). Thứ tự khoá giữa bảng (gian hàng → … → listing) không đổi. Ghi outbox là INSERT vào bảng riêng.

### 5.7 Quan sát

- Không thêm log: các đường ghi đã có log ở ranh giới (lượt đồng bộ, đẩy, ngắt). Một dòng log mỗi sự kiện sẽ lặp lại outbox.
- Số liệu sẵn có đủ để theo dõi: số liệu outbox của platform (relay, độ trễ), `notification_open_streams` của realtime. Không thêm số liệu mới.
- Lần theo một listing, yêu cầu trả, gian hàng: tra `core.outbox_messages` theo `type` và `payload->>'listingId'` / `returnId` / `shopId`.

### 5.8 Quyền và lộ dữ liệu

- Ai nhận: theo bảng 5.2, quyền có hiệu lực (bỏ quyền của phân hệ đang tắt, `effectivePermissions`).
- Lộ dữ liệu: `fields` chọn đúng trường; `toMessage` không đưa `companyId`, `aggregateId`. Test AC2 so payload bằng `toEqual` (thừa một trường là đỏ).

## 6. Documents (`21-hop-dong-api-fe-be.md`, PR riêng, merge trước hoặc cùng lúc PR BE)

- §13 ghi chú đầu mục (28/10/2026): ghi đã làm ở commerio-backend#216 (thay #134, #105).
- §13.2 bảng đầu: bỏ dòng `fulfillment.order_status_changed`; câu "Vai trò có sẵn…" viết lại theo ma trận ở 5.2.
- §13.2 "Sự kiện của mô hình mới": đổi `#134` thành `#216`; bỏ câu "Dòng `fulfillment.order_status_changed` … **bỏ** khi #134 xong"; thêm hai dòng:

  | Sự kiện | `event` | Ai nhận | `payload` | FE làm mới |
  |---|---|---|---|---|
  | Kiện giao không thành công | `fulfillment.package_delivery_failed` | `sales.order.view` hoặc `fulfillment.order.process` | `packageId`, `orderId`, `reason` | `fulfillment`, `sales`, `tasks`; toast |
  | Kiện thất lạc | `fulfillment.package_lost` | `sales.order.view` hoặc `fulfillment.order.process` | `packageId`, `orderId`, `claimCode` | `fulfillment`, `sales`, `tasks`; toast |

  Ghi rõ: hai dòng này mang thêm `reason`/`claimCode` (§11.2) để FE dựng câu toast, ngoại lệ của luật "chỉ id, `from`/`to`, cờ".
- Dòng `sales.return_status_changed`: đổi cột "Sự kiện" thành "Yêu cầu trả đổi trạng thái hoặc thông tin hiện trên màn", ghi `from = to` khi trạng thái giữ nguyên (cờ Cần xử lý, thông tin sàn: trạng thái sàn, tranh chấp, tiền hoàn, vận đơn trả), như dòng đơn.
- Dòng `channel.listing_sync_changed`: phát khi một trong `status`, `stockSync`, `priceSync` đổi (kể cả do hệ thống), mang giá trị sau khi đổi; đổi khác (nội dung lỗi, cờ tên trên sàn) không phát. Ngắt gian hàng không phát cho từng listing: FE làm mới nhóm `shops` theo `channel.shop_status_changed`.
- §13.4: thêm bên phát #216 (sales trả hàng, channel gian hàng và listing).
- D11 (dòng 547): "Sự kiện → quyền: đơn `sales.order.view`; kiện `sales.order.view` hoặc `fulfillment.order.process`; yêu cầu trả `sales.return.view`; gian hàng, listing `channel.shop.view`; tồn `inventory.stock.view`; đề nghị nhập `purchasing.request.approve`." Bỏ phần thanh toán. Sửa luôn `purchasing.order.approve` (lệch code và §13.2) thành `purchasing.request.approve`.

## 7. Test

Theo `testing-with-discernment`: luật thuần thì unit; đường phát chạm DB thật thì integration; không mock `publishEvent`, đọc `core.outbox_messages` thật.

| Mức | File | Kiểm |
|---|---|---|
| unit | `test/unit/modules/core/notification/domain/rules.test.ts` | Ma trận vai trò cho bảy loại (AC1); payload đúng trường bằng `toEqual` (AC2); hai loại cũ: `canReceive` false, `toMessage` null (AC3) |
| unit | `test/unit/modules/core/platform/domain/events.test.ts` | Mẫu cho ba loại mới; enum trùng hằng của module sở hữu (AC12) |
| integration | `test/integration/core/notification/stream.test.ts` | Mỗi loại ở 5.2 tới đúng vai trò qua stream thật; với bảy loại ở 5.2 (payload SSE trùng trọn schema, không đổi kiểu), `data.payload` parse được bằng `EVENT_SCHEMAS[type].strict()` (đúng tên trường, không thừa) (AC4). Loại cũ đổi kiểu hay bỏ trường (`sales.order_created` đổi tiền sang số, `inventory.receipt_posted` bỏ `lines`) không áp phép parse này |
| integration | cùng thư mục, file mới hoặc thêm vào `stream.test.ts` | Đầu-cuối: đổi trạng thái đơn bằng service thật → dòng outbox → envelope vào hub → stream nhận `sales.order_status_changed` (AC5) |
| integration | `test/integration/order/sales/` (returns, return-ingest) | AC6 |
| integration | `test/integration/channel/channel/` (shops, setup, shop-tokens) | AC7 |
| integration | `test/integration/channel/channel/listing-writes.test.ts` (mới) | AC8, AC9; chạy thêm một lần trên PG17 ở máy trước khi mở PR (AC13) |

Test đổi theo: các test đang dùng `payment.succeeded` trong `stream.test.ts`, `rules.test.ts` chuyển sang loại khác. Test Kafka, registry dùng `payment.succeeded` làm mẫu không đổi (schema còn).

## 8. Quyết định

| Mã | Quyết định | Ai chốt |
|---|---|---|
| D1 | `package_delivery_failed`, `package_lost` gửi người có `sales.order.view` hoặc `fulfillment.order.process`, như kiện | Khang 19/11/2026 |
| D2 | `payment.succeeded`: #216 chỉ bỏ luật; chỗ phát và schema dọn ở issue riêng | Khang 19/11/2026 |
| D3 | Giữ schema `fulfillment.order_status_changed` trong `events.ts` | Khang 19/11/2026 |
| D4 | `listing_sync_changed` phát mỗi lần bộ ba thật sự đổi, kể cả bước `pending` do hệ thống | Khang 19/11/2026 (theo đề xuất) |
| D5 | Một PR Documents, một PR BE; ba schema mới nằm trong PR BE | Khang 19/11/2026 |
| D6 | Cách A cho listing | Khang 19/11/2026 |
| D7 | `aggregateId`: trả = `orderId`, gian hàng và listing = `shopId` | Claude, chờ duyệt |
| D8 | Yêu cầu trả phát `from = to` khi cờ Cần xử lý hoặc thông tin sàn hiện trên màn đổi mà trạng thái giữ nguyên (5.3) | Khang 19/11/2026 (theo đề xuất, sau vòng rà) |
| D9 | Không phát khi xoá listing, xoá gian hàng; chèn listing mới thì phát | Claude, chờ duyệt |
| D10 | Luật dependency-cruiser chặn import thẳng repository ghi listing; cộng ghi chú trong `channel/channel/CLAUDE.md`, không test quét mã | Claude, chờ duyệt |
| D11 | Listing chỉ phát khi bộ ba đổi; đổi khác người dùng thấy (nội dung lỗi, đổi ngoài app trên listing đã ẩn, cờ tên) không phát | Khang 19/11/2026 (theo đề xuất, sau vòng rà) |
| D12 | Ngắt gian hàng không phát sự kiện listing (sự kiện gian hàng cùng giao dịch đã làm FE tải lại nhóm `shops`) | Khang 19/11/2026 (theo đề xuất, sau vòng rà) |
| D13 | Đưa lên lại sau nối lại vẫn phát mỗi listing (chạy sau sự kiện gian hàng, không có gì báo thay) | Claude, chờ duyệt (suy từ lý do của D12) |
| D14 | Không dùng `RETURNING old.*` (PG18); đọc bộ ba trước dưới khoá trong cùng hàm repository | Claude, theo `db/CLAUDE.md` (staging PG17) |

## 9. Tiêu chí nghiệm thu

- **AC1** CEO, Admin, Sale nhận cả bảy loại (theo quyền ở 5.2); Nhân viên kho nhận ba loại kiện và yêu cầu trả, không nhận đơn, gian hàng, listing. Quyền của phân hệ tắt không tính.
- **AC2** Payload SSE của mỗi loại đúng bằng các trường ở 5.2; sự kiện mang trường thừa (vd `aggregateId`) không lọt xuống.
- **AC3** `fulfillment.order_status_changed`, `payment.succeeded` không tới ai; consumer `notification-sse` không đăng ký hai loại này.
- **AC4** Mỗi loại ở 5.2 đi qua stream thật tới đúng vai trò; payload của bảy loại này parse bằng `EVENT_SCHEMAS[type].strict()`.
- **AC5** Huỷ (hoặc đổi trạng thái) một đơn bằng service thật → stream của Sale nhận `sales.order_status_changed` có `orderId`, `from`, `to` đúng.
- **AC6** Yêu cầu trả: tạo từ sàn ở `requested` → một sự kiện `from: null, to: 'requested'`; tạo khi sàn báo trạng thái khác → hai sự kiện theo thứ tự (`null → requested`, `requested → X`); kéo lại cùng yêu cầu → không thêm; mỗi bước (người dùng `accept`, sàn báo, kho `receive`, đóng sau kiểm hàng hoàn) → đúng một sự kiện `from`/`to`; xung đột (bật Cần xử lý, trạng thái giữ) → một sự kiện `from = to`; sàn đổi trường hiện trên màn (vd `disputeInProgress`) → một sự kiện `from = to`; sàn chỉ đổi trường không hiện (vd `externalUpdatedAt`) → không; báo sàn đã nhận lỗi rồi thử lại thành công → hai sự kiện `from = to` (bật, gỡ cờ); UPDATE trượt `version` → không phát.
- **AC7** Gian hàng: kết nối mới (`null → connecting`), `finish_setup`, `lose_auth`, `reconnect`, `resume_setup`, `disconnect` mỗi lần đúng một sự kiện; nối lại khi đã `active` (không đổi trạng thái) → không phát.
- **AC8** Listing, từng hàm của lớp ghi: đổi bộ ba → một sự kiện mang giá trị sau; đổi trường khác → không; `markStockPendingRows` trên listing `error` → không; trên N listing `synced` → N sự kiện; `insertListing` → một sự kiện; ngắt gian hàng (`delistForDisconnect`, `failPushingForDisconnect`) → không sự kiện listing nào, chỉ `channel.shop_status_changed`; nối lại đưa lên lại N listing → N sự kiện; `outsideChange` ghi lên listing đã `hidden` → không.
- **AC9** Mọi đường ghi listing hiện có chạy được trong `withCompany` sau khi đổi import (test của `listing-sync`, `listing-push`, `mapping`, `outside-change`, `pending-prices` vẫn xanh).
- **AC10** `npm run check` xanh, kể cả luật dependency-cruiser mới.
- **AC11** `Documents/21` §13.2, §13.4, D11 khớp code; `notification/CLAUDE.md`, `sales/CLAUDE.md`, `channel/channel/CLAUDE.md` ghi sự kiện mới.
- **AC12** Enum trong ba schema mới trùng hằng của module sở hữu.
- **AC13** Test lớp ghi listing xanh trên PG17 (`TEST_PG_IMAGE=pgvector/pgvector:pg17`); không câu SQL mới nào dùng tính năng chỉ có ở PG18.

## 10. Để người làm quyết

- Một câu `UPDATE … FROM (SELECT … FOR UPDATE)` hay hai câu cho từng hàm ghi listing (5.5); cả hai phải chạy trên PG17.
- Tên file của hàm chuyển trạng thái gian hàng, cách gom test tích hợp theo file.
- Dòng mô tả trong CLAUDE.md của từng module.
