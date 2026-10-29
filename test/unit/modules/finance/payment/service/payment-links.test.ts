import { describe, expect, it } from 'vitest';
import { paymentReturnUrl } from '#src/modules/finance/payment/service/payment-links.ts';

// Trang quay về sau khi khách trả tiền ở cổng: trang của FE (`PUBLIC_WEB_URL`), không phải của API.
describe('paymentReturnUrl', () => {
  it('có PUBLIC_WEB_URL: trang kết quả trên tên miền FE, bỏ dấu / thừa', () => {
    expect(paymentReturnUrl('https://app.commerio.test/', 'https://api.commerio.test/base')).toBe(
      'https://app.commerio.test/thanh-toan/ket-qua',
    );
  });

  it('chưa đặt PUBLIC_WEB_URL: giữ hành vi cũ, gốc của API', () => {
    expect(paymentReturnUrl(undefined, 'https://api.commerio.test/base')).toBe('https://api.commerio.test/thanh-toan/ket-qua');
  });
});
