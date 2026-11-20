// Thư của đăng ký công ty (#459, Documents/21 mục 2.1): thư mã xác minh, và thư "email đã có tài khoản" (không mã).
import { escapeHtml, type MailMessage } from '../../../../shared/mail/index.ts';
import { REGISTRATION_OTP_TTL_SECONDS } from '../domain/registration.ts';

/** Tên người dùng gõ có thể chứa xuống dòng: gộp về một dòng để không chèn được dòng giả vào tiêu đề, thân thư. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

const WARNING = 'Nếu không phải bạn đăng ký, hãy bỏ qua thư này. Đừng đưa mã cho ai.';

function html(title: string, body: string): string {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px">`
    + `<h2 style="font-size:18px">${title}</h2>${body}<p style="color:#666">Commerio</p></body></html>`;
}

export function renderRegistrationOtpMail(input: {
  fullName: string;
  companyName: string;
  code: string;
}): Omit<MailMessage, 'to'> {
  const company = oneLine(input.companyName);
  const minutes = REGISTRATION_OTP_TTL_SECONDS / 60;
  return {
    subject: `Mã xác minh đăng ký ${company} trên Commerio`,
    text: [
      `Chào ${oneLine(input.fullName)},`,
      '',
      `Mã xác minh để đăng ký công ty ${company} trên Commerio là: ${input.code}`,
      '',
      `Mã hết hạn sau ${minutes} phút.`,
      WARNING,
      '',
      'Commerio',
    ].join('\n'),
    html: html(
      `Mã xác minh đăng ký ${escapeHtml(company)}`,
      `<p>Chào ${escapeHtml(oneLine(input.fullName))},</p>`
        + `<p>Mã xác minh để đăng ký công ty <strong>${escapeHtml(company)}</strong> trên Commerio là:</p>`
        + `<p style="font-size:32px;font-weight:bold;letter-spacing:8px">${escapeHtml(input.code)}</p>`
        + `<p>Mã hết hạn sau ${minutes} phút.</p><p>${WARNING}</p>`,
    ),
  };
}

export function renderAccountExistsMail(input: { loginUrl: string | null }): Omit<MailMessage, 'to'> {
  const login = input.loginUrl ? `Đăng nhập tại: ${input.loginUrl}` : 'Hãy đăng nhập bằng email này trên Commerio.';
  return {
    subject: 'Email này đã có tài khoản Commerio',
    text: [
      'Chào bạn,',
      '',
      'Có người vừa dùng email này để đăng ký công ty trên Commerio, nhưng email đã có tài khoản.',
      login,
      '',
      'Nếu không phải bạn đăng ký, hãy bỏ qua thư này.',
      '',
      'Commerio',
    ].join('\n'),
    html: html(
      'Email này đã có tài khoản Commerio',
      '<p>Chào bạn,</p><p>Có người vừa dùng email này để đăng ký công ty trên Commerio, nhưng email đã có tài khoản.</p>'
        + (input.loginUrl
          ? `<p><a href="${escapeHtml(input.loginUrl)}">Đăng nhập Commerio</a></p>`
          : '<p>Hãy đăng nhập bằng email này trên Commerio.</p>')
        + '<p>Nếu không phải bạn đăng ký, hãy bỏ qua thư này.</p>',
    ),
  };
}
