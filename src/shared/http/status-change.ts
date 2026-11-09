import { z } from 'zod';

/**
 * `StatusChange` của Documents/21 mục 14.1: một dòng `statusHistory` trong chi tiết bản ghi có máy trạng thái. Mọi
 * module dùng chung schema này để OpenAPI chỉ có một `StatusChange`.
 */
export const StatusChangeSchema = z
  .object({
    at: z.iso.datetime(),
    from: z.string().nullable(),
    to: z.string(),
    by: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    source: z.enum(['user', 'marketplace', 'system']),
    reason: z.string().nullable(),
    selfApproved: z.boolean().meta({ description: 'Bước người duyệt khác đi theo ngoại lệ tự duyệt: FE hiện nhãn "Tự duyệt"' }),
  })
  .strict()
  .meta({ id: 'StatusChange' });
