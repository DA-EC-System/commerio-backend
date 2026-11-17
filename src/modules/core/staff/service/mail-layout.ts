// Khung HTML chung cho thư của luồng mời (#7 [C], Documents/21 mục 3.1). Thư HTML chỉ dùng thẻ và style nội tuyến đơn
// giản để Gmail, Outlook hiện được; thư nào cũng kèm bản chữ thô. Chuỗi người dùng gõ phải escape trước khi đưa vào.
import { escapeHtml } from '../../../../shared/mail/index.ts';

/** Họ tên, tên công ty do người dùng gõ: gộp xuống dòng thành khoảng trắng để không chen dòng lạ vào thư. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `oneLine` rồi escape HTML. */
export const safe = (text: string): string => escapeHtml(oneLine(text));

const font = "font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:15px;line-height:1.5";

/** Đoạn văn; `html` là HTML đã escape. */
export const paragraph = (html: string): string => `<p style="margin:0 0 16px">${html}</p>`;

/** Nút bấm dạng link; `href` là URL do server dựng (gốc `PUBLIC_WEB_URL`). */
export const button = (href: string, label: string): string =>
  `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#1d4ed8;color:#ffffff;` +
  `padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(label)}</a></p>`;

/** Bọc thân thư: tiêu đề, nội dung, chân thư. `bodyHtml` là HTML đã escape. */
export function layout(heading: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="vi"><head><meta charset="utf-8"></head>',
    `<body style="margin:0;padding:24px;background:#f3f4f6"><div style="max-width:560px;margin:0 auto;` +
      `background:#ffffff;border-radius:8px;padding:32px;${font}">`,
    `<h1 style="font-size:20px;margin:0 0 20px">${heading}</h1>`,
    bodyHtml,
    '<p style="margin:32px 0 0;color:#6b7280;font-size:13px">Commerio</p>',
    '</div></body></html>',
  ].join('');
}
