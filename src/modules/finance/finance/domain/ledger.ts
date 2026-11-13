// Luật ghi sổ tiền theo đơn (#116; Documents/25 §10.1, §10.2, §10.4; Documents/21 §21.1). Thuần: nhận số của sự kiện
// và phiên bản cấu hình đang áp, trả các dòng cần ghi. Ghi gộp (T2): doanh thu theo giá bán, mỗi loại phí một dòng;
// số có dấu, vào dương, ra âm; làm tròn tới đồng. Dòng 0 đồng không ghi (CHECK `ledger_entries_amount`).
import { Decimal } from 'decimal.js';
import type { ConfigPayload } from './config-version.ts';

/** Khớp enum `finance.ledger_kind` (Documents/19 §3.5). */
export const LEDGER_KINDS = [
  'revenue',
  'platform_subsidy',
  'shipping_income',
  'shipping_cost',
  'fee_fixed',
  'fee_transaction',
  'fee_service',
  'fee_optional',
  'withholding_tax',
  'customer_refund',
  'return_fee',
  'lost_compensation',
  'penalty',
  'cogs',
  'cogs_reversal',
  'ads',
  'opex',
  'supplier_payment',
  'supplier_refund',
  'cod_collected',
  'adjustment',
  'withdrawal',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** Giá vốn không phải tiền mặt: không cộng vào thực nhận, chỉ vào lãi gộp. */
export const NON_CASH: ReadonlySet<LedgerKind> = new Set(['cogs', 'cogs_reversal']);
/** Không vào lãi: giá vốn tính riêng, rút tiền chỉ chuyển chỗ (ví sàn → ngân hàng). */
export const NOT_PROFIT: ReadonlySet<LedgerKind> = new Set([...NON_CASH, 'withdrawal']);
/**
 * Không vào lệch quyết toán của đơn: ngoài giá vốn, rút tiền, còn bồi thường kiện thất lạc (khoản sàn trả thêm khi
 * kiện mất, không có dòng ước tính để so; US-TI-08 dòng 4, #251).
 */
export const NOT_SETTLEMENT_DIFF: ReadonlySet<LedgerKind> = new Set([...NOT_PROFIT, 'lost_compensation']);

/**
 * Mỗi loại dòng là khoản của sàn (`shop`, gắn gian hàng) hay khoản ngoài sàn (`company`). Documents/25 §10.1, "Khoản
 * không gắn đơn": "Theo gian hàng: quảng cáo (nạp ví ads hoặc trừ vào số dư), phí dịch vụ theo tháng, phạt không gắn
 * đơn. Ngoài sàn: Tiền trả NCC theo phiếu nhận (4.2); NCC hoàn tiền theo phiếu trả NCC (4.3). COD tự giao đã xác nhận
 * (8.3). Chi vận hành: lương, kho, bao bì." Thêm loại vào enum thì TypeScript buộc xếp loại ở đây. CHECK
 * `ledger_entries_shop_by_kind` (schema.ts) dựng từ bảng này.
 */
export const LEDGER_KIND_SCOPE: Readonly<Record<LedgerKind, 'shop' | 'company'>> = {
  revenue: 'shop',
  platform_subsidy: 'shop',
  shipping_income: 'shop',
  shipping_cost: 'shop',
  fee_fixed: 'shop',
  fee_transaction: 'shop',
  fee_service: 'shop',
  fee_optional: 'shop',
  withholding_tax: 'shop',
  customer_refund: 'shop',
  return_fee: 'shop',
  lost_compensation: 'shop',
  penalty: 'shop',
  cogs: 'shop',
  cogs_reversal: 'shop',
  ads: 'shop',
  opex: 'company',
  supplier_payment: 'company',
  supplier_refund: 'company',
  cod_collected: 'company',
  adjustment: 'shop',
  withdrawal: 'shop',
};
/** Khoản ngoài sàn: không vào tiền đang ở sàn hay số dư ví sàn (25 §10.3), không vào lãi bán hàng. */
export const OFF_PLATFORM: ReadonlySet<LedgerKind> = new Set(LEDGER_KINDS.filter((k) => LEDGER_KIND_SCOPE[k] === 'company'));
/**
 * Khoản ngoài sàn không bao giờ gắn gian hàng. COD tự giao thì có thể gắn: kiện tự giao của đơn sàn có gian hàng
 * (Documents/19, `packages.shop_id`).
 */
export const NEVER_SHOP: ReadonlySet<LedgerKind> = new Set(['supplier_payment', 'supplier_refund', 'opex']);
/**
 * Không vào lãi gộp (chạy thử cấu hình: "Lãi gộp ước tính của 30 ngày gần nhất nếu áp luật mới", Documents/25 §10.4):
 * khoản ngoài sàn; rút tiền ("`withdrawal` là chuyển từ ví sàn về ngân hàng, không vào lãi", 21 §21.1); quảng cáo
 * ("Lãi đóng góp = lãi gộp − quảng cáo", 25 §10.2). Giá vốn vẫn vào lãi gộp. Quảng cáo vẫn trừ vào số dư ví sàn
 * (`ledgerTotals` chỉ bỏ `OFF_PLATFORM`).
 */
export const NOT_SALES_PROFIT: ReadonlySet<LedgerKind> = new Set([...OFF_PLATFORM, 'withdrawal', 'ads']);

export interface Draft {
  kind: LedgerKind;
  /** Chuỗi thập phân hai chữ số, có dấu. */
  amount: string;
  configVersionId: string | null;
}

export interface Version<P> {
  id: string;
  payload: P;
}

export interface DeliveredLine {
  /** Null khi dòng kiện chưa ghép SKU lúc bàn giao. */
  variantId: string | null;
  quantity: number;
  /** Giá bán sau voucher shop. */
  unitPrice: string;
  /** Giá vốn lưu trên dòng kiện lúc bàn giao (25 §7.1); null khi dòng kiện không có giá vốn (21 §11.2, #229). */
  unitCost: string | null;
}

/** Có dòng không có giá vốn: lãi của đơn thiếu phần giá vốn đó (`costMissing`, 21 §21.1). */
export const costMissingOf = (lines: readonly { unitCost: string | null }[]) => lines.some((l) => l.unitCost === null);

/** Tổng giá vốn của các dòng có giá vốn; dòng null không tính (không thay bằng giá vốn bình quân, 21 §11.2). */
const costOf = <L extends { unitCost: string | null }>(lines: readonly L[], qty: (l: L) => number) =>
  lines.reduce((s, l) => (l.unitCost === null ? s : s.plus(new Decimal(l.unitCost).times(qty(l)))), new Decimal(0));

export interface DeliveredPackage {
  lines: readonly DeliveredLine[];
  platformSubsidy: string;
  shippingIncome: string;
  shippingCost: string;
}

export interface DeliveredConfigs {
  fee?: Version<ConfigPayload<'fee'>>;
  regime?: Version<ConfigPayload<'tax_regime'>>;
  rules?: Version<ConfigPayload<'tax_rules'>>;
}

const round = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

function push(out: Draft[], kind: LedgerKind, amount: Decimal, configVersionId: string | null = null) {
  const r = round(amount);
  if (!r.isZero()) out.push({ kind, amount: r.toFixed(2), configVersionId });
}

/**
 * Kiện giao xong (25 §10.1): doanh thu, trợ giá sàn, ship, bốn loại phí theo cấu hình phí của gian hàng, thuế sàn khấu
 * trừ (chỉ hộ kinh doanh, cá nhân: GTGT + TNCN theo quy tắc thuế), giá vốn. Chưa có cấu hình thì không ước tính khoản đó.
 */
export function postDelivered(pkg: DeliveredPackage, configs: DeliveredConfigs): Draft[] {
  const revenue = pkg.lines.reduce((s, l) => s.plus(new Decimal(l.unitPrice).times(l.quantity)), new Decimal(0));
  const cost = costOf(pkg.lines, (l) => l.quantity);
  const out: Draft[] = [];
  push(out, 'revenue', revenue);
  push(out, 'platform_subsidy', new Decimal(pkg.platformSubsidy));
  push(out, 'shipping_income', new Decimal(pkg.shippingIncome));
  push(out, 'shipping_cost', new Decimal(pkg.shippingCost).negated());
  const fee = configs.fee;
  if (fee) {
    const pct = (p: number) => revenue.times(p).div(100).negated();
    push(out, 'fee_fixed', pct(fee.payload.fixedPct), fee.id);
    push(out, 'fee_transaction', pct(fee.payload.transactionPct), fee.id);
    push(out, 'fee_service', pct(fee.payload.servicePct), fee.id);
    push(out, 'fee_optional', pct(fee.payload.optionalPct), fee.id);
  }
  const { regime, rules } = configs;
  if (regime && regime.payload.regime !== 'company' && rules) {
    push(out, 'withholding_tax', revenue.times(rules.payload.vatPct + rules.payload.pitPct).div(100).negated(), rules.id);
  }
  push(out, 'cogs', cost.negated());
  return out;
}

/** Kiện hoàn về kho (không giao được): phí khi hoàn theo cấu hình phí của gian hàng. Không có doanh thu cho kiện này. */
export function postReturned(fee: Version<ConfigPayload<'fee'>> | undefined): Draft[] {
  const out: Draft[] = [];
  if (fee) push(out, 'return_fee', new Decimal(fee.payload.returnFee).negated(), fee.id);
  return out;
}

/** Tiền hoàn cho khách (refund_only được duyệt, hoặc đã nhận hàng trả). */
export function postRefund(refundAmount: string): Draft[] {
  const out: Draft[] = [];
  push(out, 'customer_refund', new Decimal(refundAmount).abs().negated());
  return out;
}

/**
 * Phiếu kiểm hàng về: phần bán lại được ghi giảm giá vốn của đơn; hỏng, xuất huỷ thì giá vốn vẫn tính (25 §10.1).
 * Dòng `unitCost` null (dòng kiện gốc không có giá vốn, chưa từng ghi `cogs`) không ghi giảm (21 §11.2, #229).
 */
export function postInspected(lines: readonly { resellable: number; unitCost: string | null }[]): Draft[] {
  const out: Draft[] = [];
  push(out, 'cogs_reversal', costOf(lines, (l) => l.resellable));
  return out;
}

/** NCC hoàn tiền phiếu trả: tiền vào, chờ khớp sao kê ngân hàng (25 §10.1, US-NH-14). */
export function postSupplierRefund(refundAmount: string): Draft[] {
  const out: Draft[] = [];
  push(out, 'supplier_refund', new Decimal(refundAmount).abs());
  return out;
}

export interface Entry {
  kind: LedgerKind;
  amount: string;
  isEstimate: boolean;
  /** Đã có dòng thực tế thay: không còn tính. */
  replaced: boolean;
}

/**
 * Lãi theo đơn (25 §10.2) trên các dòng còn hiệu lực: thực nhận = tổng dòng tiền mặt; giá vốn = giá vốn trừ phần trả
 * bán lại được; lãi gộp = thực nhận + giá vốn (giá vốn âm). `estimated` khi còn dòng tiền ước tính chưa có số thật
 * thay; dòng giá vốn lấy từ thẻ kho, sàn không quyết toán, nên không giữ nhãn Ước tính (US-TI-04 dòng 2, #231).
 */
export function profitOf(entries: readonly Entry[]): { net: number; cogs: number; gross: number; estimated: boolean } {
  const live = entries.filter((e) => !e.replaced);
  const sum = (pred: (e: Entry) => boolean) => live.filter(pred).reduce((s, e) => s.plus(e.amount), new Decimal(0));
  const net = sum((e) => !NON_CASH.has(e.kind));
  const cogs = sum((e) => NON_CASH.has(e.kind));
  return { net: net.toNumber(), cogs: cogs.toNumber(), gross: net.plus(cogs).toNumber(), estimated: live.some((e) => e.isEstimate && !NON_CASH.has(e.kind)) };
}

/** Cảnh báo luỹ kế doanh thu năm theo mốc của quy tắc thuế (25 §10.4): từ 90% mốc. */
export function taxWarnings(ytdRevenue: number, milestones: readonly number[]) {
  return milestones
    .filter((m) => ytdRevenue >= m * 0.9)
    .map((milestone) => ({ milestone, ytdRevenue, over: ytdRevenue >= milestone }));
}
