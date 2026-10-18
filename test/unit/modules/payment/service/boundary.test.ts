import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  getDailyPaymentFees,
  getOrderPayments,
  markCodCollected,
  markCodNotCollected,
  markDelivered,
  markPaid,
  markRefunded,
  markRefundPending,
  recordGatewayTransaction,
  revertPaid,
  revertRefunded,
} from '#src/modules/payment/index.ts';

const notImplemented = { status: 501, code: 'not_implemented' };

// Khung của payment cho fulfillment (#25), finance (#27), báo cáo (#29) (AC-10, plan chuẩn bị 4.5, A8, A11, R2).
describe('khung payment', () => {
  it('hàm fulfillment gọi báo 501 not_implemented', async () => {
    await expect(markRefundPending('o1')).rejects.toMatchObject(notImplemented);
    await expect(markCodNotCollected('o1')).rejects.toMatchObject(notImplemented);
    await expect(markDelivered('o1', new Date())).rejects.toMatchObject(notImplemented);
  });

  it('hàm chỉ finance gọi báo 501 not_implemented', async () => {
    await expect(getOrderPayments(['o1'])).rejects.toMatchObject(notImplemented);
    await expect(markPaid('o1', { paymentTransactionId: null, paymentLinkId: null })).rejects.toMatchObject(
      notImplemented,
    );
    await expect(markCodCollected(['o1'])).rejects.toMatchObject(notImplemented);
    await expect(markRefunded('o1')).rejects.toMatchObject(notImplemented);
    await expect(revertPaid('o1')).rejects.toMatchObject(notImplemented);
    await expect(revertRefunded('o1')).rejects.toMatchObject(notImplemented);
    await expect(
      recordGatewayTransaction(
        {
          companyId: 'c1',
          gateway: 'vnpay',
          source: 'webhook',
          eventKey: 'e1',
          gatewayTxnId: 't1',
          paymentCode: null,
          paymentLinkId: null,
          orderId: null,
          amount: new Decimal(150000),
          succeeded: true,
          fee: null,
          occurredAt: new Date(),
          rawPayload: {},
        },
        'succeeded',
      ),
    ).rejects.toMatchObject(notImplemented);
  });

  it('hàm nguồn báo cáo báo 501 not_implemented', async () => {
    await expect(getDailyPaymentFees({ from: '2026-10-01', to: '2026-10-18' })).rejects.toMatchObject(notImplemented);
  });
});
