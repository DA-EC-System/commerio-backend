# #204 PR 0 và PR 1: sự kiện catalog, sửa SKU, `getVariants` đủ trường — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khai hai sự kiện của catalog (PR 0), rồi cho Admin sửa giá và số đo của một SKU qua `PATCH`, để module khác đọc được các trường đó và channel nhận sự kiện khi giá muốn bán đổi (PR 1). PR 1 gỡ kẹt `dimensions_missing` khi đẩy Lazada trên staging.

**Architecture:** PR 0 chỉ sửa `core/platform/domain/events.ts`, file dùng chung. PR 1 nằm gọn trong `product/catalog`:
- Repository đọc thêm cột sẵn có của `product_variants`.
- `UPDATE … WHERE version` vừa là khoá lạc quan, vừa khoá dòng SKU trước khi ghi outbox, nên sự kiện của một SKU giữ đúng thứ tự.
- Phần thân sửa một SKU tách thành hàm chạy trong giao dịch của bên gọi, để #242 dùng lại cho từng dòng.

**Tech Stack:** Node 24 (chạy thẳng `.ts`), Express 5, Zod 4.6, Drizzle ORM 0.45, PostgreSQL 18, `decimal.js`, Vitest 5, Supertest.

**Spec:** `docs/superpowers/specs/2026-11-16-204-trang-thai-san-pham-design.md`. Plan này phủ mục 5.1 và PR 0 của mục 8; PR 2, PR 3 có plan riêng sau.

## Global Constraints

- Import tương đối có đuôi `.ts`. Không `enum`, `namespace`, parameter property.
- Định danh tiếng Anh; comment, câu lỗi, tên test tiếng Việt.
- Lỗi nghiệp vụ ném `AppError` (qua `service/errors.ts`), không `res.status(4xx)` trong route.
- Đầu vào qua `validate()`, đọc lại bằng `validated<typeof X>(res, 'body')`.
- Route đặt `ctx.authorize(...)` trước `validate()`.
- Tiền: `numeric` trong DB, `Decimal` trong service, **số nguyên đồng** trên API, **chuỗi thập phân** trong payload sự kiện.
- Mọi đọc ghi trong `withCompany(companyId, fn)`. Repository dùng `getDb()`.
- Test chỉ ở `test/`, import `#src/...ts`, tên `describe`/`it` tiếng Việt. Lỗi API kiểm `status` và `type` (`/problems/<code>`).
- PR 0 và PR 1 **không có migration**: mọi cột đã có trên `main` (2018c63).
- `getVariants` chỉ thêm trường, không đổi chữ ký, không thêm câu truy vấn: inventory gọi nó khi đang khoá dòng tồn.
- PATCH nhận đúng `{ version, standardPrice?, targetNetPrice?, weightG?, lengthMm?, widthMm?, heightMm? }`. Trường lạ, kể cả `imageFileId`, trả 422 (spec D1).
- Payload `catalog.variant_price_changed` là `{ variantId, productId, from: string | null, to: string | null, changedAt }` (spec D3). Đổi `standardPrice` không phát.
- Dùng `npm`. Chạy `npm run check` trước khi mở PR.
- Push, mở PR, comment GitHub là việc ra ngoài: **hỏi Khang trước** từng lần. Trước khi push, kiểm PR của nhánh đã merge chưa (`gh pr view --json state`).

## Review Focus

1. **Client gửi lại một PATCH đã thành công** (mạng chập, `version` cũ, cùng giá trị) phải được 200 với bản hiện tại, không 409, không thêm nhật ký hay sự kiện. Đây là quyết định của plan, mở rộng câu "chỉ gửi `version` thì không ghi gì" của spec: body không đổi trường nào so với hiện tại thì không ghi và không kiểm `version`. Test ở Task 4.
2. **Hai PATCH cùng `version` chạy song song** phải ra đúng một 200 và một 409, và có nhiều nhất một sự kiện. Test ở Task 5.
3. **Số vượt `integer` của PostgreSQL** (`2147483648`), số lẻ, 0, số âm, chuỗi phải trả 422 theo ô, không ra 500 từ DB. Test ở Task 4.
4. **Cùng giá viết khác dạng** (gửi `150000` khi DB có `"150000.00"`) không phát sự kiện. Xoá giá bằng `null` phát sự kiện với `to: null`. Test ở Task 5.
5. **SKU đã lưu trữ vẫn sửa được**; cha đã lưu trữ trả `product_archived` trước `version_conflict`; SKU của sản phẩm khác trả 404. Test ở Task 4.

---

### Task 1: PR 0, khai hai sự kiện của catalog

**Files:**
- Modify: `src/modules/core/platform/domain/events.ts`, thêm vào `EVENT_SCHEMAS` sau nhóm `purchasing.*`
- Test: `test/unit/modules/core/platform/domain/events.test.ts`

**Interfaces:**
- Produces:
  - `EventPayload<'catalog.variant_price_changed'>` = `{ variantId: string; productId: string; from: string | null; to: string | null; changedAt: string }`
  - `EventPayload<'catalog.variant_status_changed'>` = `{ variantId: string; productId: string; from: BusinessStatus; to: BusinessStatus; changedAt: string }`, với `BusinessStatus` là `'selling' | 'paused' | 'discontinued' | 'archived'`
  - Topic mới `commerio.catalog`, `ensureTopics` tự tạo từ `EVENT_TYPES`.

- [ ] **Step 1: Tạo nhánh từ `main` mới nhất**

```bash
git fetch origin && git switch -c feature/204-su-kien-catalog origin/main
```

- [ ] **Step 2: Viết test đỏ**

Trong `SAMPLES` thêm:

```ts
'catalog.variant_status_changed': { variantId: id(), productId: id(), from: 'selling', to: 'paused', changedAt: at },
'catalog.variant_price_changed': { variantId: id(), productId: id(), from: null, to: '150000.00', changedAt: at },
```

Thêm vào `describe('danh mục sự kiện (AC-11)')`:

```ts
it('catalog.variant_price_changed: to null được (xoá giá muốn bán, spec 204 D3), tiền là number bị từ chối', () => {
  const schema = EVENT_SCHEMAS['catalog.variant_price_changed'];
  const sample = SAMPLES['catalog.variant_price_changed'];
  expect(schema.safeParse({ ...sample, from: '150000.00', to: null }).success).toBe(true);
  expect(schema.safeParse({ ...sample, to: 150000 }).success).toBe(false);
});

it('catalog.variant_status_changed: trạng thái ngoài 4 trạng thái kinh doanh bị từ chối (Documents/21 §17.1)', () => {
  const schema = EVENT_SCHEMAS['catalog.variant_status_changed'];
  expect(schema.safeParse({ ...SAMPLES['catalog.variant_status_changed'], to: 'deleted' }).success).toBe(false);
  expect(schema.safeParse({ ...SAMPLES['catalog.variant_status_changed'], from: null }).success).toBe(false);
});
```

- [ ] **Step 3: Chạy, thấy đỏ**

Run: `npx vitest run --project unit test/unit/modules/core/platform/domain/events.test.ts`
Expected: FAIL. Lỗi kiểu ở `SAMPLES` (khoá không có trong `EventType`), hoặc `EVENT_SCHEMAS['catalog…']` là `undefined`.

- [ ] **Step 4: Khai hai schema trong `events.ts`**

Thêm `const businessStatus = z.enum(['selling', 'paused', 'discontinued', 'archived']);` cạnh `fulfillmentStatus`. Hai khoá dùng `id`, `money.nullable()`, `businessStatus`, `timestamp` sẵn có trong file.

Mỗi khoá có một dòng comment tiếng Việt:
- Trạng thái kinh doanh của SKU đổi (#204, Documents/21 §11.2). Channel ẩn, hiện listing; inventory xét lại ngưỡng.
- Giá muốn bán (`target_net_price`) đổi (#204, #242). `to` null là đã xoá giá. Channel chạy lại bộ lọc giá (#225).

- [ ] **Step 5: Chạy, thấy xanh**

Run: `npx vitest run --project unit test/unit/modules/core/platform/domain/events.test.ts`
Expected: PASS, gồm cả test "tiền tố của type là một module có thật" (module `catalog` có trong registry).

- [ ] **Step 6: Kiểm cả repo, commit**

Run: `npm run check`
Expected: lint, typecheck, depcruise, test đều xanh.

```bash
git add src/modules/core/platform/domain/events.ts test/unit/modules/core/platform/domain/events.test.ts
git commit -m "#204 PR 0: khai catalog.variant_status_changed, catalog.variant_price_changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Push, mở PR (hỏi Khang trước)**

Tiêu đề: `#204 PR 0: khai hai sự kiện của catalog`.

Thân PR:
- Payload, trích `Documents/21` §11.2.
- Điểm lệch D3: `to` có thể null.
- Topic mới `commerio.catalog` (worker tự tạo cùng `.dlq`).
- Mục "Việc cho Thành": channel nghe hai sự kiện (#225 và ẩn, hiện listing). Chưa module nào phát cho tới PR 1, PR 2.

---

### Task 2: `getVariants` trả đủ trường, cổng giá muốn bán cho channel

**Files:**
- Modify: `src/modules/product/catalog/repository/variants.ts` (`findVariants`, thay `standardPricesByVariant`)
- Modify: `src/modules/product/catalog/service/variants.ts` (`VariantSummary`, `getVariants`)
- Modify: `src/modules/product/catalog/service/standard-price.ts`
- Modify: `src/modules/product/catalog/index.ts`
- Test: `test/integration/product/catalog/get-variants.test.ts`
- Test: `test/integration/channel/channel/product-port.test.ts` (tạo mới)

**Interfaces:**
- Consumes: không có (không cần PR 0).
- Produces:
  - `findVariants(filter)` trả thêm mỗi dòng: `description: string | null`, `version: number`, `standardPrice: string | null`, `targetNetPrice: string | null`, `weightG: number | null`, `lengthMm`, `widthMm`, `heightMm` (cùng kiểu `number | null`). `VariantRow` đổi theo.
  - `VariantSummary` thêm `description: string | null`, `weightG`, `lengthMm`, `widthMm`, `heightMm: number | null`. Chưa thêm giá: giá đi qua hàm riêng.
  - `variantPrices(ids: readonly string[]): Promise<{ id: string; standardPrice: string | null; targetNetPrice: string | null }[]>` ở repository, thay `standardPricesByVariant`.
  - `targetNetPricesOf(variantIds: readonly string[]): Promise<Map<string, Decimal | null>>`, export từ `catalog/index.ts`. Có đủ mọi id đầu vào; chưa đặt giá hoặc id lạ thì `null`. Cùng luật với `standardPricesOf`.

- [ ] **Step 1: Chuyển nhánh của PR 1, gộp PR 0**

```bash
git switch feature/204-trang-thai-san-pham && git branch -m feature/204-sua-sku && git merge feature/204-su-kien-catalog
```

Spec và plan đã commit sẵn trên nhánh này. PR 0 merge vào `main` trước thì chạy `git fetch origin && git merge origin/main` thay cho lệnh `merge` ở trên.

- [ ] **Step 2: Viết test đỏ cho `getVariants`**

Trong test đầu của `get-variants.test.ts`, phần tử thứ nhất của `toEqual` thêm:

```ts
description: '', weightG: null, lengthMm: null, widthMm: null, heightMm: null,
```

`createProduct` của helper gửi `description: ''`.

Thêm test:

```ts
it('trả cân nặng, kích thước của SKU và mô tả của sản phẩm (#204, Lazada cần để tính phí ship)', async () => {
  const { companyId, ceo } = await createCompany();
  const category = await createCategory(ceo.token, 'Ví', 'VI-{SEQ}');
  const wallet = await createProduct(ceo.token, { name: 'Ví da', categoryId: category.id, variants: [[]] });
  const variantId = wallet.variants[0]!.id;
  await testPool().query(
    'update product.product_variants set weight_g = 250, length_mm = 200, width_mm = 100, height_mm = 30 where id = $1',
    [variantId],
  );
  await testPool().query("update product.products set description = 'Da bò' where id = $1", [wallet.id]);
  const [v] = await withCompany(companyId, () => getVariants([variantId]));
  expect(v).toMatchObject({ description: 'Da bò', weightG: 250, lengthMm: 200, widthMm: 100, heightMm: 30 });
});

it('targetNetPricesOf: đủ mọi id, chưa đặt giá hay id lạ thì null', async () => {
  const { companyId, ceo } = await createCompany();
  const category = await createCategory(ceo.token, 'Ví', 'VI-{SEQ}');
  const priced = (await createProduct(ceo.token, { name: 'Ví có giá', categoryId: category.id, variants: [[]] })).variants[0]!.id;
  const unpriced = (await createProduct(ceo.token, { name: 'Ví chưa giá', categoryId: category.id, variants: [[]] })).variants[0]!.id;
  await testPool().query('update product.product_variants set target_net_price = 150000 where id = $1', [priced]);
  const stray = randomUUID();
  const prices = await withCompany(companyId, () => targetNetPricesOf([priced, unpriced, stray]));
  expect([...prices.keys()]).toEqual([priced, unpriced, stray]);
  expect(prices.get(priced)!.eq(150000)).toBe(true);
  expect(prices.get(unpriced)).toBeNull();
  expect(prices.get(stray)).toBeNull();
});
```

- [ ] **Step 3: Viết test đỏ với cổng channel thật** (`test/integration/channel/channel/product-port.test.ts`)

```ts
it('SKU có đủ số đo trong catalog thì qua được bước kiểm đẩy lên sàn (#204, cổng thật, không cổng giả)', async () => {
  const { companyId, ceo } = await createCompany();
  const category = await createCategory(ceo.token, 'Ví', 'VI-{SEQ}');
  const variantId = (await createProduct(ceo.token, { name: 'Ví da', categoryId: category.id, variants: [[]] })).variants[0]!.id;
  setProductPort(null);
  const port = productPort({} as ModuleContext); // `ctx` chỉ được dùng cho giá chuẩn, test không gọi
  const map = {} as CategoryMapRow; // pushBlock chỉ kiểm có ghép danh mục hay không
  const check = async () => {
    const [lv] = await withCompany(companyId, () => port.variants([variantId]));
    return pushBlock(lv!, new Decimal(150000), map, true);
  };
  expect((await check())?.code).toBe('dimensions_missing'); // đối chứng: chưa có số đo
  await testPool().query(
    'update product.product_variants set weight_g = 250, length_mm = 200, width_mm = 100, height_mm = 30 where id = $1',
    [variantId],
  );
  expect(await check()).toBeNull();
});
```

Import `productPort`, `setProductPort` từ `#src/modules/channel/channel/service/product-port.ts`, `pushBlock` từ `…/service/push-block.ts`, kiểu `CategoryMapRow` từ `…/repository/category-maps.ts`, `ModuleContext` từ `#src/shared/module.ts`. Thứ tự kiểm của `pushBlock` (`push-block.ts:17`): tạm ngừng → giá → ghép danh mục → số đo → ảnh, nên phải truyền giá, `map` và `hasImages = true` để chạm tới bước số đo. Không gọi sàn.

- [ ] **Step 4: Chạy, thấy đỏ**

Run: `npx vitest run --project integration test/integration/product/catalog/get-variants.test.ts test/integration/channel/channel/product-port.test.ts`
Expected: FAIL. `toEqual` thiếu khoá; `targetNetPricesOf` không tồn tại; số đo đọc ra `null`.

- [ ] **Step 5: Sửa repository, service, index**

- `findVariants` select thêm 8 cột ở Interfaces, trong **cùng câu** đang join `products`, không thêm truy vấn.
- `variantPrices` thay `standardPricesByVariant`.
- `standardPricesOf` đổi sang gọi `variantPrices`, hành vi giữ nguyên.
- `targetNetPricesOf` đặt cạnh `standardPricesOf`; sửa comment đầu file cho cả hai giá.
- `getVariants` map thêm 5 trường.

- [ ] **Step 6: Chạy, thấy xanh**

Run: lệnh ở Step 4, rồi `npx vitest run --project integration test/integration/product test/integration/channel`
Expected: PASS hết, không test cũ nào của inventory, channel đỏ.

- [ ] **Step 7: Commit**

```bash
git add src/modules/product/catalog test/integration/product/catalog/get-variants.test.ts test/integration/channel/channel/product-port.test.ts
git commit -m "#204: getVariants trả mô tả, cân nặng, kích thước; targetNetPricesOf cho channel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Biến thể trong `ProductDetail` có giá muốn bán, số đo, `version`

**Files:**
- Modify: `src/modules/product/catalog/service/products.ts` (`toVariantView`)
- Modify: `src/modules/product/catalog/api/schemas.ts` (`Variant`)
- Test: `test/integration/product/catalog/variant-edit.test.ts` (tạo mới, Task 4 và 5 viết tiếp)

**Interfaces:**
- Consumes: `VariantRow` của Task 2.
- Produces:
  - `toVariantView(v: VariantRow, standardPrice: Decimal | null = null)` trả thêm `version: number`, `businessStatus`, `targetNetPrice: number | null`, `weightG`, `lengthMm`, `widthMm`, `heightMm: number | null`.
  - `targetNetPrice` đổi chuỗi `numeric` sang số nguyên đồng bằng `ROUND_HALF_UP`, như `standardPrice`. Tách thành hàm nhỏ `toDong(value: Decimal | string | null): number | null` dùng cho cả hai giá.
  - Zod `Variant` (`.meta({ id: 'ProductVariant' })`) thêm đúng 7 trường đó, mỗi trường một `.meta({ description })` tiếng Việt. `version` ghi "version của SKU, gửi kèm PATCH".

- [ ] **Step 1: Viết test đỏ**

```ts
describe('chi tiết sản phẩm: trường của SKU (#204, Documents/21 §17.1)', () => {
  it('SKU mới có version 1, selling, chưa có giá và số đo; body khớp đúng schema ProductDetail', async () => {
    const product = await wallet(); // helper trong file: createCategory + createProduct 1 SKU không thuộc tính
    const res = await api(token).get(`/products/${product.id}`);
    expect(res.body.variants[0]).toMatchObject({
      version: 1, businessStatus: 'selling', standardPrice: null, targetNetPrice: null,
      weightG: null, lengthMm: null, widthMm: null, heightMm: null,
    });
    expect(ProductDetail.parse(res.body)).toEqual(res.body); // parse bỏ khoá thừa: bằng nhau là không thừa, không thiếu
  });
});
```

`ProductDetail` import từ `#src/modules/product/catalog/api/schemas.ts`.

- [ ] **Step 2: Chạy, thấy đỏ**

Run: `npx vitest run --project integration test/integration/product/catalog/variant-edit.test.ts`
Expected: FAIL, thiếu `version`, `targetNetPrice`…

- [ ] **Step 3: Sửa `toVariantView` và schema `Variant`**

- [ ] **Step 4: Chạy, thấy xanh, chạy lại test catalog cũ**

Run: `npx vitest run --project integration test/integration/product/catalog`
Expected: PASS. `variants.test.ts` dùng `toMatchObject` nên không vỡ; test nào `toEqual` cả biến thể thì sửa cho thêm trường mới.

- [ ] **Step 5: Commit**

```bash
git add src/modules/product/catalog test/integration/product/catalog
git commit -m "#204: chi tiết sản phẩm trả version, trạng thái, giá muốn bán, số đo của SKU

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `PATCH /catalog/products/:id/variants/:variantId`

**Files:**
- Modify: `src/modules/product/catalog/api/schemas.ts` (`UpdateVariantBody`)
- Modify: `src/modules/product/catalog/api/routes.ts`
- Modify: `src/modules/product/catalog/api/openapi.ts`
- Modify: `src/modules/product/catalog/service/variants.ts` (`updateVariant`, `applyVariantUpdate`)
- Modify: `src/modules/product/catalog/repository/variants.ts` (`updateVariantIfVersion`)
- Modify: `test/integration/product/catalog/helpers.ts` (thêm `patch` vào `api()`)
- Test: `test/integration/product/catalog/variant-edit.test.ts`
- Test: `test/integration/product/catalog/access.test.ts` (thêm dòng vào `writes`)

**Interfaces:**
- Consumes: `findVariants`, `VariantRow` (Task 2); `toVariantView` (Task 3); `findOwnProduct` và hàm `detail` của `service/products.ts`. Export `detail` dưới tên `productDetail(ctx: CatalogContext, p: ProductRow, variants?: VariantRow[]): Promise<ProductDetail>`, sửa hai chỗ gọi cũ trong file. Không gọi `getProduct`, vì nó mở `withCompany` thứ hai; `versionConflict`, `productArchived`, `notFound`, `isUuid`, `auditOf` (`service/errors.ts`); `recordAudit` (`core/index.ts`); `touchProduct` (`repository/products.ts`).
- Produces:
  - `UpdateVariantBody = z.strictObject({ version, standardPrice, targetNetPrice, weightG, lengthMm, widthMm, heightMm }).meta({ id: 'UpdateVariantRequest' })`.
    - `version` dùng hằng `version` sẵn có.
    - Hai giá: `z.int().positive().nullable().optional()`.
    - Bốn số đo: thêm `.max(2_147_483_647)`.
    - Câu lỗi: "Nhập số nguyên lớn hơn 0"; vượt trần: "Số quá lớn".
  - `type UpdateVariantInput = z.output<typeof UpdateVariantBody>`, khai ở service bằng interface tương đương để service không import `api/`.
  - `updateVariantIfVersion(id: string, version: number, set: VariantPatch): Promise<{ version: number; updatedAt: Date; targetNetPrice: string | null } | undefined>`.
    - `VariantPatch = Partial<{ standardPrice: string | null; targetNetPrice: string | null; weightG: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null }>`.
    - Câu lệnh: `set({ ...patch, version: sql\`${productVariants.version} + 1\`, updatedAt: sql\`now()\` })`, `where id = $1 and version = $2`, `returning`. Giá trong `patch` là chuỗi (`String(n)`), cột `numeric` nhận chuỗi.
    - Drizzle bỏ khoá `undefined`, giữ `null`.
  - `applyVariantUpdate(caller: Caller, current: VariantRow, input: UpdateVariantInput): Promise<'unchanged' | 'updated' | 'stale'>`.
    - Chạy trong giao dịch của bên gọi; #242 gọi cho từng dòng.
    - So từng trường với `current`: giá so bằng `Decimal.eq` (null chỉ bằng null), số đo so `===`.
    - Không trường nào đổi: trả `'unchanged'`, không ghi gì, không kiểm `version`.
    - Ghi không trúng `version`: `'stale'`.
    - Ghi trúng: `touchProduct(current.productId)`, rồi `recordAudit` hành động `update`, thực thể `product.product_variants`. `before`/`after` chỉ gồm trường đổi, giá trị theo dạng API (số đồng hoặc null). Trả `'updated'`.
  - `updateVariant(ctx: CatalogContext, caller: Caller, productId: string, variantId: string, input: UpdateVariantInput): Promise<ProductDetail>`, chạy trong `withCompany`, theo thứ tự:
    1. `findOwnProduct(productId)` (404).
    2. Cha có `archivedAt` thì 409 `product_archived`.
    3. `variantId` không phải uuid, hoặc không có trong `findVariants({ productId })`: 404 `notFound('biến thể')`.
    4. Gọi `applyVariantUpdate`. Kết quả `'stale'`: ném `versionConflict('SKU <sku> vừa được người khác sửa', <ProductDetail mới>)`.
    5. Trả `ProductDetail` mới.
  - Route: `router.patch('/products/:id/variants/:variantId', manage, validate({ params: VariantParams, body: UpdateVariantBody }), …)` trả 200 `updateVariant(...)`.
  - OpenAPI:
    - summary "Sửa giá, cân nặng, kích thước của một SKU; bỏ trường là giữ, null là xoá".
    - Phản hồi 200 `ProductDetail`; 409 "`version_conflict` (kèm `current`) hoặc `product_archived`"; `missing('sản phẩm hoặc biến thể')`; `invalid`.

- [ ] **Step 1: Thêm `patch` vào helper `api()`**: `patch: (path: string, body: object) => auth(request(app).patch(BASE + path).send(body))`.

- [ ] **Step 2: Viết test đỏ trong `variant-edit.test.ts`**

`describe('PATCH /catalog/products/:id/variants/:variantId (#204, Documents/21 §17.2)')`, mỗi `it` một hành vi:

| `it` | Kiểm |
|---|---|
| đặt 4 số đo và hai giá → 200 | Body có `weightG: 250, lengthMm: 200, widthMm: 100, heightMm: 30, standardPrice: 180000, targetNetPrice: 150000`; `version` SKU = 2; `version` cha giữ 1; `ProductDetail.parse(body)` bằng `body`; `getVariants` (trong `withCompany`) trả đúng 4 số đo |
| bỏ trường là giữ, `null` là xoá | Sau lần đặt ở trên, gửi `{ version: 2, weightG: null }` → `weightG: null`, ba số đo kia giữ nguyên |
| nhật ký chỉ gồm trường đổi | `auditOf(variantId)` có thêm đúng một dòng `{ action: 'update', entity_type: 'product.product_variants', before: { weightG: null }, after: { weightG: 250 } }` |
| 422 theo ô (`it.each`) | `weightG: 0` → `errors.weightG`; `-1`; `2.5`; `'250'`; `2147483648`; `targetNetPrice: 150000.5` → `errors.targetNetPrice`; thiếu `version` → `errors.version`; `imageFileId: randomUUID()` → 422 `validation_failed` |
| sai `version` → 409 | `type` là `/problems/version_conflict`; `body.current.variants[0].weightG` là giá trị đang lưu; DB không đổi |
| gửi lại PATCH đã thành công (Review Focus 1) | Cùng body, `version` cũ → 200, `version` SKU không tăng thêm, không có dòng nhật ký mới |
| chỉ gửi `version` | 200, `version` SKU không đổi |
| SKU đã lưu trữ vẫn sửa được | Sản phẩm 2 SKU (route cũ chặn ngừng bán SKU cuối bằng `last_variant`). Ngừng bán SKU đầu bằng `DELETE …/variants/:variantId` (route cũ còn tới PR 2), PATCH SKU đó → 200 |
| cha đã lưu trữ | Lưu trữ bằng `DELETE /products/:id?version=1`, PATCH → 409 `product_archived` kể cả khi `version` sai |
| không tìm thấy | SKU của sản phẩm khác, `variantId` `'abc'`, sản phẩm của công ty khác → 404 |

Trong `access.test.ts`, mảng `writes` thêm:

```ts
['PATCH /products/:id/variants/:variantId', (t) => api(t).patch(`/products/${theirs.product.id}/variants/${theirs.product.variants[0]!.id}`, {})],
```

Sửa comment "11 operation ghi" thành 12.

- [ ] **Step 3: Chạy, thấy đỏ**

Run: `npx vitest run --project integration test/integration/product/catalog/variant-edit.test.ts test/integration/product/catalog/access.test.ts`
Expected: FAIL, 404 cho route `PATCH` chưa có.

- [ ] **Step 4: Viết schema, repository, service, route, OpenAPI** theo Interfaces.

- [ ] **Step 5: Chạy, thấy xanh**

Run: lệnh ở Step 3.
Expected: PASS. Sale gọi PATCH ra 403 trước 422 vì `authorize` đứng trước `validate`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/product/catalog test/integration/product/catalog
git commit -m "#204: PATCH sửa giá, cân nặng, kích thước của một SKU

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Phát `catalog.variant_price_changed` khi giá muốn bán đổi

**Files:**
- Modify: `src/modules/product/catalog/service/variants.ts` (`applyVariantUpdate`)
- Test: `test/integration/product/catalog/variant-edit.test.ts`

**Interfaces:**
- Consumes:
  - Schema sự kiện của Task 1.
  - `publishEvent` (`core/index.ts`).
  - Kết quả `updateVariantIfVersion` (Task 4): `targetNetPrice` sau khi ghi là chuỗi `numeric` của DB, `updatedAt`.
- Produces: trong `applyVariantUpdate`, ngay sau khi ghi trúng `version` và **chỉ khi `targetNetPrice` nằm trong các trường đổi**, gọi:

```ts
publishEvent({ type: 'catalog.variant_price_changed', aggregateId: current.id,
  payload: { variantId: current.id, productId: current.productId, from: current.targetNetPrice, to: updated.targetNetPrice, changedAt: updated.updatedAt.toISOString() } })
```

`from` và `to` lấy nguyên chuỗi của DB (`"150000.00"`), không tự định dạng. Câu `UPDATE` đã khoá dòng SKU trước khi ghi outbox, đúng điều kiện thứ tự ở `core/platform/service/outbox/README.md`.

- [ ] **Step 1: Viết test đỏ**

Helper trong file:

```ts
const priceEvents = async (variantId: string) => (await testPool().query(
  "select payload from core.outbox_messages where type = 'catalog.variant_price_changed' and key = $1 order by id", [variantId])).rows.map((r) => r.payload);
```

| `it` | Kiểm |
|---|---|
| đặt giá muốn bán lần đầu | Đúng một sự kiện `{ variantId, productId, from: null, to: '150000.00', changedAt: expect.any(String) }` |
| đổi giá | Sự kiện thứ hai `from: '150000.00', to: '170000.00'` |
| xoá giá bằng `null` | Sự kiện `to: null` |
| gửi lại cùng giá `150000` khi DB đang `"150000.00"` (Review Focus 4) | Không thêm sự kiện, `version` không tăng |
| chỉ đổi `standardPrice` hoặc số đo | Không có sự kiện |
| hai PATCH cùng `version` song song (Review Focus 2) | `Promise.all` hai lệnh, giá khác nhau; trạng thái trả về sắp xếp ra `[200, 409]`; số sự kiện của SKU tăng đúng 1 |
| giao dịch rollback thì không có sự kiện | Cha bị lưu trữ giữa chừng là khó dựng; thay bằng: PATCH sai `version` có đổi giá → 409 và không có sự kiện |

- [ ] **Step 2: Chạy, thấy đỏ**

Run: `npx vitest run --project integration test/integration/product/catalog/variant-edit.test.ts`
Expected: FAIL, `priceEvents` rỗng.

- [ ] **Step 3: Thêm lời gọi `publishEvent` vào `applyVariantUpdate`**

- [ ] **Step 4: Chạy, thấy xanh**

Run: lệnh ở Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/product/catalog/service/variants.ts test/integration/product/catalog/variant-edit.test.ts
git commit -m "#204: phát catalog.variant_price_changed khi giá muốn bán của SKU đổi

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tài liệu module, kiểm toàn repo, mở PR 1

**Files:**
- Modify: `src/modules/product/catalog/CLAUDE.md`
- Modify: `graphify-out/` (sinh lại; chỉ commit nếu thư mục đang được git theo dõi)

- [ ] **Step 1: Sửa `catalog/CLAUDE.md`**

Mục "Gọi vào và gọi ra":
- `getVariants` nay trả thêm `description`, `weightG`, `lengthMm`, `widthMm`, `heightMm`.
- channel gọi `targetNetPricesOf` (#225).
- Thay câu "Không phát sự kiện" bằng: phát `catalog.variant_price_changed` khi giá muốn bán đổi (PATCH; #242 dùng lại `applyVariantUpdate`).

Mục "Bất biến": PATCH SKU tăng `version` **của SKU**, không đổi `version` cha, chỉ đổi `updated_at` cha. Body không đổi trường nào thì không ghi và không kiểm `version`.

- [ ] **Step 2: Kiểm toàn repo**

Run: `npm run check`
Expected: xanh hết. Depcruise không báo luật mới: catalog chỉ import `core/index.ts`.

- [ ] **Step 3: Cập nhật đồ thị**

Run: `graphify update .`, rồi `git status --short graphify-out`. Có thay đổi trong file đang được theo dõi thì commit cùng tài liệu.

```bash
git add src/modules/product/catalog/CLAUDE.md graphify-out
git commit -m "#204: cập nhật CLAUDE.md của catalog cho PATCH SKU và sự kiện giá

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Gộp `main` mới nhất nếu PR 0 đã merge** (`git fetch origin && git merge origin/main`), chạy lại `npm run check`.

- [ ] **Step 5: Push, mở PR vào `main` (hỏi Khang trước)**

Tiêu đề: `#204 PR 1: sửa giá, cân nặng, kích thước của SKU; getVariants đủ trường`.

Thân PR:
- Phạm vi: spec mục 5.1, link spec và plan.
- Lệch tài liệu: D1 (chưa nhận `imageFileId`), D2 (`targetNetPricesOf`), D3 (`to` null).
- Quyết định của plan: gửi lại PATCH không đổi gì thì 200.
- Việc cho Thành: bỏ `Partial` trong `channel/service/product-port.ts`; #225 đọc giá muốn bán bằng `targetNetPricesOf`, nghe `catalog.variant_price_changed`.
- Việc cho Khoa (FE#154, FE#168): `VariantUpdateInput` và `ProductVariant` thêm `targetNetPrice`; `MISSING_LABELS.price` là giá muốn bán.
- Kiểm trên staging sau khi merge: PATCH 4 số đo cho một SKU rồi đẩy Lazada, không còn `dimensions_missing`.
- PR 0 phải merge trước. Nếu PR 0 chưa merge thì mở PR 1 dạng draft.

- [ ] **Step 6: PR Documents cho D1 đến D3 (hỏi Khang trước)**

Làm trong `D:\DA-TMDT\Documents`, nhánh `docs/204-sua-sku` từ `origin/main`:
- `21` §17.2: PATCH chưa nhận `imageFileId`.
- `21` §11.2: `to` của `variant_price_changed` là `string | null`.
- `21` §11.3: thêm cổng `targetNetPricesOf(variantIds)`.

Mở PR, link vào PR 1.
