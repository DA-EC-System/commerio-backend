# #239 Sửa báo sẵn sàng giao và in vận đơn sau test đêm 18/11: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sửa bốn lỗi Thành báo trên #239 ngày 19/11/2026 (KH-B02, KH-B03, KH-B07, TRA-B06) ở BE, ghi mẫu smoke trên shop thử thật, viết lại E2E để đủ DoD đóng #239. Phần giao diện giao Khoa ở issue FE riêng.

**Architecture:** Channel thêm năng lực tuỳ chọn `packageTracking` cho adapter (TikTok Get Package Detail) và cổng `readyToShip` trả `{ trackingCode }`; đổi mã sàn 21042061 sang mã app `cancel_requested`. Fulfillment ghi mã vận đơn sau khi báo giao, chặn báo giao khi đơn có cờ `cancel_requested` (không bật `label_error`), thêm cờ `cancel_requested` cho `Package`, chỉ in vận đơn kiện có mã kiện sàn và mã vận đơn. Cổng in vận đơn đổi Lazada 50008 (đơn SOF) sang `document_not_supported`. Không đổi schema, không migration.

**Tech Stack:** Node.js 24, Express 5, TypeScript 6, Zod 4, Drizzle + PostgreSQL 18, Vitest + Testcontainers. Smoke: `npm run smoke:tiktok`, `npm run smoke:lazada`.

**Spec:** issue #239 (thân sửa 17/11/2026) và comment của Thành ngày 19/11/2026 (test đêm 18/11, staging FE 2a82a75, BE eb49bba2). Các quyết định Thành chưa chốt nằm ở mục "Quyết định" dưới; Khang chọn làm theo đề xuất trước, báo Thành khi mở PR (Task 8).

## Quyết định (chờ Thành xác nhận ở Task 8)

- **Q1 (KH-B03, Khang chốt lại 19/11 sau smoke Lazada):** in được khi kiện có mã kiện sàn **và** mã vận đơn (sàn đã cấp vận đơn), không xét trạng thái, không rẽ nhánh theo sàn. Lazada in ngay sau khi đóng gói (smoke: đơn thường in được trước RTS, request_id 0babf4c817950931301642182, và sau RTS); TikTok chỉ có vận đơn sau Ship Package, nên in sau khi báo giao (nhờ KH-B02). Thiếu thì 409 `document_not_ready`, không gọi sàn. Đổi AC US-DH-07 dòng 2 và `21` §19.3.
- **Q2 (SOF Lazada, chốt sau smoke 19/11):** `/order/package/document/get` của đơn SOF (`shipping_provider_type: seller_own_fleet`) trả `result.error_code` "50008", `error_msg` "not support operation for  sof order" cả trước RTS (0bb4a98017950932714583794), sau RTS (0bafca0117950932788822131) lẫn khi đã giao. Lỗi KH-000123 là ca này. Task 6 đổi 50008 sang 409 `document_not_supported`, chỉ ở cổng in vận đơn.
- **Q3 (KH-U13, báo nhiều kiện):** ngoài phạm vi #239, đề xuất issue riêng ở Task 8.
- **Q4 (KH-B07):** chặn trước khi gọi sàn bằng cờ `cancel_requested` của đơn (lượt kéo 5 phút); sàn báo 21042061 (app chưa kịp thấy cờ) đi cùng mã. Cả hai không bật `label_error` vì bấm lại không giúp, phải chờ Sale.
- **Q5 (KH-B02):** đọc mã sau RTS lỗi thì chỉ log `warn` và trả `trackingCode: null`: sàn đã nhận báo giao, lượt kéo đơn sẽ điền mã. Không làm hỏng request.

## Global Constraints

- Worktree `D:\DA-TMDT\commerio-backend\.claude\worktrees\239-sua-rts`, nhánh `feature/239-sua-rts-van-don` (từ `origin/main` bbdd297b). PR vào `main`. Worktree thiếu gói thì junction như `local-env-quirks` (vd `drizzle-kit`).
- Import tương đối có đuôi `.ts`; không `enum`, `namespace`, parameter property.
- Định danh tiếng Anh; comment, câu lỗi, tài liệu tiếng Việt.
- Lỗi nghiệp vụ `AppError(status, code, message, extensions?)`; lỗi sàn đổi sang mã app giữ `platformCode`, `platformMessage` (`21` R8).
- `order` không import `channel`: gọi sàn qua `ctx.marketplacePackages`. Code ngoài adapter không rẽ nhánh theo sàn.
- Gọi sàn ngoài giao dịch nghiệp vụ.
- Test chỉ trong `test/**/*.test.ts`, import `#src/...ts`, không gọi mạng thật, tên `describe`/`it` tiếng Việt, lỗi API kiểm `status` + `type`. Ca mới của AC mang mã ca D2 khi có (`D2-04`), kèm mã lỗi test đêm (`KH-B02`…) trong tên `it`.
- Không log token, URL ký vận đơn.
- Commit message tiếng Việt, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Không push, không mở PR, không comment issue khi Khang chưa đồng ý.
- Trước khi xin review: `npm run check` trong worktree. `graphify update .` chạy ở bản checkout chính sau khi merge (worktree không có `graphify-out/`).

## Review Focus

1. **Nhóm gói TikTok nhiều kiện cùng mã sàn**: mã vận đơn sàn trả phải ghi lên mọi kiện vừa chuyển `awaiting_pickup` của nhóm, không chỉ kiện đang bấm. Test ở Task 3.
2. **Đơn khác trong nhóm gói đang xin huỷ** (kiện bấm thuộc đơn không xin huỷ): vẫn 409 `cancel_requested`, không gọi sàn. Test ở Task 4.
3. **Sàn từ chối 21042061 lúc app chưa thấy cờ**: kiện giữ `packed`, `label_error` không bật, `version` không tăng. Test ở Task 4.
4. **Đọc mã vận đơn lỗi hay sàn chưa cấp**: request vẫn 200 `awaiting_pickup`, mã đã có (vd mã Lazada lúc pack) không bị ghi đè bằng null. Test ở Task 1 (cổng) và Task 3 (kiện).
5. **In lô có kiện có vận đơn lẫn kiện chưa có**: 409 `document_not_ready` liệt kê đúng mã kiện chưa có vận đơn, không gọi sàn cho kiện nào. Test ở Task 5.
6. **Lazada 50008 chỉ đổi ở cổng in vận đơn**: pack, RTS, repack gặp 50008 vẫn `marketplace_rejected`. Test ở Task 6.

---

## Cấu trúc file

| File | Việc |
|---|---|
| `src/modules/channel/channel/service/marketplaces/common.ts` | `packageTracking?` trên `MarketplaceAdapter` |
| `src/modules/channel/channel/service/marketplaces/tiktok-orders.ts` | `packageTracking` (Get Package Detail 202309) |
| `src/modules/channel/channel/service/order-actions.ts` | `marketplaceReadyToShip` trả `{ trackingCode }`; 21042061 → `cancel_requested` |
| `scripts/smoke/tiktok.ts` | Lệnh `package <packageId>` |
| `src/modules/order/fulfillment/service/packages.ts` | Kiểu `MarketplacePackages.readyToShip` |
| `src/modules/order/fulfillment/service/packing.ts` | `markReady`: ghi mã vận đơn, chặn `cancel_requested`, câu `rts_package_not_found` |
| `src/modules/order/fulfillment/service/views.ts`, `api/schemas.ts` | `PackageOrderRef.cancelRequested`, cờ `cancel_requested` |
| `src/modules/order/sales/service/orders.ts` | `packageOrderRef` điền `cancelRequested` |
| `src/modules/order/fulfillment/service/documents.ts`, `api/openapi.ts` | Chặn in kiện chưa có vận đơn trên sàn |
| `src/modules/order/fulfillment/CLAUDE.md`, `src/modules/channel/channel/CLAUDE.md` | Ghi luật mới |
| Documents: `21-hop-dong-api-fe-be.md`, `27-user-story.md`, `tich-hop-san/tiktok.md`, `tich-hop-san/lazada.md` | Hợp đồng, AC, mẫu smoke |
| FE: `e2e/be/p4/dong-goi-rts-van-don.spec.ts` | E2E với BE thật, shop thử Lazada thật |

---

### Task 1: Channel đọc mã vận đơn sau RTS, đổi mã 21042061

**Files:**
- Modify: `src/modules/channel/channel/service/marketplaces/common.ts` (interface `MarketplaceAdapter`, cạnh `readyToShip` dòng ~801)
- Modify: `src/modules/channel/channel/service/marketplaces/tiktok-orders.ts` (kiểu `Pick<…>` của `tiktokOrderMethods`, thêm hàm cạnh `shipPackage`)
- Modify: `src/modules/channel/channel/service/order-actions.ts` (`packageErrors`, `marketplaceReadyToShip`)
- Modify: `scripts/smoke/tiktok.ts` (lệnh `package`)
- Modify: `src/modules/channel/channel/CLAUDE.md` (mục "Đóng gói, RTS, vận đơn (#239)" và đoạn mã lỗi ngay sau)
- Test: `test/unit/modules/channel/channel/service/marketplaces/tiktok-packing.test.ts`, `test/unit/modules/channel/channel/service/order-actions.test.ts`

**Interfaces:**
- Produces: `MarketplaceAdapter.packageTracking?(accessToken: string, packageCode: string): Promise<string | null>`; `marketplaceReadyToShip(companyId: string, shopId: string, packageCode: string): Promise<{ trackingCode: string | null }>`; mã app `cancel_requested` (409) cho TikTok 21042061.

- [ ] **Step 1: Viết test adapter (fail)** trong `tiktok-packing.test.ts`, `describe('RTS và vận đơn TikTok')`:

```ts
it('đọc mã vận đơn của kiện: ưu tiên shipping_info, không có thì trường phẳng, chưa có thì null (KH-B02)', async () => {
  const data: Record<string, unknown> = {
    A: { package_id: 'A', shipping_info: [{ tracking_number: 'TT-A1' }, { tracking_number: 'TT-A2' }], tracking_number: 'CU' },
    B: { package_id: 'B', tracking_number: 'TT-B' },
    C: { package_id: 'C', tracking_number: '' },
  };
  const { adapter, calls } = fake((path) => ({ code: 0, data: data[path.split('/').at(-1)!] }));
  expect(await adapter.packageTracking!(token, 'A')).toBe('TT-A1');
  expect(await adapter.packageTracking!(token, 'B')).toBe('TT-B');
  expect(await adapter.packageTracking!(token, 'C')).toBeNull();
  expect(calls.map((c) => [c.method, c.url.pathname])).toContainEqual(['GET', '/fulfillment/202309/packages/A']);
});
```

- [ ] **Step 2: Viết test cổng (fail)** trong `order-actions.test.ts`: thêm `['21042061', 'cancel_requested']` vào bảng `it.each` đầu file; thêm:

```ts
it('báo giao xong thì đọc mã vận đơn nếu sàn có; đọc lỗi hay sàn không có thì null, không ném (KH-B02)', async () => {
  const readyToShip = vi.fn(async () => {});
  session({ readyToShip, packageTracking: async () => 'TT-1' });
  await expect(marketplaceReadyToShip('c', 's', 'P1')).resolves.toEqual({ trackingCode: 'TT-1' });
  expect(readyToShip).toHaveBeenCalledWith('token', ['P1']);
  session({ readyToShip, packageTracking: async () => { throw new MarketplaceError('unavailable'); } });
  await expect(marketplaceReadyToShip('c', 's', 'P1')).resolves.toEqual({ trackingCode: null });
  session({ readyToShip });
  await expect(marketplaceReadyToShip('c', 's', 'P1')).resolves.toEqual({ trackingCode: null });
});
```

- [ ] **Step 3: Chạy, thấy fail**

Run: `npx vitest run --project unit test/unit/modules/channel/channel/service/marketplaces/tiktok-packing.test.ts test/unit/modules/channel/channel/service/order-actions.test.ts`
Expected: FAIL (`packageTracking` không phải hàm; 21042061 ném nguyên lỗi; cổng trả `undefined`).

- [ ] **Step 4: Cài đặt**
  - `common.ts`: khai `packageTracking?` với JSDoc "Mã vận đơn của kiện trên sàn sau khi báo giao; null khi sàn chưa cấp. Sàn có vận đơn từ lúc đóng gói (Lazada) không khai."
  - `tiktok-orders.ts`: `GET /fulfillment/202309/packages/{package_id}` qua `client.call`, lấy `shipping_info[0].tracking_number`, rỗng thì `tracking_number`, rỗng nữa thì `null` (docv2 Get Package Detail, tra 19/11/2026: `shipping_info` là trường mới, trường phẳng cho dữ liệu cũ). Thêm `'packageTracking'` vào `Pick`.
  - `order-actions.ts`: `['21042061', ['cancel_requested', 'Khách đang xin huỷ đơn trên sàn, chờ Sale trả lời yêu cầu huỷ']]`. `marketplaceReadyToShip` sau `onPackageAction(readyToShip)` gọi `adapter.packageTracking` nếu có, trong `try/catch`: lỗi thì `logger.warn({ err, shopId, packageCode }, 'đã báo sàn sẵn sàng giao, chưa đọc được mã vận đơn; lượt kéo đơn sẽ lấy')` và trả `{ trackingCode: null }`. Import `logger` từ `../../../../shared/logger.ts`.
  - `scripts/smoke/tiktok.ts`: lệnh `package <packageId>` (chỉ đọc) gọi `adapter.packageTracking!(session(), id)`, `printStep('packageTracking (fulfillment/202309/packages/{package_id})', true, { packageId, trackingCode })`; `loggingFetch` in phản hồi gốc.
  - `channel/CLAUDE.md`: mục #239 thêm "TikTok đọc mã vận đơn sau Ship Package bằng Get Package Detail (`packageTracking`); đọc lỗi chỉ log, lượt kéo đơn điền"; đoạn mã lỗi thêm "TikTok 21042061 → `cancel_requested`".

- [ ] **Step 5: Chạy lại, thấy pass**

Run: lệnh ở Step 3. Expected: PASS. Rồi `npx tsc --noEmit` (kiểu `MarketplacePackages.readyToShip` cũ là `Promise<void>` vẫn nhận hàm trả object nên chưa lỗi).

- [ ] **Step 6: Commit**

```bash
git add src/modules/channel scripts/smoke/tiktok.ts test/unit/modules/channel
git commit -m "feat(channel): đọc mã vận đơn TikTok sau khi báo giao, đổi 21042061 sang cancel_requested (#239)"
```

---

### Task 2: Smoke trên shop thử thật (Khang thao tác Seller Center, Partner Center)

**Trạng thái:** Lazada xong 19/11/2026 (Step 3, Step 4; kết quả ở Q1, Q2). TikTok (Step 1, Step 2) hoãn.

Chạy trên `feature/239-sua-rts-van-don` sau Task 1. Ghi lại phản hồi gốc (bỏ token, URL ký) vào file nháp trong scratchpad để Task 7 chép vào Documents. Không có test tự động; kết quả quyết định Task 6.

- [ ] **Step 1: TikTok, mã vận đơn sau Ship Package.** Tạo đơn thử (Partner Center → Development Shops → Test functions → Create test order), chuyển `AWAITING_SHIPMENT`. `npm run smoke:tiktok -- order <orderId>` lấy `package_id`; `npm run smoke:tiktok -- ship <packageId>`; ngay sau đó `npm run smoke:tiktok -- package <packageId>`.
  Expected: `trackingCode` khác null, khớp `tracking_number` của `order <orderId>` gọi lại. Null thì gọi lại sau 10, 30 giây, ghi độ trễ (khi đó KH-B02 chỉ đỡ một phần, ghi vào PR).
- [ ] **Step 2: TikTok, 21042061.** Đơn thử thứ hai: khách xin huỷ (Test functions hoặc tài khoản buyer thử), rồi `ship <packageId>`.
  Expected: lỗi `platformCode` 21042061. Mã khác thì sửa bảng ở Task 1 Step 4 theo mã thật, chạy lại test Task 1.
- [ ] **Step 3: Lazada, mẫu phản hồi pack, RTS, vận đơn.** Đơn thử "Create Test Case" gói `standard`. `MSYS_NO_PATHCONV=1 npm run smoke:lazada -- call GET /order/items/get order_id=<id>` lấy `order_item_id`; gọi `/order/fulfill/pack` (TFS), `/order/package/rts`, `/order/package/document/get` như `lazada.md` §7.4. Ghi JSON mỗi bước kèm `request_id`.
- [ ] **Step 4: Lazada SOF.** Đơn thử sản phẩm "Shipped by Seller" (như đơn 530326804480318, `lazada.md` §11.1): `/order/items/get` ghi `shipping_provider_type`, `delivery_option_sof`; pack, RTS, rồi `/order/package/document/get`.
  Expected một trong hai: in được (ghi lại, bỏ Task 6), hoặc lỗi "not support operation for sof order" (ghi `code`, chạy Task 6).

---

### Task 3: Fulfillment ghi mã vận đơn sau khi báo giao (KH-B02)

**Files:**
- Modify: `src/modules/order/fulfillment/service/packages.ts:66` (`MarketplacePackages.readyToShip`)
- Modify: `src/modules/order/fulfillment/service/packing.ts` (`markReady`, bước gọi sàn và bước ghi)
- Modify: `test/integration/order/fulfillment/packing-actions.test.ts` (`ready()` trả `{ trackingCode: null }`), các fake `readyToShip` khác (`grep -rn "readyToShip" test/integration`)
- Modify: `src/modules/order/fulfillment/CLAUDE.md` (mục "Đóng gói, báo sẵn sàng giao, vận đơn (#239)")
- Test: `test/integration/order/fulfillment/packing-actions.test.ts`

**Interfaces:**
- Consumes: `marketplaceReadyToShip(...) → { trackingCode: string | null }` (Task 1), nối sẵn ở `src/wiring.ts`.
- Produces: `MarketplacePackages.readyToShip(companyId: string, shopId: string, packageCode: string): Promise<{ trackingCode: string | null }>`.

- [ ] **Step 1: Đổi kiểu và fake.** Sửa kiểu ở `packages.ts`; mọi fake `readyToShip` trong `test/integration` trả `{ trackingCode: null }` (fake ném lỗi giữ nguyên).
- [ ] **Step 2: Viết test (fail)** trong `describe('báo sẵn sàng giao')`:

```ts
it('D2-04 KH-B02: lưu mã vận đơn sàn trả cho mọi kiện của nhóm gói', async () => {
  const { packageId } = await seed('packed', { platformPackageCode: 'FP-TRACK' });
  const other = await seed('packed', { platformPackageCode: 'FP-TRACK' });
  const res = await post(packageId, 'ready', { version: 1 }, { readyToShip: async () => ({ trackingCode: 'TT-1' }) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(Package.parse(res.body)).toMatchObject({ status: 'awaiting_pickup', trackingCode: 'TT-1' });
  expect(await packageRow(other.packageId)).toMatchObject({ status: 'awaiting_pickup', tracking_code: 'TT-1' });
});

it('KH-B02: sàn chưa cấp mã vận đơn thì giữ mã đã có từ lúc đóng gói', async () => {
  const { packageId } = await seed('packed', { platformPackageCode: 'FP-KEEP', trackingCode: 'LZ-OLD' });
  const res = await post(packageId, 'ready', { version: 1 }, { readyToShip: async () => ({ trackingCode: null }) });
  expect(res.status).toBe(200);
  expect(res.body.trackingCode).toBe('LZ-OLD');
});
```

(`packageRow` trả cột snake_case; nếu helper không có `tracking_code` thì đọc thẳng bằng `testPool().query`.)

- [ ] **Step 3: Chạy, thấy fail**

Run: `npx vitest run --project integration test/integration/order/fulfillment/packing-actions.test.ts`
Expected: ca KH-B02 đầu FAIL (`trackingCode` null), ca thứ hai PASS sẵn.

- [ ] **Step 4: Cài đặt** trong `markReady`: giữ kết quả `readyToShip` (kiện `waybillKept` không gọi sàn: `trackingCode = null`); bước ghi `updatePackage(member.id, { status: 'awaiting_pickup', labelError: false, ...(trackingCode !== null && { trackingCode }) })` cho mỗi kiện vừa chuyển. Kiện đã `awaiting_pickup` do lượt kéo không ghi thêm (lượt kéo tự điền). CLAUDE.md: "Báo giao xong ghi mã vận đơn sàn trả (TikTok) lên các kiện vừa chuyển; sàn chưa cấp thì giữ mã cũ."
- [ ] **Step 5: Chạy lại cả thư mục, thấy pass**

Run: `npx vitest run --project integration test/integration/order/fulfillment`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/order/fulfillment test/integration/order/fulfillment
git commit -m "fix(fulfillment): lưu mã vận đơn sàn trả khi báo sẵn sàng giao (#239 KH-B02)"
```

---

### Task 4: Chặn báo giao khi khách đang xin huỷ, cờ `cancel_requested` (KH-B07, TRA-B06)

**Files:**
- Modify: `src/modules/order/fulfillment/service/views.ts` (`PackageOrderRef`, `toPackageSummary` cờ)
- Modify: `src/modules/order/fulfillment/api/schemas.ts:25` (`PACKAGE_FLAGS`, mô tả `flags`)
- Modify: `src/modules/order/sales/service/orders.ts:172` (`packageOrderRef`)
- Modify: `src/modules/order/fulfillment/service/packing.ts` (`markReady`)
- Modify: `src/modules/order/fulfillment/api/openapi.ts:84` (409 của `ready` thêm `cancel_requested`)
- Modify: `src/modules/order/fulfillment/CLAUDE.md` (mục #239, bảng route `POST /packages/:id/ready`)
- Test: `test/integration/order/fulfillment/packing-actions.test.ts`, `test/integration/order/fulfillment/packages-read.test.ts`

**Interfaces:**
- Consumes: `cancel_requested` từ `onPackageAction` (Task 1); `orders.cancel_requested` (sales, có sẵn).
- Produces: `PackageOrderRef.cancelRequested: boolean`; `PACKAGE_FLAGS` thêm `'cancel_requested'`; lỗi 409 `cancel_requested` của `POST /packages/:id/ready`.

- [ ] **Step 1: Viết test (fail).** `packing-actions.test.ts`, `describe('báo sẵn sàng giao')`; đặt cờ bằng `testPool().query('update "order".orders set cancel_requested = true where id = $1', [orderId])`:
  - `it('KH-B07: đơn khách đang xin huỷ thì 409 cancel_requested, không gọi sàn, không bật label_error')`: kiện `packed` có mã sàn; `readyToShip = vi.fn()`; `expectProblem(…, 409, 'cancel_requested')`; `expect(readyToShip).not.toHaveBeenCalled()`; dòng kiện `{ status: 'packed', label_error: false, version: 1 }`.
  - `it('KH-B07: đơn khác trong nhóm gói đang xin huỷ cũng chặn')`: hai kiện cùng `platformPackageCode`, cờ bật trên đơn của kiện kia; bấm kiện này → 409 `cancel_requested`.
  - `it('KH-B07: sàn báo khách đang xin huỷ (21042061) thì giữ packed, không bật label_error')`: `readyToShip` ném `new AppError(409, 'cancel_requested', '…')`; dòng kiện `{ status: 'packed', label_error: false, version: 1 }`.
  - `packages-read.test.ts`: `it('KH-B07: kiện chưa bàn giao của đơn khách đang xin huỷ mang cờ cancel_requested; kiện đã bàn giao thì không')`: `GET /api/v1/fulfillment/packages/:id`, `flags` chứa `'cancel_requested'` với kiện `packed`; kiện `in_transit` (seed riêng, đơn của nó cũng bật cờ) không chứa. Kiểm thêm `Package.parse(res.body)` qua.
- [ ] **Step 2: Chạy, thấy fail**

Run: `npx vitest run --project integration test/integration/order/fulfillment/packing-actions.test.ts test/integration/order/fulfillment/packages-read.test.ts`
Expected: FAIL (200 thay vì 409; `label_error` true; thiếu cờ).

- [ ] **Step 3: Cài đặt**
  - `views.ts`: `PackageOrderRef.cancelRequested: boolean` (JSDoc: "Khách đang xin huỷ trên sàn, chờ Sale trả lời (cờ `cancel_requested` của đơn)"); `flags` thêm `cancel_requested` khi `order.cancelRequested && PRE_HANDOVER.includes(p.status)` (`PRE_HANDOVER` ở `domain/package.ts:202`), đứng sau `needs_attention`.
  - `schemas.ts`: thêm `'cancel_requested'` vào `PACKAGE_FLAGS`; mô tả: "`cancel_requested`: khách đang xin huỷ đơn, chờ Sale trả lời; kiện chưa báo sàn sẵn sàng giao được".
  - `sales/service/orders.ts`: `cancelRequested: o.cancelRequested`.
  - `packing.ts`: hằng `cancelRequestedError = () => new AppError(409, 'cancel_requested', 'Khách đang xin huỷ đơn, chờ Sale trả lời yêu cầu huỷ rồi mới báo sàn sẵn sàng giao')`. Trong bước kiểm của `markReady`, ngay sau khi có `others`: một lần `orderRefsLookupOf(ctx)` cho đơn của kiện và các kiện trong nhóm, đơn nào `cancelRequested` thì ném. Khối `catch` quanh `readyToShip`: lỗi `AppError` mã `cancel_requested` ném lại ngay, không bật `label_error`. Câu 409 `rts_package_not_found` khi kiện chưa có mã sàn đổi thành "Sàn chưa cấp mã kiện cho đơn này (đơn còn chờ sàn duyệt). Kéo đơn ngay rồi thử lại" (TRA-B06).
  - `openapi.ts`, `CLAUDE.md`: thêm `cancel_requested` vào lỗi của `ready`; ghi luật "chặn khi đơn của kiện hay kiện cùng nhóm có cờ `cancel_requested`; sàn báo 21042061 cùng mã; cả hai không bật `label_error`".
- [ ] **Step 4: Chạy cả module order, thấy pass**

Run: `npx vitest run --project integration test/integration/order && npx tsc --noEmit`
Expected: PASS (chi tiết đơn của sales dùng chung `toPackageSummary`, nên test sales parse `Order` cũng phải qua với cờ mới).

- [ ] **Step 5: Commit**

```bash
git add src/modules/order test/integration/order
git commit -m "fix(fulfillment): chặn báo sẵn sàng giao khi khách đang xin huỷ, cờ cancel_requested trên kiện (#239 KH-B07, TRA-B06)"
```

---

### Task 5: Chỉ in vận đơn kiện sàn đã cấp vận đơn (KH-B03)

**Files:**
- Modify: `src/modules/order/fulfillment/service/documents.ts` (`packageDocuments`, vòng gom `missing`)
- Modify: `src/modules/order/fulfillment/api/openapi.ts` (mô tả route `documents`)
- Modify: `src/modules/order/fulfillment/CLAUDE.md` (bảng route `GET /packages/documents`)
- Test: `test/integration/order/fulfillment/documents.test.ts`, `test/integration/order/fulfillment/packing-wiring.test.ts` (seed thêm mã vận đơn)

**Interfaces:**
- Produces: `GET /fulfillment/packages/documents` trả 409 `document_not_ready` khi có kiện thiếu `shopId`, `platformPackageCode` hay `trackingCode`, không xét trạng thái; `detail` liệt kê mã kiện.

- [ ] **Step 1: Viết test (fail)** trong `documents.test.ts`:
  - `it('US-DH-07 AC3 KH-B03: kiện chưa có mã vận đơn thì 409 document_not_ready, không gọi sàn')`: kiện `packed` có mã sàn, `trackingCode: null` cùng một kiện in được → 409, `detail` chứa mã kiện (chỉ một mã), fake `shippingDocuments` không bị gọi.
  - `it('KH-B03: kiện đã đóng gói có mã vận đơn in được, chưa cần báo sàn sẵn sàng giao')`: kiện `packed` có mã sàn và `trackingCode` → 200 PDF.
  - Ca cũ seed `awaiting_pickup` không có `trackingCode` thì thêm `trackingCode` vào seed.
- [ ] **Step 2: Chạy, thấy fail**

Run: `npx vitest run --project integration test/integration/order/fulfillment/documents.test.ts`
Expected: ca đầu FAIL (sàn bị gọi), ca thứ hai PASS sẵn.

- [ ] **Step 3: Cài đặt**: kiện thiếu `shopId`, `platformPackageCode` hoặc `trackingCode` vào một danh sách; câu `Kiện ${list} chưa có vận đơn trên sàn`. OpenAPI, CLAUDE.md: "In được kiện có mã kiện sàn và mã vận đơn; thiếu thì 409 `document_not_ready`".
- [ ] **Step 4: Chạy cả thư mục fulfillment, thấy pass**

Run: `npx vitest run --project integration test/integration/order/fulfillment`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/order/fulfillment test/integration/order/fulfillment
git commit -m "fix(fulfillment): chỉ in vận đơn kiện sàn đã cấp vận đơn (#239 KH-B03)"
```

---

### Task 6: Lazada 50008 (đơn SOF) ở cổng in vận đơn sang `document_not_supported`

**Files:**
- Modify: `src/modules/channel/channel/service/order-actions.ts` (`onPackageAction` nhận bảng mã riêng tuỳ chọn; `marketplaceShippingDocuments` truyền `documentErrors`)
- Modify: `src/modules/order/fulfillment/api/openapi.ts` (409 của `documents`), `src/modules/channel/channel/CLAUDE.md`
- Test: `test/unit/modules/channel/channel/service/order-actions.test.ts`

Không đưa 50008 vào bảng chung `packageErrors` (bảng đó dùng cho cả pack, RTS, repack; 50008 có thể là mã chung "không hỗ trợ thao tác").

- [ ] **Step 1:** test: cổng in vận đơn gặp 50008 → 409 `document_not_supported`, giữ `platformCode`, `platformMessage`; cổng pack, RTS gặp 50008 vẫn `marketplace_rejected`. Chạy, thấy FAIL.
- [ ] **Step 2:** `documentErrors` có `['50008', ['document_not_supported', 'Sàn không cấp vận đơn cho kiện người bán tự giao (SOF), in phiếu giao của shop']]`, truyền vào `onPackageAction` ở `marketplaceShippingDocuments`; chạy lại, PASS.
- [ ] **Step 3: Commit** `fix(channel): đổi lỗi vận đơn đơn SOF Lazada sang document_not_supported (#239)`.

---

### Task 7: Documents (worktree riêng của repo Documents)

Repo `D:\DA-TMDT\Documents`, nhánh `docs/239-sua-rts-van-don` từ `origin/main` (worktree `D:\DA-TMDT\Documents-239`). Mỗi mục ghi "commerio-backend#239, test đêm 18/11/2026".

- [ ] **Step 1: `21-hop-dong-api-fe-be.md`**
  - §19.2 `Package.flags[]` thêm `cancel_requested` ("khách đang xin huỷ, chờ Sale trả lời; chỉ khi kiện chưa bàn giao").
  - Bảng thao tác kiện, dòng `mark_ready`: "Sinh mã vận đơn: Lazada có từ lúc `pack`; TikTok app đọc từ sàn ngay sau khi báo giao, sàn chưa cấp thì lượt kéo đơn điền".
  - Route `POST /fulfillment/packages/:id/ready`: thêm 409 `cancel_requested` (đơn của kiện hay kiện cùng nhóm có cờ `cancel_requested`, kiểm trước khi gọi sàn); không bật `label_error`.
  - Route `GET /fulfillment/packages/documents`: "In được kiện có mã kiện sàn và mã vận đơn (Lazada từ lúc đóng gói, TikTok sau khi báo giao). Thiếu thì 409 `document_not_ready`; đơn SOF Lazada 409 `document_not_supported`".
  - Bảng mã lỗi sàn: thêm dòng `cancel_requested` | TikTok `21042061` | "Khách đang xin huỷ đơn, chờ Sale trả lời yêu cầu huỷ"; sửa câu FE của `rts_package_not_found` khi app chưa có mã: "Sàn chưa cấp mã kiện cho đơn này (đơn còn chờ sàn duyệt). Bấm Kéo đơn ngay rồi thử lại". Thêm dòng `document_not_supported` | Lazada `50008` (chỉ ở in vận đơn) | "Sàn không cấp vận đơn cho kiện người bán tự giao (SOF), in phiếu giao của shop".
- [ ] **Step 2: `27-user-story.md`** US-DH-07: dòng 2 "Chọn 1–50 kiện **sàn đã cấp vận đơn**…"; dòng 3 thêm "hoặc chưa có vận đơn trên sàn"; thêm dòng 6 "Đơn có cờ khách xin huỷ | Sẵn sàng giao | 409 `cancel_requested`, không gọi sàn, không bật cờ Lỗi lấy vận đơn | (chưa có ca)".
- [ ] **Step 3: `tich-hop-san/tiktok.md`**: Get Package Detail (đường dẫn, trường `shipping_info`, kết quả Task 2 Step 1 kèm request_id, độ trễ có mã), 21042061 (Task 2 Step 2).
- [ ] **Step 4: `tich-hop-san/lazada.md`**: §11.2 thêm mẫu JSON pack, RTS, `document/get` (Task 2 Step 3, bỏ `pdf_url` ký); mục mới "Đơn SOF và vận đơn" (Task 2 Step 4).
- [ ] **Step 5: Commit** `21, 27, sàn: báo giao ghi vận đơn, chặn khi khách xin huỷ, in sau RTS (commerio-backend#239)`.

---

### Task 8: Kiểm tra, mở PR, báo Thành (cần Khang đồng ý từng bước ra ngoài)

- [ ] **Step 1:** `npm run check` trong worktree. Expected: lint, typecheck, depcruise, test đều đạt. Ca hỏng có sẵn trên main thì ghi rõ, không sửa trong PR này.
- [ ] **Step 2:** Kiểm `origin/main` có PR mới merge chạm `fulfillment/service/packing.ts`, `order-actions.ts` (`git fetch origin && git log HEAD..origin/main --oneline -- src/modules/order/fulfillment src/modules/channel/channel/service/order-actions.ts`); có thì gộp main, chạy lại Step 1.
- [ ] **Step 3 (Khang đồng ý):** push nhánh BE và Documents, mở hai PR vào `main`; thân PR liệt kê KH-B02/B03/B07, TRA-B06, kết quả smoke, mục "Quyết định" Q1–Q5, link issue FE của Khoa; ghi rõ không có migration.
- [ ] **Step 4 (Khang đồng ý):** comment lên #239 tóm tắt Q1–Q5 để Thành chốt, đề xuất issue riêng cho báo nhiều kiện (Q3).

---

### Task 9: E2E với BE thật và shop thử Lazada thật (FE repo, sau khi BE merge và deploy staging)

**Files:**
- Modify: `D:\DA-TMDT\FE\e2e\be\p4\dong-goi-rts-van-don.spec.ts` (nhánh FE `test/239-e2e-san-that`)

- [ ] **Step 1:** Bỏ chặn `hostname !== '127.0.0.1'` và ghi chú sàn giả lập; điều kiện chạy chỉ còn đủ `E2E_PACKING_EMAIL`, `E2E_PACKING_PASSWORD`, `E2E_PACKING_COMPANY_ID`, `E2E_PACKING_CODE` (kiện `reserved` của đơn "Create Test Case" mới trên staging). Chú thích đầu file: chạy với `PW_BASE_URL` là FE staging, mỗi lần tốn một đơn thử (tối đa 10 đơn/ngày).
- [ ] **Step 2:** Thay `platformPackageCode: 'FP600000000000001'` bằng `expect(pkg.platformPackageCode).toMatch(/^FP\d+$/)` và `expect(pkg.trackingCode).toBeTruthy()`; sau `ready` kiểm `status: 'awaiting_pickup'`; in vận đơn kiểm `content-type` `application/pdf`. Nút In vận đơn có khi kiện có mã vận đơn (Q1; Lazada ngay sau đóng gói, FE của Khoa).
- [ ] **Step 3:** Chạy `PW_BASE_URL=<FE staging> npx playwright test e2e/be/p4/dong-goi-rts-van-don.spec.ts --project=be` (máy Khang không có pnpm). Expected: 1 passed. Ghi request_id pack, RTS vào thân PR FE.
- [ ] **Step 4 (Khang đồng ý):** commit, mở PR FE; tick hai ô "Việc cần làm" và các ô DoD đã đạt trên #239.
