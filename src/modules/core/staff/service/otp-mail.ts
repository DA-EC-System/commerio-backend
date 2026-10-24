// Thư mã OTP cho người được mời (#7 [C], spec 6.8). Không có link: thư chỉ để chép mã vào trang đang mở.
import { OTP_TTL_SECONDS } from '../domain/otp.ts';

/** Họ tên, tên công ty do người dùng gõ: gộp xuống dòng thành khoảng trắng để không chen dòng lạ vào thư. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function renderOtpMail(input: { fullName: string; companyName: string; code: string }): {
  subject: string;
  text: string;
} {
  const company = oneLine(input.companyName);
  return {
    subject: `Mã xác minh tham gia ${company} trên Commerio`,
    text: [
      `Chào ${oneLine(input.fullName)},`,
      '',
      `Mã xác minh để tham gia ${company} trên Commerio là: ${input.code}`,
      '',
      `Mã hết hạn sau ${OTP_TTL_SECONDS / 60} phút và chỉ dùng được một lần. Không đưa mã này cho ai.`,
      'Nếu bạn không yêu cầu tham gia, hãy bỏ qua thư này.',
      '',
      'Commerio',
    ].join('\n'),
  };
}
