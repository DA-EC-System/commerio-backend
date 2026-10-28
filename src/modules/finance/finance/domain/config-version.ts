// Phiên bản cấu hình tiền (D4.4; Documents/21 §21.4, 25 §10 T5): phí sàn theo gian hàng, loại hình thuế, quy tắc thuế,
// ngưỡng lệch quyết toán, biên tối thiểu. Không cứng hoá mức phí, thuế suất: đổi bằng phiên bản có người thứ hai duyệt.
import { z } from 'zod';
import { defineMachine } from '../../../core/index.ts';

export const CONFIG_KINDS = ['fee', 'tax_regime', 'tax_rules', 'mismatch_threshold', 'min_margin'] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

export const CONFIG_STATUSES = ['draft', 'pending_approval', 'rejected', 'scheduled', 'active', 'expired', 'cancelled'] as const;
export type ConfigStatus = (typeof CONFIG_STATUSES)[number];

export type ConfigAction = 'submit' | 'request_changes' | 'approve' | 'reject' | 'cancel' | 'activate' | 'expire';
/** Thao tác người dùng gọi qua `POST /configs/:id/:action` (đường dẫn viết gạch ngang như mục 20). */
export const USER_ACTIONS = { submit: 'submit', 'request-changes': 'request_changes', approve: 'approve', reject: 'reject', cancel: 'cancel' } as const;

const pct = (label: string) =>
  z
    .number(`${label} là số phần trăm`)
    .min(0, `${label} từ 0 đến 100`)
    .max(100, `${label} từ 0 đến 100`)
    .multipleOf(0.01, `${label} tối đa hai chữ số thập phân`);
const vnd = (label: string) => z.number(`${label} là số đồng`).int(`${label} là số nguyên đồng`).min(0, `${label} không âm`);

/** Nội dung `payload` theo `kind` (§21.4). `tax_rules` chờ GVHD trả lời câu hỏi thuế (Documents/19 §7). */
export const PAYLOAD_SCHEMAS = {
  fee: z.strictObject({
    fixedPct: pct('Phí cố định'),
    transactionPct: pct('Phí giao dịch'),
    servicePct: pct('Phí dịch vụ'),
    optionalPct: pct('Phí tuỳ chọn'),
    returnFee: vnd('Phí hoàn hàng'),
  }),
  tax_regime: z.strictObject({ regime: z.enum(['company', 'household', 'individual'], 'Loại hình là company, household hoặc individual') }),
  tax_rules: z.strictObject({
    vatPct: pct('Thuế GTGT'),
    pitPct: pct('Thuế TNCN'),
    milestones: z.array(vnd('Mốc doanh thu')).max(5, 'Tối đa 5 mốc doanh thu'),
  }),
  mismatch_threshold: z.strictObject({ abs: vnd('Ngưỡng lệch'), pct: pct('Ngưỡng lệch theo phần trăm'), resolveLimit: vnd('Hạn mức tự chốt') }),
  min_margin: z.strictObject({ pct: pct('Biên tối thiểu') }),
} satisfies Record<ConfigKind, z.ZodType>;

export type ConfigPayload<K extends ConfigKind = ConfigKind> = z.infer<(typeof PAYLOAD_SCHEMAS)[K]>;

/** Kiểm `payload` theo `kind`; lỗi gắn dưới ô `payload` để FE hiện đúng chỗ. */
export function parsePayload(kind: ConfigKind, payload: unknown) {
  return PAYLOAD_SCHEMAS[kind].safeParse(payload);
}

/** Tổng phần trăm phí sàn trừ trên doanh thu, dùng cho chạy thử. */
export const feePctOf = (p: ConfigPayload<'fee'>) => p.fixedPct + p.transactionPct + p.servicePct + p.optionalPct;
/** Phần trăm thuế sàn khấu trừ (hộ kinh doanh, cá nhân). */
export const taxPctOf = (p: ConfigPayload<'tax_rules'>) => p.vatPct + p.pitPct;

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
  { from: 'active', to: 'expired', action: 'expire', label: 'Hết hiệu lực', system: true },
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
 * Phiên bản áp cho một ngày trong một ô (công ty, loại, gian hàng): bản `active` hoặc `expired` có khoảng ngày chứa
 * ngày đó. Bản đã bị một bản sửa lỗi đang dùng thay thế thì bỏ (bản sửa lỗi có thể cùng ngày hiệu lực).
 */
export function pickEffective<V extends DatedVersion>(versions: readonly V[], day: string): V | undefined {
  const applied = versions.filter((v) => v.status === 'active' || v.status === 'expired');
  const replaced = new Set(applied.map((v) => v.supersedesId).filter((id): id is string => !!id));
  return applied
    .filter((v) => !replaced.has(v.id) && v.effectiveFrom !== null && v.effectiveFrom <= day && (v.effectiveTo === null || v.effectiveTo >= day))
    .sort((a, b) => (a.effectiveFrom! < b.effectiveFrom! ? 1 : -1))[0];
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
