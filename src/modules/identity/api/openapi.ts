import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../shared/http/openapi.ts';
import { registerAccessOpenApi } from '../../access/index.ts';
import { registerStaffOpenApi } from '../../staff/index.ts';
import {
  ChangePasswordBody,
  GoogleLoginBody,
  LoginBody,
  LoginResponse,
  MeResponse,
  RefreshResponse,
  RegisterBody,
  RegisterResponse,
  SelectCompanyBody,
  SelectCompanyResponse,
} from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];

export function registerIdentityOpenApi(registry: OpenAPIRegistry): void {
  registry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  registerAccessOpenApi(registry);
  registerStaffOpenApi(registry);

  registry.registerPath({
    method: 'post',
    path: '/register',
    summary: 'Đăng ký công ty, người đăng ký là CEO (UC-PI-01)',
    request: { body: json(RegisterBody) },
    responses: {
      201: { description: 'Đã tạo công ty', ...json(RegisterResponse) },
      409: problemResponse('`email_taken`: email đã có tài khoản'),
      422: problemResponse('`validation_failed`'),
      429: problemResponse('`too_many_requests`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/login',
    summary: 'Đăng nhập bằng mật khẩu (UC-PI-03)',
    description: 'Đặt cookie HttpOnly `commerio_refresh`. Access token chưa gắn công ty; gọi `select-company` để chọn.',
    request: { body: json(LoginBody) },
    responses: {
      200: { description: 'Đăng nhập được', ...json(LoginResponse) },
      401: problemResponse('`invalid_credentials`: sai email hoặc mật khẩu'),
      422: problemResponse('`validation_failed`'),
      429: problemResponse('`too_many_requests`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/google',
    summary: 'Đăng nhập bằng Google cho tài khoản đã có (UC-PI-03)',
    description:
      'Body là ID token lấy từ Google Identity Services. Tìm tài khoản theo `sub` đã liên kết, không có thì theo email ' +
      'đã xác minh (lần đầu thì liên kết). Không tạo tài khoản. Phản hồi và cookie như `/login`.',
    request: { body: json(GoogleLoginBody) },
    responses: {
      200: { description: 'Đăng nhập được', ...json(LoginResponse) },
      401: problemResponse(
        '`google_token_invalid`: chữ ký, `iss`, `aud`, hạn, email chưa xác minh; `google_account_not_found`: không có ' +
          'tài khoản, hoặc tài khoản đã gắn Google khác',
      ),
      422: problemResponse('`validation_failed`'),
      429: problemResponse('`too_many_requests`'),
      503: problemResponse('`google_unavailable`: không lấy được khoá của Google hoặc máy chủ chưa cấu hình Google'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/refresh',
    summary: 'Lấy access token mới bằng cookie refresh',
    description: 'Refresh token xoay vòng: mỗi lần gọi cấp cookie mới, cookie cũ hết hiệu lực.',
    responses: {
      200: { description: 'Access token mới', ...json(RefreshResponse) },
      401: problemResponse('`unauthorized`: thiếu, hết hạn hoặc đã thu hồi'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/logout',
    summary: 'Đăng xuất: thu hồi refresh token, xoá cookie',
    responses: { 204: { description: 'Đã đăng xuất' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/me',
    summary: 'Tài khoản đang đăng nhập và các công ty của tài khoản',
    security: bearer,
    responses: {
      200: { description: 'Tài khoản', ...json(MeResponse) },
      401: problemResponse('`unauthorized`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/select-company',
    summary: 'Chọn công ty làm việc, nhận access token gắn công ty',
    security: bearer,
    request: { body: json(SelectCompanyBody) },
    responses: {
      200: { description: 'Token và ngữ cảnh công ty', ...json(SelectCompanyResponse) },
      401: problemResponse('`unauthorized`'),
      403: problemResponse('`company_locked`, `account_locked`, `password_change_required`'),
      404: problemResponse('`not_found`: tài khoản không thuộc công ty này'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/change-password',
    summary: 'Đổi mật khẩu (UC-PI-04)',
    description:
      'Gọi được khi còn mật khẩu thư mời. Đổi xong mọi phiên khác bị đăng xuất; phản hồi đặt cookie `commerio_refresh` mới, ' +
      'gọi `refresh` bằng cookie đó để lấy token không còn cờ bắt đổi mật khẩu. Lỗi quá 5 lần trong 15 phút thì 429.',
    security: bearer,
    request: { body: json(ChangePasswordBody) },
    responses: {
      204: { description: 'Đã đổi mật khẩu, đặt cookie refresh mới' },
      401: problemResponse('`unauthorized`'),
      422: problemResponse('`validation_failed`: `errors.currentPassword` hoặc `errors.newPassword`'),
      429: problemResponse('`too_many_requests`: lỗi quá 5 lần trong 15 phút với tài khoản này'),
    },
  });
}
