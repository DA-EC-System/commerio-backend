import { z } from 'zod';
import { newPasswordSchema } from '../../../shared/auth/password-policy.ts';
import { OPTIONAL_MODULES } from '../../platform/index.ts';

// Quy tắc khớp FE `src/features/auth/schemas.ts` (Documents/21 A5, V14).
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Email không hợp lệ'))
  .meta({ example: 'ceo@congty.vn' });

export const newPassword = newPasswordSchema;

export const RegisterBody = z
  .object({
    company: z.object({
      name: z.string().trim().min(2, 'Nhập tên công ty').max(200, 'Tên tối đa 200 ký tự'),
      taxCode: z
        .string()
        .trim()
        .regex(/^\d{10}(-\d{3})?$/, 'Mã số thuế gồm 10 số, hoặc dạng 0123456789-001'),
    }),
    ceo: z.object({
      fullName: z.string().trim().min(2, 'Nhập họ tên').max(100, 'Họ tên tối đa 100 ký tự'),
      email,
      password: newPassword,
    }),
    optionalModules: z
      .array(z.enum(OPTIONAL_MODULES))
      .default([])
      .transform((list) => [...new Set(list)]),
    assistantDataConsent: z.boolean().default(false),
  })
  .refine((v) => !v.optionalModules.includes('assistant') || v.assistantDataConsent, {
    path: ['assistantDataConsent'],
    message: 'Cần đồng ý gửi dữ liệu tới OpenAI để bật Trợ lý AI',
  })
  .meta({ id: 'RegisterCompanyRequest' });

export const LoginBody = z
  .object({ email, password: z.string().min(1, 'Nhập mật khẩu').max(200) })
  .meta({ id: 'LoginRequest' });

export const SelectCompanyBody = z.object({ companyId: z.uuid('Mã công ty không hợp lệ') }).meta({ id: 'SelectCompanyRequest' });

export const ChangePasswordBody = z
  .object({ currentPassword: z.string().min(1, 'Nhập mật khẩu hiện tại').max(200), newPassword })
  .meta({ id: 'ChangePasswordRequest' });

// Schema trả về, chỉ dùng cho Swagger.
export const Account = z
  .object({
    id: z.uuid(),
    email: z.string(),
    fullName: z.string(),
    isPlatformAdmin: z.boolean(),
    mustChangePassword: z.boolean(),
  })
  .meta({ id: 'Account' });

export const Membership = z
  .object({
    companyId: z.uuid(),
    companyName: z.string(),
    companyStatus: z.enum(['active', 'locked']),
    status: z.enum(['active', 'locked']).meta({ description: 'Tài khoản bị khoá trong công ty này thì `locked`' }),
    roles: z.array(z.string()),
  })
  .meta({ id: 'Membership' });

export const CompanyContext = z
  .object({
    companyId: z.uuid(),
    companyName: z.string(),
    roles: z.array(z.string()),
    permissions: z.array(z.string()).meta({ description: 'Đã bỏ quyền của phân hệ chưa bật' }),
    enabledModules: z.array(z.string()),
  })
  .meta({ id: 'CompanyContext' });

export const LoginResponse = z
  .object({ accessToken: z.string(), account: Account, memberships: z.array(Membership) })
  .meta({ id: 'LoginResponse' });
export const MeResponse = z.object({ account: Account, memberships: z.array(Membership) }).meta({ id: 'MeResponse' });
export const SelectCompanyResponse = z
  .object({ accessToken: z.string(), context: CompanyContext })
  .meta({ id: 'SelectCompanyResponse' });
export const RefreshResponse = z.object({ accessToken: z.string() }).meta({ id: 'RefreshResponse' });
export const RegisterResponse = z
  .object({ companyId: z.uuid(), email: z.string() })
  .meta({ id: 'RegisterCompanyResponse' });
