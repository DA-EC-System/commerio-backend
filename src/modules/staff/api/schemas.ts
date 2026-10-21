import { z } from 'zod';
import { INVITATION_STATUSES } from '../domain/invitation-machine.ts';

const version = z.number('Thiếu version').int().positive();

// Kiểm uuid ở cấp mảng để lỗi nằm ở `errors.roleIds`, không ở `roleIds.<i>` (Documents/21 C1).
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const roleIds = z
  .array(z.string(), 'Chọn ít nhất một vai trò')
  .min(1, 'Chọn ít nhất một vai trò')
  .max(20, 'Tối đa 20 vai trò')
  .refine((ids) => ids.every((id) => uuidPattern.test(id)), 'Có vai trò không tồn tại hoặc không thuộc công ty')
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .meta({ example: ['00000000-0000-4000-8000-000000000003'] });

export const StaffListQuery = z.object({
  search: z.string().trim().max(100, 'Tối đa 100 ký tự').optional(),
  status: z.enum(['active', 'locked']).optional(),
  roleId: z.uuid('Vai trò không hợp lệ').optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// `accountId` sai định dạng trả 404 ở service (như nhân viên không tồn tại), nên ở đây chỉ là chuỗi.
export const StaffParams = z.object({ accountId: z.string() });

export const ChangeRolesBody = z.object({ roleIds, version }).meta({ id: 'ChangeStaffRolesRequest' });

export const VersionBody = z.object({ version }).meta({ id: 'VersionRequest' });

// Schema trả về, chỉ dùng cho Swagger.
export const StaffMemberSchema = z
  .object({
    accountId: z.uuid(),
    email: z.string(),
    fullName: z.string(),
    roles: z.array(z.object({ id: z.uuid(), name: z.string() })),
    status: z.enum(['active', 'locked']),
    isCeo: z.boolean(),
    pendingFirstLogin: z.boolean().meta({ description: 'Tài khoản còn phải đổi mật khẩu' }),
    joinedAt: z.string().meta({ description: 'Lúc vào công ty (của membership)' }),
    version: z.number().int().meta({ description: 'Version của membership, gửi lại khi đổi vai trò, khoá, mở khoá' }),
  })
  .meta({ id: 'StaffMember' });

export const StaffPage = z
  .object({
    items: z.array(StaffMemberSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'StaffPage' });

// Lời mời bằng link (#7 [C], Documents/21 mục 3.1).
export const CreateInvitationBody = z.object({ roleIds }).meta({ id: 'CreateInvitationRequest' });

export const InvitationListQuery = z.object({
  status: z.enum(INVITATION_STATUSES, 'Trạng thái không hợp lệ').default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// `id` sai định dạng trả 404 ở service.
export const InvitationParams = z.object({ id: z.string() });

export const CreatedInvitationSchema = z
  .object({
    id: z.uuid(),
    link: z.string().meta({ description: '`<PUBLIC_WEB_URL>/tham-gia#<token>`, chỉ trả lần này; BE không lưu token' }),
    expiresAt: z.string(),
  })
  .meta({ id: 'CreatedInvitation' });

export const InvitationSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(INVITATION_STATUSES),
    expired: z.boolean().meta({ description: 'Suy ra từ expiresAt khi open, claimed' }),
    email: z.string().nullable(),
    fullName: z.string().nullable(),
    roles: z.array(z.object({ id: z.uuid(), name: z.string() })),
    outdated: z.boolean().meta({ description: 'Có vai trò đã bị xoá sau khi tạo link' }),
    existingAccount: z.boolean().meta({ description: 'Email đã có tài khoản lúc nộp; không lộ công ty nào' }),
    createdBy: z.object({ id: z.uuid(), fullName: z.string() }),
    createdAt: z.string(),
    expiresAt: z.string(),
    submittedAt: z.string().nullable(),
    decidedAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Invitation' });

export const InvitationPage = z
  .object({
    items: z.array(InvitationSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'InvitationPage' });

export const ApprovedInvitationSchema = z
  .object({ invitation: InvitationSchema, member: StaffMemberSchema })
  .meta({ id: 'ApprovedInvitation' });

export const RejectedInvitationSchema = z.object({ invitation: InvitationSchema }).meta({ id: 'RejectedInvitation' });
