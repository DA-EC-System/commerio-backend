import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildVietQr, crc16, parseVietQr } from '#src/modules/payment/domain/vietqr.ts';

// Chuỗi VietQR (EMVCo, NAPAS) cho mã chuyển khoản (#23 AC-22, ground-truth S11).
// Chuỗi thật do ZaloPay sandbox trả 18/10/2026 (S6): CRC 4E7B tính độc lập ở P3.
const ZALOPAY_QR =
  '00020101021226530010vn.zalopay01061800050203001031820546450197211305538620010A00000072701320006970454011899ZP26290O081165780208QRIBFTTA52047399530370454061500005802VN63044E7B';

describe('VietQR', () => {
  it('CRC16-CCITT khớp CRC của chuỗi VietQR thật', () => {
    expect(crc16(ZALOPAY_QR.slice(0, -4))).toBe('4E7B');
  });

  it('dựng chuỗi động có tài khoản, số tiền, nội dung = mã thanh toán và CRC đúng', () => {
    const qr = buildVietQr({ bankBin: '970422', accountNo: '0123456789', amount: new Decimal(150000), content: 'CMABCDEFGH23' });
    expect(qr).toMatch(/^000201010212/);
    expect(qr).toContain('0010A000000727');
    expect(qr).toContain('0208QRIBFTTA');
    expect(qr).toContain('5303704');
    expect(qr).toContain('5406150000');
    expect(qr).toContain('5802VN');
    expect(qr).toContain('62160812CMABCDEFGH23');
    expect(qr.slice(-8, -4)).toBe('6304');
    expect(crc16(qr.slice(0, -4))).toBe(qr.slice(-4));
  });

  it('giải lại được chuỗi đã dựng; chuỗi của ZaloPay giải ra BIN và số tài khoản', () => {
    const input = { bankBin: '970436', accountNo: '1234567890123', amount: new Decimal(50_000), content: 'CMZZZZZZZZ22' };
    expect(parseVietQr(buildVietQr(input))).toEqual({ ...input, amount: '50000' });
    expect(parseVietQr(ZALOPAY_QR)).toMatchObject({ bankBin: '970454', accountNo: '99ZP26290O08116578', amount: '150000' });
  });

  it('chuỗi không phải VietQR thì trả null', () => {
    expect(parseVietQr('https://test-payment.momo.vn/pay')).toBeNull();
  });
});
