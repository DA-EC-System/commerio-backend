// Thư mã OTP cho người được mời (#7 [C], spec 6.8). Không có link: thư chỉ để chép mã vào trang đang mở.
import type { MailMessage } from '../../../../shared/mail/index.ts';
import { OTP_TTL_SECONDS } from '../domain/otp.ts';
import { layout, oneLine, paragraph, safe } from './mail-layout.ts';

export function renderOtpMail(input: { fullName: string; companyName: string; code: string }): Omit<MailMessage, 'to'> {
  const company = oneLine(input.companyName);
  const minutes = OTP_TTL_SECONDS / 60;
  return {
    subject: `Mã xác minh tham gia ${company} trên Commerio`,
    text: [
      `Chào ${oneLine(input.fullName)},`,
      '',
      `Mã xác minh để tham gia ${company} trên Commerio là: ${input.code}`,
      '',
      `Mã hết hạn sau ${minutes} phút và chỉ dùng được một lần. Không đưa mã này cho ai.`,
      'Nếu bạn không yêu cầu tham gia, hãy bỏ qua thư này.',
      '',
      'Commerio',
    ].join('\n'),
    html: layout(
      `Mã xác minh tham gia ${safe(company)}`,
      [
        paragraph(`Chào ${safe(input.fullName)},`),
        paragraph(`Mã xác minh để tham gia <strong>${safe(company)}</strong> trên Commerio là:`),
        // Mã chỉ gồm chữ số do server sinh, vẫn escape cho chắc.
        `<p style="margin:0 0 16px;font-size:32px;font-weight:bold;letter-spacing:8px">${safe(input.code)}</p>`,
        paragraph(`Mã hết hạn sau ${minutes} phút và chỉ dùng được một lần. Không đưa mã này cho ai.`),
        paragraph('Nếu bạn không yêu cầu tham gia, hãy bỏ qua thư này.'),
      ].join(''),
    ),
  };
}
