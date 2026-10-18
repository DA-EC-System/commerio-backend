// Ánh xạ giao dịch bảng kê TikTok Shop (OAS `GET /finance/202501/statements/{id}/statement_transactions`) thành dòng
// đối soát (plan #30 A3, Thành duyệt 19/10). Sàn giả lập (#17) trả cùng khuôn nên dùng chung hàm này.
import { Decimal } from 'decimal.js';

/**
 * Dấu của sàn: số tiền sàn trả là số có dấu, cộng lại ra tiền về (`settlement = revenue + fee_tax + shipping +
 * adjustment`, phí âm = bị trừ). OAS tự mâu thuẫn ở điểm này (rủi ro R1, chưa đo được với sàn thật): nếu sàn thật
 * theo đúng chữ công thức OAS (`revenue − shipping − fee_tax − adjustment`) thì đổi hằng này thành 1, không sửa chỗ khác.
 */
const DEDUCTION_SIGN = -1;

export const FEE_KEYS = [
  'commission',
  'transactionFee',
  'infrastructureFee',
  'affiliate',
  'campaign',
  'tax',
  'other',
] as const;
export type FeeKey = (typeof FEE_KEYS)[number];
export type SettlementFees = Record<FeeKey, Decimal>;
export type SettlementLineKind = 'order' | 'adjustment' | 'reserve';

/** Ô phí của từng trường `fee_tax_breakdown.fee` (Documents/12 §7.3 mở rộng); trường không có ở đây vào `other`. */
const FEE_FIELD_KEY: Record<string, FeeKey> = {
  platform_commission_amount: 'commission',
  dynamic_commission_amount: 'commission',
  tsp_commission_amount: 'commission',
  referral_fee_amount: 'commission',
  fee_per_item_sold_amount: 'commission',
  transaction_fee_amount: 'transactionFee',
  credit_card_handling_fee_amount: 'transactionFee',
  seller_paylater_handling_fee_amount: 'transactionFee',
  vn_fix_infrastructure_fee: 'infrastructureFee',
  affiliate_commission_amount: 'affiliate',
  affiliate_ads_commission_amount: 'affiliate',
  affiliate_partner_commission_amount: 'affiliate',
  tap_shop_ads_commission: 'affiliate',
  external_affiliate_marketing_fee_amount: 'affiliate',
  cofunded_creator_bonus_amount: 'affiliate',
  sfp_service_fee_amount: 'campaign',
  flash_sales_service_fee_amount: 'campaign',
  voucher_xtra_service_fee_amount: 'campaign',
  bonus_cashback_service_fee_amount: 'campaign',
  live_specials_fee_amount: 'campaign',
  campaign_resource_fee: 'campaign',
  pre_order_service_fee_amount: 'campaign',
  cofunded_promotion_service_fee_amount: 'campaign',
  mall_service_fee_amount: 'campaign',
};

/** Trường chỉ để tham khảo: cộng vào sẽ đếm hai lần (số trước khấu trừ thuế TNCN). */
const IGNORED_FEE_FIELDS = new Set(['affiliate_commission_amount_before_pit']);

/** Phần của giao dịch OAS mà hàm này đọc; trường khác giữ nguyên trong `raw`. */
export interface TikTokTransaction {
  id?: string;
  type?: string;
  order_id?: string;
  adjustment_order_id?: string;
  associated_order_id?: string;
  revenue_amount?: string;
  revenue_breakdown?: Record<string, string | undefined>;
  shipping_cost_amount?: string;
  fee_tax_breakdown?: {
    fee?: Record<string, string | undefined>;
    tax?: Record<string, string | undefined>;
  };
  adjustment_amount?: string;
  reserve_amount?: string;
  settlement_amount?: string;
  [field: string]: unknown;
}

/** Dòng đối soát đã chuẩn hoá: phí, vận chuyển là chi phí (dương = sàn thu); `adjustment` dương = sàn trả thêm. */
export interface SettlementLineInput {
  kind: SettlementLineKind;
  externalTransactionId: string;
  externalOrderId: string | null;
  revenue: Decimal;
  fees: SettlementFees;
  shippingCost: Decimal;
  adjustment: Decimal;
  settlement: Decimal;
  /** Sàn đã hoàn tiền một phần hay toàn bộ đơn cho khách (T25). */
  hasRefund: boolean;
  raw: TikTokTransaction;
}

/** Giao dịch không đọc được; `field` là đường dẫn trường trong giao dịch. */
export class SettlementMappingError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'SettlementMappingError';
    this.field = field;
  }
}

const MONEY = /^-?\d+(\.\d+)?$/;

/** Tiền sàn trả dạng chuỗi; thiếu hoặc rỗng là 0 trừ khi bắt buộc. VND không có phần lẻ (Documents/21 T1). */
function money(value: unknown, field: string, required = false): Decimal {
  if (value === undefined || value === null || value === '') {
    if (required) throw new SettlementMappingError(field, `Thiếu ${field}`);
    return new Decimal(0);
  }
  if (typeof value !== 'string' || !MONEY.test(value)) {
    throw new SettlementMappingError(field, `${field} không phải số tiền`);
  }
  const amount = new Decimal(value);
  if (!amount.isInteger()) throw new SettlementMappingError(field, `${field} có phần lẻ đồng`);
  return amount;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new SettlementMappingError(field, `Thiếu ${field}`);
  return value;
}

const optionalText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Số có dấu của sàn → chi phí theo dấu kế toán. */
const cost = (signed: Decimal) => signed.times(DEDUCTION_SIGN);

function mapFees(breakdown: TikTokTransaction['fee_tax_breakdown']): SettlementFees {
  const fees = Object.fromEntries(FEE_KEYS.map((k) => [k, new Decimal(0)])) as SettlementFees;
  for (const [field, value] of Object.entries(breakdown?.fee ?? {})) {
    if (IGNORED_FEE_FIELDS.has(field)) continue;
    const key = FEE_FIELD_KEY[field] ?? 'other';
    fees[key] = fees[key].plus(cost(money(value, `fee_tax_breakdown.fee.${field}`)));
  }
  for (const [field, value] of Object.entries(breakdown?.tax ?? {})) {
    fees.tax = fees.tax.plus(cost(money(value, `fee_tax_breakdown.tax.${field}`)));
  }
  return fees;
}

/** Một giao dịch của bảng kê → dòng đối soát. Ném `SettlementMappingError` khi thiếu trường hay tiền sai. */
export function mapTikTokTransaction(tx: TikTokTransaction): SettlementLineInput {
  const externalTransactionId = text(tx.id, 'id');
  const type = text(tx.type, 'type');
  const kind: SettlementLineKind = type === 'ORDER' ? 'order' : type === 'RESERVE' ? 'reserve' : 'adjustment';
  const zero = new Decimal(0);

  if (kind === 'reserve') {
    // Giữ lại (âm) hoặc giải phóng (dương) tiền: cũng là khoản sàn trả thêm/bớt (OAS `reserve_amount`).
    const reserve = money(tx.reserve_amount, 'reserve_amount', true);
    return {
      kind,
      externalTransactionId,
      externalOrderId: optionalText(tx.associated_order_id),
      revenue: zero,
      fees: mapFees(undefined),
      shippingCost: zero,
      adjustment: reserve,
      settlement: reserve,
      hasRefund: false,
      raw: tx,
    };
  }

  const refund = money(
    tx.revenue_breakdown?.refund_subtotal_before_discount_amount,
    'revenue_breakdown.refund_subtotal_before_discount_amount',
  );
  return {
    kind,
    externalTransactionId,
    externalOrderId: kind === 'order' ? text(tx.order_id, 'order_id') : optionalText(tx.adjustment_order_id),
    revenue: money(tx.revenue_amount, 'revenue_amount'),
    fees: mapFees(tx.fee_tax_breakdown),
    shippingCost: cost(money(tx.shipping_cost_amount, 'shipping_cost_amount')),
    // Điều chỉnh có lợi cho người bán là dương, ngược dấu với chi phí.
    adjustment: cost(money(tx.adjustment_amount, 'adjustment_amount')).negated(),
    settlement: money(tx.settlement_amount, 'settlement_amount', true),
    hasRefund: kind === 'order' && !refund.isZero(),
    raw: tx,
  };
}
