import { z } from 'zod';
import { vnDayParam } from '../../../../shared/http/vn-day.ts';

// Khối dùng chung của các schema /finance (Documents/21 mục 21). Schema tiền cũ (mục 12 cũ) đã gỡ ở #235.

export const page = {
  page: z.coerce.number('Trang là số nguyên từ 1').int('Trang là số nguyên từ 1').min(1, 'Trang là số nguyên từ 1').default(1),
  pageSize: z.coerce
    .number('Cỡ trang từ 1 đến 100')
    .int('Cỡ trang từ 1 đến 100')
    .min(1, 'Cỡ trang từ 1 đến 100')
    .max(100, 'Cỡ trang từ 1 đến 100')
    .default(20),
  search: z.string().trim().max(100, 'Từ khoá tối đa 100 ký tự').optional(),
};

export const range = { from: vnDayParam('Từ ngày'), to: vnDayParam('Đến ngày', true) };

export const IdParams = z.object({ id: z.string() });

const version = z.number('Thiếu version').int('Thiếu version').min(0, 'Thiếu version');

export const VersionBody = z.object({ version }).meta({ id: 'FinanceVersionRequest' });

// — Response (Swagger)

export const OrderRef = z.object({ id: z.uuid(), code: z.string(), customerName: z.string().nullable() });
export const DocRef = z.object({ id: z.uuid(), number: z.string() });
export const pageOf = <T extends z.ZodType>(item: T, id: string) =>
  z.object({ items: z.array(item), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() }).meta({ id });
