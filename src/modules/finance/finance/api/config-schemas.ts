import { z } from 'zod';
import { CONFIG_KINDS, CONFIG_STATUSES, USER_ACTIONS } from '../domain/config-version.ts';
import { page, VersionBody } from './schemas.ts';
import { StatusChangeSchema } from '../../../../shared/http/status-change.ts';

// Hợp đồng /finance/configs (Documents/21 §21.4; #118). Ngày là `yyyy-mm-dd` theo giờ Việt Nam. `payload` kiểm theo
// `kind` ở service (domain/config-version.ts), lỗi trả dưới ô `payload.<trường>`.

const day = (label: string) => z.iso.date(`${label} dạng yyyy-mm-dd`);
const kind = z.enum(CONFIG_KINDS, 'Loại cấu hình là fee, tax_regime, tax_rules, mismatch_threshold hoặc min_margin');
const status = z.enum(CONFIG_STATUSES, 'Trạng thái không hợp lệ');
const payload = z.record(z.string(), z.unknown(), 'Nội dung cấu hình là một object').meta({
  description:
    'Theo `kind` (§21.4): `fee` `{ fixedPct, transactionPct, servicePct, optionalPct, returnFee, perItemFee?, roundStep?, roundEnding? }` ' +
    '(ba trường sau cho bộ lọc giá #225: phí mỗi món, bậc và đuôi làm tròn giá, mặc định 0, 1000, 0; đuôi nhỏ hơn bậc); `tax_regime` ' +
    "`{ regime: 'company' | 'household' | 'individual' }`; `tax_rules` `{ vatPct, pitPct, outputVatPct, milestones }` " +
    '(`vatPct`, `pitPct`: thuế sàn khấu trừ của hộ kinh doanh, cá nhân trên doanh thu; `outputVatPct`: thuế suất GTGT ' +
    'đầu ra của doanh nghiệp, doanh thu trong lãi = giá bán / (1 + outputVatPct/100)); `mismatch_threshold` ' +
    '`{ abs, pct, resolveLimit }`; `min_margin` `{ pct }`. Phần trăm 0–100, tối đa hai chữ số thập phân; số đồng nguyên không âm.',
});

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
    templateId: z.uuid('Biểu phí mẫu không hợp lệ').optional().meta({
      description: 'Biểu phí mẫu đã chọn (chỉ `kind = fee`, Documents/21 §21.6): chỉ để ghi `sourceTemplate`, `payload` vẫn bắt buộc',
    }),
  })
  .meta({ id: 'FinanceConfigCreateRequest' });

export const FeeTemplateQuery = z.object({
  platform: z.string().trim().min(1).max(30).optional().meta({ description: 'Lọc theo mã sàn' }),
});

/** Biểu phí mẫu của nền tảng (Documents/21 §21.6). */
export const FeeTemplate = z
  .object({
    id: z.uuid(),
    platform: z.string(),
    shopType: z.string(),
    shopTypeLabel: z.string(),
    payload: z.record(z.string(), z.unknown()).meta({ description: 'Cùng hình dạng `payload` của `fee` (§21.4)' }),
    sources: z.array(z.object({ title: z.string(), url: z.string(), updatedAt: z.iso.date() })),
    effectiveFrom: z.iso.date(),
    note: z.string(),
    version: z.int(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'FeeTemplate' });
export const FeeTemplateList = z.object({ items: z.array(FeeTemplate) }).meta({ id: 'FeeTemplateList' });

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
    sourceTemplate: z
      .object({ id: z.uuid(), platform: z.string(), shopType: z.string(), version: z.int() })
      .nullable()
      .meta({ description: 'Biểu phí mẫu đã dùng khi soạn (Documents/21 §21.6); null khi soạn tay hay mẫu đã bị xoá' }),
    templateOutdated: z.boolean().meta({ description: 'Bản `active` dựng từ mẫu mà mẫu đã đổi sau đó: nhắc xem lại' }),
    createdAt: z.iso.datetime(),
    version: z.int(),
  })
  .meta({ id: 'FinanceConfigSummary' });

export const FinanceConfig = FinanceConfigSummary.extend({ statusHistory: z.array(StatusChangeSchema) }).meta({ id: 'FinanceConfig' });

export const FinanceConfigPage = z
  .object({ items: z.array(FinanceConfigSummary), total: z.int(), page: z.int(), pageSize: z.int() })
  .meta({ id: 'FinanceConfigPage' });
