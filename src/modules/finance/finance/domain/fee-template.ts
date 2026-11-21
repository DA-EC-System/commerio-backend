// Biểu phí mẫu của nền tảng (Documents/21 §21.6): luật đầu vào. `payload` dùng đúng luật `fee` của cấu hình phí.
import { z } from 'zod';
import { PAYLOAD_SCHEMAS } from './config-version.ts';

const source = z.strictObject({
  title: z.string('Nhập tên trang').trim().min(1, 'Nhập tên trang').max(200, 'Tên trang tối đa 200 ký tự'),
  url: z.url('Đường dẫn không hợp lệ').max(1000, 'Đường dẫn tối đa 1000 ký tự'),
  updatedAt: z.iso.date('Ngày cập nhật dạng YYYY-MM-DD'),
});

const editable = {
  shopTypeLabel: z.string('Nhập tên loại shop').trim().min(1, 'Nhập tên loại shop').max(40, 'Tên loại shop tối đa 40 ký tự'),
  payload: PAYLOAD_SCHEMAS.fee,
  sources: z.array(source).max(20, 'Tối đa 20 nguồn'),
  effectiveFrom: z.iso.date('Ngày hiệu lực dạng YYYY-MM-DD'),
  note: z.string().trim().max(2000, 'Ghi chú tối đa 2000 ký tự').default(''),
};

export const FeeTemplateCreate = z.strictObject({
  platform: z.string('Chọn sàn').trim().min(1, 'Chọn sàn').max(30, 'Mã sàn tối đa 30 ký tự'),
  shopType: z.string('Nhập mã loại shop').regex(/^[a-z][a-z0-9_]{0,29}$/, 'Mã loại shop chỉ gồm a-z, 0-9, _, bắt đầu bằng chữ, tối đa 30 ký tự'),
  ...editable,
});
export type FeeTemplateCreate = z.infer<typeof FeeTemplateCreate>;

export const FeeTemplateUpdate = z.strictObject({
  ...editable,
  version: z.number('Thiếu version').int().positive(),
});
export type FeeTemplateUpdate = z.infer<typeof FeeTemplateUpdate>;

/** Lỗi Zod thành `errors` theo đường dẫn body (R6 của Documents/21 §1.1). */
export function issuesToErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const i of issues) errors[i.path.map(String).join('.') || 'body'] ??= i.message;
  return errors;
}
