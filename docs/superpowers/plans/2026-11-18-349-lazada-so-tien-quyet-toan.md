# Lazada đọc số tiền có dấu phẩy nghìn khi kéo quyết toán (#349): kế hoạch thi công

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kéo quyết toán gian hàng Lazada ra lần chạy `done` thay vì `failed` `[DecimalError] Invalid argument: 1,600.02`; số không đọc được thì báo câu rõ cho người dùng, ghi đủ giao dịch và giá trị gốc cho kỹ thuật.

**Architecture:** Adapter Lazada chuẩn hoá số tiền thành chuỗi thập phân trơn (`lazadaAmount`) trước khi trả `SettlementTxn`, `Payout`, như đã chuẩn hoá mã giao dịch (`normalizeLazadaTxnId`, #250). Số không đọc được thì adapter ném `MarketplaceError('rejected', 'invalid_amount')`, `toAppError` đổi thành 502 `marketplace_invalid_amount`, cổng quyết toán ghi `logger.error`. Finance lưu câu cho người đọc của `AppError` vào `error` của lần chạy (FE hiện nguyên cột này). Sàn giả lập trả số có dấu phẩy như Lazada thật.

**Tech Stack:** Node.js 24 chạy thẳng `.ts`, Express 5, decimal.js, Vitest. Dùng `npm`. Không có migration.

**Spec:** issue DA-EC-System/commerio-backend#349 (mục Việc, Definition of Done). Số dòng trong issue đã cũ: `getTransactions` nay ở `lazada.ts:1106`, `new Decimal(t.amount)` ở `settlement-runs.ts:179`.

## Global Constraints

- #349 đang giao cho Thành; Khang nhận làm (18/11/2026). Task 3 sửa `finance` (module của Thành): ghi rõ trong PR.
- Đọc trước khi sửa: `CLAUDE.md` gốc, `src/modules/channel/channel/CLAUDE.md` (mục "Cổng quyết toán cho finance"), `src/modules/finance/finance/CLAUDE.md` (mục "Đối soát quyết toán"), `test/CLAUDE.md`.
- Nền: worktree `.claude/worktrees/349-lazada-so-tien`, nhánh `feature/349-lazada-so-tien` tách từ `origin/main` fbf7e052. Không đặt upstream là `main`.
- Câu cho người dùng, đúng từng chữ (issue #349, DB-U01): `Không đọc được số tiền sàn trả về. Đã báo kỹ thuật, thử lại sau.`
- Mã lỗi: `MarketplaceError.platformCode` `invalid_amount` (hằng `INVALID_AMOUNT` ở `common.ts`); `AppError` 502 `marketplace_invalid_amount`.
- Dạng nhận: số JS hữu hạn, hoặc chuỗi khớp `^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$` sau khi bỏ khoảng trắng hai đầu. Trả chuỗi đã bỏ dấu phẩy và dấu `+`, giữ nguyên số chữ số thập phân. Không đoán định dạng khác (`1.600,02` là lỗi, không phải 1600,02).
- Không dựa vào `Decimal` để bắt chuỗi lạ: decimal.js v10 nhận `'NaN'`, `'Infinity'`, `'0x10'` (= 16), `'1_600'` mà không ném (tài liệu constructor, tra qua context7 18/11/2026). `lazadaAmount` phải chặn các dạng đó.
- `amount` của giao dịch là bắt buộc (vắng là lỗi); `WHT_amount`, `payout`, `closing_balance` vắng thì `"0"` như hiện nay.
- Không đổi kiểu `SettlementTxn`, `Payout` (vẫn chuỗi); không đổi luật ghi sổ, chống trùng.
- Định danh tiếng Anh; comment, thông báo, tên test tiếng Việt. Import tương đối có đuôi `.ts`; test import `#src/...ts`. Chỉ cú pháp TypeScript xoá được.
- Không push, không mở PR khi Khang chưa bảo. `graphify update .` sau khi sửa code.

## Sáu câu hỏi thiết kế (backend-design)

1. **Loại thành phần.** Việc nền `finance.settlement_run` (worker, thử 3 lần cách 10 phút) gọi sàn qua cổng `ctx.settlementSource` của channel; mở bằng nút Kéo quyết toán hoặc vòng 6 giờ. Tải: một lần chạy mỗi gian hàng mỗi lượt.
2. **Dữ liệu và bất biến.** Tiền là chuỗi thập phân tới finance, `Decimal` trong finance, `numeric` trong DB. Sổ tiền chỉ thêm, nên số đọc sai là sai vĩnh viễn: không bao giờ đổi số không đọc được thành 0 hay đoán định dạng.
3. **Lỗi.** Số sai dạng là lỗi của hệ thống (sàn đổi định dạng), không phải của người dùng: 502, `logger.error`, việc hết lượt thử thì vào trang việc lỗi ("Đã báo kỹ thuật"). Người dùng thấy câu cố định, không thấy `DecimalError` hay giá trị thô. Lỗi xảy ra lúc đọc sàn, trước `applyRun`, nên không ghi dòng sổ nào.
4. **Phân quyền.** Không đổi (`finance.settlement.*` mở lần chạy; việc nền là hệ thống).
5. **Gọi lặp, đồng thời.** Không đổi: chống trùng theo (gian hàng, `external_transaction_id`); lần chạy lỗi giữ mốc cũ, lần sau kéo lại.
6. **Quan sát.** `logger.error({ companyId, shopId, platformMessage })` ở cổng quyết toán (giao dịch, trường, giá trị gốc nằm trong `platformMessage`); `error` của lần chạy; trang việc lỗi. Không thêm metric.

## Review Focus

1. Dòng không có `transaction_number` mà số tiền hỏng: hiện bị bỏ ở cuối, nên không được làm hỏng cả lần chạy. Bỏ dòng trước khi đọc số (Task 1, ca "dòng không mã giao dịch").
2. Định dạng kiểu Việt `1.600,02`, nhóm sai `1,60.00`, `1,6000.00`, và chuỗi decimal.js tự nhận (`'NaN'`, `'0x10'`, `'1_600.00'`): phải ném lỗi, không đọc thành 1.6, 16 hay NaN rồi cộng vào sổ (Task 1).
3. `amount` vắng: hôm nay thành `"0"` rồi finance bỏ dòng 0 đồng, mất một khoản không ai biết. Sau sửa là lỗi (Task 1).
4. Lazada trả số JSON (`1600.02`) thay vì chuỗi: vẫn nhận (Task 1).
5. Mã `rejected` khác `invalid_amount` vẫn ra 409 `marketplace_rejected` như cũ (Task 2, ca hồi quy).

---

### Task 1: Adapter Lazada chuẩn hoá số tiền quyết toán

**Files:**
- Modify: `src/modules/channel/channel/service/marketplaces/common.ts` (thêm `INVALID_AMOUNT` cạnh `PROMOTION_LOCKED`, dòng ~389; JSDoc `SettlementTxn.amount` ~218 ghi "chuỗi thập phân trơn, không dấu phân nhóm")
- Modify: `src/modules/channel/channel/service/marketplaces/index.ts:11` (export `INVALID_AMOUNT`)
- Modify: `src/modules/channel/channel/service/marketplaces/lazada.ts` (`lazadaAmount` cạnh `normalizeLazadaTxnId` ~137; `getTransactions` 1106–1126; `getPayouts` 1128–1137; comment dòng 1105)
- Test: `test/unit/modules/channel/channel/service/marketplaces/lazada-finance.test.ts`

**Interfaces:**
- Produces: `export const INVALID_AMOUNT = 'invalid_amount'` (common.ts, re-export ở index.ts); `export function lazadaAmount(raw: unknown, where: string, opts?: { required?: boolean }): string` (lazada.ts). Ném `new MarketplaceError('rejected', INVALID_AMOUNT, \`Số tiền sàn trả không đọc được (${where}): ${JSON.stringify(raw)}\`)`. `where` dạng `amount, giao dịch TX1` hoặc `closing_balance, kỳ VN2026W44`.

- [ ] **Step 1: Viết test hỏng**

Thêm vào `lazada-finance.test.ts` (import thêm `lazadaAmount`; helper `thrown(fn)` bắt lỗi đồng bộ hoặc bất đồng bộ để `toMatchObject`):

```ts
describe('lazadaAmount: số tiền Lazada có dấu phẩy nghìn (#349)', () => {
  it.each([
    ['1,600.02', '1600.02'], ['-12,345.6', '-12345.6'], ['4,500,000.00', '4500000.00'],
    ['-5160.00', '-5160.00'], [' +1,600.02 ', '1600.02'], [1600.02, '1600.02'], [-0.5, '-0.5'],
  ])('đọc %j thành %s', (raw, want) => {
    expect(lazadaAmount(raw, 'amount, giao dịch TX1', { required: true })).toBe(want);
  });

  it.each(['1.600,02', '1,60.00', '1,6000.00', ',600', '₫1,600', '1,600.02 VND', 'abc', 'NaN', 'Infinity', '0x10', '1_600.00', NaN, Infinity, {}, true])(
    '%j không đọc được: ném rejected invalid_amount kèm chỗ và giá trị gốc',
    async (raw) => {
      expect(await thrown(() => lazadaAmount(raw, 'amount, giao dịch TX1', { required: true }))).toMatchObject({
        kind: 'rejected', platformCode: 'invalid_amount', platformMessage: expect.stringContaining('amount, giao dịch TX1'),
      });
    },
  );

  it.each([undefined, null, '', '  '])('vắng (%j): bắt buộc thì ném, không bắt buộc thì "0"', async (raw) => {
    expect(await thrown(() => lazadaAmount(raw, 'amount, giao dịch TX1', { required: true }))).toMatchObject({ platformCode: 'invalid_amount' });
    expect(lazadaAmount(raw, 'WHT_amount, giao dịch TX1')).toBe('0');
  });

  it('getTransactions: bỏ dấu phẩy ở amount, WHT_amount; WHT_amount vắng thì "0"', async () => {
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', data: [
      { ...row(1), amount: '-5,160.00', WHT_amount: '1,234.50' },
      { ...row(2), amount: '129,000.00', WHT_amount: undefined },
    ] }));
    const txns = await createLazadaAdapter(config, fn).getTransactions!('t', '2026-10-01', '2026-10-31');
    expect(txns.map((x) => [x.txnId, x.amount, x.withholding])).toEqual([['TX1', '-5160.00', '1234.50'], ['TX2', '129000.00', '0']]);
  });

  it('getTransactions: amount hỏng hoặc vắng thì ném invalid_amount kèm mã giao dịch', async () => {
    for (const amount of ['1.600,02', undefined]) {
      const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', data: [{ ...row(7), amount }] }));
      expect(await thrown(() => createLazadaAdapter(config, fn).getTransactions!('t', '2026-10-01', '2026-10-31'))).toMatchObject({
        kind: 'rejected', platformCode: 'invalid_amount', platformMessage: expect.stringContaining('TX7'),
      });
    }
  });

  it('getTransactions: dòng không mã giao dịch bị bỏ trước khi đọc số, số hỏng ở dòng đó không làm hỏng lần chạy', async () => {
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', data: [{ ...row(1), transaction_number: '', amount: 'abc' }, row(2)] }));
    const txns = await createLazadaAdapter(config, fn).getTransactions!('t', '2026-10-01', '2026-10-31');
    expect(txns.map((x) => x.txnId)).toEqual(['TX2']);
  });

  it('getPayouts: bỏ dấu phẩy ở payout, closing_balance; closing_balance hỏng thì ném kèm mã kỳ', async () => {
    const payout = { statement_number: 'VN2026W44', created_at: '2026-11-02', payout: '230,000.00', closing_balance: '1,230,000.00', paid: '0' };
    const ok = vi.fn().mockResolvedValueOnce(json({ code: '0', data: [payout] }));
    expect(await createLazadaAdapter(config, ok).getPayouts!('t', '2026-10-01')).toEqual([
      { statementNumber: 'VN2026W44', createdAt: '2026-11-02', payout: '230000.00', closingBalance: '1230000.00', paid: false },
    ]);
    const bad = vi.fn().mockResolvedValueOnce(json({ code: '0', data: [{ ...payout, closing_balance: 'n/a' }] }));
    expect(await thrown(() => createLazadaAdapter(config, bad).getPayouts!('t', '2026-10-01'))).toMatchObject({
      platformCode: 'invalid_amount', platformMessage: expect.stringContaining('VN2026W44'),
    });
  });
});
```

- [ ] **Step 2: Chạy test, thấy hỏng**

Run: `npx vitest run --project unit test/unit/modules/channel/channel/service/marketplaces/lazada-finance.test.ts`
Expected: FAIL, `lazadaAmount` không được export.

- [ ] **Step 3: Viết `INVALID_AMOUNT`, `lazadaAmount`, sửa `getTransactions`, `getPayouts`**

`lazadaAmount` theo Global Constraints (dạng nhận, vắng). `getTransactions`: lọc dòng có `normalizeLazadaTxnId(r.transaction_number)` khác rỗng **trước** khi dựng `SettlementTxn` (thay cho `out.filter((t) => t.txnId)` ở cuối; điều kiện dừng lật trang vẫn theo `rows.length`); `amount` bắt buộc, `withholding` không bắt buộc, `where` theo mã giao dịch. `getPayouts`: `payout`, `closingBalance` không bắt buộc, `where` theo `statement_number`. Comment dòng 1105: thêm "số tiền có dấu phẩy nghìn (staging 17/11/2026, #349)".

- [ ] **Step 4: Chạy test, thấy qua**

Run: `npx vitest run --project unit test/unit/modules/channel/channel/service/marketplaces/`
Expected: PASS, gồm cả ca cũ của `lazada-finance.test.ts` (`amount: '-5160.00'`, `withholding: '0.00'` giữ nguyên) và `contract-lazada.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/channel/channel/service/marketplaces/common.ts src/modules/channel/channel/service/marketplaces/index.ts src/modules/channel/channel/service/marketplaces/lazada.ts test/unit/modules/channel/channel/service/marketplaces/lazada-finance.test.ts
git commit -m "fix(channel): Lazada đọc số tiền quyết toán có dấu phẩy nghìn (#349)"
```

### Task 2: Đổi `invalid_amount` sang 502 có câu cho người dùng, ghi log cho kỹ thuật

**Files:**
- Modify: `src/modules/channel/channel/service/shops.ts:280-292` (`toAppError`)
- Modify: `src/modules/channel/channel/service/settlement-port.ts` (`settlementTransactions`, `settlementPayouts`)
- Modify: `src/modules/channel/channel/CLAUDE.md` (mục "Cổng quyết toán cho finance", dòng ~133)
- Create: `test/unit/modules/channel/channel/service/settlement-port.test.ts`

**Interfaces:**
- Consumes: `INVALID_AMOUNT` (Task 1).
- Produces: `AppError(502, 'marketplace_invalid_amount', 'Không đọc được số tiền sàn trả về. Đã báo kỹ thuật, thử lại sau.', { platformCode, platformMessage })` từ `onMarketplace`.

- [ ] **Step 1: Viết test hỏng**

Tạo `settlement-port.test.ts`, mock theo `order-actions.test.ts`: `vi.mock('#src/shared/db/client.ts', …)` cho `withCompany` (chạy luôn `fn`) và `currentCompanyId` (trả `null`); `vi.mock(import('#src/modules/channel/channel/service/shops.ts'), …)` giữ bản gốc, chỉ thay `shopSession` bằng `vi.fn()`. Mỗi ca `shopSession.mockResolvedValue({ adapter, accessToken: 't' })`.

```ts
const SENTENCE = 'Không đọc được số tiền sàn trả về. Đã báo kỹ thuật, thử lại sau.';
const bad = () => { throw new MarketplaceError('rejected', INVALID_AMOUNT, 'Số tiền sàn trả không đọc được (amount, giao dịch TX1): "1.600,02"'); };

it('getTransactions trả số hỏng: 502 marketplace_invalid_amount, câu cho người dùng, giữ chi tiết cho kỹ thuật', async () => {
  vi.mocked(shopSession).mockResolvedValue({ adapter: { getTransactions: async () => bad() }, accessToken: 't' } as never);
  await expect(settlementTransactions('c', 's', '2026-10-01', '2026-10-31')).rejects.toMatchObject({
    status: 502, code: 'marketplace_invalid_amount', message: SENTENCE,
    extensions: { platformCode: 'invalid_amount', platformMessage: expect.stringContaining('TX1') },
  });
});

it('getPayouts trả số hỏng: cùng lỗi 502', async () => {
  vi.mocked(shopSession).mockResolvedValue({ adapter: { getPayouts: async () => bad() }, accessToken: 't' } as never);
  await expect(settlementPayouts('c', 's', '2026-10-01')).rejects.toMatchObject({ status: 502, code: 'marketplace_invalid_amount' });
});

it('mã rejected khác vẫn là 409 marketplace_rejected', async () => {
  vi.mocked(shopSession).mockResolvedValue({
    adapter: { getTransactions: async () => { throw new MarketplaceError('rejected', 'E1', 'x'); } }, accessToken: 't',
  } as never);
  await expect(settlementTransactions('c', 's', '2026-10-01', '2026-10-31')).rejects.toMatchObject({ status: 409, code: 'marketplace_rejected' });
});
```

- [ ] **Step 2: Chạy test, thấy hỏng**

Run: `npx vitest run --project unit test/unit/modules/channel/channel/service/settlement-port.test.ts`
Expected: FAIL, ca đầu nhận 409 `marketplace_rejected`.

- [ ] **Step 3: Sửa `toAppError` và cổng quyết toán**

`toAppError`: trước `switch`, `err.platformCode === INVALID_AMOUNT` thì trả `AppError` 502 như Interfaces. `settlement-port.ts`: hai lời gọi `onMarketplace(...)` thêm `.catch` dùng chung: `AppError` mã `marketplace_invalid_amount` thì `logger.error({ companyId, shopId, platformMessage: err.extensions?.platformMessage }, 'Sàn trả số tiền quyết toán không đọc được')`, rồi ném lại nguyên lỗi.

`channel/CLAUDE.md`, câu "mã giao dịch chuẩn hoá trong adapter…" thêm: số tiền chuẩn hoá thành chuỗi thập phân trơn (Lazada bỏ dấu phẩy nghìn, `lazadaAmount`, #349; `amount` bắt buộc, `WHT_amount`, `payout`, `closing_balance` vắng thì 0); không đọc được thì `rejected` `invalid_amount`, `toAppError` đổi thành 502 `marketplace_invalid_amount`, cổng ghi `logger.error` kèm giao dịch và giá trị gốc. Sửa câu "Dạng phản hồi theo tài liệu Lazada, chưa so với dữ liệu thật" thành "đã thấy trên staging 17/11/2026: số tiền dạng `1,600.02`".

- [ ] **Step 4: Chạy test, thấy qua**

Run: `npx vitest run --project unit test/unit/modules/channel/channel/service/`
Expected: PASS (gồm `order-actions.test.ts` dùng chung `onMarketplace`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/channel/channel/service/shops.ts src/modules/channel/channel/service/settlement-port.ts src/modules/channel/channel/CLAUDE.md test/unit/modules/channel/channel/service/settlement-port.test.ts
git commit -m "fix(channel): số tiền sàn không đọc được trả 502 marketplace_invalid_amount, ghi log kỹ thuật (#349)"
```

### Task 3: Lần đối soát lỗi lưu câu cho người đọc

**Files:**
- Modify: `src/modules/finance/finance/service/settlement-runs.ts:131` (`processRun`, dòng tính `message`)
- Modify: `src/modules/finance/finance/CLAUDE.md` (mục "Kéo quyết toán", câu "lượt cuối lỗi để `failed` kèm `error`")
- Test: `test/integration/finance/finance/settlement-runs.test.ts`

**Interfaces:**
- Consumes: mã và câu của Task 2 (test dựng `AppError` thẳng, không gọi channel).
- Produces: `settlement_batches.error` = `err.message` khi lỗi là `AppError` (không còn tiền tố `<mã>: `); lỗi khác giữ `err.message` hoặc `String(err)` như cũ; vẫn cắt 500 ký tự.

- [ ] **Step 1: Viết test hỏng**

Trong `describe('kéo quyết toán (§21.3)')`, cạnh ca "gọi sàn lỗi" (import `AppError` từ `#src/shared/errors/app-error.ts`):

```ts
it('sàn trả số tiền không đọc được: lần chạy failed kèm câu cho người dùng, không kèm mã lỗi (#349)', async () => {
  const s = await setup();
  const sentence = 'Không đọc được số tiền sàn trả về. Đã báo kỹ thuật, thử lại sau.';
  const broken = fakeSource(() => {
    throw new AppError(502, 'marketplace_invalid_amount', sentence);
  });
  expect(await runSettlement(broken, s.companyId, null, s.shopId)).toMatchObject({ status: 'failed', error: sentence });
});
```

- [ ] **Step 2: Chạy test, thấy hỏng**

Run: `npx vitest run --project integration test/integration/finance/finance/settlement-runs.test.ts` (Docker phải đang chạy)
Expected: FAIL, `error` là `marketplace_invalid_amount: Không đọc được…`.

- [ ] **Step 3: Sửa `processRun`**

`AppError` thì lấy `err.message`; mã vẫn có trong `logger.warn({ err, … })` ngay dưới. Sửa câu trong `finance/CLAUDE.md`: "lượt cuối lỗi để `failed` kèm `error` (câu cho người đọc của `AppError`, FE hiện nguyên; mã lỗi chỉ ở log)".

- [ ] **Step 4: Chạy test, thấy qua**

Run: `npx vitest run --project integration test/integration/finance/finance/settlement-runs.test.ts`
Expected: PASS, gồm ca cũ `error: 'sàn không trả lời'`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/finance/finance/service/settlement-runs.ts src/modules/finance/finance/CLAUDE.md test/integration/finance/finance/settlement-runs.test.ts
git commit -m "fix(finance): lần đối soát lỗi lưu câu cho người đọc, không kèm mã (#349)"
```

### Task 4: Sàn giả lập trả số tiền quyết toán có dấu phẩy như Lazada thật

**Files:**
- Modify: `scripts/lazada-mock/stubs.ts:173` (`VND`), `:215` (`payout()` cộng số)
- Test: `test/unit/scripts/lazada-mock/stubs.test.ts:87-104`

**Interfaces:**
- Produces: mọi số tiền của `/finance/transaction/details/get` và `/finance/payout/status/get` trên sàn giả lập dạng `n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` (`-5,160.00`, `258,000.00`). `VND` chỉ dùng cho hai API này (8 chỗ), nên đổi chính `VND`.

- [ ] **Step 1: Sửa test cho dạng mới (hỏng)**

`fees(...)` mong `['Commission -5,160.00', 'Commission -5,160.00']` và `['Commission -10,320.00', 'Commission -10,320.00', 'Sponsored Discovery - Top up -5,000.00']`. Ca payout: `const num = (v: string) => Number(v.replaceAll(',', ''))`, `expect(num(payout.item_revenue) + num(payout.fees_total)).toBe(num(payout.payout))`, `expect(payout.item_revenue).toBe('258,000.00')`.

- [ ] **Step 2: Chạy test, thấy hỏng**

Run: `npx vitest run --project unit test/unit/scripts/lazada-mock/stubs.test.ts`
Expected: FAIL, nhận `-5160.00`.

- [ ] **Step 3: Đổi `VND`, sửa `payout()` cộng bằng `Number(r.amount.replaceAll(',', ''))`**

Comment cạnh `VND`: "Lazada trả số tiền quyết toán có dấu phẩy nghìn (staging 17/11/2026, #349)".

- [ ] **Step 4: Chạy test, thấy qua**

Run: `npx vitest run --project unit test/unit/scripts/lazada-mock/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lazada-mock/stubs.ts test/unit/scripts/lazada-mock/stubs.test.ts
git commit -m "test(lazada-mock): số tiền quyết toán có dấu phẩy nghìn như sàn thật (#349)"
```

### Task 5: Kiểm toàn nhánh

- [ ] **Step 1:** Run: `npm run check`. Expected: lint, typecheck, depcruise, test đều qua.
- [ ] **Step 2:** Run: `graphify update .` ở worktree (AST, không tốn API).
- [ ] **Step 3:** Báo Khang kết quả, chờ lệnh push và mở PR. Mô tả PR ghi: sửa cả `finance` (Task 3, báo Thành); FE còn phần chữ của bảng "Chữ cần sửa" trong #349 (nhãn TikTok chưa hỗ trợ, "—" cho lệch ví lần lỗi, "Chọn một gian hàng…").

## Sau khi merge (Definition of Done, Khang chạy trên staging)

Bấm Kéo quyết toán gian hàng "Ngô gia phát 111" (Demo), chờ việc chạy xong, rồi:

```sql
select status, error, line_count, wallet_diff, created_at
from finance.settlement_batches
where shop_id = '46451c02-a4f5-436e-9c22-c369121b000a'
order by created_at desc limit 3;

select count(*) as actual_lines
from finance.ledger_entries
where shop_id = '46451c02-a4f5-436e-9c22-c369121b000a' and not is_estimate;

select status, count(*) from finance.order_settlements
where shop_id = '46451c02-a4f5-436e-9c22-c369121b000a' group by status;
```

Đạt khi lần mới nhất `done`, có dòng thực tế, ít nhất một đơn `settled` hoặc `mismatch`. Lần chạy `failed` với câu của #349 nghĩa là Lazada còn trường số khác định dạng: đọc `platformMessage` trong log `Sàn trả số tiền quyết toán không đọc được`.
