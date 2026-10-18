import { describe, expect, it } from 'vitest';
import { bankNameOf } from '#src/modules/payment/domain/banks.ts';
import { CredentialsByGateway } from '#src/modules/payment/api/schemas.ts';
import { GATEWAYS, isGateway, maskCredentials } from '#src/modules/payment/domain/gateways.ts';

// Ô khoá theo cổng, che khoá, tên ngân hàng (#23 AC-1, AC-3, AC-7; Documents/21 §12.8; plan A5).
describe('cổng và ô khoá', () => {
  it('bốn cổng theo đúng thứ tự trả về cho FE', () => {
    expect(GATEWAYS).toEqual(['vnpay', 'momo', 'zalopay', 'vietqr']);
  });

  it('ô khoá của từng cổng theo GatewayCredentialsInput', () => {
    const fields = Object.fromEntries(GATEWAYS.map((g) => [g, Object.keys(CredentialsByGateway[g].shape)]));
    expect(fields).toEqual({
      vnpay: ['tmnCode', 'hashSecret'],
      momo: ['partnerCode', 'accessKey', 'secretKey'],
      zalopay: ['appId', 'key1', 'key2'],
      vietqr: ['bankBin', 'accountNo', 'accountName', 'sepayApiKey'],
    });
  });

  it('chỉ nhận đúng 4 tên cổng', () => {
    expect(isGateway('momo')).toBe(true);
    expect(isGateway('paypal')).toBe(false);
  });

  it('che khoá: mỗi ô chỉ còn 4 ký tự cuối', () => {
    expect(maskCredentials({ tmnCode: 'ABCD1234', hashSecret: 'secret-9876' })).toEqual({
      tmnCode: { last4: '1234' },
      hashSecret: { last4: '9876' },
    });
  });

  it('tên ngân hàng theo BIN; BIN lạ trả chính BIN', () => {
    expect(bankNameOf('970422')).toBe('MB Bank');
    expect(bankNameOf('970436')).toBe('Vietcombank');
    expect(bankNameOf('999999')).toBe('999999');
  });
});
