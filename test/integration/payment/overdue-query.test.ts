import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOverdueQuery } from '#src/modules/payment/service/overdue-query.ts';
import { createModuleContext } from '#src/wiring.ts';
import { linkedOrder, linkStatus, moneyRows, orderPayment } from '../finance/helpers.ts';
import { testPool } from '../helpers/db.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Tra cứu quá hạn (Documents/21 §12.4; plan #27 A8, AC-19). `now` đặt ở năm 2030 và lùi `expires_at` của mã trong test về
// trước đó (dựng tay, L004: không chờ 15 phút thật), để lượt tra cứu không đụng mã của file test khác (cửa sổ 24 giờ).
const NOW = new Date('2030-01-01T00:00:00Z');
const ctx = createModuleContext();
afterEach(() => vi.restoreAllMocks());

async function overdue(l: { link: { id: string } }, minutesAgo = 5) {
  await testPool().query('update payment.payment_links set expires_at = $2 where id = $1', [
    l.link.id,
    new Date(NOW.getTime() - minutesAgo * 60_000),
  ]);
}

/** Cổng giả: trả lời theo mã thanh toán trong request; ghi lại các mã đã được hỏi. */
function fakeGateways(answers: Record<string, unknown>) {
  const asked: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = String(init?.body ?? '');
    const code = /CM[A-Z0-9]{10}/.exec(body)?.[0] ?? '';
    asked.push(code);
    return new Response(JSON.stringify(answers[code] ?? { resultCode: 1005, return_code: 2 }), { status: 200 });
  });
  return asked;
}

describe('runOverdueQuery (AC-19)', () => {
  it('MoMo đã trả → ghi như webhook với source=query: phiếu thu, đơn paid, mã paid; lượt sau không thêm gì', async () => {
    const l = await linkedOrder('momo');
    await overdue(l);
    fakeGateways({ [l.link.paymentCode]: { resultCode: 0, orderId: l.link.paymentCode, transId: 99887766, amount: 150000, responseTime: 1 } });
    await runOverdueQuery(ctx, NOW);
    const r = await moneyRows(l.companyId);
    expect(r.txns).toEqual([expect.objectContaining({ gateway: 'momo', source: 'query', status: 'succeeded', gateway_txn_id: '99887766' })]);
    expect(r.receipts).toHaveLength(1);
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'paid' });
    expect(await linkStatus(l.link.id)).toBe('paid');

    await runOverdueQuery(ctx, NOW);
    expect((await moneyRows(l.companyId)).txns).toHaveLength(1);
  });

  it('ZaloPay chưa trả (return_code 3), MoMo không biết mã → mã expired, không giao dịch', async () => {
    const z = await linkedOrder('zalopay');
    const m = await linkedOrder('momo');
    await overdue(z);
    await overdue(m);
    fakeGateways({ [z.link.paymentCode]: { return_code: 3, is_processing: true } });
    await runOverdueQuery(ctx, NOW);
    expect(await linkStatus(z.link.id)).toBe('expired');
    expect(await linkStatus(m.link.id)).toBe('expired');
    expect((await moneyRows(z.companyId)).txns).toEqual([]);
    expect(await orderPayment(z.orderId)).toMatchObject({ status: 'unpaid' });
  });

  it('VietQR không có API tra cứu: mã expired, không gọi mạng', async () => {
    const l = await linkedOrder('vietqr');
    await overdue(l);
    const asked = fakeGateways({});
    await runOverdueQuery(ctx, NOW);
    expect(await linkStatus(l.link.id)).toBe('expired');
    expect(asked).not.toContain(l.link.paymentCode);
  });

  it('mã quá hạn hơn 24 giờ không động tới; cổng lỗi mạng thì mã giữ active, lượt vẫn chạy tiếp', async () => {
    const old = await linkedOrder('vietqr');
    await overdue(old, 25 * 60);
    const broken = await linkedOrder('momo');
    await overdue(broken);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await runOverdueQuery(ctx, NOW);
    expect(await linkStatus(old.link.id)).toBe('active');
    expect(await linkStatus(broken.link.id)).toBe('active');
  });

  it('cổng báo đã trả nhưng lệch tiền → khoản thu chưa khớp và mã expired, lượt sau không hỏi lại (review diff PR2)', async () => {
    const l = await linkedOrder('momo');
    await overdue(l);
    const asked = fakeGateways({
      [l.link.paymentCode]: { resultCode: 0, orderId: l.link.paymentCode, transId: 11223344, amount: 1000, responseTime: 1 },
    });
    await runOverdueQuery(ctx, NOW);
    expect(await linkStatus(l.link.id)).toBe('expired');
    expect((await moneyRows(l.companyId)).unmatched).toEqual([expect.objectContaining({ reason: 'amount_mismatch' })]);
    await runOverdueQuery(ctx, NOW);
    expect(asked.filter((c) => c === l.link.paymentCode)).toHaveLength(1);
  });

  it('IPN đến sau khi tra cứu đã ghi cùng giao dịch → duplicate, vẫn một phiếu thu', async () => {
    const l = await linkedOrder('momo');
    await overdue(l);
    fakeGateways({ [l.link.paymentCode]: { resultCode: 0, orderId: l.link.paymentCode, transId: 55443322, amount: 150000, responseTime: 1 } });
    await runOverdueQuery(ctx, NOW);
    const handler = ctx.onVerifiedPayment;
    const { withCompany } = await import('#src/shared/db/client.ts');
    const { Decimal } = await import('decimal.js');
    const again = await withCompany(l.companyId, () =>
      handler({
        companyId: l.companyId,
        gateway: 'momo',
        source: 'webhook',
        eventKey: '55443322',
        gatewayTxnId: '55443322',
        paymentCode: l.link.paymentCode,
        paymentLinkId: l.link.id,
        orderId: l.orderId,
        amount: new Decimal(150000),
        succeeded: true,
        fee: null,
        occurredAt: new Date(),
        rawPayload: {},
      }),
    );
    expect(again).toEqual({ outcome: 'duplicate' });
    expect((await moneyRows(l.companyId)).receipts).toHaveLength(1);
  });
});

describe('runOverdueQuery: một lượt mỗi lúc (#63 B20, Documents/21 §12.4 "giữ advisory lock")', () => {
  it('hai lượt chạy song song (hai bản sao worker): mỗi mã chỉ hỏi cổng một lần, một lượt trả busy', async () => {
    const l = await linkedOrder('zalopay');
    await overdue(l);
    const asked: string[] = [];
    // Cổng giả giữ lượt A ở lần hỏi đầu tới khi lượt B xong: không dựa vào thời gian.
    let entered!: () => void;
    const inFetch = new Promise<void>((resolve) => (entered = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      asked.push(/CM[A-Z0-9]{10}/.exec(String(init?.body ?? ''))?.[0] ?? '');
      entered();
      await gate;
      return new Response(JSON.stringify({ return_code: 2 }), { status: 200 });
    });
    const first = runOverdueQuery(ctx, NOW);
    await inFetch;
    const second = runOverdueQuery(ctx, NOW);
    // Có khoá: B trả busy ngay. Thiếu khoá: B đọc cùng lô và hỏi lại rồi kẹt ở cổng; thả cổng sau 2 giây để test đỏ
    // (B không busy) thay vì treo.
    const fallback = setTimeout(open, 2_000);
    try {
      expect(await second).toBe('busy');
    } finally {
      clearTimeout(fallback);
      open();
      await first;
    }
    expect(asked.filter((code) => code === l.link.paymentCode)).toHaveLength(1);
    expect(await linkStatus(l.link.id)).toBe('expired');
  });

  it('phiên khác đang giữ khoá tra cứu → lượt này trả busy, không hỏi cổng, mã giữ active; nhả khoá thì lượt sau chạy', async () => {
    const l = await linkedOrder('zalopay');
    await overdue(l);
    const asked = fakeGateways({});
    const holder = await testPool().connect();
    try {
      await holder.query("select pg_advisory_lock(hashtextextended('payment.overdue_query', 0))");
      expect(await runOverdueQuery(ctx, NOW)).toBe('busy');
      expect(asked).toEqual([]);
      expect(await linkStatus(l.link.id)).toBe('active');
    } finally {
      await holder.query("select pg_advisory_unlock(hashtextextended('payment.overdue_query', 0))");
      holder.release();
    }
    await runOverdueQuery(ctx, NOW);
    expect(await linkStatus(l.link.id)).toBe('expired');
  });

  it('lượt ném lỗi vẫn nhả khoá: lượt sau chạy được', async () => {
    const l = await linkedOrder('zalopay');
    await overdue(l);
    // Lỗi của từng mã bị nuốt trong vòng lặp; lỗi lọt ra khỏi lượt là lỗi đọc danh sách mã. Gây nó bằng cách gọi lượt
    // trong `withCompany`: `findOverdueLinksAnyCompany` ném lỗi lập trình khi đứng trong giao dịch của một công ty.
    const { withCompany } = await import('#src/shared/db/client.ts');
    await expect(withCompany(l.companyId, () => runOverdueQuery(ctx, NOW))).rejects.toThrow('findOverdueLinksAnyCompany');
    fakeGateways({});
    expect(await runOverdueQuery(ctx, NOW)).toBeUndefined();
    expect(await linkStatus(l.link.id)).toBe('expired');
  });
});
