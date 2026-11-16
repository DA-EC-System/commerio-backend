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

  it('không có link, cả bản chữ thô lẫn HTML', () => {
    const { subject, text, html } = renderOtpMail(input);
    expect(`${subject}\n${text}\n${html}`).not.toMatch(/https?:|www\.|<a /i);
  });

  it('bản HTML có mã, tên công ty; chuỗi người dùng gõ được escape', () => {
    const { html } = renderOtpMail({ ...input, fullName: '<script>x</script>', companyName: 'A & "B"' });
    expect(html).toContain('042195');
    expect(html).toContain('A &amp; &quot;B&quot;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
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
