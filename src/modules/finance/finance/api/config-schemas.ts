import { z } from 'zod';
import { CONFIG_KINDS, CONFIG_STATUSES, USER_ACTIONS } from '../domain/config-version.ts';
import { page, VersionBody } from './schemas.ts';

// Hợp đồng /finance/configs (Documents/21 §21.4; #118). Ngày là `yyyy-mm-dd` theo giờ Việt Nam. `payload` kiểm theo
// `kind` ở service (domain/config-version.ts), lỗi trả dưới ô `payload.<trường>`.

const day = (label: string) => z.iso.date(`${label} dạng yyyy-mm-dd`);
const kind = z.enum(CONFIG_KINDS, 'Loại cấu hình là fee, tax_regime, tax_rules, mismatch_threshold hoặc min_margin');
const status = z.enum(CONFIG_STATUSES, 'Trạng thái không hợp lệ');
const payload = z.record(z.string(), z.unknown(), 'Nội dung cấu hình là một object');

export const ConfigListQuery = z.object({
  ...page,
  kind: kind.optional(),
  shopId: z.uuid('Gian hàng không hợp lệ').optional(),
  status: status.optional(),
});

export const CreateConfigBody = z
  .object({
    kind,
    shopId: z.uuid('Gian hàng không hợp lệ').optional(),
    payload,
    effectiveFrom: day('Ngày hiệu lực'),
    supersedesId: z.uuid('Bản bị sửa không hợp lệ').optional(),
    isCorrection: z.boolean('isCorrection là true hoặc false').optional(),
    retroactiveFrom: day('Ngày hồi tố').optional(),
  })
  .meta({ id: 'FinanceConfigCreateRequest' });

export const UpdateConfigBody = z
  .object({ version: VersionBody.shape.version, payload, effectiveFrom: day('Ngày hiệu lực') })
  .meta({ id: 'FinanceConfigUpdateRequest' });

export const ConfigActionParams = z.object({
  id: z.string(),
  action: z.enum(Object.keys(USER_ACTIONS) as [keyof typeof USER_ACTIONS], 'Thao tác không có'),
});

export const ConfigActionBody = z
  .object({ version: VersionBody.shape.version, reason: z.string().trim().max(500, 'Lý do tối đa 500 ký tự').optional() })
  .meta({ id: 'FinanceConfigActionRequest' });

const UserRef = z.object({ id: z.uuid(), name: z.string() });

const DryRun = z.object({
  at: z.iso.datetime(),
  rows: z.array(
    z.object({
      shopId: z.uuid(),
      shopName: z.string().nullable(),
      feePct: z.number().nullable(),
      taxPct: z.number().nullable(),
      listingsRepriced: z.int().nullable(),
      belowFloor: z.int().nullable(),
    }),
  ),
  profit30: z.object({ now: z.int(), next: z.int() }),
});

export const FinanceConfigSummary = z
  .object({
    id: z.uuid(),
    kind,
    shopId: z.uuid().nullable(),
    payload: z.record(z.string(), z.unknown()),
    effectiveFrom: z.iso.date().nullable(),
    effectiveTo: z.iso.date().nullable(),
    supersedesId: z.uuid().nullable(),
    isCorrection: z.boolean(),
    retroactiveFrom: z.iso.date().nullable(),
    status,
    statusReason: z.string().nullable(),
    createdBy: UserRef.nullable(),
    approvedBy: UserRef.nullable(),
    selfApproved: z.boolean(),
    dryRun: DryRun.nullable(),
    createdAt: z.iso.datetime(),
    version: z.int(),
  })
  .meta({ id: 'FinanceConfigSummary' });

const StatusChange = z.object({
  at: z.iso.datetime(),
  from: z.string().nullable(),
  to: z.string(),
  by: UserRef.nullable(),
  source: z.enum(['user', 'marketplace', 'system']),
  reason: z.string().nullable(),
});

export const FinanceConfig = FinanceConfigSummary.extend({ statusHistory: z.array(StatusChange) }).meta({ id: 'FinanceConfig' });

export const FinanceConfigPage = z
  .object({ items: z.array(FinanceConfigSummary), total: z.int(), page: z.int(), pageSize: z.int() })
  .meta({ id: 'FinanceConfigPage' });
