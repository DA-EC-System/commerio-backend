import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { UploadBody, UploadTicketSchema } from './schemas.ts';

/** Đường dẫn Swagger của module `files`, viết tương đối với /api/v1/files. */
export function registerFilesOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/uploads',
    summary: 'Xin vé tải tệp lên kho (URL PUT ký sẵn, 15 phút)',
    description:
      'Ghi thông tin tệp rồi trả URL ký sẵn; FE PUT thẳng tệp lên kho kèm `headers`, không gắn token Commerio. ' +
      '`product_image` (JPG, PNG, WebP, tối đa 5 MB) cần `catalog.product.manage`; `attachment` (thêm PDF, tối đa ' +
      '10 MB) mọi thành viên. Documents/21 §5.2, §14.3.',
    request: { body: { content: { 'application/json': { schema: UploadBody } } } },
    responses: {
      201: { description: 'Vé tải lên', content: { 'application/json': { schema: UploadTicketSchema } } },
      401: problemResponse('Chưa đăng nhập'),
      403: problemResponse(
        'Chưa chọn công ty, công ty hoặc tài khoản bị khoá; ảnh sản phẩm thiếu `catalog.product.manage` (`forbidden`) ' +
          'hoặc phân hệ tắt (`module_disabled`)',
      ),
      422: problemResponse('`file_type_not_allowed`, `file_too_large`, `validation_failed` (`errors` theo ô)'),
      503: problemResponse('`storage_unavailable`: máy chủ chưa cấu hình kho tệp'),
      507: problemResponse('`storage_quota_exceeded`: kho chạm trần dung lượng'),
    },
  });
}
