// Phiên bản cấu hình tiền (D4.4; Documents/21 §21.4, 25 §10 T5): phí sàn theo gian hàng, loại hình thuế, quy tắc thuế,
// ngưỡng lệch quyết toán, biên tối thiểu. Không cứng hoá mức phí, thuế suất: đổi bằng phiên bản có người thứ hai duyệt.
import { z } from 'zod';
import { vnDateText } from '../../../../shared/vn-format.ts';
import { defineMachine } from '../../../core/index.ts';

export const CONFIG_KINDS = ['fee', 'tax_regime', 'tax_rules', 'mismatch_threshold', 'min_margin', 'account_map'] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

/** Tên loại cấu hình người dùng thấy (chép `CONFIG_KINDS` của FE `src/features/finance/lifecycleShared.ts`). */
const CONFIG_KIND_NAMES: Record<ConfigKind, string> = {
  fee: 'Phí sàn',
  tax_regime: 'Loại hình kinh doanh',
  tax_rules: 'Biểu thuế',
  mismatch_threshold: 'Ngưỡng chênh lệch đối soát',
  min_margin: 'Lãi tối thiểu trên giá vốn',
  account_map: 'Tài khoản kế toán',
};

/** Nhãn nhật ký: "Phí sàn <gian hàng> từ dd/MM/yyyy"; thiếu gian hàng hay ngày thì bỏ phần đó (#352). */
export function configLabel(kind: ConfigKind, shopName: string | null, effectiveFrom: string | null): string {
  return [CONFIG_KIND_NAMES[kind], shopName, effectiveFrom && `từ ${vnDateText(effectiveFrom)}`].filter(Boolean).join(' ');
}

/** Tên theo Documents/25 §10.4, 21 §21.4 (đổi `expired` → `superseded` ngày 02/11/2026, #230). */
export const CONFIG_STATUSES = ['draft', 'pending_approval', 'rejected', 'scheduled', 'active', 'superseded', 'cancelled'] as const;
export type ConfigStatus = (typeof CONFIG_STATUSES)[number];

export type ConfigAction = 'submit' | 'request_changes' | 'approve' | 'reject' | 'cancel' | 'activate' | 'supersede';
/** Thao tác người dùng gọi qua `POST /configs/:id/:action` (đường dẫn viết gạch ngang như mục 20). */
export const USER_ACTIONS = { submit: 'submit', 'request-changes': 'request_changes', approve: 'approve', reject: 'reject', cancel: 'cancel' } as const;

const pct = (label: string) =>
  z
    .number(`${label} là số phần trăm`)
    .min(0, `${label} từ 0 đến 100`)
    .max(100, `${label} từ 0 đến 100`)
    .multipleOf(0.01, `${label} tối đa hai chữ số thập phân`);
const DEFAULT_ROUND_STEP = 1000;
const vnd = (label: string) => z.number(`${label} là số đồng`).int(`${label} là số nguyên đồng`).min(0, `${label} không âm`);

/**
 * Vai trò tài khoản trong sổ xuất cho phần mềm kế toán (#232; Documents/25 §10.5). Số hiệu do công ty khai trong bản
 * `account_map`, không viết cứng: mỗi loại dòng sổ ghi Nợ/Có theo vai trò (`domain/misa-export.ts`).
 */
export const ACCOUNT_ROLES = [
  'platformReceivable',
  'customerReceivable',
  'revenue',
  'outputVat',
  'otherIncome',
  'sellingExpense',
  'adminExpense',
  'otherExpense',
  'withheldTax',
  'cogs',
  'inventory',
  'bank',
  'cash',
  'supplierPayable',
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export const ACCOUNT_ROLE_NAMES: Record<AccountRole, string> = {
  platformReceivable: 'Tài khoản phải thu sàn',
  customerReceivable: 'Tài khoản phải thu khách hàng',
  revenue: 'Tài khoản doanh thu bán hàng',
  outputVat: 'Tài khoản thuế GTGT đầu ra',
  otherIncome: 'Tài khoản thu nhập khác',
  sellingExpense: 'Tài khoản chi phí bán hàng',
  adminExpense: 'Tài khoản chi phí quản lý',
  otherExpense: 'Tài khoản chi phí khác',
  withheldTax: 'Tài khoản thuế bị khấu trừ',
  cogs: 'Tài khoản giá vốn',
  inventory: 'Tài khoản hàng hoá',
  bank: 'Tài khoản tiền gửi ngân hàng',
  cash: 'Tài khoản tiền mặt',
  supplierPayable: 'Tài khoản phải trả nhà cung cấp',
};
/** Số hiệu tài khoản chi tiết: 3–10 chữ số (MISA chỉ nhận tài khoản chi tiết đã có trong danh mục). */
const accountCode = (label: string) => z.string(`${label} là số hiệu tài khoản`).regex(/^[0-9]{3,10}$/, `${label} là 3–10 chữ số`);
/** Mã đối tượng của gian hàng trong phần mềm kế toán. */
const objectCode = z
  .string('Mã đối tượng là chuỗi')
  .regex(/^[A-Za-z0-9._-]{1,30}$/, 'Mã đối tượng 1–30 ký tự: chữ không dấu, số, dấu chấm, gạch ngang, gạch dưới');

/**
 * Nội dung `payload` theo `kind` (§21.4). `tax_rules`: `vatPct`, `pitPct` là thuế sàn khấu trừ của hộ kinh doanh, cá nhân
 * trên doanh thu; `outputVatPct` là thuế suất GTGT đầu ra của doanh nghiệp (giá bán đã gồm, 25 §10.2, E131). Số cụ thể
 * chờ GVHD trả lời câu hỏi thuế (Documents/19 §7).
 */
export const PAYLOAD_SCHEMAS = {
  fee: z.strictObject({
    fixedPct: pct('Phí hoa hồng'),
    transactionPct: pct('Phí thanh toán'),
    servicePct: pct('Phí dịch vụ'),
    optionalPct: pct('Phí tham gia chương trình'),
    returnFee: vnd('Phí khi hàng hoàn'),
    // Bộ lọc giá theo gian hàng (#225, 25 §6.2). Tuỳ chọn vì bản lưu trước #225 không có; đọc qua `feeRoundingOf`.
    perItemFee: vnd('Phí cố định mỗi món').optional(),
    roundStep: vnd('Bậc làm tròn giá').min(1, 'Bậc làm tròn giá ít nhất 1 đồng').optional(),
    roundEnding: vnd('Đuôi giá').optional(),
    // Hoa hồng theo category sàn (Documents/21 §21.4, Thành chốt 22/11/2026): áp cho category đó và category con, dòng
    // gần nhất thắng; không khớp thì `fixedPct`. Tuỳ chọn vì bản lưu trước đó không có.
    categoryRates: z
      .array(
        z.strictObject({
          externalCategoryId: z.string('Chọn category của sàn').trim().min(1, 'Chọn category của sàn').max(100, 'Mã category tối đa 100 ký tự'),
          path: z.string('Thiếu đường dẫn category').trim().min(1, 'Thiếu đường dẫn category').max(500, 'Đường dẫn category tối đa 500 ký tự'),
          fixedPct: pct('Hoa hồng theo danh mục'),
        }),
      )
      .max(500, 'Tối đa 500 danh mục')
      .superRefine((rates, ctx) => {
        const seen = new Set<string>();
        rates.forEach((r, i) => {
          if (seen.has(r.externalCategoryId)) ctx.addIssue({ code: 'custom', path: [i, 'externalCategoryId'], message: 'Category bị trùng' });
          seen.add(r.externalCategoryId);
        });
      })
      .optional(),
  }).refine((p) => (p.roundEnding ?? 0) < (p.roundStep ?? DEFAULT_ROUND_STEP), {
    path: ['roundEnding'],
    message: 'Đuôi giá phải nhỏ hơn bậc làm tròn',
  }),
  tax_regime: z.strictObject({ regime: z.enum(['company', 'household', 'individual'], 'Loại hình là company, household hoặc individual') }),
  tax_rules: z.strictObject({
    vatPct: pct('Thuế GTGT sàn khấu trừ'),
    pitPct: pct('Thuế TNCN sàn khấu trừ'),
    outputVatPct: pct('Thuế suất GTGT đầu ra'),
    milestones: z.array(vnd('Ngưỡng doanh thu năm')).max(5, 'Tối đa 5 ngưỡng doanh thu năm'),
  }),
  mismatch_threshold: z.strictObject({ abs: vnd('Ngưỡng chênh lệch đối soát'), pct: pct('Ngưỡng chênh lệch đối soát theo phần trăm'), resolveLimit: vnd('Hạn mức tự xử lý chênh lệch') }),
  min_margin: z.strictObject({ pct: pct('Lãi tối thiểu trên giá vốn') }),
  account_map: z.strictObject({
    accounts: z.strictObject(
      Object.fromEntries(ACCOUNT_ROLES.map((r) => [r, accountCode(ACCOUNT_ROLE_NAMES[r])])) as Record<AccountRole, ReturnType<typeof accountCode>>,
    ),
    shopObjects: z
      .record(z.uuid('Gian hàng không hợp lệ'), objectCode)
      .refine((m) => Object.keys(m).length <= 200, 'Tối đa 200 gian hàng')
      .optional(),
  }),
} satisfies Record<ConfigKind, z.ZodType>;

export type ConfigPayload<K extends ConfigKind = ConfigKind> = z.infer<(typeof PAYLOAD_SCHEMAS)[K]>;

/** Kiểm `payload` theo `kind`; lỗi gắn dưới ô `payload` để FE hiện đúng chỗ. */
export function parsePayload(kind: ConfigKind, payload: unknown) {
  return PAYLOAD_SCHEMAS[kind].safeParse(payload);
}

/** Phí mỗi món và cách làm tròn giá của bộ lọc giá (#225); bản phí không ghi thì 0 đồng, bậc 1.000, đuôi 0. */
export const feeRoundingOf = (p: ConfigPayload<'fee'>) => ({
  perItemFee: p.perItemFee ?? 0,
  roundStep: p.roundStep ?? DEFAULT_ROUND_STEP,
  roundEnding: p.roundEnding ?? 0,
});

/**
 * Hoa hồng của một SKU theo category sàn (Documents/21 §21.4): `pathIds` là chuỗi `externalId` từ gốc tới category của
 * SKU (`channel` `pathIdsOf`); dòng `categoryRates` của tổ tiên sâu nhất thắng. Không có category hoặc không khớp dòng
 * nào thì `fixedPct` mặc định của gian hàng.
 */
export function fixedPctFor(p: ConfigPayload<'fee'>, pathIds?: readonly string[] | null): number {
  const rates = p.categoryRates;
  if (!rates?.length || !pathIds?.length) return p.fixedPct;
  const byId = new Map(rates.map((r) => [r.externalCategoryId, r.fixedPct]));
  for (let i = pathIds.length - 1; i >= 0; i--) {
    const pct = byId.get(pathIds[i]!);
    if (pct !== undefined) return pct;
  }
  return p.fixedPct;
}

/** Tổng phần trăm phí sàn trừ trên doanh thu. `pathIds` của SKU (hoa hồng theo category); bỏ trống là tỷ lệ mặc định (chạy thử). */
export const feePctOf = (p: ConfigPayload<'fee'>, pathIds?: readonly string[] | null) =>
  fixedPctFor(p, pathIds) + p.transactionPct + p.servicePct + p.optionalPct;
/** Phần trăm thuế sàn khấu trừ (hộ kinh doanh, cá nhân). */
export const taxPctOf = (p: ConfigPayload<'tax_rules'>) => p.vatPct + p.pitPct;

/**
 * Thuế suất GTGT đầu ra phải bỏ khỏi doanh thu khi tính lãi (25 §10.2: "doanh nghiệp: chia cho 1 + v để bỏ GTGT đầu
 * ra"): chỉ doanh nghiệp có quy tắc thuế; hộ kinh doanh, cá nhân, hay chưa có cấu hình thì 0.
 */
export const outputVatPctOf = (regime: ConfigPayload<'tax_regime'> | undefined, rules: ConfigPayload<'tax_rules'> | undefined) =>
  regime?.regime === 'company' && rules ? rules.outputVatPct : 0;

export interface ConfigRecord {
  createdBy: string | null;
  effectiveFrom: string | null;
  /** Ngày hôm nay theo giờ Việt Nam, `YYYY-MM-DD`. */
  today: string;
}

/** Huỷ chỉ trước ngày hiệu lực: bản đã tới ngày thì phải soạn bản mới thay. */
const beforeEffective = (r: ConfigRecord) => (r.effectiveFrom && r.effectiveFrom <= r.today ? 'config_already_effective' : null);

/** Bảng chuyển §21.4, khớp enum `finance.config_status`. Người duyệt khác người soạn; CEO tự duyệt được (25 §11). */
export const configMachine = defineMachine<ConfigStatus, ConfigAction, ConfigRecord>([
  { from: 'draft', to: 'pending_approval', action: 'submit', label: 'Gửi duyệt', permission: 'finance.config.manage' },
  {
    from: 'pending_approval',
    to: 'draft',
    action: 'request_changes',
    label: 'Trả về',
    permission: 'finance.config.approve',
    needsSecondPerson: true,
    needsReason: true,
  },
  {
    from: 'pending_approval',
    to: 'scheduled',
    action: 'approve',
    label: 'Duyệt',
    permission: 'finance.config.approve',
    needsSecondPerson: true,
    allowSelfApproval: true,
  },
  {
    from: 'pending_approval',
    to: 'rejected',
    action: 'reject',
    label: 'Từ chối',
    permission: 'finance.config.approve',
    needsSecondPerson: true,
    needsReason: true,
  },
  {
    from: ['draft', 'pending_approval', 'scheduled'],
    to: 'cancelled',
    action: 'cancel',
    label: 'Huỷ',
    permission: 'finance.config.manage',
    guard: beforeEffective,
  },
  { from: 'scheduled', to: 'active', action: 'activate', label: 'Áp dụng', system: true },
  { from: 'active', to: 'superseded', action: 'supersede', label: 'Hết hiệu lực', system: true },
]);

const DAY_MS = 86_400_000;

/** Ngày `YYYY-MM-DD` theo giờ Việt Nam (UTC+7, không đổi giờ mùa). */
export const vnDate = (at: Date) => new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** Cộng ngày cho chuỗi `YYYY-MM-DD`. */
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export interface DatedVersion {
  id: string;
  status: ConfigStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  supersedesId: string | null;
}

/**
 * Phiên bản áp cho một ngày trong một ô (công ty, loại, gian hàng): bản `active` hoặc `superseded` có khoảng ngày chứa
 * ngày đó. Bản đã bị một bản sửa lỗi đang dùng thay thế thì bỏ (bản sửa lỗi có thể cùng ngày hiệu lực).
 */
export function pickEffective<V extends DatedVersion>(versions: readonly V[], day: string): V | undefined {
  return appliedTimeline(versions).find((v) => v.effectiveFrom <= day && (v.effectiveTo === null || v.effectiveTo >= day));
}

/**
 * Các bản đã áp dụng của một ô (`active`, `superseded`, bỏ bản bị bản sửa lỗi thay), ngày hiệu lực mới trước: bản đầu
 * tiên chứa một ngày là bản áp cho ngày đó (`pickEffective`). Lãi theo đơn (#231) dựng mốc lãi tối thiểu theo ngày
 * giao từ danh sách này trong SQL.
 */
export function appliedTimeline<V extends DatedVersion>(versions: readonly V[]): (V & { effectiveFrom: string })[] {
  const applied = versions.filter((v) => v.status === 'active' || v.status === 'superseded');
  const replaced = new Set(applied.map((v) => v.supersedesId).filter((id): id is string => !!id));
  return applied
    .filter((v): v is V & { effectiveFrom: string } => !replaced.has(v.id) && v.effectiveFrom !== null)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
}

/**
 * Khi duyệt một bản vào ô đã có bản `scheduled`/`active`: bản đứng trước kết thúc ngay trước ngày hiệu lực của bản mới,
 * bản mới kết thúc ngay trước bản đứng sau. Ràng buộc `config_versions_no_overlap` của DB cấm hai khoảng chồng nhau.
 * Trùng ngày hiệu lực mà không phải bản sửa lỗi của bản đó: `overlap`.
 */
export function placeInTimeline<V extends DatedVersion>(
  live: readonly V[],
  incoming: { effectiveFrom: string; supersedesId: string | null },
): { overlap: true } | { overlap: false; predecessor?: V; effectiveTo: string | null } {
  const others = live.filter((v) => v.id !== incoming.supersedesId && v.effectiveFrom !== null);
  if (others.some((v) => v.effectiveFrom === incoming.effectiveFrom)) return { overlap: true };
  const before = others.filter((v) => v.effectiveFrom! < incoming.effectiveFrom).sort((a, b) => (a.effectiveFrom! < b.effectiveFrom! ? 1 : -1))[0];
  const after = others.filter((v) => v.effectiveFrom! > incoming.effectiveFrom).sort((a, b) => (a.effectiveFrom! > b.effectiveFrom! ? 1 : -1))[0];
  return { overlap: false, predecessor: before, effectiveTo: after ? addDays(after.effectiveFrom!, -1) : null };
}
