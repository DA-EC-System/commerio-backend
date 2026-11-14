# #239 Đóng gói, RTS, in vận đơn, danh sách nhặt: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kho làm trọn `reserved → packed → awaiting_pickup` trong app (danh sách nhặt, quét đóng gói, báo sàn sẵn sàng giao, mở lại kiện đóng nhầm) và in vận đơn PDF cho 1–50 kiện Lazada, TikTok.

**Architecture:** Channel (lớp 5) thêm năng lực adapter (Lazada: nhà vận chuyển, pack, RTS, repack, vận đơn; TikTok: giao kiện, vận đơn) và cổng `marketplacePackages`, tiêm vào fulfillment (lớp 3) qua `src/wiring.ts`. Fulfillment thêm 6 route; mỗi thao tác ghi đi ba bước (kiểm trong giao dịch ngắn → gọi sàn ngoài giao dịch → ghi theo `version`), trong khoá phiên theo kiện. Vận đơn hai sàn đều là PDF, gộp bằng `pdf-lib`.

**Tech Stack:** Node.js 24 (chạy thẳng `.ts`), Express 5, TypeScript 6, Zod 4, Drizzle ORM + PostgreSQL 18, Vitest + Testcontainers, `pdf-lib` (mới).

**Spec:** `docs/superpowers/specs/2026-11-13-239-dong-goi-rts-van-don-design.md` (gọi tắt "spec"; mục đánh số theo spec). Executor đọc spec trước task đầu tiên.

## Global Constraints

- Nhánh `feature/239-dong-goi-rts` (đã có, commit spec e6e8937). PR vào `main`. PR #300 (#199c) merge trước PR fulfillment: gộp `main` rồi `npm run db:regen` (CLAUDE.md mục Migration), không ghép tay `_journal.json`.
- Import tương đối có đuôi `.ts`; không `enum`, `namespace`, parameter property (union literal / `as const`).
- Định danh tiếng Anh; comment, câu lỗi, tài liệu tiếng Việt, giọng như các câu đã có trong module.
- Lỗi nghiệp vụ ném `AppError(status, code, message, extensions?)`; không `res.status(4xx)` trong route. Lỗi sàn đổi sang mã app, giữ `platformCode`, `platformMessage` (`21` R8).
- Route: `ctx.authorize('fulfillment.order.process')` trước `validate({ body, query, params })`; đọc lại bằng `validated<typeof Schema>(res, 'body')`; dữ liệu công ty trong `withCompany` (RLS).
- `order` không import `channel`: mọi lời gọi sàn qua `ctx.marketplacePackages`. Code ngoài adapter không rẽ nhánh theo mã sàn.
- Gọi sàn ngoài giao dịch nghiệp vụ.
- Test chỉ trong `test/**/*.test.ts`, import `#src/...ts`, không gọi mạng thật, tên `describe`/`it` tiếng Việt, lỗi API kiểm `status` + `type` (`/problems/<code>`). Đọc `test/CLAUDE.md` trước khi viết test.
- Mã ca test D2 (`D2-03`, `D2-03q`, `D2-03g`, `D2-04`, `D2-04q`, `D2-04g`) đặt trong tên `it`.
- Giới hạn từ spec: `documents` 1–50 kiện, `pick-list` `ids` 1–200, mặc định tối đa 500 kiện; `pack.lines` 0–200 dòng, `quantity` 1–10000; `carrierCode` 1–100 ký tự; khoá phiên chờ 10 000 ms; tải PDF chỉ `https`, ≤ 10 MB/tệp, 15 000 ms, mở đầu `%PDF-`; tổng tệp vận đơn ≤ 50 MB; Lazada RTS lô 20; TikTok vận đơn tối đa 5 lời gọi cùng lúc; tối đa 3 gian hàng cùng lúc khi in.
- Không log URL ký của vận đơn, không log token. Không thêm metric mới (module chưa dùng `prom-client`); log `warn`/`error` có `packageId`, `platformPackageCode`, mã lỗi sàn.
- Commit message tiếng Việt, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Không push, không mở PR khi Khang chưa đồng ý.
- Sau khi sửa code: `graphify update .`. Trước khi xin review: `npm run check`.

## Review Focus

1. **Bấm Đóng gói hai lần liền (hai tab, double-click) trên cùng kiện, cùng `version`**: người dùng chờ sàn chỉ nhận **một** lệnh pack; lần sau nhận `Package` đã `packed` hoặc 409 `version_conflict`, không bao giờ 500. Test ở Task 12 ("hai request đóng gói đua nhau chỉ gọi sàn một lần").
2. **Gian hàng vừa ngắt hoặc mất uỷ quyền khi kho đang đóng gói hay báo sẵn sàng**: cổng ném 409 `shop_not_connected`/`marketplace_unauthorized`; kiện giữ nguyên trạng thái. Với `ready`, kiện có `label_error` để kho biết bấm lại sau khi nối lại. Test ở Task 12 và Task 13.
3. **Kiện chỉ toàn dòng chưa ghép SKU** (SKU "không quản tồn"): `lines: []` vẫn đóng gói được; kiện có dòng đã ghép mà gửi `lines: []` thì 422 `scan_mismatch`. Test ở Task 10 và Task 12.
4. **In vận đơn lô có cả kiện đơn tay lẫn hai kiện chung mã nhóm gói**: 409 `document_not_ready` chỉ liệt kê kiện thiếu mã; bỏ kiện đơn tay rồi in thì sàn chỉ được gọi một lần cho mã nhóm. Test ở Task 15.
5. **Sàn trả tệp không phải PDF hoặc PDF hỏng** (OSS lỗi, trang HTML báo lỗi): 503 `marketplace_unavailable` "Sàn trả tệp vận đơn hỏng, thử lại sau", log `error`, không 500 và không gửi tệp hỏng cho trình duyệt. Test ở Task 2 (bộ tải) và Task 15 (gộp).

---

## Cấu trúc file

**Channel (PR1):**

| File | Việc |
|---|---|
| `src/modules/channel/channel/service/marketplaces/common.ts` (sửa) | Kiểu `PackageItemsRef`, `CarrierOption`, `PlatformPack`, hằng `CARRIER_REQUIRED`; 5 hàm tuỳ chọn trên `MarketplaceAdapter` |
| `src/modules/channel/channel/service/marketplaces/image-source.ts` (sửa) | Tách phần tải ghim địa chỉ thành hàm dùng chung; thêm `downloadDocument` (PDF) |
| `src/modules/channel/channel/service/marketplaces/lazada-packing.ts` (mới) | `lazadaPackingMethods(call, deps)`: providers, pack, RTS, repack, vận đơn (giữ `lazada.ts` khỏi phình) |
| `src/modules/channel/channel/service/marketplaces/lazada.ts` (sửa) | Spread `lazadaPackingMethods` vào adapter; tham số `deps` |
| `src/modules/channel/channel/service/marketplaces/tiktok-orders.ts` (sửa) | `readyToShip`, `shippingDocuments`; tham số `deps` |
| `src/modules/channel/channel/service/marketplaces/tiktok.ts` (sửa) | Truyền `deps` |
| `src/modules/channel/channel/service/order-actions.ts` (sửa) | 5 hàm cổng, `onPackageAction` |
| `src/modules/channel/index.ts`, `src/wiring.ts` (sửa) | Export, nối cổng |
| `scripts/lazada-mock/stubs.ts`, `scripts/lazada-mock/gate.ts` (sửa) | API vận đơn mới, PDF tĩnh, kịch bản `NTFS` |
| `src/modules/channel/channel/CLAUDE.md` (sửa) | Mục "Đóng gói, RTS, vận đơn (#239)" |

**Fulfillment (PR2):**

| File | Việc |
|---|---|
| `src/modules/order/fulfillment/repository/schema.ts` (sửa) | `carrierCode`, `carrierName`, `labelError`, CHECK `packages_carrier` |
| `db/migrations/<sinh>_dong-goi-rts.sql` (sinh) | Migration |
| `src/modules/order/fulfillment/domain/packing.ts` (mới) | Luật thuần: so số quét, nhóm gói, gộp danh sách nhặt |
| `src/modules/order/fulfillment/repository/packing.ts` (mới) | Truy vấn cho đóng gói: khoá kiện, nhóm, mã món sàn, `packed_qty`, dòng nhặt |
| `src/modules/order/fulfillment/repository/packages.ts` (sửa) | `updatePackage` nhận thêm trường |
| `src/modules/order/fulfillment/service/packing.ts` (mới) | `pickList`, `carriersOf`, `packPackage`, `markReady`, `openPackage` |
| `src/modules/order/fulfillment/service/documents.ts` (mới) | `packageDocuments` (gom, gọi cổng, gộp PDF) |
| `src/modules/order/fulfillment/service/packages.ts` (sửa) | Kiểu `MarketplacePackages` thêm 5 hàm |
| `src/modules/order/fulfillment/service/views.ts`, `api/schemas.ts` (sửa) | `carrier`, cờ `label_error`; schema route mới |
| `src/modules/order/fulfillment/service/platform-packages.ts` (sửa) | Xoá `label_error` khi sàn đưa kiện khỏi `packed` |
| `src/modules/order/fulfillment/api/routes.ts`, `api/openapi.ts` (sửa) | 6 route, Swagger |
| `src/modules/order/fulfillment/CLAUDE.md` (sửa) | Mục đóng gói, route |
| `test/integration/order/fulfillment/helpers.ts` (sửa) | `seedPackage` thêm tham số; `packingApp(fake)` |

**Repo khác:** `D:\DA-TMDT\Documents` (Task 1), `D:\DA-TMDT\FE` (Task 17, dùng `pnpm`).

---

### Task 1: Documents (repo `D:\DA-TMDT\Documents`)

**Files:**
- Modify: `21-hop-dong-api-fe-be.md` §19.2, §19.3
- Modify: `19-mo-hinh-du-lieu.md` mục 2 (dòng `packages`)
- Modify: `17-modular-monolith.md` §6
- Modify: `tich-hop-san/lazada.md` §7.4
- Modify: `tich-hop-san/tiktok.md`

**Interfaces:** Produces: hợp đồng mà Task 11–17 code theo.

- [ ] **Step 1: Tạo nhánh** `git switch -c docs/239-dong-goi-rts origin/main` trong repo Documents.
- [ ] **Step 2: Sửa `21` §19.2** đúng spec mục 8: hình trả về `GET /fulfillment/pick-list` (`{ items: { variantId: uuid | null, sku, productName, attributesLabel, quantity, packageCount }[], packageCount, truncated }`, `ids` 1–200, không `ids` thì tab `reserved` tối đa 500 kiện); mã 409 `package_group_not_ready` (thêm vào câu "Mã lỗi mới FE đã có câu báo"); route `open`: tới khi có commerio-backend#238 chỉ nhận kiện `packed`, kiện chưa giữ đủ hàng thì giữ lại lúc mở (422 `insufficient_stock`, 409 `shop_awaiting_stocktake`), kiện `awaiting_pickup` 409 `invalid_transition`.
- [ ] **Step 3: Sửa `21` §19.3**: thay gạch "`open` kiện sàn đã có `platformPackageCode` thì BE gọi repack…" bằng "chỉ kiện `packed` (chưa báo sẵn sàng giao) mới gọi repack; kiện `awaiting_pickup` giữ vận đơn theo `25` §8.3 (E115)"; `documents` luôn trả PDF, gộp nhiều gian hàng, nhiều sàn; `document_not_ready` cả khi TikTok chưa giao kiện hay ĐVVC đang tạo tệp; bảng đổi lỗi thêm dòng TikTok (`21042104`, `21023035`, `11034037` → `document_not_ready`; `21023059`, `21042102` → `package_status_not_allowed`); nhà vận chuyển `{ items: [] }` khi sàn tự chọn (`TFS`) và khi kiện TikTok.
- [ ] **Step 4: Sửa `19`**: dòng `packages` thêm `carrier_code`, `carrier_name` (null được, CHECK cùng null; commerio-backend#239).
- [ ] **Step 5: Sửa `17` §6**: thêm dòng bảng `| Gộp tệp PDF (vận đơn) | (không có) | \`pdf-lib\`. Thêm 13/11/2026 (commerio-backend#239) |`.
- [ ] **Step 6: Sửa `lazada.md` §7.4**: chuyển `/order/package/document/get` ra khỏi bảng "Chưa gọi thử", ghi kết quả gọi thật 13/11/2026 (spec mục 2: `pdf_url` ký OSS ~14 ngày, tải không đăng nhập 200 `application/pdf`, request_id `0b803a6517945323507881094`; API cũ trả `text/html`, request_id `0baf58d017945323488813116`).
- [ ] **Step 7: Sửa `tiktok.md`**: mục vận đơn `GET /fulfillment/202309/packages/{package_id}/shipping_documents` (tham số, `doc_url` 24 giờ, điều kiện, mã lỗi như spec mục 2).
- [ ] **Step 8: Commit** `git commit -am "21, 19, 17, sàn: đóng gói, RTS, vận đơn PDF (commerio-backend#239)"` (kèm dòng Co-Authored-By). Hỏi Khang trước khi push và mở PR.

---

### Task 2: Tải tệp PDF vận đơn (`downloadDocument`)

**Files:**
- Modify: `src/modules/channel/channel/service/marketplaces/image-source.ts`
- Test: `test/unit/modules/channel/channel/service/marketplaces/image-source.test.ts` (mới nếu chưa có; nếu đã có test `downloadImage` ở file khác thì thêm `describe` mới vào file đó)

**Interfaces:**
- Produces:
  ```ts
  export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
  export interface DocumentSourceOptions {
    resolveHost?: (host: string) => Promise<string[]>;
    allowAddress?: (ip: string) => boolean;
    /** Origin tin cậy từ cấu hình (vd `LAZADA_API_URL` trỏ sàn giả lập): được `http` và địa chỉ riêng. */
    trustedOrigin?: string;
    maxBytes?: number;
    timeoutMs?: number;
  }
  export async function downloadDocument(source: string, opts?: DocumentSourceOptions): Promise<Uint8Array>;
  ```
  Mọi lỗi ném `MarketplaceError('unavailable', 'document_download_failed', <câu tiếng Việt>)` (503 qua `onMarketplace`).

- [ ] **Step 1: Viết test hỏng** (server cục bộ `http.createServer` cổng 0, `allowAddress: () => true` như test ảnh hiện có, hoặc `trustedOrigin` = origin server):
  - `it('tải PDF qua origin tin cậy, trả đúng byte')`: server trả `%PDF-1.4…` với `content-type: application/pdf` → `Buffer.from(result).subarray(0, 5).toString() === '%PDF-'`.
  - `it('từ chối http khi không phải origin tin cậy')` → `rejects.toMatchObject({ kind: 'unavailable', platformCode: 'document_download_failed' })`.
  - `it('từ chối content-type không phải application/pdf')`.
  - `it('từ chối tệp không mở đầu bằng %PDF-')` (content-type đúng, body `<html>`).
  - `it('huỷ khi vượt maxBytes')` (`maxBytes: 10`).
  - `it('từ chối địa chỉ riêng khi không có origin tin cậy')` (`resolveHost` trả `['10.0.0.1']`, không `allowAddress`).
- [ ] **Step 2: Chạy** `npx vitest run test/unit/modules/channel/channel/service/marketplaces/image-source.test.ts` → FAIL (`downloadDocument` chưa có).
- [ ] **Step 3: Cài đặt.** Tách thân vòng lặp tải của `downloadImage` thành hàm riêng trong file, nhận `{ accept, isType(type), label, maxBytes, timeoutMs, httpsOnly, trustedOrigin, error(why) }`; `downloadImage` giữ nguyên hành vi và câu lỗi (test ảnh hiện có phải xanh). `downloadDocument`: `accept: 'application/pdf'`, chỉ `https` trừ URL cùng `trustedOrigin`, URL cùng `trustedOrigin` bỏ qua kiểm địa chỉ riêng, kiểm `%PDF-` sau khi đọc.
- [ ] **Step 4: Chạy** test file mới và mọi test đang có của `downloadImage` (`npx vitest run test/unit/modules/channel`) → PASS.
- [ ] **Step 5: Commit** `feat(channel): tải tệp PDF vận đơn có ghim địa chỉ (#239)`.

---

### Task 3: Interface adapter + Lazada nhà vận chuyển, đóng gói

**Files:**
- Modify: `src/modules/channel/channel/service/marketplaces/common.ts`
- Create: `src/modules/channel/channel/service/marketplaces/lazada-packing.ts`
- Modify: `src/modules/channel/channel/service/marketplaces/lazada.ts`
- Test: `test/unit/modules/channel/channel/service/marketplaces/lazada-packing.test.ts`

**Interfaces:**
- Produces (trong `common.ts`):
  ```ts
  export interface PackageItemsRef { externalOrderId: string; externalLineIds: readonly string[] }
  export interface CarrierOption { code: string; name: string; isDefault: boolean }
  export interface PlatformPack { packageCode: string; trackingCode: string | null; carrier: { code: string; name: string } | null }
  /** Adapter ném khi sàn bắt chọn nhà vận chuyển mà thiếu hoặc sai mã. */
  export const CARRIER_REQUIRED = 'carrier_required';
  // trên MarketplaceAdapter:
  shipmentProviders?(accessToken: string, ref: PackageItemsRef): Promise<{ platformChooses: boolean; items: CarrierOption[] }>;
  packItems?(accessToken: string, ref: PackageItemsRef & { carrierCode?: string }): Promise<PlatformPack>;
  readyToShip?(accessToken: string, packageCodes: readonly string[]): Promise<void>;
  repackPackage?(accessToken: string, packageCode: string): Promise<void>;
  shippingDocuments?(accessToken: string, packageCodes: readonly string[]): Promise<Uint8Array[]>;
  ```
  JSDoc mỗi hàm theo spec 5.3. **Không** thêm vào `NO_RETRY` (spec 5.3).
- Produces (trong `lazada-packing.ts`):
  ```ts
  export interface LazadaPackingDeps { download?: (url: string) => Promise<Uint8Array> }
  type LazadaCall = (apiPath: string, params: Record<string, string>, method: 'GET' | 'POST' | 'FORM') => Promise<LazadaResponse>;
  export function lazadaPackingMethods(call: LazadaCall, deps: Required<LazadaPackingDeps>):
    Pick<MarketplaceAdapter, 'shipmentProviders' | 'packItems' | 'readyToShip' | 'repackPackage' | 'shippingDocuments'>;
  ```
  `createLazadaAdapter(config, fetchFn = fetch, deps: LazadaPackingDeps = {})`; `download` mặc định `(url) => downloadDocument(url, { trustedOrigin: new URL(config.apiUrl).origin })`. Task này chỉ làm `shipmentProviders`, `packItems`; Task 4 làm ba hàm còn lại trong cùng file.

- [ ] **Step 1: Viết test hỏng** (khuôn `lazada-order.test.ts`: `config`, `fetchFn = vi.fn`, `query(fn, n)`; body POST đọc từ form):
  - `it('nhà vận chuyển TFS: platformChooses, danh sách rỗng')`: sàn trả `{ code: '0', result: { success: true, data: { shipping_allocate_type: 'TFS', shipment_providers: [], platform_default: 'LEX VN' } } }` → `{ platformChooses: true, items: [] }`; tham số `getShipmentProvidersReq` = `{"orders":[{"order_id":"O1","order_item_ids":["I1","I2"]}]}`.
  - `it('nhà vận chuyển NTFS: danh sách theo shipment_providers, isDefault theo platform_default')` (dùng tên trường phần tử theo tài liệu GetShipmentProvider; tra trước khi viết, ghi nguồn trong comment fixture).
  - `it('đóng gói TFS: gọi providers rồi /order/fulfill/pack, trả mã kiện, vận đơn, carrier null')`: kiểm `packReq` = `{"pack_order_list":[{"order_id":"O1","order_item_list":["I1","I2"]}],"delivery_type":"dropship","shipping_allocate_type":"TFS"}`; trả `{ packageCode: 'FP1', trackingCode: 'LZ1', carrier: null }`.
  - `it('đóng gói NTFS thiếu carrierCode: rejected carrier_required, không gọi pack')` → `fetchFn` gọi đúng 1 lần.
  - `it('đóng gói NTFS: gửi shipment_provider_code, carrier là mục đã chọn')`.
  - `it('món lỗi item_err_code 700026: rejected giữ mã và câu của sàn')`.
  - `it('các món ra hai package_id hoặc thiếu món: rejected unexpected_response')`.
  - `it('result.success false: rejected với mã lỗi của result')`.
- [ ] **Step 2: Chạy** `npx vitest run test/unit/modules/channel/channel/service/marketplaces/lazada-packing.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt** kiểu trong `common.ts`, `shipmentProviders`, `packItems` trong `lazada-packing.ts` (spec 5.3 mục Lazada), spread vào adapter trong `lazada.ts` với `call` bọc `config.apiUrl`. Pack gửi `FORM` (payload JSON dài). Phản hồi bọc `result`: `result.success !== true` thì `rejected` với `result.error_code ?? 'unexpected_response'`, `result.error_msg`.
- [ ] **Step 4: Chạy** file test mới + `contract-lazada.test.ts` + `contract-fake.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(channel): adapter Lazada lấy nhà vận chuyển, đóng gói theo món (#239)`.

---

### Task 4: Lazada RTS, repack, vận đơn

**Files:**
- Modify: `src/modules/channel/channel/service/marketplaces/lazada-packing.ts`
- Test: `test/unit/modules/channel/channel/service/marketplaces/lazada-packing.test.ts`

**Interfaces:**
- Consumes: `lazadaPackingMethods`, `LazadaPackingDeps` (Task 3).
- Produces: `readyToShip`, `repackPackage`, `shippingDocuments` trên adapter Lazada.

- [ ] **Step 1: Viết test hỏng:**
  - `it('RTS chia lô 20 kiện')`: 21 mã → 2 lời gọi `/order/package/rts`, `readyToShipReq` lần 1 có 20 `package_id`, lần 2 có 1.
  - `it('RTS kiện lỗi 30012: rejected giữ mã')`.
  - `it('repack gửi đúng mã kiện tới /order/package/repack')` (tên tham số theo tài liệu RePack; ghi nguồn).
  - `it('vận đơn: gọi /order/package/document/get doc_type PDF rồi tải pdf_url')`: `deps.download` giả ghi URL nhận được, trả `Uint8Array` `%PDF-`; kiểm `getDocumentReq` = `{"doc_type":"PDF","packages":[{"package_id":"FP1"},{"package_id":"FP2"}]}`; kết quả có 1 phần tử.
  - `it('vận đơn quá N kiện thì chia lô, mỗi lô một tệp')` (N là hằng `DOCUMENT_BATCH`, lấy theo tài liệu, không có thì 20).
  - `it('vận đơn result.success false: rejected giữ mã')`.
- [ ] **Step 2: Chạy** test → FAIL.
- [ ] **Step 3: Cài đặt** ba hàm (spec 5.3). Hằng `RTS_BATCH = 20`, `DOCUMENT_BATCH` có comment nguồn.
- [ ] **Step 4: Chạy** test → PASS.
- [ ] **Step 5: Commit** `feat(channel): adapter Lazada báo sẵn sàng giao, đóng gói lại, vận đơn PDF (#239)`.

---

### Task 5: TikTok báo sẵn sàng giao, vận đơn

**Files:**
- Modify: `src/modules/channel/channel/service/marketplaces/tiktok-orders.ts`, `tiktok.ts`
- Test: `test/unit/modules/channel/channel/service/marketplaces/tiktok-packing.test.ts`

**Interfaces:**
- Consumes: kiểu `MarketplaceAdapter` (Task 3), `downloadDocument` (Task 2).
- Produces: `tiktokOrderMethods(client, deps: { download?: (url: string) => Promise<Uint8Array> } = {})` khai thêm `readyToShip`, `shippingDocuments`; `createTiktokAdapter(config, fetchFn = fetch, deps = {})` truyền `deps` xuống. `download` mặc định `(url) => downloadDocument(url)`.

- [ ] **Step 1: Viết test hỏng** (khuôn `fakeSan` của `tiktok-orders.test.ts`):
  - `it('readyToShip gọi giao kiện cho từng mã')` → 2 lời gọi `POST /fulfillment/202309/packages/<mã>/ship`.
  - `it('readyToShip: 11006021 coi là xong')`.
  - `it('vận đơn: GET shipping_documents từng kiện với SHIPPING_LABEL, A6, PDF rồi tải doc_url, giữ thứ tự')`.
  - `it('vận đơn: kiện chưa giao (21042104) ném rejected giữ mã, câu có mã kiện sàn')`.
  - `it('vận đơn: không quá 5 lời gọi cùng lúc')` (handler đếm số lời gọi đang mở, 12 mã).
- [ ] **Step 2: Chạy** test → FAIL.
- [ ] **Step 3: Cài đặt** (spec 5.3 mục TikTok). Không khai `shipmentProviders`, `packItems`, `repackPackage`.
- [ ] **Step 4: Chạy** test mới + `tiktok-orders.test.ts` + `contract-tiktok.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(channel): adapter TikTok báo sẵn sàng giao, vận đơn PDF (#239)`.

---

### Task 6: Cổng `marketplacePackages`, đổi lỗi, nối `wiring.ts`

**Files:**
- Modify: `src/modules/channel/channel/service/order-actions.ts`
- Modify: `src/modules/channel/index.ts`, `src/wiring.ts`
- Modify: `src/modules/order/fulfillment/service/packages.ts` (kiểu `MarketplacePackages`)
- Test: `test/unit/modules/channel/channel/service/order-actions.test.ts`

**Interfaces:**
- Consumes: hàm adapter (Task 3–5), `shopSession`, `onMarketplace` (`service/shops.ts`).
- Produces (channel, export qua `channel/index.ts`):
  ```ts
  export function onPackageAction<T>(fn: () => Promise<T>): Promise<T>;
  export async function marketplaceCarriers(companyId: string, shopId: string, ref: PackageItemsRef): Promise<CarrierOption[]>;
  export async function marketplacePack(companyId: string, shopId: string, ref: PackageItemsRef & { carrierCode?: string }): Promise<PlatformPack | null>;
  export async function marketplaceReadyToShip(companyId: string, shopId: string, packageCode: string): Promise<void>;
  export async function marketplaceRepack(companyId: string, shopId: string, packageCode: string): Promise<'repacked' | 'not_supported'>;
  export async function marketplaceShippingDocuments(companyId: string, shopId: string, packageCodes: readonly string[]): Promise<Uint8Array[]>;
  ```
- Produces (fulfillment, `MarketplacePackages` thêm, kiểu cấu trúc tự khai, không import channel):
  ```ts
  carriers(companyId: string, shopId: string, ref: { externalOrderId: string; externalLineIds: readonly string[] }): Promise<{ code: string; name: string; isDefault: boolean }[]>;
  pack(companyId: string, shopId: string, ref: { externalOrderId: string; externalLineIds: readonly string[]; carrierCode?: string }): Promise<{ packageCode: string; trackingCode: string | null; carrier: { code: string; name: string } | null } | null>;
  readyToShip(companyId: string, shopId: string, packageCode: string): Promise<void>;
  repack(companyId: string, shopId: string, packageCode: string): Promise<'repacked' | 'not_supported'>;
  shippingDocuments(companyId: string, shopId: string, packageCodes: readonly string[]): Promise<Uint8Array[]>;
  ```
  `wiring.ts`: `marketplacePackages: { splitAttributes, split, ship, carriers: marketplaceCarriers, pack: marketplacePack, readyToShip: marketplaceReadyToShip, repack: marketplaceRepack, shippingDocuments: marketplaceShippingDocuments }`.

- [ ] **Step 1: Viết test hỏng** cho `onPackageAction` (bảng spec 5.3, dạng `it.each`):
  - `MarketplaceError('rejected','700000')` → `AppError` 409 `package_status_not_allowed` có `platformCode: '700000'`; `700026` → `item_not_packable`; `30012` → `rts_package_not_found`; `21042104`, `21023035`, `11034037` → 409 `document_not_ready`; `21023059`, `21042102` → 409 `package_status_not_allowed`; `carrier_required` → 422 `validation_failed` với `errors.carrierCode`; `MarketplaceError('unavailable')` → 503 `marketplace_unavailable`; lỗi không phải `MarketplaceError` ném nguyên.
  - Phần "chọn hàm adapter" tách thành hàm thuần nhận adapter và token (vd `packWith(adapter, token, ref)`, `repackWith`, `carriersWith`), hàm cổng chỉ thêm `shopSession` + `onPackageAction`. Test bằng adapter giả: `packWith` trả `null` khi adapter không có `packItems`; `repackWith` trả `'not_supported'` khi không có `repackPackage`, `'repacked'` khi có; `carriersWith` trả `[]` khi không có `shipmentProviders` hoặc khi `platformChooses: true`. Không có test nào chạy `shopSession` thật ở task này (integration của fulfillment dùng cổng giả).
- [ ] **Step 2: Chạy** test → FAIL.
- [ ] **Step 3: Cài đặt** `onPackageAction` (khuôn `onSplit`), 5 hàm cổng (khuôn `marketplaceShipPackage`: `session()` trong `withCompany`, gọi sàn ngoài giao dịch). `readyToShip`, `shippingDocuments` thiếu hàm adapter → 422 `marketplace_unsupported` câu "Sàn này chưa hỗ trợ … từ app". Kiểu `MarketplacePackages`, export, `wiring.ts` cùng commit (thiếu một hàm là lỗi kiểu ở `AppContext`).
- [ ] **Step 4: Chạy** `npx vitest run test/unit/modules/channel` và `npm run typecheck` (hoặc `npx tsc --noEmit`) → PASS.
- [ ] **Step 5: Commit** `feat(channel): cổng đóng gói, RTS, vận đơn cho fulfillment, đổi mã lỗi sàn (#239)`.

---

### Task 7: Sàn giả lập + tài liệu channel

**Files:**
- Modify: `scripts/lazada-mock/stubs.ts`, `scripts/lazada-mock/gate.ts`, `scripts/lazada-mock/README.md`
- Modify: `src/modules/channel/channel/CLAUDE.md`

**Interfaces:** Consumes: đường gọi của Task 3–4.

- [ ] **Step 1: Stub `/order/package/document/get`** theo trạng thái kịch bản (`RTS_OR_LATER` → `{ result: { success: true, data: { doc_type: 'PDF', pdf_url: '<origin cổng giả>/files/awb-mock.pdf' } } }`, trước đó lỗi `30012`). `Mapping.response` cho phép `base64Body` (thêm kiểu); mapping `/files/awb-mock.pdf` trả một PDF tối thiểu hợp lệ (`%PDF-1.4…%%EOF`, dựng một lần bằng `pdf-lib` rồi nhúng base64, hoặc chuỗi PDF tay hợp lệ). `gate.ts` cho `/files/*` đi qua không kiểm chữ ký.
- [ ] **Step 2: Kịch bản `NTFS`**: một kịch bản mới trong `SCENARIOS` mà providers trả `NTFS` với 2 nhà vận chuyển (tên trường như Task 3), pack bắt buộc `shipment_provider_code`.
- [ ] **Step 3: Kiểm tay**: `docker compose -f deploy/compose.yaml --profile lazada-mock up -d lazada-wiremock lazada-mock`, `npm run mock:lazada -- load giao-thanh-cong`, rồi gọi adapter qua `npm run mock:lazada -- check` (nếu `check` chưa gọi pack/RTS/vận đơn thì thêm ba bước vào `check`). Kỳ vọng: pack → `FP600000000000001`, RTS ok, vận đơn tải được PDF.
- [ ] **Step 4: `channel/CLAUDE.md`**: thêm mục "Đóng gói, RTS, vận đơn (#239)" trong "Adapter sàn": năng lực mới, `onPackageAction` và bảng mã, `downloadDocument` + `trustedOrigin`, không `NO_RETRY`; sửa câu "Fulfillment chưa gọi (tách kiện #205, RTS #239 của Khang); Lazada chưa có hàm tương ứng" cho đúng.
- [ ] **Step 5: Commit** `chore(lazada-mock): vận đơn PDF, kịch bản NTFS; channel CLAUDE.md (#239)`.

---

### Task 8: Smoke trên shop thử (tay, cần Khang đồng ý)

Ghi lên shop thử **dùng chung**, mỗi ngày 10 đơn thử: hỏi Khang trước khi chạy, chỉ thao tác đơn thử của mình.

**Files:**
- Modify: `scripts/smoke/lazada.ts`, `scripts/smoke/tiktok.ts` (thêm lệnh nếu cần), `src/modules/channel/channel/CLAUDE.md`, Documents `tich-hop-san/lazada.md`, `tiktok.md`

- [ ] **Step 1: Lazada** (Git Bash cần `MSYS_NO_PATHCONV=1`): một đơn thử mới `pending` → providers → pack (ghi `package_id`, `tracking_number`) → RTS → vận đơn PDF (lưu tệp, mở được). Một đơn thử khác: pack → repack → kiểm `/order/items/get` món về `pending`, `package_id` rỗng hay còn.
- [ ] **Step 2: TikTok**: đơn thử `AWAITING_SHIPMENT` → `npm run smoke:tiktok -- ship <kiện>` → shipping_documents ra PDF.
- [ ] **Step 3: Ghi kết quả** (request_id, tên tham số repack, số kiện tối đa mỗi lời gọi vận đơn nếu thử được, việc gắn lại mã cũ sau repack) vào `channel/CLAUDE.md` và Documents; sửa `DOCUMENT_BATCH` hay tên tham số repack nếu khác (kèm test).
- [ ] **Step 4: Commit** `docs(channel): kết quả gọi thật đóng gói, RTS, repack, vận đơn (#239)`.

---

### Task 9: Cột mới, migration, `Package` có `carrier` và cờ `label_error`

**Files:**
- Modify: `src/modules/order/fulfillment/repository/schema.ts`, `repository/packages.ts` (`updatePackage`)
- Modify: `src/modules/order/fulfillment/service/views.ts`, `api/schemas.ts` (`PACKAGE_FLAGS`)
- Create: `db/migrations/<sinh>_dong-goi-rts.sql` (+ `meta`)
- Test: `test/integration/order/fulfillment/constraints.test.ts`, `test/integration/order/fulfillment/packages-read.test.ts`

**Interfaces:**
- Produces: cột `packages.carrier_code text`, `carrier_name text`, `label_error boolean not null default false`; CHECK `packages_carrier` = `(carrier_code is null) = (carrier_name is null)`. `updatePackage` nhận thêm `carrierCode: string | null`, `carrierName: string | null`, `labelError: boolean`, `packedBy: string | null`, `packedAt: Date | null`, và `platformPackageCode: string | null`. `PACKAGE_FLAGS` có `'label_error'`; `toPackageSummary` trả `carrier: p.carrierCode ? { code: p.carrierCode, name: p.carrierName! } : null`, `flags` có `label_error` khi `p.labelError`.

- [ ] **Step 1: Viết test hỏng:**
  - `constraints.test.ts`: `it('CHECK packages_carrier: có mã mà không tên bị chặn')` (update thẳng bằng `testPool()`, kỳ vọng lỗi `23514` tên `packages_carrier`).
  - `packages-read.test.ts`: `it('GET /packages/:id trả carrier và cờ label_error từ cột')` (seed rồi update cột bằng `testPool()`; `Package.parse(body)`; `carrier` = `{ code: 'GHN', name: 'Giao Hàng Nhanh' }`, `flags` chứa `label_error`).
- [ ] **Step 2: Sửa `schema.ts`**, rồi sinh migration **một lần**, vì schema đã chốt: `npm run db:generate -- --name dong-goi-rts`. Đọc SQL sinh ra: chỉ có `ADD COLUMN` (cột null; `label_error` mặc định hằng nên chỉ đổi metadata, không ghi lại bảng) và `ADD CONSTRAINT … CHECK` (bảng nhỏ, quét nhanh; mọi dòng cũ null nên qua). Không cần `NOT VALID`. Nếu sau này `schema.ts` phải đổi thêm thì xoá migration này và sinh lại, không sửa tay.
- [ ] **Step 3: Chạy** test → FAIL (view chưa đọc cột).
- [ ] **Step 4: Cài đặt** `updatePackage`, `views.ts`, `PACKAGE_FLAGS` (thêm mô tả `label_error` vào `.meta` của `flags`).
- [ ] **Step 5: Chạy** `npx vitest run --project integration test/integration/order/fulfillment/constraints.test.ts test/integration/order/fulfillment/packages-read.test.ts` và `npm run db:migrate:check` → PASS.
- [ ] **Step 6: Commit** `feat(fulfillment): cột nhà vận chuyển, cờ Lỗi lấy vận đơn (#239)`.

---

### Task 10: Luật thuần `domain/packing.ts`

**Files:**
- Create: `src/modules/order/fulfillment/domain/packing.ts`
- Test: `test/unit/modules/order/fulfillment/domain/packing.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PackLine { variantId: string | null; quantity: number }
  export interface ScannedLine { variantId: string; quantity: number }
  /** null khi khớp; không thì map `lines.<variantId>` → câu báo. */
  export function scanMismatch(lines: readonly PackLine[], scanned: readonly ScannedLine[]): Record<string, string> | null;
  export interface GroupMember { code: string; status: PackageStatus; orderStatus: 'unpaid' | 'processing' | 'completed' | 'cancelled' }
  /** Mã các kiện khác trong nhóm chặn đóng gói: trạng thái ngoài {reserved, packed} hoặc đơn chưa processing. */
  export function packGroupBlockers(others: readonly GroupMember[]): string[];
  /** Mã các kiện khác trong nhóm chưa packed. */
  export function readyGroupBlockers(others: readonly Pick<GroupMember, 'code' | 'status'>[]): string[];
  export interface PickRow { packageId: string; variantId: string | null; sku: string; productName: string; attributesLabel: string; quantity: number }
  export interface PickListLine { variantId: string | null; sku: string; productName: string; attributesLabel: string; quantity: number; packageCount: number }
  export function buildPickList(rows: readonly PickRow[]): PickListLine[];
  ```

- [ ] **Step 1: Viết test hỏng:**
  - `scanMismatch`: khớp (hai dòng cùng biến thể gộp 1+2, quét 3) → `null`; quét thiếu → `{ 'lines.<v>': 'Kiện cần 3, đã quét 2' }`; quét thừa → câu "Kiện cần 1, đã quét 2"; món ngoài kiện → câu "Món này không có trong kiện"; kiện toàn dòng chưa ghép, `scanned: []` → `null`; kiện có dòng ghép mà `scanned: []` → có lỗi đúng khoá.
  - `packGroupBlockers`: `[{code:'K2',status:'packed',orderStatus:'processing'}]` → `[]`; `reserved` + `unpaid` → `['K2']`; `awaiting_pickup` → `['K2']`; `[]` → `[]`.
  - `readyGroupBlockers`: `reserved` → `['K2']`; `packed` → `[]`.
  - `buildPickList`: hai kiện cùng biến thể (2 + 1) → một dòng `quantity: 3, packageCount: 2`; dòng chưa ghép gộp theo `sku`, `variantId: null`; sắp theo `sku`.
- [ ] **Step 2: Chạy** `npx vitest run test/unit/modules/order/fulfillment/domain/packing.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt** (thuần, không import ngoài `domain/package.ts`).
- [ ] **Step 4: Chạy** test → PASS.
- [ ] **Step 5: Commit** `feat(fulfillment): luật thuần so số quét, nhóm gói, danh sách nhặt (#239)`.

---

### Task 11: Repository đóng gói, `GET /pick-list`, `GET /packages/:id/carriers`

**Files:**
- Create: `src/modules/order/fulfillment/repository/packing.ts`, `service/packing.ts`
- Modify: `api/routes.ts`, `api/schemas.ts`, `api/openapi.ts`
- Modify: `test/integration/order/fulfillment/helpers.ts`
- Test: `test/integration/order/fulfillment/packing-read.test.ts`

**Interfaces:**
- Consumes: `buildPickList`, `PickListLine` (Task 10); `MarketplacePackages.carriers` (Task 6); `ctx.orderRefsOf`.
- Produces (repository/packing.ts):
  ```ts
  export interface PackingPackage {
    id: string; code: string; orderId: string; shopId: string | null; status: PackageStatus; version: number;
    selfDelivery: boolean; platformPackageCode: string | null; trackingCode: string | null; labelError: boolean;
    lines: { id: string; orderLineId: string; variantId: string | null; quantity: number; reservedQty: number }[];
  }
  export async function readPackingPackage(id: string): Promise<PackingPackage | undefined>;   // không khoá
  export async function lockPackingPackage(id: string): Promise<PackingPackage | undefined>;   // FOR UPDATE
  export async function packageGroupOf(shopId: string, platformPackageCode: string): Promise<{ id: string; code: string; orderId: string; status: PackageStatus; version: number }[]>; // chưa huỷ, sắp theo id
  export async function platformItemsOf(packageId: string): Promise<{ externalOrderId: string; externalLineIds: string[] }>; // join "order".order_lines, "order".orders
  export async function setLinesPacked(packageId: string, packed: boolean): Promise<void>;
  export async function pickListBase(f: { ids: readonly string[] } | { limit: number }): Promise<{ rows: { packageId: string; orderId: string; orderLineId: string; variantId: string | null; quantity: number }[]; packageIds: string[]; truncated: boolean }>;
  ```
  `packageGroupOf` dùng được index `packages_platform_code_order_uq (shop_id, platform_package_code, order_id)`; `pickListBase` không `ids` lọc như tab `reserved` của `package-list.ts` (dùng lại điều kiện tab), `limit + 1` để biết `truncated`.
- Produces (service/packing.ts):
  ```ts
  export async function pickList(ctx: FulfillmentContext, ids: readonly string[] | undefined): Promise<{ items: PickListLine[]; packageCount: number; truncated: boolean }>;
  export async function carriersOf(ctx: FulfillmentContext, companyId: string, id: string): Promise<{ items: { code: string; name: string; isDefault: boolean }[] }>;
  ```
  Nhãn `sku`, `productName`, `attributesLabel` lấy từ `ctx.orderRefsOf(orderIds)` (`PackageOrderRef.lines`), không tự dựng nhãn.
- Produces (schemas.ts): `idsCsv(max: number)` (chuỗi UUID phân cách bằng dấu phẩy → mảng, không trùng, 1..max; lỗi ở `errors.ids`), `PickListQuery`, `PickList`, `CarrierList` (`.meta({ id })`).
- Produces (helpers.ts): `seedPackage` thêm `platformPackageCode?: string | null`, `selfDelivery?: boolean`; bảo đảm `order_lines.external_line_id` có giá trị (nếu `createOrder` để null thì điền `L-<uuid>`). Thêm:
  ```ts
  export function packingApp(fake: Partial<MarketplacePackages>): ReturnType<typeof request>;
  // = request(createApp({ ...createModuleContext(), marketplacePackages: { ...throwingPackages, ...fake } }))
  // throwingPackages: mọi hàm ném Error('cổng sàn không được gọi trong test này')
  ```

- [ ] **Step 1: Viết test hỏng** (`packing-read.test.ts`):
  - `it('US-DH-06 AC1: danh sách nhặt mặc định gộp kiện tab reserved theo biến thể, kèm số kiện')`: 2 kiện `reserved` (biến thể A ×2, A ×1 + B ×1), 1 kiện `reserved` của đơn `unpaid`, 1 kiện `packed` → `items` = A `quantity 3, packageCount 2`, B `quantity 1, packageCount 1`; `packageCount` 2; `truncated: false`; `PickList.parse(body)`.
  - `it('danh sách nhặt theo ids: chỉ các kiện đó, bỏ qua id của công ty khác')`.
  - `it('ids quá 200 hoặc trùng: 422 errors.ids')`.
  - `it('nhà vận chuyển kiện đơn tay: items rỗng, không gọi cổng')` (kiện không `shopId`, `packingApp({})`).
  - `it('nhà vận chuyển kiện sàn: gọi cổng với mã đơn, mã món sàn của kiện')` (cổng giả ghi tham số; kiểm `externalLineIds` đúng các dòng của kiện).
  - `it('D2-03q: Sale gọi pick-list, carriers nhận 403')` (`addMember(companyId, 'sale')`).
- [ ] **Step 2: Chạy** `npx vitest run --project integration test/integration/order/fulfillment/packing-read.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt** repository, service, route (`GET /pick-list` khai **trước** `GET /packages/:id`), schemas, OpenAPI (khuôn `openapi.ts` hiện có; mô tả quyền và mã lỗi).
- [ ] **Step 4: Chạy** test → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(fulfillment): danh sách nhặt, nhà vận chuyển của kiện (#239)`.

---

### Task 12: `POST /packages/:id/pack`

**Files:**
- Modify: `service/packing.ts`, `api/routes.ts`, `api/schemas.ts`, `api/openapi.ts`
- Test: `test/integration/order/fulfillment/pack.test.ts`

**Interfaces:**
- Consumes: `scanMismatch`, `packGroupBlockers` (Task 10); `readPackingPackage`, `lockPackingPackage`, `packageGroupOf`, `platformItemsOf`, `setLinesPacked` (Task 11); `updatePackage` (Task 9); `MarketplacePackages.pack` (Task 6); `withSessionLock` (`shared/db/client.ts`); `assertTransition`, `recordTransition`, `publishEvent` (core); `getPackage` (`service/packages.ts`); `Actor` (`service/handover.ts`).
- Produces:
  ```ts
  export const PACKAGE_LOCK_WAIT_MS = 10_000;
  /** Bản chi tiết kiện mà route trả (R7). */
  export type PackageDetail = Awaited<ReturnType<typeof getPackage>>;
  /** Chạy fn trong khoá phiên `fulfillment.package:<id>`; bận quá hạn thì 409 version_conflict kèm current. */
  export async function withPackageLock<T>(ctx: FulfillmentContext, companyId: string, id: string, fn: () => Promise<T>): Promise<T>;
  export async function packPackage(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number; lines: ScannedLine[]; carrierCode?: string }): Promise<PackageDetail>;
  export const PackBody: z.ZodType; // { version, lines (0..200, variantId uuid không trùng, quantity int 1..10000), carrierCode? (1..100) }
  ```
  Luồng đúng spec 5.4 mục `pack` (bước 1 kiểm, 2 gọi sàn, 3 ghi, ca "đã ở đích" khi `version` đổi). Lỗi nhóm: `new AppError(409, 'package_group_not_ready', 'Gói gộp còn kiện chưa sẵn sàng: K-1, K-2')`. Bước 3 lỗi sau khi sàn nhận lệnh: `logger.error({ err, packageId, platformPackageCode }, 'sàn đã đóng gói, app chưa ghi; lượt kéo đơn sẽ khớp')`.

- [ ] **Step 1: Viết test hỏng** (`pack.test.ts`, `packingApp`, kho là `addMember(…,'warehouse')`, tồn qua `receive` như `hand-over.test.ts`):
  - `it('D2-03 US-DH-06 AC2: kiện sàn reserved, đơn processing, quét đủ → packed, có mã kiện sàn, vận đơn, packed_qty, lịch sử, sự kiện')`: cổng `pack` trả `{ packageCode: 'FP1', trackingCode: 'LZ1', carrier: null }` → `status: 'packed'`, `platformPackageCode: 'FP1'`, `trackingCode: 'LZ1'`, `carrier: null`; dòng `packed_qty = quantity`; `transitionsOf` có `pack` với `actor_id` của kho; outbox `package_status_changed` `reserved → packed`.
  - `it('kiện đơn tay: không gọi cổng, vẫn packed')`.
  - `it('NTFS: cổng trả carrier thì lưu carrier_code, carrier_name')`.
  - `it('D2-03g: đơn chưa processing → 409 order_not_processing, không gọi cổng')`.
  - `it('US-DH-06 AC3: quét lệch → 422 scan_mismatch, errors["lines.<variantId>"], không gọi cổng')`.
  - `it('US-DH-06 AC4: cổng ném 422 errors.carrierCode → trả nguyên, kiện vẫn reserved')`.
  - `it('US-DH-06 AC5: cổng ném 409 item_not_packable → kiện vẫn reserved, version không đổi')`.
  - `it('Review Focus 2: cổng ném 409 shop_not_connected → kiện vẫn reserved')`.
  - `it('sai version → 409 version_conflict kèm current')`.
  - `it('đua với lượt kéo đơn: sàn đã áp packed cùng mã giữa lúc gọi sàn → trả packed, lịch sử chỉ một dòng pack')`: cổng `pack` giả, trước khi trả, dùng `testPool()` đặt kiện `packed`, `platform_package_code = 'FP1'`, `version + 1` và chèn một dòng `core.state_transitions` `actor_id` null; kỳ vọng 200, `status: 'packed'`, số dòng lịch sử `pack` = 1.
  - `it('Review Focus 1: hai request đóng gói đua nhau chỉ gọi sàn một lần')`: cổng `pack` chờ 200 ms rồi trả; gửi hai request cùng `version` bằng `Promise.all` → cổng gọi đúng 1 lần; một response 200, response kia 200 (`packed`) hoặc 409 `version_conflict`.
  - `it('Review Focus 3: kiện toàn dòng chưa ghép, lines rỗng → packed')`.
  - `it('nhóm gói: kiện kia của nhóm thuộc đơn unpaid → 409 package_group_not_ready, detail có mã kiện')` (hai `seedPackage` cùng `shopId`, cùng `platformPackageCode`, khác đơn).
  - `it('nhóm gói: kiện kia đã packed → đóng gói được')`.
- [ ] **Step 2: Chạy** `npx vitest run --project integration test/integration/order/fulfillment/pack.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt** `withPackageLock`, `packPackage`, route, `PackBody`, OpenAPI (409: `version_conflict`, `invalid_transition`, `order_not_processing`, `package_group_not_ready`, `package_status_not_allowed`, `item_not_packable`, `shop_not_connected`, `marketplace_rejected`, `marketplace_unauthorized`; 422: `scan_mismatch`, `validation_failed`; 503).
- [ ] **Step 4: Chạy** test → PASS.
- [ ] **Step 5: Commit** `feat(fulfillment): đóng gói kiện, gọi sàn ngoài giao dịch trong khoá theo kiện (#239)`.

---

### Task 13: `POST /packages/:id/ready`, cờ Lỗi lấy vận đơn

**Files:**
- Modify: `service/packing.ts`, `service/platform-packages.ts`, `api/routes.ts`, `api/schemas.ts`, `api/openapi.ts`
- Test: `test/integration/order/fulfillment/ready.test.ts`, `test/integration/order/fulfillment/platform-handover.test.ts` (hoặc file đồng bộ kiện tương ứng)

**Interfaces:**
- Consumes: `withPackageLock` (Task 12); `readyGroupBlockers` (Task 10); `packageGroupOf`, `lockPackingPackage` (Task 11); `MarketplacePackages.readyToShip` (Task 6).
- Produces:
  ```ts
  export async function markReady(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number }): Promise<PackageDetail>;
  export const ReadyBody: z.ZodType; // { version }
  ```
  Luồng spec 5.4 mục `ready` (bước 2b bật `label_error` trong giao dịch riêng rồi ném lỗi gốc; bước 3 khoá các kiện của nhóm theo `id` tăng dần). `changeStatus` trong `platform-packages.ts`: khi `from === 'packed'` và kiện có `label_error` thì ghi `labelError: false` cùng lần cập nhật.

- [ ] **Step 1: Viết test hỏng:**
  - `it('D2-04 US-DH-07 AC1: kiện Lazada packed → gọi cổng với mã kiện sàn, awaiting_pickup, lịch sử mark_ready')`.
  - `it('D2-04g US-DH-07 AC5: kiện tự giao → 409 self_delivery, không gọi cổng')` (`seedPackage` `selfDelivery: true`).
  - `it('D2-04q: Sale gọi ready → 403')`.
  - `it('US-DH-07 AC4: cổng ném 503 → kiện vẫn packed, có label_error; bấm lại thành công thì hết cờ')` (bấm lại với `version` mới).
  - `it('Review Focus 2: cổng ném 409 marketplace_unauthorized → packed, có label_error')`.
  - `it('kiện sàn chưa có mã kiện sàn → 409 rts_package_not_found, không gọi cổng')`.
  - `it('kiện đơn tay → awaiting_pickup, không gọi cổng')`.
  - `it('lượt kéo đơn đã áp awaiting_pickup giữa lúc gọi sàn → trả awaiting_pickup, không 409')`.
  - `it('nhóm gói: một kiện còn reserved → 409 package_group_not_ready')`.
  - `it('nhóm gói: cả nhóm packed → cổng gọi đúng một lần, cả nhóm awaiting_pickup, mỗi kiện một dòng lịch sử')`.
  - (file đồng bộ kiện) `it('sàn đưa kiện packed có label_error sang awaiting_pickup → xoá cờ')`.
- [ ] **Step 2: Chạy** hai file test → FAIL.
- [ ] **Step 3: Cài đặt** `markReady`, sửa `changeStatus`, route, `ReadyBody`, OpenAPI.
- [ ] **Step 4: Chạy** test + toàn bộ `test/integration/order/fulfillment` (bảo đảm đồng bộ kiện cũ không vỡ) → PASS.
- [ ] **Step 5: Commit** `feat(fulfillment): báo sàn sẵn sàng giao, cờ Lỗi lấy vận đơn, nhóm gói (#239)`.

---

### Task 14: `POST /packages/:id/open` (chỉ từ `packed`)

**Files:**
- Modify: `service/packing.ts`, `api/routes.ts`, `api/schemas.ts`, `api/openapi.ts`
- Test: `test/integration/order/fulfillment/open.test.ts`

**Interfaces:**
- Consumes: `withPackageLock`, `lockPackingPackage`, `setLinesPacked`, `updatePackage`; `stockPort().reserve` (`service/stock-port.ts`); `markLinesReserved`, `setReserved` hoặc tương đương (`repository/packages.ts`) để đánh dấu dòng đã giữ và `reserved_at`; `stockHoldLookupOf(ctx)` (`service/packages.ts`); `MarketplacePackages.repack` (Task 6).
- Produces:
  ```ts
  export async function openPackage(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number }): Promise<PackageDetail>;
  export const OpenBody: z.ZodType; // { version }
  ```
  Luồng spec 5.4 mục `open`. Giữ hàng lúc mở phát `publishEvent({ type: 'fulfillment.allocation_done', aggregateId: companyId, payload: { variantIds } })`, `variantIds` sắp tăng, bỏ trùng (khuôn `createPackage` ở `platform-packages.ts:183-187`).

- [ ] **Step 1: Viết test hỏng:**
  - `it('kiện Lazada packed có mã kiện sàn: gọi repack, về reserved, xoá mã kiện sàn, vận đơn, nhà vận chuyển, packed_qty về 0, vẫn giữ hàng')` (`stockOfVariant` không đổi `reserved`).
  - `it('TikTok: cổng trả not_supported → reserved, giữ mã kiện sàn')`.
  - `it('kiện awaiting_pickup → 409 invalid_transition, không gọi cổng')`.
  - `it('kiện packed chưa giữ hàng, đủ hàng → giữ cả kiện, phát allocation_done, reserved')` (seed `packed` dòng không `reserved`; outbox `fulfillment.allocation_done` có `variantIds` của kiện).
  - `it('kiện packed chưa giữ hàng, không đủ hàng → 422 insufficient_stock, vẫn packed, không gọi cổng')`.
  - `it('kiện packed chưa giữ hàng của gian hàng chờ kiểm kê → 409 shop_awaiting_stocktake')` (`channelShop(companyId, true)`).
  - `it('cổng repack ném 409 package_status_not_allowed → vẫn packed, mã kiện sàn còn')`.
  - `it('sai version → 409 version_conflict')`.
- [ ] **Step 2: Chạy** test → FAIL.
- [ ] **Step 3: Cài đặt** `openPackage`, route, `OpenBody`, OpenAPI.
- [ ] **Step 4: Chạy** test → PASS.
- [ ] **Step 5: Commit** `feat(fulfillment): mở lại kiện đóng nhầm (packed), đóng gói lại trên sàn (#239)`.

---

### Task 15: `GET /packages/documents` (vận đơn PDF)

**Files:**
- Create: `src/modules/order/fulfillment/service/documents.ts`
- Modify: `package.json` (`pdf-lib`), `api/routes.ts`, `api/schemas.ts`, `api/openapi.ts`
- Test: `test/integration/order/fulfillment/documents.test.ts`

**Interfaces:**
- Consumes: `findPackagesByIds` (`repository/package-list.ts`); `MarketplacePackages.shippingDocuments` (Task 6); `idsCsv` (Task 11).
- Produces:
  ```ts
  export const MAX_DOCUMENT_TOTAL_BYTES = 50 * 1024 * 1024;
  export async function packageDocuments(ctx: FulfillmentContext, companyId: string, ids: readonly string[]): Promise<{ pdf: Uint8Array; filename: string }>;
  export async function mergePdfs(files: readonly Uint8Array[]): Promise<Uint8Array>; // pdf-lib; tệp hỏng → AppError 503 marketplace_unavailable 'Sàn trả tệp vận đơn hỏng, thử lại sau'
  export const PackageDocumentsQuery: z.ZodType; // { ids: idsCsv(50), kind: z.enum(['awb']).default('awb') }
  ```
  `filename` = `van-don-<YYYYMMDD-HHmm>.pdf` theo giờ `Asia/Ho_Chi_Minh`. Route: `res.type('application/pdf').set('Content-Disposition', \`attachment; filename="${filename}"\`).send(Buffer.from(pdf))`, khai **trước** `GET /packages/:id`.

- [ ] **Step 1: Cài thư viện** `npm install pdf-lib` (bản ổn định mới nhất đã phát hành ít nhất hai tuần; ghi bản vào `package.json` như các dependency khác).
- [ ] **Step 2: Viết test hỏng** (cổng giả trả PDF dựng bằng `pdf-lib` trong test: mỗi tệp 1 trang có chữ mã kiện):
  - `it('US-DH-07 AC2: ba kiện hai gian hàng, hai kiện chung mã nhóm → cổng gọi hai lần, mã nhóm một lần, ra một PDF đủ trang')`: `Content-Type` `application/pdf`, `Content-Disposition` khớp `/^attachment; filename="van-don-\d{8}-\d{4}\.pdf"$/`, `PDFDocument.load(body).getPageCount()` = số tệp cổng trả.
  - `it('US-DH-07 AC3 + Review Focus 4: có kiện chưa có mã kiện sàn hoặc kiện đơn tay → 409 document_not_ready, detail liệt kê đúng mã, không gọi cổng')`.
  - `it('kiện của công ty khác → 404')`.
  - `it('ids 0 hoặc 51, kind lạ → 422')`.
  - `it('cổng ném 409 document_not_ready (TikTok chưa giao kiện) → trả nguyên dạng Problem Details JSON')`.
  - `it('Review Focus 5: cổng trả byte không phải PDF → 503 marketplace_unavailable, không gửi tệp')`.
  - `it('Sale gọi documents → 403')`.
- [ ] **Step 3: Chạy** `npx vitest run --project integration test/integration/order/fulfillment/documents.test.ts` → FAIL.
- [ ] **Step 4: Cài đặt** `documents.ts` (gom theo gian hàng theo thứ tự xuất hiện, bỏ trùng mã, tối đa 3 gian hàng cùng lúc, kiểm tổng byte ≤ `MAX_DOCUMENT_TOTAL_BYTES` → 422 `errors.ids` 'Chọn ít kiện hơn'), route, schema, OpenAPI (response `content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } }`).
- [ ] **Step 5: Chạy** test → PASS.
- [ ] **Step 6: Commit** `feat(fulfillment): in vận đơn PDF gộp nhiều kiện, nhiều sàn (#239)`.

---

### Task 16: Hoàn tất PR2: tài liệu module, kiểm toàn bộ

**Files:**
- Modify: `src/modules/order/fulfillment/CLAUDE.md`
- Modify: `test/integration/order/fulfillment/*` nếu `npm run check` báo

- [ ] **Step 1: `fulfillment/CLAUDE.md`**: mục mới "Đóng gói, báo sẵn sàng giao, vận đơn (#239)" (ba bước gọi sàn, khoá phiên, ca "đã ở đích", nhóm gói, `label_error`, `open` chỉ `packed`); thêm 6 route vào bảng Route; mục "Cho module khác" thêm hàm cổng `marketplacePackages`; mục "Giới hạn đã biết" thêm lịch sử ghi sàn khi lượt kéo đơn thắng đua, gắn lại mã cũ sau repack, mở kiện `awaiting_pickup` chờ #238; sửa dòng "Chưa làm: … đóng gói, RTS (#239)".
- [ ] **Step 2: Gộp `main`** nếu #300 đã merge: `git fetch origin && git merge origin/main`, rồi `npm run db:regen`, commit `db/migrations`.
- [ ] **Step 3: Chạy** `npm run check` → xanh (lint, typecheck, depcruise, test). Lỗi depcruise thì sửa import, không nới luật.
- [ ] **Step 4: Chạy** `graphify update .`.
- [ ] **Step 5: Commit** `docs(fulfillment): CLAUDE.md đóng gói, RTS, vận đơn (#239)`. Hỏi Khang trước khi push, mở PR (PR1 channel và PR2 fulfillment theo spec D13: tách nhánh `feature/239-channel` từ các commit Task 2–8 nếu Khang muốn hai PR).

---

### Task 17: FE nối API thật (repo `D:\DA-TMDT\FE`, `pnpm`)

**Files:**
- Modify: `src/api/fulfillment.api.ts` (`usePickList`), `src/types/fulfillment.ts` (`PickList`), `src/mocks/handlers/fulfillment.ts` (pick-list trả `{ items, packageCount, truncated }`), file câu báo lỗi theo mã (tìm nơi map `scan_mismatch` hiện có)
- Modify: màn kiện (`src/features/fulfillment/…`) ẩn nút "Dỡ kiện về kệ" khi `awaiting_pickup`
- Create: `e2e/be/pN/<tên>.spec.ts` (đặt `pN` theo quy ước thư mục `e2e/be/` hiện có)

- [ ] **Step 1: Nhánh** `git switch -c feature/239-dong-goi-rts origin/main` trong repo FE.
- [ ] **Step 2: Sửa test đơn vị đang có** (`pickList.test.ts`, test của hook) cho hình `{ items, packageCount, truncated }`, `variantId` có thể `null` → chạy `pnpm test` → FAIL.
- [ ] **Step 3: Cài đặt** hook, kiểu, mock, câu báo cho `package_group_not_ready`, `insufficient_stock`, `shop_awaiting_stocktake`, `document_not_ready` ("thử lại sau ít phút" khi từ TikTok), nhãn cờ `label_error`; ẩn nút mở kiện ở `awaiting_pickup`.
- [ ] **Step 4: E2E** `e2e/be/pN/`: danh sách nhặt → quét đóng gói → sẵn sàng giao → in vận đơn (BE trỏ sàn giả lập Task 7). Chạy `pnpm e2e` trên máy → PASS.
- [ ] **Step 5: Commit** `feat(fulfillment): nối API đóng gói, RTS, vận đơn (commerio-backend#239)`. Hỏi Khang trước khi push.

---

## Kiểm lại plan so với spec

- Spec mục 1 (mục tiêu 1–4) → Task 11–15; mục 2 bằng chứng gọi thật → Task 1, 8.
- D1 → Task 12–14 (`withPackageLock`, ba bước). D2, D3 → Task 2, 4, 5, 15. D4 → Task 9. D5 → Task 10, 12, 13, 15. D6 → Task 14, Task 1. D7, D8 → Task 3–6. D9 → Task 13. D10 → Task 10, 11, 12. D11 → Task 3, 11. D12 → Task 4, 13. D13 → Task 16 (tách PR).
- 5.1 → Task 9. 5.2 → Task 10. 5.3 → Task 2–7. 5.4 → Task 11–15. 5.5 → OpenAPI và test trong Task 11–15. 5.6 → Task 12–13 (đua, khoá), Task 13 (xoá cờ khi đồng bộ). 5.7 → Task 2, 15. 5.8: không có task riêng (giới hạn đồng thời trong Task 5, 15). 5.9 → test trong từng task; smoke → Task 8; E2E → Task 17. Mục 7 → Task 17. Mục 8 → Task 1, 8.
- Lệch spec đã ghi lại: test 403/422 đặt ở `integration/`, không ở `api/`, vì cần đăng nhập thật (`test/CLAUDE.md`: `api/` không có DB); `NO_RETRY` không thêm (spec 5.3 đã sửa).
