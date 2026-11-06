# Thẻ kho đủ trường và lọc Tồn âm (#206 phần 2a): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /inventory/stock/:variantId` trả thẻ kho đúng hình `StockMove` của FE (`onHandAfter`, `area`, `document { id, number, type, kind }`, `doneBy` có thể null). `GET /inventory/stock` lọc được Tồn âm. `StockLevel` có `drift`.

**Architecture:** Luật suy `kind`, `area` là hàm thuần ở `domain/moves.ts`. Số phiếu kho inventory tự tra theo lô (`repository/move-sources.ts`). Số phiếu nhận, phiếu trả NCC do purchasing đưa qua `ctx`, cùng khuôn `incomingOf`. Không migration, không đổi luồng ghi sổ.

**Tech Stack:** Node 24 (chạy thẳng `.ts`), Express 5, Zod 4, Drizzle ORM 0.45 + PostgreSQL 18, Vitest + testcontainers + Supertest.

**Spec:** `docs/superpowers/specs/2026-11-06-206-so-lieu-the-kho-design.md` (gọi tắt **S2a**).

## Global Constraints

- Import tương đối có đuôi `.ts`. Không `enum`, `namespace`, parameter property.
- Định danh viết tiếng Anh; comment, message, tên `describe`/`it` viết tiếng Việt.
- Đầu vào HTTP qua `validate(...)`; lỗi nghiệp vụ ném `AppError(status, code, message)`.
- `domain/` không import lớp nào khác của module (luật `domain-thuan`). Inventory không import `purchasing`; số phiếu của purchasing đi qua `ctx` (S2a D2).
- Mọi truy vấn đọc chạy trong `withCompany` của request và lọc `company_id`.
- Không migration (S2a D9).
- Test chỉ nằm trong `test/`, import bằng `#src/...ts`. Integration test cần Docker đang chạy.
- Dùng `npm`. Chạy `npm run check` trước PR, `graphify update .` sau khi sửa code. File trong `docs/superpowers/` phải `git add -f`.
- Commit có dạng `#206: <việc>`, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Thân PR kết thúc bằng `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Nhánh và PR

| PR | Repo, nhánh | Task |
|---|---|---|
| Documents | `Documents`, `docs/21-the-kho` từ `main` | 1 |
| Backend | `commerio-backend`, `feature/206-the-kho` (đã có commit spec `04ae98b`, tách từ `main`) | 2–6 |
| FE | ngoài plan này (S2a §4, §7) | — |

## Chỗ plan chốt thêm so với spec

1. **Tên file khác S2a 5.3 để tránh xung đột với #266.** #266 (chưa merge) tạo `domain/documents.ts`, `repository/documents.ts` và sửa `domain/stock.ts`. Nhánh này tách từ `main`, nên:
   - `documentKind`, `areaOf` đặt ở file mới `domain/moves.ts`;
   - `documentHeads` đặt ở file mới `repository/move-sources.ts`.
2. **`purchaseDocumentNumbers` đặt ở file mới `purchasing/repository/document-numbers.ts`.** Purchasing export hàm này thẳng ở `index.ts`, giống `incomingOf`.
3. **`getStock` gom hai hàm tra cứu thành tham số đầu `lookups: StockLookups`.** Route dựng `lookups` từ `incomingLookupOf(ctx)` và `purchaseNumbersOf(ctx)`. `listStock`, `setReorderRule` vẫn nhận `incomingOf` như cũ.
4. **Thêm helper test `postedReceipt` vào `test/integration/product/purchasing/helpers.ts`.** Helper lập rồi ghi sổ một phiếu nhận qua API, theo cách `receipt-posting.test.ts:40-49` đang làm (`createReceipt`, `PUT` số đếm, `post`).

## Review Focus

1. **Thẻ kho có đủ ba loại nguồn trong cùng 100 dòng:** kiểm kê tay, phiếu nhận `NH-` và phiếu xuất `XK-` của một SKU. Mỗi dòng phải ra đúng số phiếu của nó, không lẫn. Test ở Task 5.
2. **SKU chưa có dòng thẻ kho nào:** trả `moves: []` và không gọi tra cứu purchasing. Test ở Task 5.
3. **`negative=true` cùng `belowMin=true`:** chỉ ra SKU thoả cả hai (AND). Test ở Task 4.
4. **Dòng thẻ kho gắn phiếu trả NCC `TN-`:** luồng hiện tại chưa ghi loại dòng này, nhưng hợp đồng đã có. Phải ra `supplier_return`, `purchase` và đúng số `TN-`. Test ở Task 5.
5. **Phiếu kho `stocktake` có `source_type` nhưng không phải kiểm kê đầu kỳ:** ra `auto` theo bảng S2a 5.2. Test ở Task 2.

---

## PR 1: Documents

### Task 1: Sửa `21` §15.2 theo S2a §8

**Files:**
- Modify: `D:\DA-TMDT\Documents\21-hop-dong-api-fe-be.md`, mục `### 15.2` (khoảng dòng 810–824)

- [ ] **Step 1: Tạo nhánh `docs/21-the-kho` từ `origin/main` của repo Documents**

- [ ] **Step 2: Sửa bảng §15.2**

Dòng `GET /inventory/stock`, cột "Vào": `page, pageSize, search, categoryId, belowMin, quarantine` thành `page, pageSize, search, categoryId, belowMin, quarantine, negative` (`negative=true`: chỉ SKU Tồn âm).

- [ ] **Step 3: Thêm vào đoạn "Kiểu dữ liệu đầy đủ…" của §15.2**

Ghi bốn ý theo S2a §8:
- `StockMove.area` là `'stock' | 'quarantine'`;
- `document.type` là loại phiếu kho (gồm `shipment`, `shipment_reversal`), `goods_receipt` hoặc `supplier_return`;
- `document.kind` suy ra theo bảng S2a 5.2;
- `StockLevel.drift` luôn `false` tới commerio-backend#206 phần 2b.

- [ ] **Step 4: Commit, push, mở PR (người duyệt: Thành, Khoa)**

```bash
git -C /d/DA-TMDT/Documents commit -am "21 §15.2: lọc Tồn âm, area, document.type và kind của thẻ kho, drift (commerio-backend#206 phần 2a)"
```

---

## PR 2: Backend (`feature/206-the-kho`)

### Task 2: Luật suy `kind` và `area`

**Files:**
- Create: `src/modules/product/inventory/domain/moves.ts`
- Test: `test/unit/modules/product/inventory/domain/moves.test.ts`

**Interfaces:**
- Produces (`domain/moves.ts`):
  - `type StockDocumentKind = 'stocktake' | 'write_off' | 'to_quarantine' | 'return_inspection' | 'shipment' | 'shipment_reversal'`
  - `type MoveSource = { type: 'goods_receipt' | 'supplier_return' } | { type: 'stock_document'; kind: StockDocumentKind; isOpening: boolean; sourceType: string | null }`
  - `type DocumentKind = 'manual' | 'purchase' | 'order' | 'auto'`
  - `documentKind(source: MoveSource): DocumentKind`, theo bảng S2a 5.2, kiểm theo thứ tự trong bảng
  - `areaOf(bucket: 'on_hand' | 'quarantine'): 'stock' | 'quarantine'`

- [ ] **Step 1: Viết test đỏ**

```ts
const doc = (kind: StockDocumentKind, extra: { isOpening?: boolean; sourceType?: string | null } = {}): MoveSource => ({
  type: 'stock_document', kind, isOpening: extra.isOpening ?? false, sourceType: extra.sourceType ?? null,
});
it.each([
  [{ type: 'goods_receipt' } as MoveSource, 'purchase'],
  [{ type: 'supplier_return' } as MoveSource, 'purchase'],
  [doc('shipment', { sourceType: 'package' }), 'order'],
  [doc('shipment_reversal', { sourceType: 'package' }), 'order'],
  [doc('return_inspection', { sourceType: 'package' }), 'auto'],
  [doc('stocktake', { isOpening: true }), 'auto'],
  [doc('write_off', { sourceType: 'stock_document' }), 'auto'],
  [doc('stocktake', { sourceType: 'stock_document' }), 'auto'],   // Review Focus 5
  [doc('stocktake'), 'manual'],
  [doc('write_off'), 'manual'],
  [doc('to_quarantine'), 'manual'],
])('documentKind(%o) = %s', (source, kind) => expect(documentKind(source)).toBe(kind));

it('areaOf: on_hand → stock, quarantine giữ nguyên', () => {
  expect([areaOf('on_hand'), areaOf('quarantine')]).toEqual(['stock', 'quarantine']);
});
```

- [ ] **Step 2: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/unit/modules/product/inventory/domain/moves.test.ts`
Expected: FAIL, không tìm thấy module `domain/moves.ts`.

- [ ] **Step 3: Viết `domain/moves.ts` theo Interfaces**

- [ ] **Step 4: Chạy lại test**

Run: `npx vitest run test/unit/modules/product/inventory/domain/moves.test.ts && npm run depcruise`
Expected: PASS; depcruise không báo vi phạm.

- [ ] **Step 5: Commit**

```bash
git add src/modules/product/inventory/domain/moves.ts test/unit/modules/product/inventory/domain/moves.test.ts
git commit -m "#206: luật suy kind, area của thẻ kho"
```

### Task 3: Purchasing tra số phiếu nhận, phiếu trả NCC

**Files:**
- Create: `src/modules/product/purchasing/repository/document-numbers.ts`
- Modify: `src/modules/product/purchasing/index.ts` (export)
- Modify: `test/integration/product/purchasing/helpers.ts` (thêm `postedReceipt`)
- Test: `test/integration/product/purchasing/document-numbers.test.ts`

**Interfaces:**
- Produces:
  - `purchaseDocumentNumbers(ids: readonly string[]): Promise<Map<string, string>>`, export ở `purchasing/index.ts`.
    - Tra `goods_receipts` và `supplier_returns` theo `id in (…)`, lọc `company_id = requireCompanyId(...)`, mỗi bảng một câu.
    - `ids` rỗng thì trả `Map` rỗng, không chạy câu nào.
    - Lọc trước bằng `isUuid` như `getVariants`, để id lạ không làm câu SQL lỗi.
  - Helper test `postedReceipt(t: { ceo: string; requester: string; kho: string }, supplierId: string, variantId: string, counts: { accepted: number; defectKept?: number; unitCost?: number }): Promise<{ receiptId: string; number: string }>`.
    - Lập đề nghị đã đặt bằng `orderedRequest`, số lượng = `accepted + defectKept`, `unitCost` mặc định 100000.
    - Kho lập phiếu, `PUT` số đếm, rồi `post`.

- [ ] **Step 1: Viết test đỏ (AC 8)**

```ts
it('AC8: trả số NH- và TN- của công ty; id công ty khác, id không phải uuid thì không có trong Map', async () => {
  // A: postedReceipt với accepted 3, defectKept 1 → phiếu nhận NH-000001 và phiếu trả NCC nháp TN-000001
  // returnId = select id from product.supplier_returns where company_id = A
  // B: postedReceipt → receiptB
  const map = await withCompany(A.companyId, () => purchaseDocumentNumbers([receiptId, returnId, receiptB, 'abc']));
  expect(Object.fromEntries(map)).toEqual({ [receiptId]: 'NH-000001', [returnId]: 'TN-000001' });
});
it('không có id thì Map rỗng', async () => {
  expect(await withCompany(A.companyId, () => purchaseDocumentNumbers([]))).toEqual(new Map());
});
```

- [ ] **Step 2: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/integration/product/purchasing/document-numbers.test.ts`
Expected: FAIL, `purchaseDocumentNumbers` chưa được export.

- [ ] **Step 3: Viết `document-numbers.ts`, export ở `purchasing/index.ts`, viết helper `postedReceipt`**

- [ ] **Step 4: Chạy lại test**

Run: `npx vitest run test/integration/product/purchasing && npm run depcruise`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/product/purchasing test/integration/product/purchasing
git commit -m "#206: purchasing tra số phiếu nhận, phiếu trả NCC theo lô cho thẻ kho"
```

### Task 4: Lọc Tồn âm và `drift`

**Files:**
- Modify: `src/modules/product/inventory/api/schemas.ts` (`StockListQuery`, `StockLevel`)
- Modify: `src/modules/product/inventory/service/stock.ts` (`listStock`)
- Modify: `src/modules/product/inventory/service/views.ts` (`toStockLevel`)
- Test: `test/integration/product/inventory/stock.test.ts` (describe `danh sách tồn`)

**Interfaces:**
- Produces:
  - `StockListQuery.negative`: viết như `belowMin` (`enum(['true','false'], 'negative là true hoặc false')`, transform sang boolean, optional);
  - `listStock` lọc thêm `(!q.negative || l.negative)`;
  - `toStockLevel` trả thêm `drift: false`, kèm comment `// shortcut: Lệch tồn thật ở #206 phần 2b (dữ liệu channel, #223).`;
  - `StockLevel` schema thêm `drift: z.boolean()`.

- [ ] **Step 1: Viết test đỏ (AC 1, 2; Review Focus 3)**

```ts
it('AC1: negative=true chỉ trả SKU Tồn âm; summary không theo lọc; negative=abc → 422', async () => {
  // A: receive 3, setBuckets reserved 5 + invariantBroken; B: receive 2
  const res = await inv(c.ceo.token).get('/stock?negative=true');
  expect(res.body.items.map((i) => i.variantId)).toEqual([A]);
  expect(res.body.total).toBe(1);
  expect(res.body.summary).toMatchObject({ variantCount: 2, negativeCount: 1 });
  expect((await inv(c.ceo.token).get('/stock?negative=abc')).status).toBe(422);
});
it('negative và belowMin gộp AND', async () => {
  // A Tồn âm có ngưỡng và dưới ngưỡng; B Tồn âm, chưa đặt ngưỡng; C dưới ngưỡng, không Tồn âm
  // GET /stock?negative=true&belowMin=true → chỉ A
});
it('AC2: mọi dòng có drift false; body parse được bằng StockPage', async () => {
  const res = await inv(c.ceo.token).get('/stock');
  StockPage.parse(res.body);
  expect(res.body.items.every((i) => i.drift === false)).toBe(true);
});
```

`StockPage` import từ `#src/modules/product/inventory/api/schemas.ts`.

- [ ] **Step 2: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/integration/product/inventory/stock.test.ts -t "negative|drift"`
Expected: FAIL. Lọc chưa có nên trả cả B; chưa có `drift`.

- [ ] **Step 3: Sửa schema, `listStock`, `toStockLevel` theo Interfaces**

- [ ] **Step 4: Chạy lại cả file**

Run: `npx vitest run test/integration/product/inventory/stock.test.ts`
Expected: PASS, kể cả ca Swagger cũ.

- [ ] **Step 5: Commit**

```bash
git add src/modules/product/inventory test/integration/product/inventory/stock.test.ts
git commit -m "#206: lọc Tồn âm ở danh sách tồn; StockLevel có drift (2a luôn false)"
```

### Task 5: Thẻ kho đủ trường

**Files:**
- Create: `src/modules/product/inventory/repository/move-sources.ts`
- Modify: `src/modules/product/inventory/service/views.ts` (`InventoryContext`, `purchaseNumbersOf`)
- Modify: `src/modules/product/inventory/service/stock.ts` (`getStock`)
- Modify: `src/modules/product/inventory/api/schemas.ts` (`StockMove`), `src/modules/product/inventory/api/routes.ts`
- Modify: `src/modules/product/index.ts` (tiêm `purchaseDocumentNumbers`)
- Test: `test/integration/product/inventory/stock.test.ts` (describe `chi tiết tồn`)

**Interfaces:**
- Consumes: `documentKind`, `areaOf`, `MoveSource`, `StockDocumentKind` (Task 2); `purchaseDocumentNumbers` (Task 3).
- Produces:
  - `documentHeads(ids: readonly string[]): Promise<Map<string, { number: string; kind: StockDocumentKind; isOpening: boolean; sourceType: string | null }>>` ở `repository/move-sources.ts`. Một câu trên `stock_documents` theo `id in (…)` và `company_id`; `ids` rỗng thì không chạy câu nào.
  - `type PurchaseNumberLookup = (ids: readonly string[]) => Promise<Map<string, string>>`.
  - `InventoryContext.purchaseDocumentNumbers?: PurchaseNumberLookup`.
  - `purchaseNumbersOf(ctx: InventoryContext): PurchaseNumberLookup`: chưa tiêm thì `AppError(500, 'internal_error', 'Chưa nối số phiếu của purchasing (src/modules/product/index.ts)')`.
  - `interface StockLookups { incomingOf: IncomingLookup; purchaseNumbers: PurchaseNumberLookup }`; `getStock(lookups: StockLookups, viewer: Viewer, variantId: string)`.
  - `StockMove` schema: `{ id, qtyChange, area: enum(['stock','quarantine']), onHandAfter, document: { id, number, type: enum([...6 loại phiếu kho, 'goods_receipt', 'supplier_return']), kind: enum(['manual','purchase','order','auto']) }, unitCost: money, doneAt, doneBy: string().nullable() }`.
  - `product/index.ts`: `withContext(inventoryModule, (ctx) => ({ ...ctx, incomingOf, purchaseDocumentNumbers }))`.
  - Dòng thẻ kho thiếu chứng từ: `AppError(500, 'internal_error', 'Thẻ kho <id dòng> trỏ chứng từ <source_id> không tồn tại')` (S2a D8).

- [ ] **Step 1: Viết helper chèn phiếu kho kèm dòng thẻ kho (trong `stock.test.ts`)**

`docMove(companyId, variantId, d: { kind: StockDocumentKind; number: string; isOpening?: boolean; sourceType?: string | null }, m: { qty: number; balanceAfter: number; bucket?: 'on_hand' | 'quarantine'; doneBy?: string | null })` chèn bằng `testPool()`:
- `stock_documents` với `status 'posted'`, `posted_at now()`;
- `counted_at now()` khi `kind = 'stocktake'`;
- `source_type 'package'`, `source_id` uuid ngẫu nhiên khi kind là `shipment`, `shipment_reversal` (CHECK `stock_documents_shipment_source`);
- một dòng `stock_moves` trỏ phiếu đó.

Trả `documentId`.

- [ ] **Step 2: Sửa ca cũ, viết test đỏ (AC 3–7; Review Focus 1, 2, 4)**

```ts
// ca cũ 'thẻ kho mới nhất trước…': đổi area: 'on_hand' → 'stock', balanceAfter → onHandAfter,
//   document → { id: expect.any(String), number: expect.stringMatching(/^KK-/), type: 'stocktake', kind: 'manual' }
it('AC3: ngăn stock và quarantine, onHandAfter là số của ngăn đó; body parse được bằng StockDetail', …)
  // docMove A: on_hand +5 (balance 5); quarantine +2 (balance 2) → moves[0] { area: 'quarantine', onHandAfter: 2 }, moves[1] { area: 'stock', onHandAfter: 5 }
it('AC4: phiếu nhận → { id: receiptId, number: "NH-000001", type: "goods_receipt", kind: "purchase" }, doneBy là tên người ghi sổ', …)
  // postedReceipt (Task 3) cho SKU A
it('AC5: XK-000001 → shipment, order; DX-000001 → shipment_reversal, order; doneBy null', …)
it('AC6: kiểm kê đầu kỳ → auto; xuất huỷ có source_type → auto; return_inspection → auto', …)
it('Review Focus 1: một SKU có dòng kiểm kê tay, phiếu nhận NH- và phiếu xuất XK- → mỗi dòng đúng số, type, kind của nó', …)
it('Review Focus 4: dòng gắn phiếu trả NCC TN- → { number: "TN-000001", type: "supplier_return", kind: "purchase" }', …)
  // postedReceipt có defectKept 1 → phiếu trả NCC nháp; chèn stock_moves source_type 'supplier_return', source_id = id phiếu trả
it('Review Focus 2: SKU chưa có dòng thẻ kho → moves []', …)
it('AC7: dòng thẻ kho trỏ chứng từ không tồn tại → 500', …)
  // chèn stock_moves source_type 'stock_document', source_id randomUUID()
```

Mọi ca 200 đều `StockDetail.parse(res.body)`.

- [ ] **Step 3: Chạy, xác nhận test đỏ**

Run: `npx vitest run test/integration/product/inventory/stock.test.ts -t "chi tiết tồn|AC3|AC4|AC5|AC6|AC7|Review Focus"`
Expected: FAIL. Response còn `area: 'on_hand'`, `balanceAfter`, `document` chưa có `number`, `kind`; AC7 trả 200.

- [ ] **Step 4: Viết `documentHeads`, `purchaseNumbersOf`, `getStock` mới, schema `StockMove`, route, tiêm ở `product/index.ts` theo Interfaces**

`getStock` gom `source_id` theo `source_type`, gọi `documentHeads` và `lookups.purchaseNumbers` mỗi hàm tối đa một lần (chỉ khi có id loại đó), rồi dựng từng dòng (S2a 5.3).

- [ ] **Step 5: Chạy lại test inventory, purchasing**

Run: `npx vitest run test/integration/product/inventory test/integration/product/purchasing test/unit/modules/product && npm run typecheck && npm run depcruise`
Expected: PASS; typecheck sạch; depcruise không báo vi phạm.

- [ ] **Step 6: Commit**

```bash
git add src/modules/product test/integration/product
git commit -m "#206: thẻ kho trả onHandAfter, area, số phiếu, loại và nhóm chứng từ; purchasing đưa số phiếu qua ctx"
```

### Task 6: Tài liệu module, kiểm toàn bộ, mở PR

**Files:**
- Modify: `src/modules/product/inventory/CLAUDE.md`. Ghi ở mục "Con số và bất biến" và "Quyền ở API":
  - thẻ kho trả `area` `stock`/`quarantine`;
  - `kind` suy ra (`domain/moves.ts`);
  - số phiếu purchasing qua `ctx` (`purchaseDocumentNumbers`);
  - lọc `negative`;
  - `drift` luôn `false` tới 2b.

- [ ] **Step 1: Cập nhật `inventory/CLAUDE.md` như trên**

- [ ] **Step 2: Chạy toàn bộ kiểm tra, cập nhật đồ thị**

Run: `npm run check && graphify update .`
Expected: xanh; depcruise không báo vi phạm.

- [ ] **Step 3: Commit, push nhánh, mở PR vào `main`**

Thân PR cần ghi:
- merge sau PR Documents (Task 1);
- đổi hợp đồng: `balanceAfter` → `onHandAfter`, `area: 'on_hand'` → `'stock'`; FE cần sửa theo S2a §7;
- AC 1–9 nằm ở test nào.
