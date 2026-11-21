// Gợi ý cấu hình phí của gian hàng từ phí thực tế của các đơn đã quyết toán (.claude/issues/luong-san-pham/tra-phi-san.md
// mục 5b, Thành chốt câu 1 ngày 21/11/2026): sàn không có API biểu phí, nên tỷ lệ suy từ quyết toán thật, CEO duyệt bằng
// luồng cấu hình phí sẵn có. Hàm thuần: nhận mẫu theo đơn (adapter sàn dựng, `feeSamples` của cổng quyết toán), trả số gợi
// ý theo dạng payload `fee` kèm độ phân tán. Route và hợp đồng chờ PR Documents gộp cấu hình phí.
import { Decimal } from 'decimal.js';
import type { LedgerKind } from './ledger.ts';

/** Loại phí có trong cấu hình phí (`fee` của `config_versions`) cộng thuế sàn khấu trừ (để tham khảo). */
export const SAMPLE_FEE_KINDS = ['fee_fixed', 'fee_transaction', 'fee_service', 'fee_optional', 'withholding_tax'] as const;
export type SampleFeeKind = (typeof SAMPLE_FEE_KINDS)[number];

/**
 * Phí của một đơn đã giao, không hoàn. Số là chuỗi thập phân, phí là số dương (độ lớn khoản sàn trừ).
 * `commissionBase`: cơ sở của hoa hồng, giá sau chiết khấu người bán (TikTok `subtotal_before_discount − seller_discount`;
 * Lazada dòng doanh thu). `transactionBase`: cơ sở của phí giao dịch nếu sàn tính khác (TikTok khách trả + chiết khấu nền
 * tảng); null thì dùng `commissionBase`. `estimated`: số ước tính của đơn chưa quyết toán (chỉ để gợi ý, không ghi sổ).
 */
export interface FeeSample {
  externalOrderId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  commissionBase: string;
  transactionBase: string | null;
  /** Số món của đơn; null là chưa biết (tính 1). */
  itemCount: number | null;
  fees: Partial<Record<SampleFeeKind, string>>;
  estimated: boolean;
}

/** Mặc định lấy 30 đơn gần nhất. */
export const DEFAULT_SAMPLE_SIZE = 30;
/** Tỷ lệ từng đơn lệch quá ngưỡng này (điểm %, p90 − p10) thì cảnh báo gian hàng bán nhiều ngành. */
export const SPREAD_WARNING_PCT = 1;

export interface Spread {
  /** Phân vị 10, 90 và lệch chuẩn của tỷ lệ từng đơn, điểm %, hai chữ số thập phân. */
  p10: number;
  p90: number;
  stdev: number;
}

export interface FeeSuggestion {
  sampleCount: number;
  estimatedCount: number;
  fixedPct: number;
  transactionPct: number;
  servicePct: number;
  optionalPct: number;
  /** Phí cố định mỗi món (đồng), từ phần cố định của `fee_service` mỗi đơn. */
  perItemFee: number;
  /** Thuế sàn khấu trừ trên cơ sở hoa hồng, để so với `tax_rules`; không thuộc cấu hình phí. */
  withholdingPct: number;
  spread: Record<'fee_fixed' | 'fee_transaction' | 'fee_optional', Spread>;
  warnings: string[];
}

const pct2 = (d: Decimal) => d.toDecimalPlaces(2).toNumber();

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function spreadOf(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / (values.length || 1);
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length || 1);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { p10: round(quantile(sorted, 0.1)), p90: round(quantile(sorted, 0.9)), stdev: round(Math.sqrt(variance)) };
}

const feeOf = (s: FeeSample, k: SampleFeeKind) => new Decimal(s.fees[k] ?? 0).abs();

/**
 * Gợi ý từ tối đa `n` mẫu mới nhất (theo `date`). Mỗi loại: `pct = Σ|phí| / Σ cơ sở × 100` trên cả lô (tổng, không trung
 * bình từng đơn, để đơn nhỏ không kéo lệch). Phí giao dịch dùng `transactionBase` khi có. `fee_service` gồm phần cố định
 * mỗi đơn (TikTok `vn_fix_infrastructure_fee` 3.000đ) và phần theo % (Mall): phần cố định = trung vị `fee_service` mỗi đơn,
 * `perItemFee` = phần đó chia số món trung bình; phần vượt trung vị tính thành `servicePct`. Không có mẫu hợp lệ thì null.
 */
export function suggestFeeConfig(samples: readonly FeeSample[], n = DEFAULT_SAMPLE_SIZE): FeeSuggestion | null {
  const usable = samples
    .filter((s) => new Decimal(s.commissionBase).gt(0))
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
    .slice(0, n);
  if (!usable.length) return null;

  const sum = (f: (s: FeeSample) => Decimal) => usable.reduce((acc, s) => acc.plus(f(s)), new Decimal(0));
  const commissionBase = sum((s) => new Decimal(s.commissionBase));
  const transactionBase = sum((s) => new Decimal(s.transactionBase ?? s.commissionBase));
  const pctOver = (fee: Decimal, base: Decimal) => (base.gt(0) ? fee.div(base).times(100) : new Decimal(0));

  const services = usable.map((s) => feeOf(s, 'fee_service').toNumber()).sort((a, b) => a - b);
  const fixedPerOrder = new Decimal(quantile(services, 0.5));
  const meanItems = usable.reduce((acc, s) => acc + (s.itemCount && s.itemCount > 0 ? s.itemCount : 1), 0) / usable.length;
  const serviceOverFixed = sum((s) => Decimal.max(feeOf(s, 'fee_service').minus(fixedPerOrder), 0));

  const perOrder = (k: 'fee_fixed' | 'fee_transaction' | 'fee_optional') =>
    usable.map((s) => {
      const base = new Decimal(k === 'fee_transaction' ? (s.transactionBase ?? s.commissionBase) : s.commissionBase);
      return pctOver(feeOf(s, k), base).toNumber();
    });
  const spread = { fee_fixed: spreadOf(perOrder('fee_fixed')), fee_transaction: spreadOf(perOrder('fee_transaction')), fee_optional: spreadOf(perOrder('fee_optional')) };

  const warnings: string[] = [];
  if (spread.fee_fixed.p90 - spread.fee_fixed.p10 > SPREAD_WARNING_PCT) {
    warnings.push('Tỷ lệ hoa hồng giữa các đơn lệch hơn 1 điểm %: gian hàng có thể bán nhiều ngành với mức phí khác nhau');
  }
  if (spread.fee_optional.p90 - spread.fee_optional.p10 > SPREAD_WARNING_PCT) {
    warnings.push('Phí tham gia chương trình chỉ có ở một phần đơn: tỷ lệ gợi ý là bình quân, đơn không tham gia sẽ lệch');
  }
  const estimatedCount = usable.filter((s) => s.estimated).length;
  if (estimatedCount) warnings.push(`${estimatedCount}/${usable.length} đơn là số ước tính của sàn (chưa quyết toán), có thể đổi`);
  if (usable.length < n) warnings.push(`Mới có ${usable.length} đơn, ít hơn ${n} đơn nên gợi ý chưa chắc`);

  return {
    sampleCount: usable.length,
    estimatedCount,
    fixedPct: pct2(pctOver(sum((s) => feeOf(s, 'fee_fixed')), commissionBase)),
    transactionPct: pct2(pctOver(sum((s) => feeOf(s, 'fee_transaction')), transactionBase)),
    servicePct: pct2(pctOver(serviceOverFixed, commissionBase)),
    optionalPct: pct2(pctOver(sum((s) => feeOf(s, 'fee_optional')), commissionBase)),
    perItemFee: fixedPerOrder.div(meanItems).toDecimalPlaces(0).toNumber(),
    withholdingPct: pct2(pctOver(sum((s) => feeOf(s, 'withholding_tax')), commissionBase)),
    spread,
    warnings,
  };
}

/**
 * Mẫu dựng từ các dòng quyết toán của sàn chỉ có dòng theo khoản (Lazada QueryTransactionDetails): gom theo đơn, cơ sở là
 * tổng dòng `revenue`, phí theo `kind`. Bỏ đơn có hoàn tiền (`customer_refund`) hoặc chưa có doanh thu. Sàn không trả cơ sở
 * riêng của phí giao dịch nên `transactionBase` null, số món chưa biết.
 */
export function feeSamplesFromLines(
  lines: readonly { externalOrderId: string | null; date: string; amount: string; kind: LedgerKind | null }[],
): FeeSample[] {
  const byOrder = new Map<string, { date: string; revenue: Decimal; refunded: boolean; fees: Map<SampleFeeKind, Decimal> }>();
  for (const l of lines) {
    if (!l.externalOrderId || !l.kind) continue;
    const o = byOrder.get(l.externalOrderId) ?? { date: l.date, revenue: new Decimal(0), refunded: false, fees: new Map() };
    if (l.date > o.date) o.date = l.date;
    if (l.kind === 'revenue') o.revenue = o.revenue.plus(l.amount);
    else if (l.kind === 'customer_refund') o.refunded = true;
    else if ((SAMPLE_FEE_KINDS as readonly string[]).includes(l.kind)) {
      const k = l.kind as SampleFeeKind;
      o.fees.set(k, (o.fees.get(k) ?? new Decimal(0)).plus(new Decimal(l.amount).abs()));
    }
    byOrder.set(l.externalOrderId, o);
  }
  return [...byOrder.entries()].flatMap(([externalOrderId, o]) =>
    o.refunded || o.revenue.lte(0)
      ? []
      : [
          {
            externalOrderId,
            date: o.date,
            commissionBase: o.revenue.toString(),
            transactionBase: null,
            itemCount: null,
            fees: Object.fromEntries([...o.fees].map(([k, v]) => [k, v.toString()])),
            estimated: false,
          },
        ],
  );
}
