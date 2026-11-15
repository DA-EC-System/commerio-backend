// Thư của luồng mời sau bước nộp (Documents/21 mục 3.1): báo người duyệt có yêu cầu chờ, báo người đăng ký kết quả.
import type { MailMessage } from '../../../../shared/mail/index.ts';
import { button, layout, oneLine, paragraph, safe } from './mail-layout.ts';

type Rendered = Omit<MailMessage, 'to'>;

/** Gửi người có quyền `identity.account.manage`: có người vừa nộp yêu cầu tham gia qua link. */
export function renderSubmittedMail(input: {
  companyName: string;
  fullName: string;
  email: string;
  roleNames: readonly string[];
  queueLink: string;
}): Rendered {
  const company = oneLine(input.companyName);
  const roles = input.roleNames.map(oneLine).join(', ');
  return {
    subject: `Có yêu cầu tham gia ${company} chờ duyệt`,
    text: [
      'Chào bạn,',
      '',
      `${oneLine(input.fullName)} (${input.email}) vừa nộp yêu cầu tham gia ${company} qua link mời.`,
      `Vai trò của link: ${roles}.`,
      '',
      `Duyệt hoặc từ chối tại: ${input.queueLink}`,
      'Chưa duyệt thì người này chưa vào được công ty.',
      '',
      'Commerio',
    ].join('\n'),
    html: layout(
      `Có yêu cầu tham gia ${safe(company)} chờ duyệt`,
      [
        paragraph('Chào bạn,'),
        paragraph(
          `<strong>${safe(input.fullName)}</strong> (${safe(input.email)}) vừa nộp yêu cầu tham gia ` +
            `<strong>${safe(company)}</strong> qua link mời.`,
        ),
        paragraph(`Vai trò của link: ${input.roleNames.map(safe).join(', ')}.`),
        button(input.queueLink, 'Mở danh sách chờ duyệt'),
        paragraph('Chưa duyệt thì người này chưa vào được công ty.'),
      ].join(''),
    ),
  };
}

/** Gửi người đăng ký: yêu cầu đã được duyệt, đăng nhập bằng email nào và mật khẩu nào. */
export function renderApprovedMail(input: {
  companyName: string;
  fullName: string;
  email: string;
  existingAccount: boolean;
  loginLink: string;
}): Rendered {
  const company = oneLine(input.companyName);
  const password = input.existingAccount ? 'mật khẩu hiện có của tài khoản này' : 'mật khẩu bạn đã đặt khi đăng ký';
  return {
    subject: `Bạn đã được duyệt vào ${company} trên Commerio`,
    text: [
      `Chào ${oneLine(input.fullName)},`,
      '',
      `Yêu cầu tham gia ${company} của bạn đã được duyệt.`,
      `Đăng nhập bằng email ${input.email} và ${password} tại: ${input.loginLink}`,
      '',
      'Commerio',
    ].join('\n'),
    html: layout(
      `Bạn đã được duyệt vào ${safe(company)}`,
      [
        paragraph(`Chào ${safe(input.fullName)},`),
        paragraph(`Yêu cầu tham gia <strong>${safe(company)}</strong> của bạn đã được duyệt.`),
        paragraph(`Đăng nhập bằng email <strong>${safe(input.email)}</strong> và ${password}.`),
        button(input.loginLink, 'Đăng nhập Commerio'),
      ].join(''),
    ),
  };
}

/** Gửi người đăng ký: yêu cầu bị từ chối. Không nêu lý do, không lộ ai từ chối. */
export function renderRejectedMail(input: { companyName: string; fullName: string }): Rendered {
  const company = oneLine(input.companyName);
  return {
    subject: `Yêu cầu tham gia ${company} không được duyệt`,
    text: [
      `Chào ${oneLine(input.fullName)},`,
      '',
      `Yêu cầu tham gia ${company} trên Commerio của bạn không được duyệt.`,
      'Nếu bạn nghĩ đây là nhầm lẫn, hãy liên hệ người đã gửi link mời để được gửi link mới.',
      '',
      'Commerio',
    ].join('\n'),
    html: layout(
      `Yêu cầu tham gia ${safe(company)} không được duyệt`,
      [
        paragraph(`Chào ${safe(input.fullName)},`),
        paragraph(`Yêu cầu tham gia <strong>${safe(company)}</strong> trên Commerio của bạn không được duyệt.`),
        paragraph('Nếu bạn nghĩ đây là nhầm lẫn, hãy liên hệ người đã gửi link mời để được gửi link mới.'),
      ].join(''),
    ),
  };
}
