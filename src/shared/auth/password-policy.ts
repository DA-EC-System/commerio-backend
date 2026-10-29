import { z } from 'zod';

// Quy tắc mật khẩu mới (Documents/21 A5), khớp FE `src/features/auth/schemas.ts`. Dùng chung cho đăng ký,
// đổi mật khẩu (identity) và đặt mật khẩu khi tham gia qua link mời (staff, #7).
export const newPasswordSchema = z
  .string()
  .min(8, 'Mật khẩu tối thiểu 8 ký tự')
  .max(72, 'Mật khẩu tối đa 72 ký tự')
  .regex(/[A-Za-z]/, 'Mật khẩu cần có ít nhất một chữ cái')
  .regex(/\d/, 'Mật khẩu cần có ít nhất một chữ số');
