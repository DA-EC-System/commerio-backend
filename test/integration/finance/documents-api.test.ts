import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { issueInvoiceForOrder } from '#src/modules/finance/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember, createCompany } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { api, paidOrder } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Hoá đơn, phiếu thu chỉ đọc (Documents/21 §12.5 bốn dòng đầu, §12.8 InvoiceSummary, Invoice, Receipt; plan #27 AC-23,
// AC-24, AC-38, A15, A20). Hoá đơn lập bằng hàm #25 sẽ gọi khi xuất kho; phiếu thu sinh từ webhook thật (handler).

async function invoicedAndPaid() {
  const l = await paidOrder();
  // Phí vận chuyển 30.000 đ: tổng đơn 180.000, dòng hàng 150.000 (dựng tay cột của #24, A20).
  await testPool().query("update sales.orders set shipping_fee = 30000, total = 180000 where id = $1", [l.orderId]);
  const inv = await withCompany(l.companyId, () => issueInvoiceForOrder(l.orderId));
  return { ...l, invoiceId: inv.invoiceId };
}

describe('GET /finance/invoices', () => {
  it('danh sách InvoiceSummary; chi tiết có dòng hàng (SKU, tên, nhãn thuộc tính), shippingFee (AC-23, A15, A20)', async () => {
    const l = await invoicedAndPaid();
    const list = await api('get', '/invoices', l.ceo.token);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(list.body.items[0]).toEqual({
      id: l.invoiceId,
      number: 'HD-000001',
      order: { id: l.orderId, code: l.code, customerName: null },
      status: 'posted',
      issuedAt: expect.any(String),
      total: 180000,
      reversalOf: null,
      reversedBy: null,
      version: 1,
    });
    const detail = await api('get', `/invoices/${l.invoiceId}`, l.ceo.token);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ number: 'HD-000001', total: 180000, shippingFee: 30000, reversalReason: null });
    expect(detail.body.lines).toEqual([
      {
        variantId: l.variantId,
        sku: expect.any(String),
        productName: expect.any(String),
        attributesLabel: expect.any(String),
        quantity: 1,
        unitPrice: 150000,
        lineTotal: 150000,
      },
    ]);
  });

  it('lọc status, from/to theo issuedAt, search theo số hoá đơn và mã đơn', async () => {
    const l = await invoicedAndPaid();
    const t = l.ceo.token;
    expect((await api('get', '/invoices?status=reversed', t)).body.total).toBe(0);
    expect((await api('get', '/invoices?from=2000-01-01&to=2000-01-02', t)).body.total).toBe(0);
    expect((await api('get', '/invoices?search=hd-000001', t)).body.total).toBe(1);
    expect((await api('get', `/invoices?search=${l.code}`, t)).body.total).toBe(1);
    expect((await api('get', '/invoices?search=khongco', t)).body.total).toBe(0);
  });
});

describe('GET /finance/receipts', () => {
  it('phiếu thu từ webhook: source gateway, cổng, giao dịch; lọc theo source, orderId; chi tiết (AC-24)', async () => {
    const l = await invoicedAndPaid();
    const list = await api('get', `/receipts?orderId=${l.orderId}`, l.ceo.token);
    expect(list.body.items).toEqual([
      {
        id: expect.any(String),
        number: 'PT-000001',
        source: 'gateway',
        order: { id: l.orderId, code: l.code, customerName: null },
        amount: 150000,
        status: 'posted',
        postedAt: expect.any(String),
        gateway: 'vietqr',
        paymentTransactionId: expect.any(String),
        settlementLineId: null,
        unmatchedReceiptId: null,
        reversalOf: null,
        reversedBy: null,
        reversalReason: null,
        version: 1,
      },
    ]);
    expect((await api('get', '/receipts?source=cod', l.ceo.token)).body.total).toBe(0);
    const detail = await api('get', `/receipts/${list.body.items[0].id}`, l.ceo.token);
    expect(detail.body).toMatchObject({ number: 'PT-000001', gateway: 'vietqr' });
  });
});

describe('quyền và công ty (AC-38)', () => {
  it('401 không token; 403 Admin, Sale (không có finance.invoice.view); 404 chứng từ công ty khác, id lạ; 422 lọc sai', async () => {
    const l = await invoicedAndPaid();
    const other = await createCompany();
    const admin = await addMember(l.companyId, 'admin');
    expect((await api('get', '/invoices')).status).toBe(401);
    expect((await api('get', '/invoices', admin.token)).status).toBe(403);
    expect((await api('get', '/receipts', l.sale.token)).status).toBe(403);
    expect((await api('get', `/invoices/${l.invoiceId}`, other.ceo.token)).status).toBe(404);
    expect((await api('get', '/invoices', other.ceo.token)).body.total).toBe(0);
    expect((await api('get', `/receipts/${randomUUID()}`, l.ceo.token)).status).toBe(404);
    expect((await api('get', '/invoices/khong-phai-uuid', l.ceo.token)).status).toBe(404);
    const bad = await api('get', '/receipts?source=abc&pageSize=500', l.ceo.token);
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors)).toEqual(expect.arrayContaining(['source', 'pageSize']));
  });
});
