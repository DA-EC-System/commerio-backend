import { z } from 'zod';
import { ONBOARDING_KEYS } from '../domain/items.ts';

export const OnboardingItem = z.object({
  key: z.enum(ONBOARDING_KEYS),
  done: z.boolean(),
  optional: z.boolean().describe('Mục tuỳ chọn: không tính vào `done`, `total`'),
  ref: z
    .object({ type: z.enum(['shop', 'stock_document']), id: z.string().uuid() })
    .nullable()
    .describe('Chứng từ để FE dẫn tới khi chưa xong: gian hàng đang thiết lập, phiếu kiểm kê đầu kỳ chưa ghi sổ'),
});

export const OnboardingResponse = z.object({
  items: z.array(OnboardingItem),
  done: z.number().int().describe('Số mục bắt buộc đã xong'),
  total: z.number().int().describe('Số mục bắt buộc người xem thấy'),
  completedAt: z.iso.datetime().nullable().describe('Mốc hoàn tất onboarding của công ty; đặt một lần, không xoá'),
  next: z
    .object({
      key: z.enum(ONBOARDING_KEYS),
      mine: z.boolean().describe('Người gọi có quyền làm mục này (tồn đầu kỳ theo trạng thái phiếu)'),
    })
    .nullable()
    .describe('Mục bắt buộc chưa xong đầu tiên của công ty, không lọc theo quyền; null khi mọi mục bắt buộc đã xong'),
  mustWizard: z.boolean().describe('FE đưa mọi route công ty về /welcome'),
});

export const OnboardingCompleteResponse = z.object({ completedAt: z.iso.datetime() });
