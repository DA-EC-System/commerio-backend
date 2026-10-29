# Cổng tồn, lõi ghi sổ (#111) và phiếu nhận hàng (#109): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kho có một lõi duy nhất đổi tồn thực và chờ xử lý (#111). Trên lõi đó làm phiếu nhận hàng: lập, kiểm đếm, ghi sổ, giao thiếu, báo cáo NCC (#109).

**Architecture:** `inventory/service/posting.ts` giữ lõi riêng `applyMoves` và hàm nghiệp vụ `receiveGoods`; `port.ts` thêm `availableOf` và năm hàm cổng tạm. `purchasing` thêm phiếu nhận theo bốn lớp như đề nghị nhập (#108): máy trạng thái ở `domain`, câu Drizzle ở `repository`, giao dịch và thứ tự khoá ở `service`, Zod và route ở `api`. Ghi sổ chạy trong một giao dịch `withCompany`, khoá theo thứ tự: đề nghị → dòng đề nghị → phiếu nhận → dòng tồn.

**Tech Stack:** Node 24 (chạy thẳng `.ts`), Express 5, Zod 4, Drizzle ORM + PostgreSQL 18, decimal.js, Vitest + testcontainers.

**Spec:**
- `docs/superpowers/specs/2026-10-28-111-cong-ton-ghi-so-design.md` (gọi tắt **S111**)
- `docs/superpowers/specs/2026-10-28-109-phieu-nhan-hang-design.md` (gọi tắt **S109**)

## Global Constraints

- Import tương đối có đuôi `.ts`; không `enum`, `namespace`, parameter property (lớp lỗi khai trường rồi gán trong constructor).
- Tiền: `numeric(18,2)` trong DB, chuỗi hoặc `Decimal` trong code, số nguyên đồng ở API (`toDong`).
- Lỗi nghiệp vụ là `AppError(status, code, message, extensions)`; lỗi theo ô là 422 với `errors: { "<đường dẫn>": "<câu tiếng Việt>" }`.
- Route: `ctx.authorize(...)` đặt trước `validate(...)`. Service mở `withCompany`; `withCompany` không lồng được. Hàm cổng của inventory chạy trong giao dịch của bên gọi.
- Thứ tự khoá cho mọi thao tác ghi lên phiếu nhận và đề nghị: `lockRequest` → `lockLines` → `lockReceipt` → (catalog) → `lockLevel` theo `variantId` tăng dần. So `version` sau khi khoá.
- Test chỉ đặt trong `test/`; import code bằng `#src/...ts`. Integration test cần Docker đang chạy.
- Dùng `npm`. Chạy `npm run check` trước mỗi PR. Migration sinh bằng `npm run db:generate -- --name <tên>`, không viết tay.
- Câu cho người đọc viết tiếng Việt; định danh viết tiếng Anh.
- Commit kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Thân PR kết thúc bằng `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- File trong `docs/superpowers/` bị `.gitignore` cục bộ của plugin chặn, nên phải `git add -f`.

## Nhánh và PR

PR #141 và #142 (đề nghị nhập) chưa merge, nên mọi nhánh dưới đây xếp chồng lên `feature/108-de-nghi-nhap`. Mỗi PR mở vào `develop`, thân ghi "Merge #… trước". Khi PR dưới được merge thì rebase nhánh trên lên `develop`.

| PR | Nhánh | Tách từ | Task |
|---|---|---|---|
| #111 | `feature/111-cong-ton` | `feature/108-de-nghi-nhap` | 1–3 |
| #109 A | `feature/109-phieu-nhan` | `feature/111-cong-ton` | 4–6 |
| #109 B | `feature/109-ghi-so` | `feature/109-phieu-nhan` | 7 |
| #109 C | `feature/109-giao-thieu-bao-cao` | `feature/109-ghi-so` | 8–10 |
| #109 D | đính kèm, `evidence_required` | sau #114 | ngoài plan này |

## Chỗ plan chọn khác hoặc chốt thêm so với spec

1. **Lập phiếu với `requestId` không thấy:** trả 422 `errors.requestId = 'Chọn đề nghị nhập'` như mock FE, không trả 404 như S109 §6.9. `requestId` là một ô trong body, giống cách `add-line` của #108 đang làm.
2. **Số chứng từ:** dùng lại `docNumber(prefix, n)` có sẵn ở `purchasing/domain/request.ts`. Không thêm `formatNumber`.
3. **`checkTransition`:** hàm này đang nằm riêng trong `request-actions.ts`. Plan chuyển nó sang `service/transitions.ts` dạng generic để phiếu nhận dùng chung.
4. **PR A:** `post` và `post_short` đi qua route nhưng trả 501 `not_implemented` cho tới PR B, để PR A vẫn đúng hình hợp đồng.
5. **Báo cáo NCC:** trả mọi NCC của công ty, kể cả NCC đã ngừng giao dịch (như mock FE), xếp theo tên.
6. **`PUT` phiếu:** trả 422 khi `lineId` không thuộc phiếu hoặc bị lặp trong `lines`. Mock FE bỏ qua hai trường hợp này mà không báo gì.
7. **Không làm trong plan:**
   - dọn `inventory.receipt_posted` và `inventory.issue_posted` cũ trong `events.ts` (S111 §10; việc này cần PR sự kiện riêng);
   - `box_count`;
   - nhắc việc quá 24 giờ.

## Review Focus

1. **`lineId` sai trong `PUT /goods-receipts/:id`:** `lineId` không thuộc phiếu, hoặc gửi hai lần → 422 theo ô và không ghi dòng nào. Test ở Task 6.
2. **Phiếu chỉ có hàng trả tại chỗ** (đạt 0, lỗi 0, báo giao > 0): ghi sổ được, không tạo dòng thẻ kho, không phát `stock_changed`, không lập phiếu trả NCC. Test ở Task 7.
3. **SKU đã lưu trữ hoặc ngừng nhập** sau khi đặt NCC, rồi hàng mới về: lõi vẫn nhận, vì `getVariants` trả cả biến thể `archived`. Test ở Task 2.
4. **Bấm ghi sổ hai lần với cùng `version`:** lần hai trả 409 `version_conflict`; tồn chỉ tăng một lần, phiếu trả NCC chỉ có một. Test ở Task 7.
5. **Kỳ báo cáo theo ngày Việt Nam:** phiếu ghi sổ lúc 00:30 giờ VN ngày 28/10 (17:30Z ngày 27/10) được tính vào ngày 28/10, không tính vào ngày 27/10. Test ở Task 9.

---

## PR #111: `feature/111-cong-ton`

```bash
git checkout feature/108-de-nghi-nhap && git checkout -b feature/111-cong-ton
```

### Task 1: Luật thuần của tồn

**Files:**
- Modify: `src/modules/product/inventory/domain/stock.ts`
- Test: `test/unit/modules/product/inventory/domain/stock.test.ts`

**Interfaces:**
- Produces:
  - `weightedAvgCost(onHand, avgCost, qty, unitCost): Decimal`: khi `onHand ≤ 0` thì trả `unitCost` làm tròn 2 chữ số (S111 Q5).
  - `breaksInvariant(onHand: number, reserved: number): boolean`.
  - `worsens(before: { onHand: number }, after: { onHand: number; reserved: number }): boolean`.

- [ ] **Step 1: Viết test (thêm vào file đã có)**

```ts
describe('giá vốn khi tồn ≤ 0 (S111 Q5)', () => {
  it('tồn âm hoặc bằng 0 thì giá vốn mới bằng giá nhập', () => {
    expect(weightedAvgCost(-3, '80000', 5, '50000').toFixed(2)).toBe('50000.00');
    expect(weightedAvgCost(0, '0', 5, '100000').toFixed(2)).toBe('100000.00');
  });
  it('tồn dương vẫn bình quân gia quyền', () => {
    expect(weightedAvgCost(10, '80000', 5, '100000').toFixed(2)).toBe('86666.67');
  });
});

describe('không làm tệ hơn (S111 Q6)', () => {
  it('chặn khi tồn thực giảm mà kết quả vỡ bất biến', () => {
    expect(worsens({ onHand: 2 }, { onHand: -1, reserved: 0 })).toBe(true);
    expect(worsens({ onHand: 5 }, { onHand: 3, reserved: 4 })).toBe(true);
  });
  it('cho qua khi tồn thực tăng, kể cả khi vẫn còn âm', () => {
    expect(worsens({ onHand: -3 }, { onHand: -1, reserved: 0 })).toBe(false);
    expect(worsens({ onHand: -3 }, { onHand: 2, reserved: 0 })).toBe(false);
  });
  it('cho qua khi giảm mà bất biến vẫn đúng', () => {
    expect(worsens({ onHand: 5 }, { onHand: 3, reserved: 3 })).toBe(false);
  });
  it('breaksInvariant: âm, hoặc đang giữ > tồn thực', () => {
    expect([breaksInvariant(-1, 0), breaksInvariant(2, 3), breaksInvariant(2, 2)]).toEqual([true, true, false]);
  });
});
```

- [ ] **Step 2: Chạy test, kỳ vọng FAIL**

Run: `npx vitest run --project unit test/unit/modules/product/inventory/domain/stock.test.ts`
Expected: FAIL. `weightedAvgCost(-3, …)` trả sai, `worsens` và `breaksInvariant` chưa có.

- [ ] **Step 3: Sửa và thêm hàm trong `domain/stock.ts`**

`worsens = after.onHand < before.onHand && breaksInvariant(after.onHand, after.reserved)`.

- [ ] **Step 4: Chạy lại, kỳ vọng PASS** (cùng lệnh)

- [ ] **Step 5: Commit**

```bash
git add src/modules/product/inventory/domain/stock.ts test/unit/modules/product/inventory/domain/stock.test.ts
git commit -m "#111: giá vốn khi tồn ≤ 0 bằng giá nhập; luật không làm tệ hơn"
```

### Task 2: Lõi `applyMoves` và `receiveGoods`

**Files:**
- Modify: `src/modules/product/inventory/repository/levels.ts`
- Modify: `src/modules/product/inventory/service/port.ts` (export `lockedOf` cho `posting.ts` dùng)
- Create: `src/modules/product/inventory/service/posting.ts`
- Test: `test/integration/product/inventory/posting.test.ts`

**Interfaces:**
- Consumes: `breaksInvariant`, `worsens`, `weightedAvgCost`, `availableQty` (Task 1); `lockLevel`, `companyOfTransaction` (đã có); `getVariants` (catalog); `publishEvent` (core).
- Produces (`repository/levels.ts`):
  - `saveLevel(variantId: string, next: { onHand: number; quarantine: number; avgCost: string; invariantBroken: boolean }): Promise<void>`: ghi số mới, `version + 1`, `updated_at = now()`.
  - `insertMoves(rows: readonly NewMove[]): Promise<void>`, với `NewMove = { variantId; bucket: 'on_hand' | 'quarantine'; qtyChange; balanceAfter; unitCost: string | null; sourceType; sourceId; sourceLineId: string | null; doneBy: string | null }`. `companyId` lấy từ giao dịch.
- Produces (`service/posting.ts`):
  - `type StockSourceType = (typeof stockSourceType.enumValues)[number]`
  - `interface Move { variantId: string; bucket: 'on_hand' | 'quarantine'; qty: number; unitCost: string | null; sourceLineId: string | null }`
  - `class InsufficientStock extends Error { readonly variantIds: string[] }`
  - `applyMoves(source: { type: StockSourceType; id: string }, moves: readonly Move[], actorId: string | null): Promise<void>`. **Không** export ra `index.ts` (S111 Q1).
  - `interface ReceivedLine { lineId: string; variantId: string; accepted: number; defective: number; unitCost: string }`
  - `receiveGoods(receiptId: string, lines: readonly ReceivedLine[], actorId: string | null): Promise<void>`

- [ ] **Step 1: Viết test integration**

Ba hàm đọc DB ngay trong file test, dùng `testPool()` (role chủ bảng, không qua RLS):
- `levelOf(companyId, variantId)` → `select on_hand, reserved, quarantine, avg_cost, invariant_broken, version from product.stock_levels …`
- `movesOf(sourceId)` → `select bucket, qty_change, balance_after, unit_cost, source_type, source_line_id, done_by from product.stock_moves where source_id = $1 order by id`
- `stockEvents(variantId)` → `select payload from core.outbox_messages where type = 'inventory.stock_changed' and key = $1 order by id`

Dữ liệu dựng bằng `companyWithVariants`, `receive`, `archiveVariant` trong `test/integration/product/inventory/helpers.ts`. Mỗi lần gọi bọc trong `withCompany(companyId, () => …)`.

```ts
it('AC1: SKU có 10 cái giá 80.000, nhập 5 đạt giá 100.000', async () => {
  // receive(c, v, 10, 80000) rồi receiveGoods(receiptId, [{ lineId, variantId: v, accepted: 5, defective: 0, unitCost: '100000' }], actor)
  expect(await levelOf(c, v)).toMatchObject({ on_hand: 15, quarantine: 0, avg_cost: '86666.67', invariant_broken: false });
  expect(await movesOf(receiptId)).toEqual([
    { bucket: 'on_hand', qty_change: 5, balance_after: 15, unit_cost: '100000.00', source_type: 'goods_receipt', source_line_id: lineId, done_by: actor },
  ]);
  expect((await stockEvents(v)).map((e) => e.payload)).toEqual([{ variantId: v, onHand: 15, reserved: 0, available: 15 }]);
});
it('AC2: chỉ có hàng lỗi → chờ xử lý +2, giá vốn giữ nguyên, có thẻ kho quarantine, không phát stock_changed', …);
it('AC3: tồn −3 đang invariant_broken, nhập 5 giá 50.000 → on_hand 2, avg_cost 50000.00, invariant_broken false', …);
// Dựng bằng testPool: insert stock_levels (on_hand -3, avg_cost '80000', invariant_broken true)
it('AC4: applyMoves giảm on_hand xuống dưới 0 → InsufficientStock { variantIds: [v] }; stock_levels và stock_moves không đổi', …);
it('quarantine xuống dưới 0 cũng là InsufficientStock', …);
it('AC6: hai receiveGoods song song cùng SKU → tồn bằng tổng, balance_after liên tiếp', async () => {
  // tạo dòng tồn bằng một lần nhận 1 cái, rồi:
  await raceBehindLock(
    (h) => h.query('select 1 from product.stock_levels where company_id = $1 and variant_id = $2 for update', [c, v]),
    2,
    () => Promise.all([withCompany(c, () => receiveGoods(r1, [line(3)], null)), withCompany(c, () => receiveGoods(r2, [line(4)], null))]),
  );
  const balances = [...(await movesOf(r1)), ...(await movesOf(r2))].map((m) => m.balance_after).sort((a, b) => a - b);
  expect(balances[1]).toBe(8);
  expect([4, 5]).toContain(balances[0]);
});
it('biến thể của công ty khác → Error, không tạo dòng tồn nào', …);
it('Review Focus 3: SKU đã lưu trữ vẫn nhận được', …); // archiveVariant(v) rồi receiveGoods → on_hand tăng
```

- [ ] **Step 2: Chạy test, kỳ vọng FAIL**

Run: `npx vitest run --project integration test/integration/product/inventory/posting.test.ts`
Expected: FAIL vì không tìm thấy module `posting.ts`.

- [ ] **Step 3: Thêm `saveLevel`, `insertMoves` vào `levels.ts`**

- [ ] **Step 4: Viết `posting.ts` theo S111 §5.4**

Thứ tự trong `applyMoves`:
1. Bỏ các move `qty = 0`. Không còn move nào thì return.
2. `getVariants(ids)`. Id nào thiếu trong kết quả thì `throw new Error(…)`: đây là lỗi lập trình, ra 500.
3. `lockLevel` từng id, sắp tăng dần.
4. Duyệt move theo thứ tự đưa vào, giữ số chạy cho từng ngăn để tính `balanceAfter`. Move `on_hand` có `qty > 0` và có `unitCost` thì tính lại `avgCost`.
5. Với mỗi SKU: `worsens(...)` hoặc `quarantine < 0` thì gom id rồi ném một lần `InsufficientStock`.
6. `saveLevel` với `invariantBroken = breaksInvariant(onHand, reserved)`, rồi `insertMoves`.
7. Với mỗi SKU có ít nhất một move `on_hand`: `publishEvent({ type: 'inventory.stock_changed', aggregateId: variantId, payload: { variantId, onHand, reserved, available: availableQty(onHand, reserved, lockedOf(variantId)) } })`.

`receiveGoods`:
- mỗi dòng sinh tối đa hai move: `on_hand +accepted` theo `unitCost`, và `quarantine +defective` có `unitCost` nhưng không vào giá vốn;
- `sourceLineId = lineId`; nguồn là `{ type: 'goods_receipt', id: receiptId }`.

- [ ] **Step 5: Chạy lại, kỳ vọng PASS** (cùng lệnh)

- [ ] **Step 6: Commit**

```bash
git add src/modules/product/inventory test/integration/product/inventory/posting.test.ts
git commit -m "#111: lõi ghi sổ applyMoves (thẻ kho, giá vốn, bất biến, stock_changed) và receiveGoods"
```

### Task 3: Cổng `availableOf`, năm hàm tạm, export, tài liệu, PR

**Files:**
- Modify: `src/modules/product/inventory/service/port.ts`, `src/modules/product/inventory/index.ts`, `src/modules/product/inventory/CLAUDE.md`
- Test: `test/integration/product/inventory/port.test.ts`
- Documents (repo `D:\DA-TMDT\Documents`, nhánh `docs/21-cong-ton` tách từ `main`): `21-hop-dong-api-fe-be.md` §11, §11.1

**Interfaces:**
- Consumes: `stockOf`, `nextDocNumber` (đã có); `notImplemented(fn, issue)` (`shared/errors/app-error.ts`).
- Produces (export qua `inventory/index.ts`, và qua `export *` của `product/index.ts`):
  - `availableOf(variantIds: readonly string[]): Promise<Map<string, number>>`, dựng trên `stockOf`. Thêm comment `shortcut: getVariants nạp cả thuộc tính, đổi sang truy vấn chỉ lấy id nếu #104 gọi hàng nghìn id`.
  - `interface StockLine { variantId: string; quantity: number }`
  - `reserve(packageId, lines): Promise<{ reserved: boolean }>`
  - `release(packageId, lines): Promise<void>`
  - `ship(packageId, lines, opts: { actorId: string }): Promise<{ documentId: string; number: string }>`
  - `reverseShipment(packageId, lines, opts: { actorId: string; reason: string }): Promise<{ documentId: string; number: string }>`
  - `receiveBack(source: { type: 'package' | 'return_request'; id: string }, lines): Promise<{ documentId: string; number: string }>`

  Năm hàm này viết dạng hàm thường trả `Promise.reject(notImplemented('<tên>', '#111'))`, tham số có tiền tố `_`.
  - `receiveGoods`, `type ReceivedLine` (Task 2).

- [ ] **Step 1: Viết test**

```ts
it('AC5: availableOf trả biến thể của công ty, kể cả biến thể chưa có dòng tồn; bỏ id lạ', async () => {
  // A có a (chưa có tồn) và b (receive 7, setBuckets reserved 2); x là biến thể của công ty B
  const map = await withCompany(A.companyId, () => availableOf([a, b, x, 'abc']));
  expect(Object.fromEntries(map)).toEqual({ [a]: 0, [b]: 5 });
});
it.each([
  ['reserve', () => reserve('p', [])],
  ['release', () => release('p', [])],
  ['ship', () => ship('p', [], { actorId: 'u' })],
  ['reverseShipment', () => reverseShipment('p', [], { actorId: 'u', reason: 'x' })],
  ['receiveBack', () => receiveBack({ type: 'package', id: 'p' }, [])],
])('AC7: %s trả 501 not_implemented', async (_name, call) => {
  await expect(call()).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
});
it('AC8: nextDocNumber tăng 1, 2, 3 trong một công ty; công ty khác bắt đầu lại từ 1', …);
```

Import từ `#src/modules/product/index.ts` để test đúng đường mà module khác sẽ dùng.

- [ ] **Step 2: Chạy test, kỳ vọng FAIL**

Run: `npx vitest run --project integration test/integration/product/inventory/port.test.ts`
Expected: FAIL vì `availableOf` không được export.

- [ ] **Step 3: Viết `availableOf` và năm hàm tạm; export trong `inventory/index.ts`**

- [ ] **Step 4: Chạy lại, kỳ vọng PASS**

- [ ] **Step 5: Cập nhật `inventory/CLAUDE.md`**

Phần "Gọi vào" ghi các hàm export và hai luật:
- chỉ lõi đổi `on_hand` và `quarantine`;
- bất biến "không làm tệ hơn", và `stock_changed` mang số tuyệt đối, nên bên nghe đọc lại `availableOf` thay vì cộng dồn.

- [ ] **Step 6: Sửa `Documents/21` theo S111 §8, commit và mở PR Documents**

Sửa ba chỗ:
- §11.1: đổi "chờ Khang xác nhận" thành "chốt chữ ký, bản tạm ở #111"; ghi kiểu trả `{ documentId, number }`; thêm câu "bên nghe đọc lại `availableOf`";
- §11: thêm `receiveGoods`, `stockOf`, `nextDocNumber`.

Nhánh `docs/21-cong-ton` tách từ `main`. Mở PR vào `main`.

- [ ] **Step 7: `npm run check`**

Expected: exit 0; depcruise báo "no dependency violations found".

- [ ] **Step 8: Commit, push, mở PR**

```bash
git add src/modules/product/inventory test/integration/product/inventory/port.test.ts
git add -f docs/superpowers/plans/2026-10-29-111-109-cong-ton-phieu-nhan.md
git commit -m "#111: availableOf, chữ ký tạm reserve/release/ship/reverseShipment/receiveBack (501), export cổng"
git push -u origin feature/111-cong-ton
gh pr create --base develop --title "#111: cổng tồn và lõi ghi sổ" --body "…Merge #141, #142 trước…"
```

Trong thân PR, nhắc Thành về chữ ký cổng và kiểu trả `{ documentId, number }`, và nhắc người làm #104 về `availableOf` và `stock_changed`.

---

## PR #109 A: `feature/109-phieu-nhan`

### Task 4: Migration `self_approved`, máy trạng thái và luật thuần của phiếu nhận

**Files:**
- Modify: `src/modules/product/purchasing/repository/schema.ts` (thêm `selfApproved: boolean('self_approved').notNull().default(false)` vào `goodsReceipts`)
- Create: `db/migrations/0008_phieu-nhan.sql`, cùng snapshot và journal do drizzle-kit sinh
- Create: `src/modules/product/purchasing/domain/receipt-machine.ts`, `src/modules/product/purchasing/domain/receipt.ts`
- Test: `test/unit/modules/product/purchasing/domain/receipt-machine.test.ts`, `test/unit/modules/product/purchasing/domain/receipt.test.ts`

**Interfaces:**
- Produces (`receipt-machine.ts`):
  - `GOODS_RECEIPT_STATUSES` = `['counting', 'matched', 'short', 'resolved', 'cancelled'] as const`, kèm type `GoodsReceiptStatus`.
  - `RECEIPT_USER_ACTIONS` = `['post', 'post_short', 'cancel'] as const`.
  - `type GoodsReceiptAction = (typeof RECEIPT_USER_ACTIONS)[number] | 'resolve' | 'auto_resolve'`.
  - `interface GoodsReceiptRecord { createdBy: string | null; short: number }`.
  - `goodsReceiptMachine`: chép bảng FE (`D:\DA-TMDT\FE\src\lib\machines\purchasing.ts`), thêm `allowSelfApproval: true` cho `post` và `post_short`, và thêm `{ from: 'short', to: 'resolved', action: 'resolve', label: 'Ghi kết quả', permission: 'purchasing.request.manage' }`.
- Produces (`receipt.ts`):
  - `interface CountLine { announced: number; accepted: number; defectKept: number; returnedOnSpot: number; reason: string }`
  - `shortOf(l: Omit<CountLine, 'reason'>): number`
  - `countErrors(l: CountLine, i: number): Record<string, string>`
  - `toDbMode(m: 'waiting' | 'left'): 'driver_waiting' | 'driver_left'` và `fromDbMode` (chiều ngược lại)
  - `MAX_REASON = 300`

- [ ] **Step 1: Thêm cột vào schema, sinh migration**

Run: `npm run db:generate -- --name phieu-nhan`
Expected: file `db/migrations/0008_phieu-nhan.sql` chỉ có `ALTER TABLE "product"."goods_receipts" ADD COLUMN "self_approved" boolean DEFAULT false NOT NULL;`.

- [ ] **Step 2: Viết unit test**

```ts
// receipt-machine.test.ts. kho = receipt.manage, buyer = request.manage; rec = { createdBy: 'buyer', short: 0 }
it('post không thiếu → matched; post khi có thiếu → 409 has_shortage; post_short có thiếu → short', …);
it('post_short khi không thiếu → 409 no_shortage', …);
it('người lập đề nghị ghi sổ: second_person_required; canSelfApprove thì { to: matched, selfApproved: true }', …);
it('huỷ phiếu không có lý do → 422 reason_required', …);
it('resolve: kho 403 forbidden, mua hàng đi short → resolved', …);
it('auto_resolve chỉ hệ thống (actor null); người gọi → invalid_transition', …);

// receipt.test.ts
expect(shortOf({ announced: 60, accepted: 55, defectKept: 0, returnedOnSpot: 0 })).toBe(5);
expect(countErrors({ announced: 5, accepted: 4, defectKept: 2, returnedOnSpot: 0, reason: 'x' }, 1))
  .toEqual({ 'lines.1.accepted': 'Nhận đạt, lỗi giữ, trả tại chỗ cộng lại vượt số báo giao' });
expect(countErrors({ announced: 60, accepted: 55, defectKept: 0, returnedOnSpot: 0, reason: ' ' }, 0))
  .toEqual({ 'lines.0.reason': 'Ghi lý do khi có thiếu, lỗi hoặc trả tại chỗ' });
expect(countErrors({ announced: 10, accepted: 10, defectKept: 0, returnedOnSpot: 0, reason: '' }, 0)).toEqual({});
expect([toDbMode('left'), fromDbMode('driver_waiting')]).toEqual(['driver_left', 'waiting']);
```

- [ ] **Step 3: Chạy test, kỳ vọng FAIL**

Run: `npx vitest run --project unit test/unit/modules/product/purchasing/domain`
Expected: FAIL vì hai module mới chưa có.

- [ ] **Step 4: Viết `receipt-machine.ts` và `receipt.ts`**

- [ ] **Step 5: Chạy lại, kỳ vọng PASS**

- [ ] **Step 6: Commit**

```bash
git add src/modules/product/purchasing db/migrations test/unit/modules/product/purchasing
git commit -m "#109: cột goods_receipts.self_approved, máy trạng thái và luật kiểm đếm của phiếu nhận"
```

### Task 5: Repository, dựng response, lập, sửa số, huỷ, xem

**Files:**
- Create: `src/modules/product/purchasing/repository/receipts.ts`
- Create: `src/modules/product/purchasing/service/receipt-views.ts`, `service/receipts.ts`, `service/receipt-actions.ts`, `service/transitions.ts`
- Modify: `src/modules/product/purchasing/service/request-actions.ts` (dùng `checkTransition` mới)

**Interfaces:**
- Consumes:
  - `lockRequest`, `findLines`, `RequestRow`, `LineRow` (`repository/requests.ts`);
  - `outstanding`, `docNumber` (`domain/request.ts`);
  - `nextDocNumber` (inventory); `getVariants` (catalog);
  - `recordTransition`, `recordAudit`, `getStatusHistory`, `canSelfApprove`, `type StateMachine`, `type TransitionContext` (core);
  - `Actor`, `notFound`, `invalid`, `namesOf` (`request-views.ts`).
- Produces (`repository/receipts.ts`):
  - `ReceiptRow`: các cột của `goods_receipts`, trừ `company_id`, `box_count`, `updated_at`.
  - `findReceipt(id)`, `lockReceipt(id)` (`FOR UPDATE`).
  - `listReceipts(filter: { page; pageSize; search?; status?; requestId? }): Promise<{ rows: (ReceiptRow & { requestNumber: string; supplierId: string; supplierName: string })[]; total: number }>`. Join `purchase_requests` và `suppliers` (cùng schema). `search` dùng `strpos` trên số phiếu và số đề nghị, như `listRequests`.
  - `insertReceipt(values): Promise<string>`.
  - `insertReceiptLines(companyId, receiptId, lines: { requestLineId: string; variantId: string }[])`: giữ thứ tự bằng `created_at = now() + i µs`.
  - `receiptLines(receiptIds)`: trả `id, receiptId, requestLineId, variantId, declaredQty, acceptedQty, defectiveQty, returnedOnSpotQty, shortageQty, reason`.
  - `updateReceipt(id, set)` và `updateReceiptLine(id, set)`: cả hai tự `version + 1` và `updated_at = now()`.
- Produces (`service/transitions.ts`):
  - `checkTransition<S extends string, A extends string, R>(machine: StateMachine<S, A, R>, from: S, action: A, ctx: TransitionContext<R>, current: () => Promise<unknown>)`
  - Bắt `invalid_transition` rồi ném lại với `current: await current()`. Đây là chính hàm cũ trong `request-actions.ts`, sửa thành generic.
- Produces (`service/receipt-views.ts`):
  - `toReceiptSummaries(rows, actor)`, `toReceiptDetail(row: ReceiptRow, actor): Promise<GoodsReceiptView>`, kèm `type GoodsReceiptView`.
  - Trường đúng như FE `GoodsReceipt` (`D:\DA-TMDT\FE\src\types\purchasing.ts`) và S109 §6.7 "Dựng response":
    - `lines[].lineId` là `request_line_id`;
    - `followUps = []` và `shortResolution = null` ở PR này;
    - `attachments = []`.
- Produces (`service/receipts.ts`):
  - `RECEIPT_ENTITY = 'goods_receipts'`
  - `lockOwnReceipt(id): Promise<{ receipt: ReceiptRow; request: RequestRow }>`: `findReceipt` (id không phải uuid hoặc không thấy → 404 "phiếu nhận"), rồi `lockRequest(receipt.requestId)`, rồi `lockReceipt(id)`.
  - `assertReceiptVersion(row, version, actor)`: 409 `version_conflict` kèm `current`.
  - `listReceiptPage(actor, q)`, `getReceipt(actor, id)`.
  - `createReceipt(actor, input: { requestId: string; deliveryMode: 'waiting' | 'left'; note: string })`.
  - `updateReceiptCount(actor, id, input: { deliveryMode; note; attachmentIds: string[]; lines: (CountLine & { lineId: string })[]; version: number })`.
- Produces (`service/receipt-actions.ts`):
  - `runReceiptAction(actor, id, action: string, input: { version: number; reason?: string | null })`
  - Action lạ → 404. `cancel` ghi `statusReason`. `post` và `post_short` ném `notImplemented('post', '#109 PR B')`.

Luật của `createReceipt` (S109 §6.4 dòng "(lập)"):
- Khoá đề nghị trước. Không thấy → 422 `errors.requestId = 'Chọn đề nghị nhập'`.
- Đề nghị không ở `ordered` hoặc `partially_received` → 409 `invalid_transition`, `current` = trạng thái đề nghị.
- Dòng phiếu sinh từ dòng đề nghị không bị loại, có `variantId` và `outstanding > 0`. Không còn dòng nào → 409 `empty_document`.
- Số phiếu là `docNumber('NH', await nextDocNumber('goods_receipt'))`.
- Người giao đã đi (`left`) thì `checkDeadline = sql\`now() + interval '24 hours'\``.
- Ghi `recordTransition(null → counting, action 'create')` và `recordAudit` (`product.goods_receipts`).

Luật của `updateReceiptCount`, theo thứ tự:
1. `lockOwnReceipt`, rồi so `version`.
2. Phiếu không ở `counting` → 409 `not_draft`.
3. Lỗi theo ô:
   - `attachmentIds` khác rỗng → 422 `errors.attachments = 'Chưa nhận tệp đính kèm (chờ #114)'`;
   - `lineId` không thuộc phiếu → `errors["lines.i.lineId"] = 'Dòng không thuộc phiếu'`;
   - `lineId` lặp → `errors["lines.i.lineId"] = 'Dòng bị lặp'`;
   - lỗi của `countErrors`.
4. Kiểm sớm `đạt + lỗi ≤ outstanding(dòng đề nghị)`. Vượt → 422 `over_outstanding` với `errors["lines.i.accepted"] = 'Còn chờ N, nhận đạt và lỗi giữ không được vượt'`.
5. Ghi các dòng, rồi ghi phiếu. Đổi cách giao thì tính lại `checkDeadline` theo `created_at + interval '24 hours'`, hoặc đặt null. Ghi `recordAudit` có bản trước và bản sau.

Task này không có test riêng: Task 6 test qua HTTP. Chạy `npx tsc --noEmit` và test #108 sau khi dời `checkTransition`.

- [ ] **Step 1: Dời `checkTransition` sang `service/transitions.ts`, sửa `request-actions.ts` dùng hàm mới**

Run: `npx vitest run --project integration test/integration/product/purchasing/requests.test.ts`
Expected: PASS (không đổi hành vi).

- [ ] **Step 2: Viết `repository/receipts.ts`, `receipt-views.ts`, `receipts.ts`, `receipt-actions.ts`**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/modules/product/purchasing
git commit -m "#109: phiếu nhận (lập, kiểm đếm, huỷ, xem); checkTransition dùng chung cho đề nghị và phiếu nhận"
```

### Task 6: API phiếu nhận, test HTTP, PR A

**Files:**
- Modify: `src/modules/product/purchasing/api/schemas.ts`, `api/routes.ts`, `api/openapi.ts`
- Modify: `test/integration/product/purchasing/helpers.ts`
- Test: `test/integration/product/purchasing/goods-receipts.test.ts`

**Interfaces:**
- Consumes: service của Task 5.
- Produces (Zod, `.strict()`, `.meta({ id })` trùng tên kiểu FE):
  - `GoodsReceiptCreateInput`
  - `GoodsReceiptLineInput`: bốn số nguyên 0–`MAX_QTY`, `reason` tối đa 300 ký tự.
  - `GoodsReceiptUpdateInput`: `attachmentIds` gồm tối đa 10 uuid.
  - `ReceiptListQuery`
  - `ReceiptActionInput` = `{ version, reason? }`
  - `GoodsReceiptSummary`, `GoodsReceipt`, `GoodsReceiptPage`
- Route (S109 §6.7). `POST /goods-receipts/:id/short-resolution` của PR C phải khai **trước** `/:id/:action`:
  - `GET /goods-receipts` (view)
  - `GET /goods-receipts/:id` (view)
  - `POST /goods-receipts` (`purchasing.receipt.manage`)
  - `PUT /goods-receipts/:id` (`purchasing.receipt.manage`)
  - `POST /goods-receipts/:id/:action` (view)
- Produces (`helpers.ts`):
  - `orderedRequest(t: { buyer: string; ceo: string }, supplierId: string, lines: LineInput[])`: mua hàng lập và gửi, CEO duyệt, mua hàng đặt; trả bản chi tiết.
  - `createReceipt(token, requestId, deliveryMode: 'waiting' | 'left' = 'waiting')`: kỳ vọng 201; trả `z.infer<typeof GoodsReceipt>`.
  - `countBody(receipt, counts: Partial<CountLine>[])`: dựng body `PUT` theo thứ tự dòng; trường không nêu lấy 0, `reason` lấy `''`.

- [ ] **Step 1: Viết test**

```ts
it('AC1: đề nghị approved → 409 invalid_transition, current = approved', …);
it('AC1: đề nghị ordered → 201 NH-…, dòng = dòng còn chờ với mọi số 0; left → checkDeadline ≈ lúc lập + 24 giờ', async () => {
  const r = GoodsReceipt.parse(res.body);
  expect(r).toMatchObject({ number: expect.stringMatching(/^NH-\d{6}$/), status: 'counting', deliveryMode: 'left', shortQty: 0 });
  expect(r.lines.map((l) => [l.lineId, l.outstanding, l.announced])).toEqual(req.lines.map((l) => [l.id, 10, 0]));
  // check_deadline - created_at = 24 giờ, đọc bằng testPool
});
it('đề nghị closed_short hoặc đã nhận đủ → 409; đề nghị của công ty khác → 422 errors.requestId', …);
it('AC2: vượt báo giao, thiếu mà không có lý do → 422 đúng ô; đạt + lỗi > còn chờ → 422 over_outstanding', …);
it('Review Focus 1: lineId lạ, lineId lặp → 422 errors["lines.i.lineId"], không dòng nào bị ghi', …);
it('AC11: attachmentIds khác rỗng → 422 errors.attachments', …);
it('PUT với version cũ → 409 version_conflict kèm current; phiếu đã huỷ → 409 not_draft', …);
it('huỷ không có lý do → 422 reason_required; có lý do → cancelled, lịch sử có lý do', …);
it('kho thấy phiếu nhưng không thấy giá; mua hàng (không có receipt.manage) lập phiếu → 403', …);
it('phiếu của công ty khác: GET 404; danh sách lọc theo requestId, status, search số phiếu', …);
```

Mỗi response phải parse được bằng schema cùng tên. Kho là `addMember(c, 'warehouse')`, có `purchasing.receipt.manage`.

- [ ] **Step 2: Chạy test, kỳ vọng FAIL**

Run: `npx vitest run --project integration test/integration/product/purchasing/goods-receipts.test.ts`
Expected: FAIL (404 vì chưa có route).

- [ ] **Step 3: Viết schema, route, openapi**

- [ ] **Step 4: Chạy lại, kỳ vọng PASS**

- [ ] **Step 5: `npm run check`, commit, push, mở PR A** (thân PR ghi "Merge #111 trước")

```bash
git add src/modules/product/purchasing test/integration/product/purchasing
git commit -m "#109: API phiếu nhận /goods-receipts (danh sách, chi tiết, lập, kiểm đếm, huỷ)"
git push -u origin feature/109-phieu-nhan
```

---

## PR #109 B: `feature/109-ghi-so`

### Task 7: Ghi sổ, phiếu trả NCC nháp, tác động lên đề nghị, tự Đã xử lý

**Files:**
- Modify: `src/modules/product/purchasing/repository/requests.ts` (thêm `lockLines(requestId)`, giống `findLines` nhưng `FOR UPDATE`)
- Modify: `src/modules/product/purchasing/repository/receipts.ts` (thêm `shortReceiptsOf(requestId)`)
- Create: `src/modules/product/purchasing/repository/returns.ts`, `src/modules/product/purchasing/service/request-receiving.ts`
- Modify: `src/modules/product/purchasing/service/receipt-actions.ts`, `service/receipt-views.ts` (`followUps`, `shortResolution`)
- Test: `test/integration/product/purchasing/receipt-posting.test.ts`

**Interfaces:**
- Consumes: `receiveGoods` (#111); `goodsReceiptMachine`, `shortOf` (Task 4); `purchaseRequestMachine` (#108); `publishEvent` (core).
- Produces (`repository/returns.ts`):
  - `insertDraftReturn(v: { companyId: string; number: string; supplierId: string; sourceId: string }): Promise<string>`: `source = 'receipt_defect'`, `created_by = null`.
  - `insertReturnLines(companyId: string, returnId: string, lines: { variantId: string; quantity: number; unitCost: string; sourceLineId: string }[])`
  - `returnsOfReceipts(receiptIds): Promise<{ id: string; number: string; sourceId: string }[]>`
- Produces (`service/request-receiving.ts`):
  - `applyReceiving(request: RequestRow, posted: { receiptId: string; actorId: string }): Promise<void>`. Đọc lại các dòng, rồi:
    - tổng `outstanding` = 0 → `receive_all`, sau đó `autoResolveShort`;
    - còn chờ và đề nghị đang `ordered` → `receive_partial`;
    - đề nghị đã `partially_received` → chỉ `updateRequest(id, {})` để `version + 1`.

    Hai thao tác `receive_*` gọi `assertTransition` với `actor: null`; `recordTransition` có `actorId: null`.
  - `autoResolveShort(requestId: string, r: { kind: 'follow_up'; followUpReceiptId: string; by: string } | { kind: 'close_short'; note: string; by: string }): Promise<void>`. Với mọi phiếu `short` của đề nghị:
    - đặt `status = 'resolved'`, `short_resolution`, `follow_up_receipt_id` hoặc `resolution_note`, `resolved_by = by`, `resolved_at = now()`, `version + 1`;
    - ghi `recordTransition(short → resolved, 'auto_resolve', actorId null)`.
- Produces: `runReceiptAction` làm đủ `post` và `post_short`.

Luồng `post` và `post_short` (S109 §6.5; thứ tự kiểm theo mock FE):
1. `lockOwnReceipt`, rồi `lockLines(request.id)`, rồi so `version`.
2. `checkTransition(goodsReceiptMachine, …)` với `record = { createdBy: request.createdBy, short: Σ shortage_qty }` và `canSelfApprove` (chỉ hỏi khi `request.createdBy === actor.accountId`).
3. Không dòng nào có `declared_qty > 0` → 409 `empty_document`.
4. Dòng có `đạt + lỗi > outstanding` → 422 `over_outstanding` theo ô.
5. Cộng `received_qty += đạt`, `defective_qty += lỗi` vào dòng đề nghị.
6. Gọi `receiveGoods` với các dòng có đạt hoặc lỗi > 0. `lineId` là id dòng phiếu nhận; `unitCost` là `unit_price` của dòng đề nghị.
7. Có lỗi thì lập phiếu trả NCC nháp. Số là `docNumber('TN', await nextDocNumber('supplier_return'))`; ghi `recordTransition('supplier_returns', null → draft, 'create', actorId null)`.
8. Cập nhật phiếu nhận: `status`, `posted_by`, `posted_at`, `self_approved`. Ghi lịch sử.
9. `applyReceiving`.
10. Phát `purchasing.goods_receipt_posted { receiptId, requestId, lines: [{ variantId, accepted, defective }] }`, chỉ gồm dòng có đạt hoặc lỗi > 0.

- [ ] **Step 1: Viết test**

```ts
it('AC5: đạt 55, lỗi 2, giá 100.000 → tồn, chờ xử lý, giá vốn, thẻ kho, phiếu trả nháp, outbox', async () => {
  // đề nghị đặt 60 cái giá 100.000, SKU chưa có tồn; phiếu báo giao 60, đạt 55, lỗi 2, trả tại chỗ 0, post_short (thiếu 3)
  const stock = (await inv(ceo).get(`/stock/${v}`)).body;
  expect(stock).toMatchObject({ onHand: 55, quarantine: 2, avgCost: 100000, incoming: 3 });
  expect(posted.followUps).toEqual([{ type: 'supplier_return', id: expect.any(String), number: expect.stringMatching(/^TN-\d{6}$/) }]);
  // supplier_return_lines: quantity 2, unit_cost '100000.00'; stock_moves theo source_id = receipt.id: 2 dòng
  // outbox: goods_receipt_posted { receiptId, requestId, lines: [{ variantId: v, accepted: 55, defective: 2 }] } và stock_changed
});
it('AC6: phiếu 1 thiếu (post_short) → đề nghị partially_received; phiếu 2 nhận đủ → received, phiếu 1 resolved follow_up trỏ phiếu 2', async () => {
  expect(first.shortResolution).toMatchObject({ kind: 'follow_up', followUp: { type: 'goods_receipt', id: second.id, number: second.number } });
  expect(first.statusHistory.at(-1)).toMatchObject({ to: 'resolved', source: 'system' });
});
it('AC3: người lập đề nghị (vai tự tạo có request.manage + receipt.manage) ghi sổ → 409 second_person_required', …);
it('AC3: CEO lập đề nghị rồi tự ghi sổ → 200, goods_receipts.self_approved = true', …);
it('AC4: post khi có thiếu → 409 has_shortage; post_short khi không thiếu → 409 no_shortage', …);
it('chưa nhập số báo giao → 409 empty_document', …);
it('AC7: hai phiếu cùng nhận đủ còn chờ, ghi sổ song song → một 200, một 422 over_outstanding; tồn tăng một lần', async () => {
  const results = await raceBehindLock(
    (h) => h.query('select 1 from product.purchase_requests where id = $1 for update', [req.id]),
    2,
    () => Promise.all([post(kho, r1), post(kho, r2)]), // đề nghị do mua hàng lập, kho là người thứ hai
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
});
it('Review Focus 4: bấm ghi sổ lần hai với version cũ → 409 version_conflict; tồn và số phiếu trả không đổi', …);
it('Review Focus 2: chỉ trả tại chỗ (báo giao 5, trả 5, lý do) → post được; không có thẻ kho, stock_changed, phiếu trả', …);
```

- [ ] **Step 2: Chạy test, kỳ vọng FAIL**

Run: `npx vitest run --project integration test/integration/product/purchasing/receipt-posting.test.ts`
Expected: FAIL (501 `not_implemented` từ `post`).

- [ ] **Step 3: Viết `lockLines`, `shortReceiptsOf`, `returns.ts`, `request-receiving.ts`, và phần `post` / `post_short` trong `receipt-actions.ts`. Bổ sung `followUps` và `shortResolution` trong view.**

- [ ] **Step 4: Chạy lại, kỳ vọng PASS.** Chạy thêm `requests.test.ts` để chắc #108 không vỡ.

- [ ] **Step 5: `npm run check`, commit, push, mở PR B** (thân PR ghi "Merge PR A trước")

```bash
git commit -m "#109: ghi sổ phiếu nhận (tồn, phiếu trả NCC nháp, nhận một phần / nhận xong, tự Đã xử lý, goods_receipt_posted)"
```

---

## PR #109 C: `feature/109-giao-thieu-bao-cao`

### Task 8: Đóng thiếu dùng chung và ghi kết quả giao thiếu

**Files:**
- Modify: `src/modules/product/purchasing/service/request-receiving.ts` (thêm `closeShortRequest`; chuyển `closeShortLines` từ `request-actions.ts` sang)
- Modify: `src/modules/product/purchasing/service/request-actions.ts` (`close_short` gọi `closeShortRequest`)
- Modify: `src/modules/product/purchasing/repository/receipts.ts` (`findReceiptByNumber(requestId, number)`)
- Modify: `src/modules/product/purchasing/service/receipt-actions.ts` (`resolveShort`), `api/schemas.ts` (`ShortResolutionInput`), `api/routes.ts`, `api/openapi.ts`
- Test: `test/integration/product/purchasing/short-resolution.test.ts`

**Interfaces:**
- Produces:
  - `closeShortRequest(actor: Actor, request: RequestRow, reason: string | null): Promise<void>`. Nạp các dòng và phiếu nhận để dựng `record`, rồi:
    1. `checkTransition(purchaseRequestMachine, …, 'close_short', …)`;
    2. `closeShortLines`;
    3. `updateRequest` với `closedBy`, `closedAt`, `statusReason`;
    4. `recordTransition`;
    5. `autoResolveShort(request.id, { kind: 'close_short', note: reason!, by: actor.accountId })`.
  - `resolveShort(actor, id, input: { kind: 'follow_up' | 'supplier_wrong' | 'close_short'; followUpNumber?: string; note: string; version: number }): Promise<GoodsReceiptView>`
  - Route `POST /goods-receipts/:id/short-resolution` (`purchasing.request.manage`), khai trước `/:id/:action`.

Luật của `resolveShort` (S109 §6.6), theo thứ tự:
1. `lockOwnReceipt`, rồi so `version`.
2. Phiếu đã `resolved` → 409 `resolution_recorded`. Phiếu không ở `short` → `checkTransition` ném `invalid_transition`.
3. Theo `kind`:
   - `close_short`:
     - không có `purchasing.request.approve` (dùng `hasPermission`) → 403 `forbidden` 'Chỉ CEO đóng thiếu đề nghị';
     - `note` trống → 422 `reason_required`, `errors.note = 'Nhập lý do đóng thiếu'`;
     - còn lại thì gọi `closeShortRequest`.
   - `follow_up`:
     - tìm phiếu theo `followUpNumber.trim().toUpperCase()`: phải khác phiếu này, cùng đề nghị, chưa huỷ;
     - không thấy → 422 `follow_up_invalid`, `errors.followUpNumber = 'Không có phiếu nhận này trong cùng đề nghị'`.
   - `supplier_wrong`: `note` trống → 422 `errors.note = 'Ghi NCC nhận sai thế nào'`.
4. Với `follow_up` và `supplier_wrong`: `checkTransition(goodsReceiptMachine, 'short', 'resolve', …)`, rồi `updateReceipt` các trường kết quả và ghi lịch sử `resolve`.

- [ ] **Step 1: Viết test**

```ts
it('AC8: follow_up với số phiếu của đề nghị khác → 422 follow_up_invalid; đúng → resolved; lần hai → 409 resolution_recorded', …);
it('supplier_wrong thiếu ghi chú → 422 errors.note; có ghi chú → resolved, lịch sử action resolve', …);
it('AC9: mua hàng chọn close_short → 403; CEO khi còn phiếu đang kiểm → 409 receipt_counting', …);
it('AC9: CEO close_short → đề nghị closed_short, incoming của SKU về 0, mọi phiếu short → resolved kind close_short', …);
it('đóng thiếu qua POST /requests/:id/close_short cũng tự resolved các phiếu short (S109 Q6)', …);
it('phiếu đang kiểm → 409 invalid_transition', …);
```

- [ ] **Step 2: Chạy test, kỳ vọng FAIL**

Run: `npx vitest run --project integration test/integration/product/purchasing/short-resolution.test.ts`
Expected: FAIL (404 route).

- [ ] **Step 3: Viết code. Chạy lại `short-resolution.test.ts` và `requests.test.ts`, kỳ vọng PASS.**

- [ ] **Step 4: Commit**

```bash
git commit -m "#109: ghi kết quả giao thiếu; đóng thiếu dùng chung cho đề nghị và phiếu nhận, tự Đã xử lý phiếu thiếu"
```

### Task 9: Báo cáo theo NCC

**Files:**
- Create: `src/modules/product/purchasing/repository/report.ts`
- Modify: `src/modules/product/purchasing/service/suppliers.ts`, `api/schemas.ts`, `api/routes.ts`, `api/openapi.ts`
- Test: `test/integration/product/purchasing/supplier-report.test.ts`

**Interfaces:**
- Produces:
  - `supplierReport(from: string, to: string): Promise<{ supplierId; supplierName; receiptCount; shortReceiptCount; deliveredQty; defectQty }[]>`. Một câu SQL:
    - `suppliers` LEFT JOIN `purchase_requests` LEFT JOIN `goods_receipts`; điều kiện `posted_at is not null` và `inVnDays(posted_at, from, to)` đặt **trong ON** của join phiếu, không đặt ở WHERE;
    - tiếp tục LEFT JOIN `goods_receipt_lines`;
    - `count(distinct r.id)`, `count(distinct r.id) filter (where r.status in ('short', 'resolved'))`, các `coalesce(sum(...), 0)::int`;
    - xếp theo `lower(name)`.
  - `getSupplierReport(actor, q: { from?: string; to?: string })`: thiếu đầu nào thì service điền `'2000-01-01'` hoặc `'9999-12-30'`. `defectRate = delivered ? defect / delivered : null`.
  - `SupplierReportQuery`: hai trường `z.iso.date()` tuỳ chọn; refine `from ≤ to`, nếu sai thì `path: ['from']`, câu 'Ngày bắt đầu sau ngày kết thúc'.
  - `SupplierReport` (meta id), `SupplierReportList`.
  - Route `GET /suppliers/report` (view).

- [ ] **Step 1: Viết test**

```ts
it('AC10: số phiếu, số lần giao thiếu, deliveredQty, defectQty, defectRate trong kỳ', …);
it('NCC chưa có phiếu (kể cả đã ngừng giao dịch) → số 0, defectRate null', …);
it('Review Focus 5: phiếu posted_at 2026-10-27T17:30:00Z tính vào ngày 2026-10-28, không tính vào 2026-10-27', …);
// đặt posted_at bằng testPool sau khi ghi sổ
it('from > to → 422 validation_failed errors.from', …);
```

- [ ] **Step 2: Chạy test, kỳ vọng FAIL**

Run: `npx vitest run --project integration test/integration/product/purchasing/supplier-report.test.ts`

- [ ] **Step 3: Viết code. Chạy lại, kỳ vọng PASS.**

- [ ] **Step 4: Commit**

```bash
git commit -m "#109: báo cáo theo NCC /suppliers/report (kỳ theo ngày giờ Việt Nam)"
```

### Task 10: Tài liệu và PR C

**Files:**
- Modify: `src/modules/product/purchasing/CLAUDE.md`. Thêm:
  - phần phiếu nhận: quyền, bất biến của S109 §6.3, thứ tự khoá, `closeShortRequest` là đường đóng thiếu duy nhất;
  - sự kiện `goods_receipt_posted`;
  - gọi ra `inventory.receiveGoods`.
- Documents (nhánh `docs/21-phieu-nhan` tách từ `main`):
  - `21-hop-dong-api-fe-be.md` §16.2: `deliveryMode` nhận `waiting` hoặc `left`; `/suppliers/report` nhận `from`, `to`; lập phiếu với đề nghị không thấy trả 422 `errors.requestId`;
  - `21-hop-dong-api-fe-be.md` §16.3: thêm bước `resolve` và luật tự Đã xử lý (S109 Q6);
  - `21-hop-dong-api-fe-be.md` §16.4: thêm `empty_document`, `no_shortage`, `over_outstanding`, `resolution_recorded`, `follow_up_invalid`;
  - `19-mo-hinh-du-lieu.md`: thêm `goods_receipts.self_approved`.

- [ ] **Step 1: Sửa `CLAUDE.md`, commit**

- [ ] **Step 2: Sửa Documents, commit, mở PR vào `main`.** PR cần Thành và Khoa duyệt.

- [ ] **Step 3: `npm run check`, push, mở PR C**

Thân PR C ghi:
- "Merge PR B trước";
- các điểm FE cần sửa theo S109 §8: mock `/short-resolution` chuyển phiếu sang `resolved`; kỳ ngược trả 422; thêm câu báo cho các mã lỗi mới.

---

## Self-review

- **Độ phủ spec:**
  - S111: AC1–9 nằm ở Task 1–3.
  - S109: AC1, 2, 11 ở Task 6; AC3–7 ở Task 7; AC8, 9 ở Task 8; AC10 ở Task 9; AC12 nằm trong mỗi bước `npm run check` và mỗi lần `.parse` bằng schema.
  - S109 Q2, Q3 và PR D thuộc #114, nằm ngoài plan.
- **Kiểu dùng chung:** `ReceivedLine` (Task 2) là kiểu Task 7 truyền vào. `checkTransition` (Task 5) được Task 7 và Task 8 dùng. `autoResolveShort` (Task 7) được `closeShortRequest` (Task 8) gọi.
- **Rủi ro còn lại:**
  - Năm PR xếp chồng: PR dưới phải merge trước thì PR trên mới có diff gọn.
  - `defectRate` là tỉ lệ 0–1 theo FE, trong khi R2 ghi phần trăm. Khoa cần xác nhận (S109 §10).
