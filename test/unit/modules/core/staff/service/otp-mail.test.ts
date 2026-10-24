import { describe, expect, it } from 'vitest';
import { renderOtpMail } from '#src/modules/core/staff/service/otp-mail.ts';

const input = { fullName: 'Trần Thị Mai', companyName: 'Công ty Hoa Sen', code: '042195' };

// Thư OTP của lời mời (#7 [C], spec 6.8): tiếng Việt, họ tên, tên công ty, mã, hạn 5 phút, không link.
describe('renderOtpMail', () => {
  it('có họ tên, tên công ty, mã và hạn 5 phút', () => {
    const { subject, text } = renderOtpMail(input);
    expect(subject).toContain('Công ty Hoa Sen');
    expect(text).toContain('Trần Thị Mai');
    expect(text).toContain('Công ty Hoa Sen');
    expect(text).toContain('042195');
    expect(text).toContain('hết hạn sau 5 phút');
  });

  it('không có link', () => {
    const { subject, text } = renderOtpMail(input);
    expect(`${subject}\n${text}`).not.toMatch(/https?:|www\./i);
  });

  it('xuống dòng trong họ tên, tên công ty bị gộp thành khoảng trắng', () => {
    const { subject, text } = renderOtpMail({
      ...input,
      fullName: 'Mai\r\nBcc: x@y.z',
      companyName: 'Hoa\nSen',
    });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain('Hoa Sen');
    expect(text).toContain('Mai Bcc: x@y.z');
  });
});
