import { z } from 'zod';
import { FILE_PURPOSES } from '../domain/upload-rules.ts';

/**
 * Body của `POST /files/uploads` (Documents/21 §5.2, §14.3). Kiểu và cỡ theo `purpose` kiểm ở service, trả mã riêng
 * (`file_type_not_allowed`, `file_too_large`) thay vì `validation_failed`.
 */
export const UploadBody = z
  .object({
    fileName: z.string('Thiếu tên tệp').trim().min(1, 'Thiếu tên tệp').max(255, 'Tên tệp tối đa 255 ký tự'),
    contentType: z.string('Thiếu kiểu tệp').trim().min(1, 'Thiếu kiểu tệp').max(100, 'Kiểu tệp không hợp lệ'),
    sizeBytes: z.number('Thiếu cỡ tệp').int('Cỡ tệp phải là số nguyên').positive('Tệp rỗng'),
    purpose: z.enum(FILE_PURPOSES, 'Mục đích phải là product_image hoặc attachment'),
  })
  .meta({ id: 'UploadRequest' });

export const UploadTicketSchema = z
  .object({
    fileId: z.uuid(),
    uploadUrl: z.url().meta({ description: 'URL PUT ký sẵn, hết hạn sau 15 phút; không gắn token Commerio' }),
    headers: z
      .record(z.string(), z.string())
      .meta({ description: 'Gửi đúng các header này khi PUT (`Content-Type`, `Content-Length` đã ký)' }),
  })
  .meta({ id: 'UploadTicket' });
