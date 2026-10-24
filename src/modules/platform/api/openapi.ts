import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../shared/http/openapi.ts';
import { AccountParams } from './routes.ts';

/** Đường dẫn Swagger của module `platform`, viết tương đối với /api/v1/platform. */
export function registerPlatformOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/accounts/:accountId/2fa/reset',
    summary: 'Đặt lại xác thực hai lớp của một tài khoản',
    description:
      'Chỉ quản trị nền tảng. Xoá 2FA và mã khôi phục, thu hồi mọi refresh token; lần đăng nhập sau người đó phải ' +
      'thiết lập lại. Gọi lại vẫn 204. Admin, CEO công ty không gọi được vì một tài khoản dùng chung nhiều công ty.',
    security: [{ bearerAuth: [] }],
    request: { params: AccountParams },
    responses: {
      204: { description: 'Đã đặt lại' },
      401: problemResponse('`unauthorized`'),
      403: problemResponse('`forbidden`: không phải quản trị nền tảng; `two_factor_setup_required`'),
      404: problemResponse('`not_found`: không có tài khoản'),
    },
  });
}
