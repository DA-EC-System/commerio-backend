# #434 Trần cân nặng, kích thước SKU: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cân nặng (1–50.000 g) và ba cạnh gói (1–2.000 mm) của SKU có cùng một trần ở mọi đường ghi (BE, DB) và ô nhập FE không nuốt dấu thập phân.

**Architecture:** BE gom luật vào `catalog/domain/measure.ts`, dùng chung cho PATCH SKU và sửa hàng loạt; DB siết CHECK `product_variants_dimensions` cùng trần (dữ liệu staging vượt trần xoá trống trước bằng migration dữ liệu). FE gom luật vào `src/utils/measure.ts` (chỉ nhận chữ số, báo lỗi theo đơn vị), dùng ở hộp Thông tin SKU và trang Sửa hàng loạt; ô có hậu tố "g", "mm".

**Tech Stack:** BE: Node 24, Express 5, Zod 4, Drizzle + PostgreSQL 18, Vitest. FE: React, react-hook-form, Zod, Vitest.

**Spec:** issue commerio-backend#434; `Documents/21-hop-dong-api-fe-be.md` §17.2 (PATCH SKU, dòng ~1042) và §17.5 (`weightG?; // tối đa 50.000`, `lengthMm?; widthMm?; heightMm?; // tối đa 2.000`).

## Hiện trạng (đã đọc code 19/11/2026, BE `a35944ef`, FE `8108e9c`)

- BE `src/modules/product/catalog/api/schemas.ts:201` `measure` chỉ chặn `2_147_483_647` → PATCH SKU nhận `weightG: 999999999`. Đây là lỗi chính.
- BE `src/modules/product/catalog/domain/bulk-row.ts:10` `bulkMeasure` đã có trần đúng nhưng là bản riêng, câu "Cân nặng (g) tối đa 50000".
- **Tạo sản phẩm không nhận số đo** (body tạo không có `weightG`/`*Mm`; người ghi duy nhất là `applyVariantUpdate` trong `service/variants.ts`, gọi từ PATCH và sửa hàng loạt). Không có việc ở đường này.
- DB: `product_variants_dimensions` chỉ là `> 0` (`repository/schema.ts:204`).
- FE `src/features/catalog/VariantSpecDialog.tsx:25` `positiveInt` bỏ `.`, `,`, khoảng trắng rồi mới kiểm (đã có trần 50000/2000). FE `src/features/catalog/BulkEditPage.tsx:53` `parseCell` bỏ `.`, khoảng trắng, **không có trần**, dùng chung cho giá, ngưỡng tồn, số đo.
- Gợi ý SKU anh em (`domain/suggestion.ts`) chép số từ DB: hết số vượt trần trong DB (migration + CHECK) thì hết gợi ý sai, không sửa code gợi ý.

## Global Constraints

- Trần: `WEIGHT_MAX_G = 50_000`, `EDGE_MAX_MM = 2_000`; sàn: 1 (số nguyên dương). `null` vẫn là xoá, bỏ trường là giữ.
- Câu lỗi (BE và FE giống nhau):
  - Vượt trần cân nặng: `Cân nặng tối đa 50 kg`
  - Vượt trần cạnh: BE `Chiều dài tối đa 2.000 mm` / `Chiều rộng …` / `Chiều cao …`; FE (ô đã có nhãn Dài/Rộng/Cao) `Tối đa 2.000 mm`
  - Không phải số nguyên (BE nhận số lẻ; FE gõ có `.` `,` hoặc ký tự khác số): cân nặng `Nhập số gam nguyên, vd 250`; cạnh `Nhập số mm nguyên, vd 300`
  - Số ≤ 0: `Nhập số nguyên lớn hơn 0` (giữ câu `POSITIVE_INT` hiện có)
- FE ô số đo: chỉ `trim()` hai đầu; **không bỏ** `.`, `,`, khoảng trắng giữa số (không tự ghép số: `"50.000"`, `"2 50"` đều lỗi).
- BE: định danh tiếng Anh, câu lỗi tiếng Việt, import tương đối có `.ts`, không `enum`. Test chỉ ở `test/`, import `#src/...ts`; tên `it` tiếng Việt; lỗi API kiểm `status` + `type`, không so nguyên `detail`.
- Migration sinh ở bước cuối của BE, sau khi `schema.ts` chốt; không ghép tay `_journal.json`.
- Nhánh: `feature/434-tran-can-nang-kich-thuoc` ở cả BE, FE, Documents; PR vào `main`.

## Review Focus

1. **Gõ `"50.000"` (dấu chấm nghìn kiểu VN) ở ô cân nặng** → báo `Nhập số gam nguyên, vd 250`, không lưu 50000 hay 50. Test ở Task 5.
2. **Đúng trần**: `weightG: 50000`, `lengthMm: 2000` → 200; `50001`, `2001` → 422. Test ở Task 2.
3. **Staging có sẵn số vượt trần** → migration dữ liệu xoá trống trước, CHECK mới thêm được, deploy không đứng. Kiểm bằng SQL trên staging ở Task 9; CHECK test ở Task 3.
4. **Khoảng trắng hai đầu (`" 250 "`)** → nhận 250; khoảng trắng giữa (`"2 50"`) → lỗi. Test ở Task 5.
5. **Image cũ còn chạy giữa lúc migrate và đổi image** gửi số vượt trần → DB trả lỗi CHECK (500 cho một request), không lưu. Chấp nhận, ghi trong PR BE.

---

## Phần BE (repo `commerio-backend`)

Làm trong worktree riêng (`superpowers:using-git-worktrees`), nhánh `feature/434-tran-can-nang-kich-thuoc` từ `origin/main`. Worktree thiếu drizzle-kit thì tạo junction `node_modules` như các nhánh trước.

### Task 1: Luật số đo dùng chung (`domain/measure.ts`)

**Files:**
- Create: `src/modules/product/catalog/domain/measure.ts`
- Test: `test/unit/modules/product/catalog/domain/measure.test.ts`

**Interfaces:**
- Produces:
  - `export const WEIGHT_MAX_G = 50_000;`
  - `export const EDGE_MAX_MM = 2_000;`
  - `export const weightG` — `z.int('Nhập số gam nguyên, vd 250').positive(POSITIVE_INT).max(WEIGHT_MAX_G, 'Cân nặng tối đa 50 kg').nullable().optional()`
  - `export const edgeMm(label: 'Chiều dài' | 'Chiều rộng' | 'Chiều cao')` — như trên với `'Nhập số mm nguyên, vd 300'`, `.max(EDGE_MAX_MM, \`${label} tối đa 2.000 mm\`)`
  - Lưu ý: `z.int(msg)` trong Zod 4 đặt câu cho cả "không phải số" và "không nguyên"; giữ `POSITIVE_INT = 'Nhập số nguyên lớn hơn 0'`.

- [ ] **Step 1: Viết test hỏng**

```ts
describe('weightG', () => {
  it('nhận 1 và 50000, null, bỏ trống', () => {
    for (const v of [1, 50_000, null, undefined]) expect(weightG.safeParse(v).success).toBe(true);
  });
  it.each([
    [50_001, 'Cân nặng tối đa 50 kg'],
    [0.25, 'Nhập số gam nguyên, vd 250'],
    [0, 'Nhập số nguyên lớn hơn 0'],
  ])('%s → %s', (v, msg) => expect(weightG.safeParse(v).error?.issues[0]?.message).toBe(msg));
});
describe('edgeMm', () => {
  it('nhận 2000, chặn 2001 với nhãn cạnh', () => {
    expect(edgeMm('Chiều dài').safeParse(2_000).success).toBe(true);
    expect(edgeMm('Chiều cao').safeParse(2_001).error?.issues[0]?.message).toBe('Chiều cao tối đa 2.000 mm');
  });
  it('30.5 → Nhập số mm nguyên, vd 300', () =>
    expect(edgeMm('Chiều dài').safeParse(30.5).error?.issues[0]?.message).toBe('Nhập số mm nguyên, vd 300'));
});
```

- [ ] **Step 2: Chạy, thấy hỏng** — `npx vitest run test/unit/modules/product/catalog/domain/measure.test.ts` → FAIL (không có module).
- [ ] **Step 3: Viết `measure.ts`** theo Interfaces; comment đầu file trỏ Documents/21 §17.5 và #434.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit** `feat(catalog): luật cân nặng, kích thước SKU dùng chung (#434)`

### Task 2: PATCH SKU và sửa hàng loạt dùng luật chung

**Files:**
- Modify: `src/modules/product/catalog/api/schemas.ts:196-218` (bỏ `measure`, dùng `weightG`, `edgeMm(...)`; `.meta` ghi "tối đa 50.000" / "tối đa 2.000")
- Modify: `src/modules/product/catalog/domain/bulk-row.ts:10-37` (bỏ `bulkMeasure`, dùng `weightG`, `edgeMm(...)`, giữ `.meta` hiện có)
- Test: `test/integration/product/catalog/variant-edit.test.ts` (bảng `it.each` dòng ~91), `test/integration/product/catalog/bulk-edit.test.ts`

**Interfaces:**
- Consumes: `weightG`, `edgeMm`, `WEIGHT_MAX_G`, `EDGE_MAX_MM` từ Task 1.

- [ ] **Step 1: Viết test hỏng**
  - `variant-edit.test.ts`, thêm vào bảng `it.each` 422 hiện có:
    - `['cân nặng 50001 (Documents/21 §17.5)', { weightG: 50_001 }, 'weightG']`
    - `['cân nặng 999999999 (ca test 18/11)', { weightG: 999_999_999 }, 'weightG']`
    - `['chiều dài 2001', { lengthMm: 2_001 }, 'lengthMm']`
    - `['cân nặng 0.25', { weightG: 0.25 }, 'weightG']`
  - `variant-edit.test.ts`, ca mới: `it('đúng trần: cân nặng 50000, ba cạnh 2000 → 200, lưu nguyên số')`, PATCH `{ version: 1, weightG: 50_000, lengthMm: 2_000, widthMm: 2_000, heightMm: 2_000 }` → `200`, `variantOf(...)` khớp bốn số.
  - `variant-edit.test.ts`, ca câu lỗi: PATCH `{ version: 1, weightG: 50_001 }` → `res.body.errors.weightG === 'Cân nặng tối đa 50 kg'` (câu này issue chốt nên được so nguyên).
  - `bulk-edit.test.ts`, ca mới: `it('dòng cân nặng 50001 hoặc cạnh 2001 lỗi theo ô, dòng khác vẫn lưu (#434)')`, lưu `[{ good, weightG: 50_000 }, { bad, weightG: 50_001, widthMm: 2_001 }]` → `saved` có `good`; `failed[0]` là `{ variantId: bad, code: 'validation_failed', errors: { weightG: 'Cân nặng tối đa 50 kg', widthMm: 'Chiều rộng tối đa 2.000 mm' } }` (dùng `toMatchObject`); `weight_g` của `bad` vẫn `null`.
- [ ] **Step 2: Chạy, thấy hỏng** — `npx vitest run --project integration test/integration/product/catalog/variant-edit.test.ts test/integration/product/catalog/bulk-edit.test.ts` (cần Docker) → các ca 50001/2001/999999999 của PATCH trả 200; câu lỗi sửa hàng loạt khác.
- [ ] **Step 3: Sửa `schemas.ts`, `bulk-row.ts`** theo Files. Ca `heightMm: 2147483648` cũ vẫn 422 nhờ trần mới.
- [ ] **Step 4: Chạy lại** → PASS, cả ca cũ trong hai file.
- [ ] **Step 5: Commit** `fix(catalog): PATCH SKU chặn cân nặng trên 50 kg, cạnh trên 2 m như sửa hàng loạt (#434)`

### Task 3: CHECK trong DB và dọn dữ liệu vượt trần

Bước cuối của BE (CLAUDE.md: migration sinh sau khi `schema.ts` chốt). Bảng `product_variants` nhỏ (chưa có người dùng thật), `ALTER TABLE … ADD CONSTRAINT` quét bảng trong giao dịch migrate là chấp nhận được, không cần `NOT VALID`.

**Files:**
- Create (viết tay): `db/migrations/<ts>_can-nang-kich-thuoc-du-lieu.sql`
- Modify: `src/modules/product/catalog/repository/schema.ts:204-207`
- Create (drizzle sinh): `db/migrations/<ts>_can-nang-kich-thuoc-tran.sql` + snapshot, journal
- Modify: `db/CLAUDE.md` (thêm một dòng cho `*_can-nang-kich-thuoc-du-lieu`, theo mẫu các migration dữ liệu khác), `src/modules/product/catalog/CLAUDE.md` (một dòng: trần số đo ở `domain/measure.ts` + CHECK)
- Test: `test/integration/product/catalog/constraints.test.ts`

- [ ] **Step 1: Viết test hỏng** trong `constraints.test.ts`: `it('cân nặng tối đa 50.000 g, mỗi cạnh tối đa 2.000 mm (#434)')`. Dùng `createVariant` (helper `catalog.ts`) rồi `db().query('update product.product_variants set weight_g = $2 where id = $1', …)`: `50000` qua; `50001` reject với `constraint: 'product_variants_dimensions'`; `length_mm = 2001` reject cùng constraint.
- [ ] **Step 2: Chạy, thấy hỏng** — `npx vitest run --project integration test/integration/product/catalog/constraints.test.ts` → 50001 không bị chặn.
- [ ] **Step 3: Sinh migration dữ liệu TRƯỚC khi sửa `schema.ts`** — `npm run db:generate -- --custom --name can-nang-kich-thuoc-du-lieu`, viết tay (chạy lại được):

```sql
-- #434: số đo vượt trần (Documents/21 §17.5) là dữ liệu thử trên staging; xoá trống để CHECK
-- product_variants_dimensions ở migration sau thêm được. Tăng version để form đang mở nhận 409 thay vì ghi đè.
UPDATE "product"."product_variants" SET
  "weight_g"  = CASE WHEN "weight_g"  > 50000 THEN NULL ELSE "weight_g"  END,
  "length_mm" = CASE WHEN "length_mm" > 2000  THEN NULL ELSE "length_mm" END,
  "width_mm"  = CASE WHEN "width_mm"  > 2000  THEN NULL ELSE "width_mm"  END,
  "height_mm" = CASE WHEN "height_mm" > 2000  THEN NULL ELSE "height_mm" END,
  "version" = "version" + 1, "updated_at" = now()
WHERE "weight_g" > 50000 OR "length_mm" > 2000 OR "width_mm" > 2000 OR "height_mm" > 2000;
```

- [ ] **Step 4: Sửa CHECK trong `schema.ts`**, giữ tên `product_variants_dimensions`, số viết thẳng (không nội suy hằng vào `sql`, drizzle sẽ thành tham số), comment trỏ `domain/measure.ts`:
  `${t.weightG} between 1 and 50000 and ${t.lengthMm} between 1 and 2000 and ${t.widthMm} between 1 and 2000 and ${t.heightMm} between 1 and 2000`
- [ ] **Step 5: Sinh migration CHECK** — `npm run db:generate -- --name can-nang-kich-thuoc-tran`. Mở file xem: phải là `DROP CONSTRAINT "product_variants_dimensions"` rồi `ADD CONSTRAINT … CHECK (…between…)`, đứng **sau** file dữ liệu trong `_journal.json`.
- [ ] **Step 6: Chạy lại test** constraints → PASS; `npm run db:ci-check` → đạt.
- [ ] **Step 7: Ghi `db/CLAUDE.md`, `catalog/CLAUDE.md`**; commit `feat(db): CHECK cân nặng ≤ 50.000 g, cạnh ≤ 2.000 mm; xoá trống số vượt trần (#434)`

### Task 4: Kiểm toàn bộ và mở PR BE

- [ ] **Step 1:** `npm run check` → lint, typecheck, depcruise, test đều đạt.
- [ ] **Step 2:** `graphify update .`
- [ ] **Step 3:** Push, mở PR vào `main`, `Closes` không dùng (issue còn phần FE, staging); body nêu: hai migration, rollback (lùi image vẫn chạy; số đã xoá trống không lấy lại, là dữ liệu thử), ca Review Focus 5 (image cũ giữa lúc migrate gặp 500), link PR Docs (Task 8).

---

## Phần FE (repo `FE`)

Nhánh `feature/434-tran-can-nang-kich-thuoc` từ `origin/main`, worktree `D:\DA-TMDT\FE-434`. Test FE nằm cạnh file (`*.test.ts`), không có testing-library: test logic thuần, component kiểm bằng `renderToStaticMarkup` (mẫu `src/components/common/HelpTip.test.tsx`).

### Task 5: Luật ô số đo (`src/utils/measure.ts`)

**Files:**
- Create: `src/utils/measure.ts`
- Test: `src/utils/measure.test.ts`

**Interfaces:**
- Produces:
  - `export const WEIGHT_MAX_G = 50_000; export const EDGE_MAX_MM = 2_000;`
  - `export type MeasureKind = 'weight' | 'edge';`
  - `export function parseMeasure(kind: MeasureKind, raw: string): { ok: true; value: number | null } | { ok: false; error: string }` — `trim()`; rỗng → `null`; không khớp `/^\d+$/` → câu "Nhập số … nguyên"; `0` → `Nhập số nguyên lớn hơn 0`; vượt trần → câu trần (Global Constraints).
  - `export const measureTextSchema(kind: MeasureKind)` — `z.string().transform` gọi `parseMeasure`, lỗi thì `ctx.addIssue({ code: 'custom', message: error })`.

- [ ] **Step 1: Viết test hỏng**

```ts
it.each([
  ['weight', '250', 250], ['weight', ' 250 ', 250], ['weight', '', null], ['weight', '50000', 50_000], ['edge', '2000', 2_000],
])('%s "%s" → %s', (k, raw, v) => expect(parseMeasure(k as MeasureKind, raw)).toEqual({ ok: true, value: v }));
it.each([
  ['weight', '0,25', 'Nhập số gam nguyên, vd 250'],
  ['weight', '0.25', 'Nhập số gam nguyên, vd 250'],
  ['weight', '50.000', 'Nhập số gam nguyên, vd 250'],
  ['weight', '2 50', 'Nhập số gam nguyên, vd 250'],
  ['weight', '50001', 'Cân nặng tối đa 50 kg'],
  ['weight', '0', 'Nhập số nguyên lớn hơn 0'],
  ['edge', '30.5', 'Nhập số mm nguyên, vd 300'],
  ['edge', '2001', 'Tối đa 2.000 mm'],
])('%s "%s" → lỗi "%s"', (k, raw, error) => expect(parseMeasure(k as MeasureKind, raw)).toEqual({ ok: false, error }));
```

- [ ] **Step 2: Chạy, thấy hỏng** — `npx vitest run src/utils/measure.test.ts` → FAIL.
- [ ] **Step 3: Viết `measure.ts`** theo Interfaces.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit** `feat(catalog): luật ô cân nặng, kích thước không tự ghép số (#434)`

### Task 6: Ô có hậu tố đơn vị; hộp Thông tin SKU dùng luật mới

**Files:**
- Create: `src/components/common/UnitInput.tsx` (+ `UnitInput.test.tsx`)
- Modify: `src/components/common/FormTextField.tsx` (prop `suffix?: ReactNode`, có thì render `UnitInput`)
- Modify: `src/features/catalog/VariantSpecDialog.tsx:24-46` (bỏ `positiveInt`; `weightG: measureTextSchema('weight')`, ba cạnh `measureTextSchema('edge')`; giữ `superRefine` "Nhập đủ ba cạnh"), dòng ~48-54 (thêm `suffix="g"`, `suffix="mm"`; nhãn cân nặng bỏ "(g)" vì đã có hậu tố)

**Interfaces:**
- Consumes: `measureTextSchema`, `MeasureKind` (Task 5).
- Produces: `export function UnitInput(props: ComponentProps<typeof Input> & { suffix: ReactNode })` — bọc `Input` trong `div.relative`, hậu tố là `span` tuyệt đối bên phải (`pointer-events-none text-muted-foreground`, `aria-hidden`), input thêm `pr-8`; `ref` và props khác chuyển nguyên xuống `Input` (react-hook-form cần `ref`).

- [ ] **Step 1: Viết test hỏng** `UnitInput.test.tsx`: `renderToStaticMarkup(<UnitInput suffix="g" aria-label="Cân nặng" />)` chứa `>g</span>` và `aria-label="Cân nặng"`.
- [ ] **Step 2: Chạy, thấy hỏng** → FAIL.
- [ ] **Step 3: Viết `UnitInput`, thêm `suffix` vào `FormTextField`, sửa `VariantSpecDialog`**.
- [ ] **Step 4:** `npx vitest run src/components/common/UnitInput.test.tsx` → PASS; `npm run typecheck` → đạt.
- [ ] **Step 5: Commit** `fix(catalog): hộp Thông tin SKU báo lỗi khi gõ số lẻ, ô có đơn vị g, mm (#434)`

### Task 7: Sửa hàng loạt dùng luật mới

**Files:**
- Modify: `src/features/catalog/BulkEditPage.tsx:52-58` (`parseCell(field: BulkField, raw: string)`: `weightG` → `parseMeasure('weight', raw)`, ba cạnh → `parseMeasure('edge', raw)`, `standardPrice`, `minQty` giữ cách cũ), các chỗ gọi `parseCell` (dòng ~147, ~427), ô (dòng ~428) dùng `UnitInput` với `suffix` cho bốn ô số đo, hiện `error` của `parseMeasure` dưới ô (`title`/dòng nhỏ như lỗi dòng BE đang hiện).
- Modify: `FIELD_LABELS` bỏ "(g)", "(mm)" nếu ô đã có hậu tố (giữ một chỗ ghi đơn vị).

**Interfaces:**
- Consumes: `parseMeasure` (Task 5), `UnitInput` (Task 6).

- [ ] **Step 1:** Sửa theo Files. `submit` không gửi ô lỗi (đang bỏ qua ô `!ok`): thêm chặn lưu khi còn ô lỗi, toast "Còn ô nhập sai, sửa trước khi lưu", để "0,25" không bị lặng lẽ bỏ qua.
- [ ] **Step 2:** `npm run lint && npm run typecheck && npm test` → đạt.
- [ ] **Step 3: Kiểm tay** (Vite dev với MSW hoặc trỏ BE local): Thông tin SKU gõ "0,25" → lỗi tại ô, không gọi PATCH; "30.5" ở Dài → lỗi; "50001" → `Cân nặng tối đa 50 kg`. Sửa hàng loạt: "0,25" ở ô cân nặng → viền đỏ + câu lỗi, nút lưu báo còn ô sai.
- [ ] **Step 4: Commit** `fix(catalog): sửa hàng loạt không ghép số ở ô cân nặng, kích thước (#434)`; push, mở PR FE, link PR BE.

---

## Phần Documents và staging

### Task 8: Cập nhật Documents

**Files:**
- Modify: `Documents/21-hop-dong-api-fe-be.md` §17.2 (dòng PATCH ~1042): "số nguyên dương; `weightG` 1–50.000, `lengthMm`, `widthMm`, `heightMm` 1–2.000, vượt thì 422 `errors.<ô>` (vd "Cân nặng tối đa 50 kg")".
- Modify: `Documents/19-mo-hinh-du-lieu.md` dòng `product_variants` (~77): thêm `CHECK weight_g 1–50000, length_mm, width_mm, height_mm 1–2000 (#434)`.

- [ ] **Step 1:** Sửa, nhánh `feature/434-tran-can-nang-kich-thuoc`, mở PR Documents, link vào PR BE.

### Task 9: Staging và DoD

- [ ] **Step 1 (trước khi merge BE):** đếm số vượt trần trên staging để ghi vào PR: `select count(*) filter (where weight_g > 50000) w, count(*) filter (where greatest(length_mm, width_mm, height_mm) > 2000) d from product.product_variants;` (AO-0009-DO-S của Công ty B hiện 250 g, có thể đã sạch).
- [ ] **Step 2:** `npm run db:migrate:check:staging` → hai migration mới ở cuối, không lệch thứ tự.
- [ ] **Step 3 (sau deploy BE + FE):** chạy lại câu đếm → `0 | 0`. DoD: PATCH `weightG: 50001` → 422 `validation_failed`, `errors.weightG = "Cân nặng tối đa 50 kg"`; trên FE staging gõ "0,25" → lỗi tại ô, không có request PATCH.
- [ ] **Step 4:** Tick checklist issue #434, comment kết quả DoD kèm link ba PR.
