import { z } from 'zod';
import { vnDayParam } from '../../../../shared/http/vn-day.ts';

const AuditAction = z.enum(['create', 'update', 'delete']);

export const AuditLogQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  actorId: z.uuid('Người làm không hợp lệ').optional(),
  entityType: z.string().trim().min(1).max(100).optional(),
  action: AuditAction.optional(),
  from: vnDayParam('Từ ngày'),
  to: vnDayParam('Đến ngày', true),
});

export const AuditLogParams = z.object({ id: z.string() });

const AuditActor = z
  .object({
    accountId: z.string().meta({ description: 'Trống khi hệ thống làm' }),
    email: z.string(),
    fullName: z.string(),
  })
  .meta({ id: 'AuditActor' });

export const CompanyAuditLog = z
  .object({
    id: z.string(),
    action: AuditAction,
    entityType: z.string().meta({ description: '`<schema>.<bảng>`, vd `core.roles`' }),
    entityId: z.uuid().nullable(),
    entityLabel: z.string(),
    actor: AuditActor,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'CompanyAuditLog' });

export const CompanyAuditLogDetail = CompanyAuditLog.extend({
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
}).meta({ id: 'CompanyAuditLogDetail' });

export const CompanyAuditLogPage = z
  .object({ items: z.array(CompanyAuditLog), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .meta({ id: 'CompanyAuditLogPage' });
