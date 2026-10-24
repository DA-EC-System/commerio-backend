import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { gatewayBlockReason, orderBlockReason } from '#src/modules/finance/payment/domain/link-rules.ts';

// Luật được tạo mã (Documents/21 §12.9 payment_not_allowed; plan #23 A9, AC-16, AC-29).
const ok = { paymentMethod: 'prepaid', status: 'confirmed', paymentStatus: 'unpaid', total: new Decimal(150000) } as const;

describe('luật theo đơn', () => {
  it('đơn trả trước chưa thu, tổng nguyên đồng: tạo được (kể cả đơn đã giao)', () => {
    expect(orderBlockReason(ok)).toBeNull();
    expect(orderBlockReason({ ...ok, status: 'delivered' })).toBeNull();
  });

  it.each([
    ['đơn sàn', { paymentMethod: null }],
    ['đơn COD', { paymentMethod: 'cod' }],
    ['đơn đã thu', { paymentStatus: 'paid' }],
    ['đơn đã huỷ', { status: 'cancelled' }],
    ['tổng có phần lẻ đồng', { total: new Decimal('150000.50') }],
    ['tổng bằng 0', { total: new Decimal(0) }],
  ] as const)('%s: không tạo được', (_name, patch) => {
    expect(orderBlockReason({ ...ok, ...patch })).toEqual(expect.any(String));
  });
});

describe('luật theo cổng', () => {
  it('MoMo nhận tổng từ 1.000 đến 50.000.000 đồng, gồm hai đầu', () => {
    expect(gatewayBlockReason('momo', new Decimal(1000))).toBeNull();
    expect(gatewayBlockReason('momo', new Decimal(50_000_000))).toBeNull();
    expect(gatewayBlockReason('momo', new Decimal(999))).toEqual(expect.any(String));
    expect(gatewayBlockReason('momo', new Decimal(50_000_001))).toEqual(expect.any(String));
  });

  it('cổng khác không chặn theo số tiền', () => {
    expect(gatewayBlockReason('vietqr', new Decimal(60_000_000))).toBeNull();
    expect(gatewayBlockReason('zalopay', new Decimal(500))).toBeNull();
  });
});
