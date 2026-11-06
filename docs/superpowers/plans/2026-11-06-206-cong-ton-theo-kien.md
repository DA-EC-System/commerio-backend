# Cổng tồn theo kiện (#206, phần cổng): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Năm hàm cổng `reserve`, `release`, `ship`, `reverseShipment`, `receiveBack` của `inventory` có bản giả trước, rồi chạy thật theo `Documents/21` §11.1, qua một lõi ghi `stock_levels` duy nhất.

**Architecture:** Lõi `applyMoves` (`service/posting.ts`) mở rộng thành `applyChange`, đổi được cả đang giữ trong cùng lần khoá và kiểm bất biến. Năm hàm nằm ở `service/reservation.ts`, `service/shipment.ts`, `service/returns.ts`, `port.ts` chỉ re-export. Phiếu `XK`, `DX`, `KT` do hệ thống lập qua `service/documents.ts`. Không có migration, không có route mới.

**Tech Stack:** Node 24 (chạy thẳng `.ts`), Drizzle ORM 0.45 + PostgreSQL 18, decimal.js, Vitest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-06-206-cong-ton-theo-kien-design.md` (gọi tắt **S206**). Q1–Q9 ở `2026-10-28-111-cong-ton-ghi-so-design.md` vẫn giữ, trừ Q6 (S206 Q14 thay).

## Global Constraints

- Import tương đối có đuôi `.ts`. Không dùng `enum`, `namespace`, parameter property; dùng union literal hoặc `as const`.
- Định danh viết tiếng Anh; comment, message lỗi, tên `describe`/`it` viết tiếng Việt.
- Tiền: `numeric(18,2)` trong DB, chuỗi hoặc `Decimal` trong code, làm tròn `ROUND_HALF_UP` 2 chữ số.
- Năm hàm chạy trong giao dịch và `withCompany` của bên gọi (`getDb()`, `requireCompanyId`). Inventory không đọc bảng `"order"`.
- Lỗi do bên gọi vi phạm hợp đồng là `Error` thường (500), không dùng `AppError`. `reserve` thiếu hàng thì trả `{ reserved: false }`, không ném.
- Thứ tự khoá trong một lần gọi: dòng tồn theo `variantId` tăng dần → dòng đếm `doc_counters` sau cùng.
- Thẻ kho chỉ thêm. Đang giữ không ghi thẻ kho.
- `inventory.stock_changed` chỉ phát cho SKU có **tồn thực** đổi; `recheckThresholds` chạy cho SKU có tồn thực **hoặc** đang giữ đổi (Q15).
- Không migration (Q20). `depcruise` phải xanh, kể cả `khong-vong-tron`; luật này tính cả `import type`.
- Test chỉ nằm trong `test/`, import bằng `#src/...ts`. Test cần ngưỡng thì import hàm cổng qua `#src/modules/product/index.ts` (để `setIncomingSource` đã được nối). Id kiện, id yêu cầu trả trong test dùng `randomUUID()`.
- Dùng `npm`. Chạy `npm run check` trước mỗi PR, `graphify update .` sau khi sửa code.
- File trong `docs/superpowers/` phải `git add -f`.
- Commit có dạng `#206: <việc>`, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Thân PR kết thúc bằng `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Hỏi Khang trước khi push hoặc mở PR.

## Nhánh và PR

| PR | Repo, nhánh | Tách từ | Task | Điều kiện merge |
|---|---|---|---|---|
| 1. Bản giả | `commerio-backend`, `feature/206-cong-ton-theo-kien` (nhánh hiện tại, đã có spec) | `main` | 1 | Làm ngay, báo #199, #202 |
| 2. Documents | `Documents`, `docs/21-cong-ton-theo-kien` | `main` | 2 | Thành, Khoa duyệt; merge trước PR 3 |
| 3. Bản thật | `commerio-backend`, `feature/206-than-cong-ton` | `main` sau khi PR 1 merge | 3–9 | PR 2 đã merge; đã kiểm staging (Task 9) |

## Chỗ plan chốt thêm so với spec

1. **`StockLine` và `DocumentRef` khai báo ở `domain/documents.ts`.** `port.ts` re-export cả hai nên module khác import như cũ. Nếu để `StockLine` ở `port.ts` thì `reservation.ts` import ngược `port.ts`, thành vòng (S206 5.2 cấm chiều này).
2. **Thêm `service/documents.ts` với `createSystemDocument`.** Hàm này lấy số, chèn phiếu, chèn dòng và gọi `recordTransition`, dùng chung cho ba loại phiếu. S206 5.2 không liệt kê file này.
3. **Luật thuần `mergeLines`, `sameLines`, `activeRound` đặt ở `domain/documents.ts`** để unit test được: gộp dòng theo SKU, so dòng cho lưới Q12, tìm lượt đang xuất Q17.
4. **`release` và `ship` không `forced` tự kiểm đang giữ trước khi ghi.** `release` dùng `precheck` của lõi; `ship` kiểm ngay sau `lockLevels`, trước `nextDocNumber`. Nhờ vậy message có `packageId` đúng S206 5.6, và `doc_counters` không bị đụng (AC 7), kể cả khi bên gọi bắt lỗi trong savepoint. Lõi vẫn giữ bước kiểm `reserved < 0` làm lưới.
5. **`receiveBack` kiểm SKU thuộc công ty bằng `getVariants`.** S206 5.6 có yêu cầu này nhưng bảng 5.5 không ghi bước. Hàm không khoá dòng tồn nên không có lần kiểm nào khác.
6. **SKU chỉ đổi đang giữ thì không tăng `version`** (S206 Q24, Khang chốt 06/11/2026). `version` cũng là `reorderVersion` (`service/stock.ts:110`); tăng ở mỗi lần giữ hàng thì người đang sửa ngưỡng nhận 409 dù không ai sửa ngưỡng. `saveLevel` nhận thêm cờ `bumpVersion: boolean`.

## Review Focus

1. **`quantity` không nguyên dương** (0, −1, 1.5, `NaN`) ở bất kỳ hàm nào: ném `Error`, DB không đổi. Unit test ở Task 3 (`mergeLines`), integration test ở Task 5 (`reserve` với 0).
2. **Một SKU có nhiều dòng trong một lần `ship`:** `ship(k, [A×1, A×2])` rồi `ship(k, [A×3])` thì lần hai là gọi lặp và trả phiếu cũ, vì lưới so theo dòng đã gộp. Test ở Task 6.
3. **SKU chưa có dòng tồn** (biến thể mới tạo): `reserve` trả `false`; `ship` `forced` tạo dòng tồn âm. Test ở Task 5 và Task 6.
4. **SKU của công ty khác trong `receiveBack`:** ném `Error`, không lập phiếu. Hàm này không khoá dòng tồn nên rất dễ bỏ sót bước kiểm. Test ở Task 8.
5. **`reason` chỉ có khoảng trắng hoặc dài 501 ký tự; đảo SKU không có trong lượt:** ném `Error`, không có phiếu `DX`. Test ở Task 7.

## Hiệu năng và vận hành (soát thiết kế theo backend-performance-review)

Không thấy vấn đề hiệu năng đáng kể ở tải S206 5.1 nêu (vài trăm kiện mỗi ngày, mỗi kiện dưới 10 dòng; số do spec đưa, chưa đo). Căn cứ:
- Giao dịch của worker gói theo từng đơn (`channel/channel/service/order-pull.ts:49`, mỗi đơn một `withCompany`), nên khoá dòng tồn chỉ giữ trong lúc xử lý một đơn.
- Ước lượng số câu SQL của một lần `reserve` có N SKU: N lần `insert … on conflict` và N lần `select … for update` (`lockLevel`), N lần `saveLevel`, khoảng 3 câu cho `recheckThresholds`, cộng `getVariants`. Tức khoảng 3N + 4 câu, chừng 34 câu khi N = 10. Không đáng kể ở tải trên. Đã cân nhắc gộp `lockLevels` thành 2 câu, nhưng không đưa vào plan: chỉ đáng làm khi kiện có hàng trăm dòng.

Ba điểm cần theo dõi. Ghi cả ba vào `inventory/CLAUDE.md` ở Task 9.
- **Deadlock khi bên gọi gọi cổng nhiều lần trong một giao dịch.** Ví dụ một đơn nhiều kiện (`fulfillment/service/platform-packages.ts:129` gọi `reserve` cho từng kiện). Thứ tự khoá chỉ đúng trong một lần gọi: giao dịch đã giữ `doc_counters` sau `ship` kiện 1 rồi mới khoá SKU của kiện 2. PostgreSQL phát hiện và huỷ một bên (`40P01`), việc nền chạy lại. Không sửa trong #206; báo #199 để khoá đủ SKU của mọi kiện trước nếu hay gặp.
- **Dòng `doc_counters` loại `shipment` là điểm xếp hàng** của mọi `ship` trong một công ty cho tới khi giao dịch commit. Spec đã chấp nhận (S206 5.8).
- **Kiểm khi nghi có tranh khoá:** chạy `select pid, wait_event_type, wait_event, now() - xact_start as age, left(query, 80) from pg_stat_activity where wait_event_type = 'Lock';` để xem phiên nào đang chờ khoá và chờ bao lâu. Câu này chỉ đọc, chạy được trên production (safe-on-production).

---

## PR 1: Bản giả

### Task 1: Năm hàm cổng trả thành công

**Files:**
- Modify: `src/modules/product/inventory/service/port.ts:2,59-96`
- Modify: `src/modules/product/inventory/CLAUDE.md:44`
- Test: `test/integration/product/inventory/port.test.ts:28-38`

**Interfaces:**
- Produces: giữ nguyên chữ ký bản 29/10. `ship` vẫn nhận `{ actorId: string }`, chưa có `forced`.

- [ ] **Step 1: Thay ca "trả 501" bằng ca bản giả**

```ts
describe('bản giả cổng theo kiện (spec #206 Q23)', () => {
  it('reserve trả reserved: true; release không ném', async () => {
    await expect(reserve(randomUUID(), [])).resolves.toEqual({ reserved: true });
    await expect(release(randomUUID(), [])).resolves.toBeUndefined();
  });
  it.each([
    ['ship', () => ship(randomUUID(), [], { actorId: randomUUID() }), 'XK-000000'],
    ['reverseShipment', () => reverseShipment(randomUUID(), [], { actorId: randomUUID(), reason: 'x' }), 'DX-000000'],
    ['receiveBack', () => receiveBack({ type: 'package', id: randomUUID() }, []), 'KT-000000'],
  ])('%s trả phiếu giả %s', async (_name, call, number) => {
    expect(await call()).toEqual({ documentId: expect.any(String), number });
  });
});
```

- [ ] **Step 2: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/integration/product/inventory/port.test.ts`
Expected: FAIL, vì các hàm còn trả về `{ status: 501, code: 'not_implemented' }`.

- [ ] **Step 3: Viết thân giả trong `port.ts`**

`reserve` trả `{ reserved: true }`; `release` không làm gì; `ship`, `reverseShipment`, `receiveBack` trả `{ documentId: randomUUID(), number }` với `number` lần lượt là `'XK-000000'`, `'DX-000000'`, `'KT-000000'`. Mỗi thân có comment `// shortcut: bản giả, thân thật theo spec 2026-11-06-206 mục 5.5`. Bỏ import `notImplemented`, sửa comment ở dòng 59 cho đúng hiện trạng.

- [ ] **Step 4: Cập nhật dòng 44 của `inventory/CLAUDE.md`**

Ghi: "bản giả trả thành công (#206, không ghi gì); thân thật làm ở PR sau, spec `2026-11-06-206-cong-ton-theo-kien-design.md`".

- [ ] **Step 5: Chạy toàn bộ kiểm tra**

Run: `npm run check`
Expected: lint, typecheck, depcruise, test đều xanh.

- [ ] **Step 6: Commit, rồi hỏi Khang trước khi push và mở PR vào `main`**

```bash
git add src/modules/product/inventory/service/port.ts src/modules/product/inventory/CLAUDE.md test/integration/product/inventory/port.test.ts
git commit -m "#206: bản giả năm hàm cổng tồn theo kiện trả thành công"
```

Thân PR cần ghi: #199 và #202 dùng được bản giả; bản giả không cộng `stock_levels.reserved` (S206 §10).

---

## PR 2: Documents

### Task 2: Sửa `21` §11.1 theo S206 §8

**Files:**
- Modify: `D:\DA-TMDT\Documents\21-hop-dong-api-fe-be.md`, mục `### 11.1` (khoảng dòng 581–592)

- [ ] **Step 1: Tạo nhánh `docs/21-cong-ton-theo-kien` từ `main` của repo Documents**

- [ ] **Step 2: Sửa đoạn mở đầu và tiêu đề §11.1**

Tiêu đề hiện ghi "bản tạm ở commerio-backend#111". Đoạn mở đầu hiện ghi "năm hàm còn lại là bản tạm ném `AppError` 501". Sửa cả hai thành: bản giả trả thành công, thân thật ở commerio-backend#206.

- [ ] **Step 3: Sửa bảng theo đúng năm gạch đầu dòng ở S206 §8**

Gồm:
- chữ ký `ship(packageId, lines, { actorId, forced? })` và nghĩa của `forced`;
- ghi chú chống lặp cho `reserve`, `release` (Q11);
- ghi chú cho `ship`: gọi lặp và giá vốn dòng kiện (Q12, Q16);
- ghi chú lượt đảo cho `reverseShipment` (Q17);
- ghi chú gọi lặp cho `receiveBack` (Q19).

Chép nguyên văn câu trong ngoặc kép ở S206 §8.

- [ ] **Step 4: Commit, rồi hỏi Khang trước khi push và mở PR**

```bash
git -C /d/DA-TMDT/Documents commit -am "21 §11.1: chữ ký ship có forced, cách chống lặp và lượt đảo của cổng tồn theo kiện (commerio-backend#206)"
```

Người duyệt: Thành, Khoa.

---

## PR 3: Bản thật

Tạo nhánh `feature/206-than-cong-ton` từ `main` sau khi PR 1 đã merge.

### Task 3: Luật thuần (domain)

**Files:**
- Modify: `src/modules/product/inventory/domain/stock.ts:35-41`
- Create: `src/modules/product/inventory/domain/documents.ts`
- Test: `test/unit/modules/product/inventory/domain/stock.test.ts:48-66`
- Create test: `test/unit/modules/product/inventory/domain/documents.test.ts`

**Interfaces:**
- Produces (`domain/stock.ts`):
  - `shortfall(level: { onHand: number; reserved: number }): number`, bằng `reserved − onHand`
  - `worsens(before: { onHand: number; reserved: number }, after: { onHand: number; reserved: number }): boolean`, bằng `breaksInvariant(after) && shortfall(after) > shortfall(before)`. `before` giờ cần thêm `reserved`.
  - `averageCost(lines: readonly { quantity: number; unitCost: Decimal.Value }[]): Decimal`, bằng `Σ(q × giá) / Σq`, làm tròn nửa lên 2 chữ số; mảng rỗng hoặc `quantity` không nguyên dương thì ném lỗi
- Produces (`domain/documents.ts`):
  - `interface StockLine { variantId: string; quantity: number }` (chuyển từ `port.ts`)
  - `interface DocumentRef { documentId: string; number: string }`
  - `DOC_PREFIX = { shipment: 'XK', shipment_reversal: 'DX', return_inspection: 'KT' } as const`; `type SystemDocKind = keyof typeof DOC_PREFIX`
  - `docNumber(prefix: string, n: number): string`, cho ra `${prefix}-${n đệm 0 tới 6 chữ số}`
  - `mergeLines(lines: readonly StockLine[]): Map<string, number>`: gộp theo SKU; `quantity` không phải số nguyên dương thì ném `Error` kèm SKU
  - `sameLines(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean`
  - `activeRound<T extends { kind: 'shipment' | 'shipment_reversal' }>(docs: readonly T[]): T[]`: `docs` đã sắp theo thời điểm lập; trả các phiếu `shipment` sau phiếu `shipment_reversal` cuối cùng

- [ ] **Step 1: Viết test đỏ cho `worsens`, `shortfall`, `averageCost`**

Đổi describe `không làm tệ hơn (spec #111 Q6)` thành `(spec #206 Q14)`. Thêm `reserved` vào `before` của các ca cũ (giữ nguyên kết quả mong đợi), và thêm:

```ts
it('bàn giao thường khi đang Tồn âm thì qua: tồn 3 giữ 5 → tồn 1 giữ 3', () => {
  expect(worsens({ onHand: 3, reserved: 5 }, { onHand: 1, reserved: 3 })).toBe(false);
});
it('giảm tồn làm phần hụt tăng thì chặn: tồn 5 giữ 2 → tồn 1 giữ 2', () => {
  expect(worsens({ onHand: 5, reserved: 2 }, { onHand: 1, reserved: 2 })).toBe(true);
});
it('nhập khi vẫn còn âm thì qua: −5 → −2', () => {
  expect(worsens({ onHand: -5, reserved: 0 }, { onHand: -2, reserved: 0 })).toBe(false);
});
it('giữ quá tồn thực thì chặn', () => {
  expect(worsens({ onHand: 5, reserved: 0 }, { onHand: 5, reserved: 6 })).toBe(true);
});
it('averageCost: một dòng, nhiều dòng, làm tròn nửa lên', () => {
  expect(averageCost([{ quantity: 3, unitCost: '80000' }]).toFixed(2)).toBe('80000.00');
  expect(averageCost([{ quantity: 3, unitCost: '80000' }, { quantity: 2, unitCost: '90000' }]).toFixed(2)).toBe('84000.00');
  expect(averageCost([{ quantity: 1, unitCost: '0.01' }, { quantity: 1, unitCost: '0' }]).toFixed(2)).toBe('0.01');
  expect(() => averageCost([])).toThrow();
});
```

- [ ] **Step 2: Viết test đỏ cho `documents.test.ts`**

```ts
expect(docNumber('XK', 1)).toBe('XK-000001');
expect(docNumber('DX', 1234567)).toBe('DX-1234567');
expect(DOC_PREFIX).toEqual({ shipment: 'XK', shipment_reversal: 'DX', return_inspection: 'KT' });
expect(mergeLines([{ variantId: 'a', quantity: 2 }, { variantId: 'b', quantity: 1 }, { variantId: 'a', quantity: 3 }]))
  .toEqual(new Map([['a', 5], ['b', 1]]));
expect(mergeLines([])).toEqual(new Map());
it.each([0, -1, 1.5, Number.NaN])('mergeLines từ chối quantity %s', (q) => {
  expect(() => mergeLines([{ variantId: 'a', quantity: q }])).toThrow(/a/);
});
expect(sameLines(new Map([['a', 3]]), new Map([['a', 3]]))).toBe(true);
expect(sameLines(new Map([['a', 3]]), new Map([['a', 3], ['b', 1]]))).toBe(false);
const xk = (n: number) => ({ kind: 'shipment' as const, n });
const dx = (n: number) => ({ kind: 'shipment_reversal' as const, n });
expect(activeRound([xk(1), dx(1), xk(2), xk(3)])).toEqual([xk(2), xk(3)]);
expect(activeRound([xk(1)])).toEqual([xk(1)]);
expect(activeRound([xk(1), dx(1)])).toEqual([]);
expect(activeRound([])).toEqual([]);
```

- [ ] **Step 3: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/unit/modules/product/inventory/domain`
Expected: FAIL, vì các hàm mới chưa có và `worsens` chưa xét `reserved` của `before`.

- [ ] **Step 4: Viết các hàm ở Interfaces**

Ở `posting.ts:73`, truyền đủ `before` (có `reserved`) cho `worsens` để typecheck qua. Task 5 sẽ viết lại đoạn này.

- [ ] **Step 5: Chạy lại test**

Run: `npx vitest run test/unit/modules/product/inventory/domain && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/product/inventory/domain src/modules/product/inventory/service/posting.ts test/unit/modules/product/inventory/domain
git commit -m "#206: worsens theo phần hụt (Q14), averageCost, luật phiếu do hệ thống lập"
```

### Task 4: Lõi `applyChange` đổi được cả đang giữ

**Files:**
- Create: `src/modules/product/inventory/service/locked.ts`
- Modify: `src/modules/product/inventory/service/port.ts:18-19` (bỏ `lockedOf`, import từ `locked.ts`)
- Modify: `src/modules/product/inventory/service/thresholds.ts:7`
- Modify: `src/modules/product/inventory/service/posting.ts` (cả file trừ `receiveGoods`)
- Modify: `src/modules/product/inventory/repository/levels.ts:104-112`
- Test: `test/integration/product/inventory/posting.test.ts` (thêm describe `applyChange`)

**Interfaces:**
- Consumes: `worsens`, `shortfall` (Task 3)
- Produces:
  - `service/locked.ts`: `export const lockedOf = (_variantId: string) => 0`. Chuyển nguyên comment `shortcut` từ `port.ts:18`.
  - `repository/levels.ts`: `saveLevel(variantId, next: { onHand; reserved; quarantine; avgCost; invariantBroken }, bumpVersion: boolean)`; `bumpVersion` false khi SKU chỉ đổi đang giữ (Q24)
  - `service/posting.ts`:
    - `lockLevels(variantIds: readonly string[]): Promise<Map<string, LevelRow>>`: bỏ trùng và sắp tăng dần, gọi `getVariants` (id lạ thì `Error` "Biến thể không thuộc công ty"), rồi `lockLevel` từng id
    - `interface StockChange { source: { type: StockSourceType; id: string } | null; moves: readonly Move[]; reserved?: ReadonlyMap<string, number>; forced?: boolean; actorId: string | null }`
    - `applyChange(change: StockChange, precheck?: (locked: ReadonlyMap<string, LevelRow>) => boolean): Promise<boolean>`
    - `applyMoves(source, moves, actorId)` giữ chữ ký, thân gọi `applyChange({ source, moves, actorId })`

- [ ] **Step 1: Chuyển `lockedOf` sang `service/locked.ts`, đổi import ở `port.ts`, `posting.ts`, `thresholds.ts`**

Run: `npm run typecheck && npm run depcruise`
Expected: PASS. Đây là bước refactor, hành vi không đổi.

- [ ] **Step 2: Viết test đỏ trong describe `applyChange` của `posting.test.ts`**

Dùng `levelOf`, `movesOf`, `stockEvents` có sẵn trong file; dùng `setBuckets` từ `./helpers.ts`.

```ts
it('chỉ đổi đang giữ: không ghi thẻ kho, không phát stock_changed, không tăng version (Q24)', async () => {
  // A tồn 5 (receive). applyChange({ source: null, moves: [], reserved: new Map([[A, 2]]), actorId: null }) → true
  // levelOf: on_hand 5, reserved 2, version không đổi; stock_moves của A vẫn 1 dòng (dòng của receive); stockEvents(A) = []
});
it('precheck trả false: trả false, không ghi gì', async () => {
  // applyChange(..., () => false) → false; reserved và version không đổi
});
it('move tồn thực và đang giữ trong một lần ghi: một sự kiện mang số sau cùng', async () => {
  // A tồn 10, giữ 3 (setBuckets), giá vốn 80000. moves [{ A, on_hand, −3, unitCost '80000.00', sourceLineId: null }],
  // reserved { A: −3 }, source { type: 'stock_document', id }
  // → on_hand 7, reserved 0; stockEvents(A) = [{ variantId: A, onHand: 7, reserved: 0, available: 7 }]
});
it('đang giữ xuống dưới 0 → Error "nhả quá số đang giữ", DB không đổi', async () => {
  // reserved { A: −1 } khi giữ 0 → rejects.toThrow(/nhả quá số đang giữ/); levelOf không đổi
});
it('Q14: đang Tồn âm mà giảm làm phần hụt tăng → InsufficientStock; forced thì qua, invariant_broken true', async () => {
  // A tồn 3 giữ 5 invariant_broken. move −1 không kèm đang giữ → rejects InsufficientStock
  // cùng move với forced: true → on_hand 2, invariant_broken true
});
it('có move mà source null → Error', async () => { /* rejects.toThrow() */ });
```

- [ ] **Step 3: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/integration/product/inventory/posting.test.ts`
Expected: các ca mới FAIL vì `applyChange` chưa có; các ca cũ vẫn PASS.

- [ ] **Step 4: Viết `lockLevels`, `applyChange`, `saveLevel(reserved)`**

Viết theo S206 5.4, bước 1–9, đúng thứ tự kiểm ở bước 5:
1. `reserved < 0`: ném `Error` "nhả quá số đang giữ: <SKU>";
2. `quarantine < 0`: ném `InsufficientStock`;
3. không `forced` mà `worsens(trước, sau)`: ném `InsufficientStock`.

Phát `stock_changed` cho SKU có `on_hand` đổi; gọi `recheckThresholds` cho SKU có `on_hand` hoặc `reserved` đổi. Sau đó cho `applyMoves` gọi qua `applyChange`.

- [ ] **Step 5: Chạy lại toàn bộ test inventory**

Run: `npx vitest run test/integration/product/inventory test/unit/modules/product/inventory`
Expected: PASS, kể cả test cũ của `receiveGoods`, `applyMoves`, ngưỡng (AC 11).

- [ ] **Step 6: Commit**

```bash
git add src/modules/product/inventory test/integration/product/inventory/posting.test.ts
git commit -m "#206: lõi applyChange đổi cả đang giữ trong một lần khoá; lockedOf sang service/locked.ts"
```

### Task 5: `reserve`, `release`

**Files:**
- Create: `src/modules/product/inventory/service/reservation.ts`
- Modify: `src/modules/product/inventory/service/port.ts` (bỏ hai thân giả, re-export từ `reservation.ts`; re-export `StockLine` từ `domain/documents.ts`)
- Modify: `test/integration/product/inventory/port.test.ts` (bỏ ca bản giả của `reserve`, `release`)
- Create test: `test/integration/product/inventory/reservation.test.ts`

**Interfaces:**
- Consumes: `applyChange`, `LevelRow` (Task 4); `mergeLines`, `StockLine` (Task 3); `availableQty` (`domain/stock.ts`); `lockedOf` (`service/locked.ts`)
- Produces:
  - `reserve(packageId: string, lines: readonly StockLine[]): Promise<{ reserved: boolean }>`
  - `release(packageId: string, lines: readonly StockLine[]): Promise<void>`

- [ ] **Step 1: Viết test đỏ** (import cổng từ `#src/modules/product/index.ts`; đặt ngưỡng bằng `testPool().query('update product.stock_levels set min_qty = $3 where company_id = $1 and variant_id = $2', …)`)

```ts
it('AC1: thiếu một dòng thì không giữ gì; đủ hết thì giữ cả kiện, không phát stock_changed, có below_threshold của A', …)
  // A tồn 5, ngưỡng 2; B tồn 1. reserve(k1, [A×3, B×2]) → { reserved: false }; levelOf A, B không đổi; outbox không có dòng nào cho A, B
  // receive thêm 1 B. Gọi lại → { reserved: true }; A reserved 3, B reserved 2
  // stockEvents(A) = [], stockEvents(B) = []; alerts(A) = [{ variantId: A, available: 2, minQty: 2 }]
it('AC2: gộp dòng cùng SKU: A tồn 4, reserve(k2, [A×2, A×3]) → false', …)
it('AC3: release(k1, [A×3, B×2]) đưa đang giữ về 0, không phát stock_changed; nhả thêm A×1 → lỗi có packageId, DB không đổi', …)
  // rejects.toThrow(new RegExp(k1))
it('AC10a: A tồn 1, hai reserve A×1 song song → đúng một true, đang giữ 1', …)
  // raceBehindLock(h => h.query('select 1 from product.stock_levels where company_id = $1 and variant_id = $2 for update', [c, A]), 2,
  //   () => Promise.all([withCompany(c, () => reserve(randomUUID(), [{ variantId: A, quantity: 1 }])), …same…]))
  // → kết quả sắp lại bằng [{ reserved: false }, { reserved: true }]
it('SKU chưa có dòng tồn: reserve trả false', …)                          // Review Focus 3
it('quantity 0 → Error, không ghi gì', …)                                   // Review Focus 1
it('SKU của công ty khác → Error, không tạo dòng tồn cho SKU đó', …)
it('lines rỗng: reserve trả true, release không làm gì', …)
```

`alerts` và `stockEvents` lấy từ `core.outbox_messages` như ở `thresholds.test.ts:13` và `posting.test.ts:29`; chép hai hàm này sang file test mới.

- [ ] **Step 2: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/integration/product/inventory/reservation.test.ts`
Expected: FAIL. AC1 sai vì bản giả trả `true` mà không ghi gì.

- [ ] **Step 3: Viết `reservation.ts`**

- `reserve`: `mergeLines`; rỗng thì trả `{ reserved: true }`. Gọi `applyChange({ source: null, moves: [], reserved: +q, actorId: null }, precheck)`, trong đó `precheck` kiểm mọi SKU có `availableQty(onHand, reserved, lockedOf(id)) ≥ q`.
- `release`: `mergeLines`; rỗng thì thôi. Gọi `applyChange` với `reserved: −q` và `precheck` kiểm mọi SKU có `reserved ≥ q`. Kết quả `false` thì ném `Error("Kiện <packageId> nhả quá số đang giữ: <SKU>")`.

Cập nhật `port.ts`, bỏ hai dòng `reserve`, `release` trong ca bản giả của `port.test.ts`.

- [ ] **Step 4: Chạy lại test**

Run: `npx vitest run test/integration/product/inventory && npm run depcruise`
Expected: PASS, depcruise không báo vòng.

- [ ] **Step 5: Commit**

```bash
git commit -m "#206: reserve, release nguyên kiện qua lõi applyChange"
```

### Task 6: `ship` và phiếu do hệ thống lập

**Files:**
- Create: `src/modules/product/inventory/repository/documents.ts`
- Create: `src/modules/product/inventory/service/documents.ts`
- Create: `src/modules/product/inventory/service/shipment.ts`
- Modify: `src/modules/product/inventory/service/port.ts`, `src/modules/product/inventory/index.ts` (export thêm `type ShipOptions`, `type DocumentRef`)
- Modify: `test/integration/product/inventory/port.test.ts` (bỏ ca bản giả của `ship`)
- Create test: `test/integration/product/inventory/shipment.test.ts`

**Interfaces:**
- Consumes: `lockLevels`, `applyChange` (Task 4); `mergeLines`, `sameLines`, `activeRound`, `docNumber`, `DOC_PREFIX`, `DocumentRef` (Task 3); `takeNextNumber` (`repository/counters.ts`); `recordTransition` (`core/index.ts`)
- Produces:
  - `repository/documents.ts`:
    - `insertDocument(d: { number: string; kind: SystemDocKind; status: 'posted' | 'draft'; sourceType: 'package' | 'return_request'; sourceId: string; actorId: string | null; note: string | null }): Promise<string>`
      - `created_at = sql\`clock_timestamp()\`` (Q22)
      - khi `posted`: `posted_at = now()`, `posted_by = actorId`
      - `created_by = actorId`
    - `insertDocumentLines(documentId: string, lines: readonly { variantId: string; quantity: number | null; expectedQty: number | null; unitCost: string | null }[]): Promise<Map<string, string>>`, trả `variantId → id dòng phiếu`
    - `packageShipments(packageId: string): Promise<ShipmentDoc[]>`:
      - `ShipmentDoc = { id; number; kind: 'shipment' | 'shipment_reversal'; lines: { variantId; quantity: number; unitCost: string }[] }`
      - sắp theo `created_at`, rồi `id`
      - hai câu: lấy phiếu theo `(source_type, source_id)`, rồi lấy dòng theo `document_id in (…)`
    - `returnInspectionOf(sourceType: 'package' | 'return_request', sourceId: string): Promise<DocumentRef | null>`
  - `service/documents.ts`: `createSystemDocument(input: Omit<insertDocument input, 'number'> & { lines: …; reason?: string | null }): Promise<{ ref: DocumentRef; lineIdOf: Map<string, string> }>`
    - lấy số bằng `takeNextNumber(kind)` rồi ghép `docNumber(DOC_PREFIX[kind], n)`
    - chèn phiếu và dòng
    - gọi `recordTransition({ entityType: 'stock_documents', entityId, from: null, to: status, action: 'create', actorId, reason })`
  - `service/shipment.ts`: `interface ShipOptions { actorId: string | null; forced?: boolean }`; `ship(packageId: string, lines: readonly StockLine[], opts: ShipOptions): Promise<DocumentRef>`

- [ ] **Step 1: Viết test đỏ**

```ts
it('AC4: A tồn 10 giữ 3 giá vốn 80.000; ship(k3, [A×3]) → tồn 7 giữ 0, phiếu XK-000001 posted', …)
  // ref.number 'XK-000001'; stock_documents: kind 'shipment', status 'posted', source_type 'package', source_id k3, created_by = posted_by = actor
  // stock_document_lines: một dòng A quantity 3 unit_cost '80000.00'
  // movesOf(ref.documentId) = [{ bucket 'on_hand', qty_change −3, balance_after 7, unit_cost '80000.00', source_type 'stock_document', source_line_id = id dòng phiếu, done_by actor }]
  // stockEvents(A) = [{ variantId: A, onHand: 7, reserved: 0, available: 7 }]
  // trong cùng withCompany: (await stockOf([A])).get(A)!.avgCost === '80000.00'
  // state_transitions: entity_type 'stock_documents', entity_id ref.documentId, to_state 'posted', action 'create'
it('AC5: gọi lại ship(k3, [A×3]) → trả XK-000001; không thêm phiếu, thẻ kho, sự kiện', …)
it('gọi lặp với dòng tách khác: ship(k, [A×1, A×2]) rồi ship(k, [A×3]) → cùng phiếu', …)   // Review Focus 2
it('AC6: A tồn 3 giữ 5 invariant_broken; ship 2 → tồn 1 giữ 3, invariant_broken vẫn true', …)
it('AC7a: forced khi tồn 1 giữ 0: ship(k4, [A×3], { actorId: null, forced: true }) → tồn −2, invariant_broken true, note "Bàn giao bắt buộc theo sàn", created_by null', …)
it('AC7b: A tồn 5 forced 3 → tồn 2, invariant_broken false', …)
it('AC7c: A tồn 5 giữ 0, ship 2 không forced → Error; DB không đổi, không có dòng doc_counters loại shipment', …)
it('forced cho SKU chưa có dòng tồn → tạo dòng tồn âm', …)                                  // Review Focus 3
it('AC10b: A tồn 5 giữ 2; reserve A×3 và ship(k, [A×2]) song song → cả hai qua, tồn 3 giữ 3', …)
it('AC10c: A tồn 5 giữ 2; hai ship(k6, [A×2]) song song → cùng phiếu, tồn 3, một dòng thẻ kho', …)
  // raceBehindLock(khoá dòng tồn của A, 2, () => Promise.all([...]))
it('lines rỗng → Error', …)
```

- [ ] **Step 2: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/integration/product/inventory/shipment.test.ts`
Expected: FAIL, vì bản giả trả `XK-000000`.

- [ ] **Step 3: Viết `repository/documents.ts`, `service/documents.ts`, `ship`**

`ship` làm theo các bước:
1. `mergeLines`; rỗng thì ném `Error`.
2. `lockLevels`.
3. Lưới Q12: trong `activeRound(await packageShipments(packageId))` có phiếu `shipment` mà `sameLines(dòng gộp của phiếu, dòng gộp của lần gọi)` thì trả `{ documentId, number }` của phiếu đó.
4. Không `forced` mà có SKU giữ ít hơn số bàn giao: ném `Error("Kiện <packageId> chưa giữ hàng; bàn giao bắt buộc thì truyền forced")`. Bước này chạy trước khi lấy số phiếu (chỗ chốt thêm 4).
5. `createSystemDocument`: kind `shipment`, status `posted`; giá dòng lấy `avgCost` của dòng tồn đã khoá; `note` ghi `'Bàn giao bắt buộc theo sàn'` khi `forced`.
6. `applyChange` với move `on_hand −q`, `unitCost = avgCost`, `sourceLineId = lineIdOf.get(variantId)`, source `{ type: 'stock_document', id }`. Không `forced` thì kèm `reserved: −q`.

Export kiểu ở `index.ts`; bỏ ca bản giả của `ship` trong `port.test.ts`.

- [ ] **Step 4: Chạy lại test**

Run: `npx vitest run test/integration/product/inventory && npm run typecheck && npm run depcruise`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "#206: ship lập phiếu XK, trừ tồn thực và đang giữ; forced cho bàn giao bắt buộc; lưới gọi lặp theo lượt"
```

### Task 7: `reverseShipment`

**Files:**
- Modify: `src/modules/product/inventory/service/shipment.ts`, `service/port.ts`
- Modify: `test/integration/product/inventory/port.test.ts` (bỏ ca bản giả của `reverseShipment`)
- Test: `test/integration/product/inventory/shipment.test.ts` (thêm describe `reverseShipment`)

**Interfaces:**
- Consumes: `packageShipments`, `createSystemDocument` (Task 6); `activeRound`, `averageCost`, `mergeLines` (Task 3)
- Produces: `reverseShipment(packageId: string, lines: readonly StockLine[], opts: { actorId: string; reason: string }): Promise<DocumentRef>`

- [ ] **Step 1: Viết test đỏ**

```ts
it('AC8: đảo theo giá của lượt, giá vốn tính lại 90.000,00; gọi lại lỗi; bàn giao lại rồi đảo lần hai lấy giá 90.000', …)
  // từ trạng thái sau AC4 (tồn 7 giá 80.000, XK-000001 của k3); receiveGoods 10 cái giá '100000' → avg_cost '91764.71', tồn 17
  // reverseShipment(k3, [A×3], { actorId, reason: 'Quét nhầm kiện' }) → number 'DX-000001'
  //   levelOf: on_hand 20, reserved 3, avg_cost '90000.00'; dòng phiếu DX unit_cost '80000.00'; note = reason
  //   stockEvents(A) có thêm { onHand: 20, reserved: 3, available: 17 }
  // gọi lại reverseShipment(k3, …) → rejects (không còn lượt đang xuất)
  // ship(k3, [A×3], { actorId }) → 'XK-000002' (lưới không trả XK-000001), unit_cost '90000.00'
  // reverseShipment lần hai → 'DX-000002', dòng phiếu unit_cost '90000.00'
it('reason chỉ có khoảng trắng hoặc dài 501 ký tự → Error, không có phiếu DX', …)            // Review Focus 5
it('đảo SKU không có trong lượt, hoặc đảo nhiều hơn số đã xuất → Error', …)                   // Review Focus 5
it('kiện chưa từng bàn giao → Error', …)
```

- [ ] **Step 2: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/integration/product/inventory/shipment.test.ts -t reverseShipment`
Expected: FAIL.

- [ ] **Step 3: Viết `reverseShipment`**

Các bước:
1. `mergeLines`; rỗng thì ném lỗi.
2. `reason.trim()` phải khác rỗng và dài ≤ 500 ký tự.
3. `lockLevels`.
4. Lấy `round = activeRound(packageShipments)`. `round` rỗng thì ném lỗi. Với mỗi SKU: số đảo phải ≤ tổng `quantity` của SKU đó trong `round`, giá dòng phiếu là `averageCost` các dòng xuất của SKU trong `round`.
5. `createSystemDocument`: kind `shipment_reversal`, status `posted`, `note = reason`, `reason` cũng ghi vào `recordTransition`.
6. `applyChange` với move `on_hand +q` theo giá đó, `reserved: +q`.

Bỏ ca bản giả của `reverseShipment` trong `port.test.ts`.

- [ ] **Step 4: Chạy lại test**

Run: `npx vitest run test/integration/product/inventory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "#206: reverseShipment đảo lượt bàn giao gần nhất theo giá của lượt (Q17)"
```

### Task 8: `receiveBack`

**Files:**
- Create: `src/modules/product/inventory/service/returns.ts`
- Modify: `src/modules/product/inventory/service/port.ts`
- Modify: `test/integration/product/inventory/port.test.ts` (xoá cả describe bản giả)
- Create test: `test/integration/product/inventory/return.test.ts`

**Interfaces:**
- Consumes: `returnInspectionOf`, `createSystemDocument` (Task 6); `mergeLines` (Task 3); `getVariants` (`catalog/index.ts`)
- Produces: `receiveBack(source: { type: 'package' | 'return_request'; id: string }, lines: readonly StockLine[]): Promise<DocumentRef>`

- [ ] **Step 1: Viết test đỏ**

```ts
it('AC9: receiveBack(package k5, [A×2, A×1]) → KT-000001 draft, một dòng A expected_qty 3, unit_cost null; tồn và outbox không đổi', …)
  // stock_documents: kind 'return_inspection', status 'draft', source_type 'package', source_id k5, created_by null, posted_at null
  // gọi lại cùng nguồn → 'KT-000001'; nguồn { type: 'return_request', id khác } → 'KT-000002'
  // state_transitions: to_state 'draft', actor_id null, source 'system'
it('SKU của công ty khác → Error, không lập phiếu', …)                                         // Review Focus 4
it('lines rỗng hoặc source.type lạ → Error', …)
```

- [ ] **Step 2: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/integration/product/inventory/return.test.ts`
Expected: FAIL.

- [ ] **Step 3: Viết `receiveBack`**

Các bước:
1. Kiểm `source.type`.
2. `mergeLines`; rỗng thì ném lỗi.
3. `getVariants`; SKU không thuộc công ty thì ném `Error`.
4. `returnInspectionOf` tìm thấy phiếu thì trả phiếu đó.
5. `createSystemDocument`: kind `return_inspection`, status `draft`, `actorId: null`, dòng có `expectedQty = q`, `quantity: null`, `unitCost: null`.

Không gọi `applyChange`. Xoá describe bản giả trong `port.test.ts`.

- [ ] **Step 4: Chạy lại test**

Run: `npx vitest run test/integration/product/inventory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "#206: receiveBack lập phiếu kiểm hàng hoàn nháp, gọi lại cùng nguồn trả phiếu cũ"
```

### Task 9: Tài liệu module, kiểm toàn bộ, mở PR

**Files:**
- Modify: `src/modules/product/inventory/CLAUDE.md` (mục "Ghi sổ", "Gọi vào", thêm "Bên gọi phải làm")
- Modify: header comment của `src/modules/product/inventory/index.ts:1-3` và `service/posting.ts:1-2` (nhắc `applyChange`)

- [ ] **Step 1: Cập nhật `inventory/CLAUDE.md`**

Ghi các điểm sau:
- lõi `applyChange` đổi cả đang giữ; `worsens` theo phần hụt (Q14);
- năm hàm và cách mỗi hàm chống gọi lặp (Q11, Q12, Q19);
- ba bộ đếm `XK`, `DX`, `KT` (Q18);
- việc bên gọi phải làm: khoá kiện trước khi gọi cổng, đổi `reserved_qty`, `stock_deducted` có điều kiện, đọc `stockOf(...).avgCost` sau `ship` (Q16);
- ba điểm ở mục "Hiệu năng và vận hành" của plan này.

- [ ] **Step 2: Chạy toàn bộ kiểm tra và cập nhật đồ thị**

Run: `npm run check && graphify update .`
Expected: xanh; depcruise không báo vi phạm.

- [ ] **Step 3: Kiểm staging trước khi merge (S206 §10)**

Hỏi Khang trước khi đụng staging. Chạy câu chỉ đọc sau, an toàn:

```sql
select count(*) from "order".package_lines where reserved_qty > 0;
```

- Kết quả 0: không phải làm gì.
- Khác 0: Khang chọn xoá kiện demo, hoặc chạy script đặt `stock_levels.reserved` bằng tổng `reserved_qty` của các kiện còn mở. Không tự chạy câu ghi nào.

- [ ] **Step 4: Commit, rồi hỏi Khang trước khi push và mở PR vào `main`**

Thân PR cần ghi:
- PR Documents (Task 2) phải merge trước;
- #199 trỏ `stock-port.ts` sang `product/index.ts` và làm phần khoá kiện, cập nhật có điều kiện (S206 §6 bước 4);
- AC 1–11 nằm ở test nào.
