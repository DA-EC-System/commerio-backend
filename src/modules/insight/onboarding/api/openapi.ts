import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { OnboardingCompleteResponse, OnboardingResponse } from './schemas.ts';

/** Đường dẫn Swagger của module `onboarding`, tương đối với /api/v1/onboarding (Documents/21 mục 23). */
export function registerOnboardingOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/',
    summary: 'Checklist thiết lập ban đầu của công ty, tính lại từ dữ liệu mỗi lần gọi',
    description:
      'Mọi thành viên gọi được; mỗi mục chỉ có khi người xem có quyền làm việc đó (quyền của phân hệ đang tắt không tính). `done`, `total` chỉ đếm mục bắt buộc.',
    responses: {
      200: { description: 'Các mục theo thứ tự cố định', content: { 'application/json': { schema: OnboardingResponse } } },
      401: problemResponse('Chưa đăng nhập'),
      403: problemResponse('Chưa chọn công ty, công ty hoặc tài khoản bị khoá'),
      404: problemResponse('Không thuộc công ty trong token'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/complete',
    summary: 'Hoàn tất onboarding: đặt mốc một lần khi mọi mục bắt buộc của công ty đã xong',
    description:
      'Quyền `platform.company.manage`. Tính lại mọi mục bắt buộc, không lọc theo quyền. Đã có mốc thì trả mốc cũ, không kiểm lại. Nhật ký `onboarding.completed` chỉ ghi ở lần đặt mốc.',
    responses: {
      200: { description: 'Mốc hoàn tất', content: { 'application/json': { schema: OnboardingCompleteResponse } } },
      401: problemResponse('Chưa đăng nhập'),
      403: problemResponse('Thiếu quyền, chưa chọn công ty, công ty hoặc tài khoản bị khoá'),
      409: problemResponse('`onboarding_incomplete` kèm `missing`: các key bắt buộc còn thiếu, theo thứ tự bảng'),
    },
  });
}
