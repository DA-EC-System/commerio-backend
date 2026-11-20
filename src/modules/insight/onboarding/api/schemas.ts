import { z } from 'zod';
import { ONBOARDING_KEYS } from '../domain/items.ts';

export const OnboardingItem = z.object({
  key: z.enum(ONBOARDING_KEYS),
  done: z.boolean(),
  optional: z.boolean().describe('Mục tuỳ chọn: không tính vào `done`, `total`'),
  ref: z
    .object({ type: z.enum(['shop', 'stock_document']), id: z.string().uuid() })
    .nullable()
    .describe('Chứng từ để FE dẫn tới khi chưa xong: gian hàng chờ thiết lập, phiếu kiểm kê đầu kỳ chưa ghi sổ'),
});

export const OnboardingResponse = z.object({
  items: z.array(OnboardingItem),
  done: z.number().int().describe('Số mục bắt buộc đã xong'),
  total: z.number().int().describe('Số mục bắt buộc người xem thấy'),
});
