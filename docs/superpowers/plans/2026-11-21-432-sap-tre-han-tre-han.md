# #432 Cờ Sắp trễ hạn theo 25%, cờ Trễ hạn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `due_soon` bật khi còn kiện chưa bàn giao và còn ≤ 25% thời gian tới `shipBy`; tới hạn thì `overdue` thay `due_soon`; `GET /sales/orders?flag=due_soon|overdue` lọc bằng SQL, không giới hạn 1.000 đơn.

**Architecture:** Hàm thuần `shipByFlag` ở `sales/domain/order.ts` quyết cờ cho chi tiết và danh sách; câu SQL cùng công thức ở `flagCondition` (`sales/repository/order-views.ts`) cho bộ lọc, nhận cùng mốc `now` với service để hai bên không lệch. Không migration: dùng cột có sẵn `orders.placed_at`, `orders.created_at`, `orders.ship_by`, `packages.status`.

**Tech Stack:** TypeScript 6, Drizzle ORM (`sql` template), PostgreSQL 17, Vitest.

**Spec:** không có spec riêng (issue cỡ S). Nguồn: issue https://github.com/DA-EC-System/commerio-backend/issues/432 và comment soát issue https://github.com/DA-EC-System/commerio-backend/issues/432#issuecomment-7060288090; hợp đồng `Documents/21` §19.1 (`due_soon`, `overdue`), `Documents/25` §8.2, §8.5.

## Quyết định (chờ Thành xác nhận ở comment; đổi D1, D4 thì chỉ sửa Task 1 bước 3 và Task 2 bước 3)

- **D1 Mốc bắt đầu** = `placed_at ?? created_at` (lúc khách đặt trên sàn; đơn không có thì lúc app nhận đơn). Không dùng "lúc sàn cấp `shipBy`" (không có cột).
- **D2 Ngưỡng**: `overdue` khi `now ≥ shipBy`; `due_soon` khi `now < shipBy` và `4 × (shipBy − now) ≤ shipBy − mốc bắt đầu` (≤ 25%, so số nguyên mili giây, không số thực). Mốc bắt đầu không trước `shipBy` thì không bao giờ `due_soon`, chỉ có thể `overdue`.
- **D3 Kiện chưa bàn giao** = trạng thái trong `PRE_HANDOVER` (`backordered`, `reserved`, `packed`, `awaiting_pickup`) của fulfillment; không còn kiện nào như vậy thì không cờ nào.
- **D4 Chỉ đơn còn mở** (`unpaid`, `processing`) và **không mang cờ `cancelling`** (đơn Đang huỷ còn kiện chờ mở không phải gửi).
- **D5 Bộ lọc** `due_soon`, `overdue` chạy trong SQL như các cờ suy ra khác; `DERIVED_SCAN` chỉ còn cho `stage`.

## Global Constraints

- Không migration, không đổi `schema.ts`.
- Định danh tiếng Anh; comment, mô tả OpenAPI, tên test bằng tiếng Việt.
- Import tương đối có đuôi `.ts`; module con khác trong `order` chỉ import qua `../../fulfillment/index.ts`.
- SQL viết tay ghi `"order".packages` (từ khoá `order`, `db/CLAUDE.md`); tham số giờ truyền chuỗi ISO kèm `::timestamptz` như `syncPackagesShipBy` (`fulfillment/repository/packages.ts:183`).
- Test theo `test/CLAUDE.md`: unit ở `test/unit/modules/order/sales/domain/order.test.ts` (truyền `now`, không đọc giờ thật), luồng đầy đủ ở `test/integration/order/sales/orders-api.test.ts`.
- Làm trong worktree `D:\DA-TMDT\commerio-backend\.claude\worktrees\432-tre-han` (nhánh `feature/432-tre-han`), không đụng thư mục chính (đang ở nhánh #414).

## Review Focus

1. **Đơn kéo về muộn** (đặt 40 giờ trước, hạn 48 giờ, app vừa nhận): phải `due_soon` ngay, tức service truyền `placedAt`, không `createdAt`. Pin: Task 2, ca `lateIngest`.
2. **Hàm domain và câu SQL lệch nhau**: đơn lọc ra bằng `flag=X` phải mang đúng cờ `X` trong `flags`, đơn không lọc ra thì không mang. Pin: Task 2, vòng `for` kiểm `flags` của mọi đơn trong công ty test.
3. **Đơn Đang huỷ đã quá hạn**: không mang `overdue`, không lọt vào `flag=overdue`. Pin: Task 2, ca `cancellingOverdue`.
4. **Đúng lúc tới hạn** (`now = shipBy`) và **còn đúng 25%**: ra `overdue` và `due_soon`. Pin: Task 1, ca biên.
5. **Đơn trễ hạn cũ nằm ngoài 1.000 đơn mới nhất**: bộ lọc không còn đi đường `DERIVED_SCAN`. Pin: Task 2 bước 3 (`derived` chỉ còn theo `stage`); không dựng 1.000 đơn trong test.

---

### Task 0: Chuẩn bị worktree

- [ ] **Step 1: Cho worktree dùng `node_modules` của bản checkout chính**

Kiểm trước: `git diff --stat feature/414-timeout-open-order-pull feature/432-tre-han -- package.json package-lock.json` rỗng. Rỗng thì (PowerShell, ở `D:\DA-TMDT\commerio-backend`):
```powershell
New-Item -ItemType Junction -Path .claude\worktrees\432-tre-han\node_modules -Target D:\DA-TMDT\commerio-backend\node_modules
```
Khác thì chạy `npm ci` trong worktree.

- [ ] **Step 2: Mốc xanh**

Run (trong worktree): `npx vitest run --project unit test/unit/modules/order/sales/domain/order.test.ts`
Expected: PASS.

---

### Task 1: Hàm thuần `shipByFlag`

**Files:**
- Modify: `src/modules/order/fulfillment/index.ts:31-41` (export thêm `PRE_HANDOVER`)
- Modify: `src/modules/order/sales/domain/order.ts` (thêm cạnh `isDueSoon`, chưa xoá `isDueSoon`: service còn dùng tới Task 2)
- Test: `test/unit/modules/order/sales/domain/order.test.ts`

**Interfaces:**
- Produces:
  - `PRE_HANDOVER: readonly PackageStatus[]` từ `src/modules/order/fulfillment/index.ts` (đã có ở `domain/package.ts:202`, chỉ thêm vào khối export từ `./domain/package.ts`).
  - Trong `src/modules/order/sales/domain/order.ts`:
    ```ts
    export type ShipByFlag = 'due_soon' | 'overdue';
    /** Còn ≤ 1/DUE_SOON_PARTS thời gian chuẩn bị hàng thì Sắp trễ hạn (Documents/25 §8.5). */
    export const DUE_SOON_PARTS = 4;
    export interface ShipByInput {
      shipBy: Date | null;
      /** Mốc bắt đầu thời gian chuẩn bị (D1): `placedAt ?? createdAt`. */
      startAt: Date;
      packages: readonly PackageStatus[];
      now: number;
    }
    export function shipByFlag(i: ShipByInput): ShipByFlag | null;
    ```

- [ ] **Step 1: Viết unit test**

Thêm `shipByFlag` vào import; thêm khối sau `describe('isDueSoon', …)`:

```ts
describe('shipByFlag: Sắp trễ hạn ≤ 25%, Trễ hạn (#432)', () => {
  const H = 3_600_000;
  // Đơn TikTok ca test 18/11: về 03:00, hạn 19:00 (16 giờ).
  const startAt = at('2026-11-18T03:00:00Z');
  const shipBy = at('2026-11-18T19:00:00Z');
  const flag = (now: number, packages: PackageStatus[] = ['reserved'], o: Partial<{ shipBy: Date | null; startAt: Date }> = {}) =>
    shipByFlag({ shipBy, startAt, packages, now, ...o });

  it('đơn hạn 16 giờ: không cờ ở giờ đầu, còn trên 25% cũng không', () => {
    expect(flag(startAt.getTime() + H)).toBeNull();
    expect(flag(shipBy.getTime() - 4 * H - 60_000)).toBeNull();
  });
  it('còn đúng 4 giờ (25%) tới trước hạn 1 ms: due_soon', () => {
    expect(flag(shipBy.getTime() - 4 * H)).toBe('due_soon');
    expect(flag(shipBy.getTime() - 1)).toBe('due_soon');
  });
  it('đúng lúc tới hạn và sau hạn: overdue, không due_soon', () => {
    expect(flag(shipBy.getTime())).toBe('overdue');
    expect(flag(shipBy.getTime() + 11 * 24 * H)).toBe('overdue');
  });
  it('chỉ xét kiện chưa bàn giao', () => {
    const late = shipBy.getTime() + H;
    expect(flag(late, ['in_transit', 'delivered'])).toBeNull();
    expect(flag(late, ['cancelled'])).toBeNull();
    expect(flag(late, [])).toBeNull();
    expect(flag(late, ['in_transit', 'packed'])).toBe('overdue');
    expect(flag(late, ['backordered'])).toBe('overdue');
    expect(flag(late, ['awaiting_pickup'])).toBe('overdue');
  });
  it('không có hạn thì không cờ', () => {
    expect(flag(shipBy.getTime() + H, ['reserved'], { shipBy: null })).toBeNull();
  });
  it('đơn đặt sớm, kéo về muộn: tính từ lúc đặt nên còn 8/48 giờ là due_soon', () => {
    const placed = at('2026-11-16T19:00:00Z'); // 48 giờ trước hạn
    expect(flag(shipBy.getTime() - 8 * H, ['reserved'], { startAt: placed })).toBe('due_soon');
  });
  it('mốc bắt đầu không trước hạn: chỉ có thể overdue', () => {
    expect(flag(shipBy.getTime() - H, ['reserved'], { startAt: shipBy })).toBeNull();
    expect(flag(shipBy.getTime() + H, ['reserved'], { startAt: at('2026-11-18T20:00:00Z') })).toBe('overdue');
  });
});
```

- [ ] **Step 2: Chạy test, phải đỏ**

Run: `npx vitest run --project unit test/unit/modules/order/sales/domain/order.test.ts`
Expected: FAIL, `shipByFlag` không được export.

- [ ] **Step 3: Viết `shipByFlag` theo D2, D3; export `PRE_HANDOVER`**

So mili giây nguyên: `remaining = shipBy − now`; không còn kiện `PRE_HANDOVER` hay `shipBy` null → `null`; `remaining <= 0` → `'overdue'`; `DUE_SOON_PARTS * remaining <= shipBy − startAt` → `'due_soon'`; còn lại `null`. JSDoc dẫn `Documents/25` §8.2, §8.5, #432.

- [ ] **Step 4: Chạy test và typecheck**

Run: `npx vitest run --project unit test/unit/modules/order/sales/domain/order.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: không lỗi.

- [ ] **Step 5: Commit**

```bash
git add src/modules/order/fulfillment/index.ts src/modules/order/sales/domain/order.ts test/unit/modules/order/sales/domain/order.test.ts
git commit -m "shipByFlag: Sắp trễ hạn khi còn ≤ 25% thời gian chuẩn bị, Trễ hạn khi tới hạn (#432)"
```

---

### Task 2: Cờ `overdue` trên API, lọc hai cờ bằng SQL

**Files:**
- Modify: `src/modules/order/sales/domain/order.ts` (`OrderFlag` thêm `'overdue'` sau `'due_soon'`; xoá `DUE_SOON_HOURS` và `isDueSoon`)
- Modify: `src/modules/order/sales/api/schemas.ts:26-37` (`ORDER_FLAGS` thêm `'overdue'` sau `'due_soon'`)
- Modify: `src/modules/order/sales/repository/order-views.ts:10-33` (`OrderFilter.now`, `SqlFlag`), `:38-69` (`flagCondition`), `:80-94` (`where`)
- Modify: `src/modules/order/sales/service/orders.ts:11-23` (import), `:113-128` (`flagsOf`), `:200-236` (`DERIVED_SCAN`, `listOrders`)
- Modify: `src/modules/order/sales/api/openapi.ts:30` (mô tả)
- Modify: `src/modules/order/sales/CLAUDE.md` (mục Đơn: dòng `due_soon` "dưới 24 giờ tới `ship_by`" và dòng "chỉ giai đoạn suy từ kiện và `due_soon` lọc trong bộ nhớ")
- Test: `test/unit/modules/order/sales/domain/order.test.ts` (xoá import `isDueSoon` và khối `describe('isDueSoon')`), `test/integration/order/sales/orders-api.test.ts` (thêm một `it`)

**Interfaces:**
- Consumes: `shipByFlag`, `DUE_SOON_PARTS`, `PRE_HANDOVER` (Task 1); `cancellingSql` (`repository/orders.ts:76`, đã import ở `order-views.ts`).
- Produces:
  - `OrderFlag`, `ORDER_FLAGS` có `'overdue'` (FE đọc qua `flags`, `?flag=overdue` hết 422).
  - `OrderFilter.now?: Date | undefined`: mốc giờ cho cờ hạn; vắng thì `new Date()`.
  - `SqlFlag` thêm `'due_soon' | 'overdue'` (bằng `Exclude<OrderFlag, 'payment_mismatch'>`).
  - `flagCondition(flag: SqlFlag, now: Date): SQL`.

- [ ] **Step 1: Viết integration test**

Thêm vào `describe('GET /sales/orders (#105)')`, theo mẫu ca `flag=cancelling` (công ty riêng, helper `order()` của file):

```ts
it('cờ hạn bàn giao: due_soon khi còn ≤ 25% tính từ lúc đặt, overdue khi tới hạn; lọc bằng SQL, đơn Đang huỷ không mang (#432)', async () => {
  const own = await createCompany();
  const tag = randomUUID().slice(0, 6);
  const H = 3_600_000;
  const now = Date.now();
  const ids432: Record<string, string> = {};
  const add = async (key: string, line: 'pending' | 'in_transit', placedAgo: number, shipIn: number) => {
    const o = order(`T${key}-${tag}`, [{ variantId: null, status: line, pkg: `FP-T${key}-${tag}` }], {
      placedAt: new Date(now - placedAgo * H),
      shipBy: new Date(now + shipIn * H),
    });
    ids432[key] = (await withCompany(own.companyId, () => ingestMarketplaceOrder(o))).orderId;
  };
  await add('early', 'pending', 1, 15); // còn 15/16: không cờ
  await add('dueSoon', 'pending', 13, 3); // còn 3/16: due_soon
  await add('lateIngest', 'pending', 40, 8); // đặt 40 giờ trước, app vừa nhận: 8/48 → due_soon (D1)
  await add('overdue', 'pending', 20, -1); // quá hạn 1 giờ
  await add('handedOver', 'in_transit', 20, -1); // quá hạn nhưng đã bàn giao: không cờ
  await add('cancellingOverdue', 'pending', 20, -1);
  await testPool().query(`update "order".orders set cancel_pending = true where id = $1`, [ids432.cancellingOverdue]);

  const list = async (q: string) => {
    const res = await app().get(`/api/v1/sales/orders?pageSize=50${q}`).set('Authorization', `Bearer ${own.ceo.token}`);
    expect(res.status).toBe(200);
    return OrderSummaryPage.parse(res.body);
  };
  expect((await list('&flag=due_soon')).items.map((i) => i.id).sort()).toEqual([ids432.dueSoon, ids432.lateIngest].sort());
  expect((await list('&flag=overdue')).items.map((i) => i.id)).toEqual([ids432.overdue]);
  // Hàm domain và câu SQL cùng kết quả: cờ trong `flags` khớp bộ lọc trên mọi đơn.
  const expected: Record<string, string | null> = {
    early: null, dueSoon: 'due_soon', lateIngest: 'due_soon', overdue: 'overdue', handedOver: null, cancellingOverdue: null,
  };
  const byId = new Map((await list('')).items.map((i) => [i.id, i.flags]));
  for (const [key, flag] of Object.entries(expected)) {
    const flags = byId.get(ids432[key]!)!;
    expect(flags.filter((f) => f === 'due_soon' || f === 'overdue'), key).toEqual(flag ? [flag] : []);
  }
});
```

- [ ] **Step 2: Chạy test, phải đỏ**

Run (Docker đang chạy): `npx vitest run --project integration test/integration/order/sales/orders-api.test.ts -t "cờ hạn bàn giao"`
Expected: FAIL ở `flag=due_soon`: luật 24 giờ cũ trả cả `early`, `overdue`, `cancellingOverdue`.

- [ ] **Step 3: Nối `shipByFlag` vào API và viết nhánh SQL**

- `domain/order.ts`: `OrderFlag` thêm `| 'overdue'`; xoá `DUE_SOON_HOURS`, `isDueSoon`. `api/schemas.ts`: `ORDER_FLAGS` thêm `'overdue'`.
- `service/orders.ts` `flagsOf`: thay dòng `isDueSoon` bằng: chỉ khi `open && !o.cancelling` (D4) thì `shipByFlag({ shipBy: o.shipBy, startAt: o.placedAt ?? o.createdAt, packages: statuses, now })`, có kết quả thì `flags.push` (cùng vị trí trong mảng như `due_soon` cũ).
- `order-views.ts`:
  - `SqlFlag` thêm hai cờ; `OrderFilter` thêm `now` (JSDoc: "Mốc giờ của cờ hạn bàn giao, cùng mốc service dùng tính `flags`"); cập nhật JSDoc `OrderFilter.flag`.
  - `where(f)` gọi `flagCondition(f.flag, f.now ?? new Date())`.
  - `flagCondition` thêm hai nhánh dùng chung một mẩu điều kiện nội bộ:
    ```sql
    status in ('unpaid', 'processing') and ship_by is not null and not <cancellingSql>
    and exists (select 1 from "order".packages p where p.order_id = orders.id and p.status in (<PRE_HANDOVER>))
    ```
    `<PRE_HANDOVER>` dựng bằng `sql.join(PRE_HANDOVER.map((s) => sql`${s}`), sql`, `)`; `now` là `${now.toISOString()}::timestamptz`.
    - `overdue`: thêm `ship_by <= now`.
    - `due_soon`: thêm `ship_by > now and ${DUE_SOON_PARTS} * (ship_by - now) <= ship_by - coalesce(placed_at, created_at)`.
- `service/orders.ts` `listOrders`: `derived` chỉ còn `q.stage !== undefined && !stageIsStatus`; `filter.flag = q.flag`; thêm `now: new Date(now)` vào `filter`; lọc trong bộ nhớ chỉ còn theo `stage`. Comment `DERIVED_SCAN` chỉ nói giai đoạn suy từ kiện.
- `api/openapi.ts:30`: "`stage` suy từ kiện chỉ xét 1.000 đơn chưa dừng mới nhất; các bộ lọc khác (kể cả `flag=due_soon`, `flag=overdue`) không giới hạn."
- `sales/CLAUDE.md` mục Đơn: `due_soon` (còn kiện chưa bàn giao, còn ≤ 25% thời gian từ `placed_at`, thiếu thì `created_at`, tới `ship_by`; đơn Đang huỷ không mang), `overdue` (còn kiện chưa bàn giao mà đã tới `ship_by`, thay `due_soon`); cả hai lọc bằng SQL (`flagCondition`), cùng công thức với `shipByFlag`; chỉ giai đoạn suy từ kiện lọc trong bộ nhớ (`DERIVED_SCAN`).
- Unit test: xoá import `isDueSoon` và khối `describe('isDueSoon')`.

- [ ] **Step 4: Chạy test của đơn, typecheck, depcruise**

Run: `npx vitest run --project integration test/integration/order/sales/orders-api.test.ts`
Expected: PASS cả file (ca cũ không đổi).
Run: `npx vitest run --project unit test/unit/modules/order/sales/domain/order.test.ts`
Expected: PASS.
Run: `npm run typecheck; npm run depcruise`
Expected: không lỗi.

- [ ] **Step 5: Xem kế hoạch câu lọc**

Trên DB dev (`npm run infra:up`, `npm run db:migrate`), sau khi có vài đơn:
```sql
explain analyze select id from "order".orders o
where o.status in ('unpaid','processing') and o.ship_by is not null and o.ship_by <= now()
  and exists (select 1 from "order".packages p where p.order_id = o.id and p.status in ('backordered','reserved','packed','awaiting_pickup'));
```
Expected: `exists` thành semi join theo `order_id` (dùng `packages_order_id_index` khi bảng đủ lớn), không có SubPlan quét `packages` cho từng đơn. Không thêm index (không migration).

- [ ] **Step 6: Commit**

```bash
git add src/modules/order/sales test/unit/modules/order/sales/domain/order.test.ts test/integration/order/sales/orders-api.test.ts
git commit -m "Cờ overdue trên đơn, lọc due_soon, overdue bằng SQL (#432)"
```

---

### Task 3: Kiểm toàn bộ, PR, phối hợp FE

- [ ] **Step 1: `npm run check` trong worktree**

Expected: lint, typecheck, depcruise, test đều đạt.

- [ ] **Step 2: `npm run db:ci-check -- --base origin/main`**

Expected: đạt (nhánh không có migration). Thiếu `drizzle-kit` thì junction như `local-env-quirks`.

- [ ] **Step 3: Hỏi Khang trước khi đẩy nhánh, mở PR, mở issue FE**

Ba việc ra ngoài, chỉ làm khi Khang đồng ý:
- `git push -u origin feature/432-tre-han`; PR vào `main`: tóm tắt D1–D5, link comment soát issue, cách kiểm, ghi "FE phải đọc `overdue` trước hoặc cùng lúc"; `Closes #432` chỉ khi Thành đã chốt D1, D4.
- Issue FE: thêm `'overdue'` vào `OrderFlag` (`FE/src/types/sales.ts`), nhãn "Trễ hạn" (`destructive`) ở `ORDER_FLAGS` (`FE/src/features/sales/shared.ts`); `isOverdue` trả true khi `flags` có `overdue`, vẫn nhận dạng cũ (`due_soon` và `shipBy < now`) để không phụ thuộc thứ tự deploy; bộ lọc cờ thêm "Trễ hạn".
- Nếu Thành đồng ý D1: PR Documents ghi mốc vào dòng `due_soon` ở `21` §19.1 và sửa mốc của `package.ship_by` ở `21` §14.2 ("Lúc lập kiện") cho cùng luật.

- [ ] **Step 4: Sau khi deploy staging, kiểm DoD**

`GET /sales/orders?shopId=<gian hàng Lazada của Demo>&flag=overdue` và `&flag=due_soon`:
Expected: những đơn còn lại trong DH-000108, 118, 121, 132, 135, 136, 137, 145 (còn `processing`, còn kiện chưa bàn giao) mang `overdue`, không còn `due_soon`; đơn TikTok mới về không mang cờ trong 75% thời gian đầu. Staging có thể đã xoá bớt đơn thử: ghi rõ đơn nào còn để kiểm.

- [ ] **Step 5: Cập nhật graphify sau khi PR merge**

Ở bản checkout chính, trên `main` đã có commit này: `graphify update .` (không chạy trong worktree).
