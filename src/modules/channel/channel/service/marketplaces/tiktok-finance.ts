// Quyết toán TikTok Shop cho cổng `settlementSource` (#117) và mẫu phí cho gợi ý cấu hình phí
// (.claude/issues/luong-san-pham/tra-phi-san.md, plan `tiktok-quyet-toan-plan.md` cùng thư mục, cố vấn chốt 21/11/2026).
// Nguồn: OAS của skill `tts-openapi-guide` (`references/oas/paths/finance.json`, tra 21/11/2026):
// - Get Statements 202309 `GET /finance/202309/statements`: `statement_time_ge`, `statement_time_lt` (Unix giây),
//   `sort_field` chỉ `statement_time`, `page_size` 1–100, `next_page_token`. Sao kê sinh mỗi ngày.
// - Get Transactions by Statement 202501 `GET /finance/202501/statements/{id}/statement_transactions`: `sort_field` chỉ
//   `order_create_time`, `page_size` 1–100. Mỗi giao dịch ứng với **một đơn** (`order_id`) hoặc một điều chỉnh
//   (`adjustment_id`, `adjustment_order_id`), mang cùng bộ `fee_tax_breakdown.fee.*`, `tax.*`, `revenue_breakdown`,
//   `shipping_cost_breakdown` như Get Transactions by Order 202501 (bản đó chia thêm theo SKU). Cổng `getTransactions`
//   nhận khoảng ngày, nên đi đường sao kê; đối chiếu với đơn của app bằng `order_id` (finance tìm đơn theo gian hàng +
//   mã đơn sàn, `externalOrderId`).
// - Get Unsettled Transactions 202507 `GET /finance/202507/orders/unsettled`: số **ước tính** của đơn chưa quyết toán
//   ("estimated amount which subject to change before settlement"), chỉ dùng cho mẫu gợi ý, không bao giờ vào sổ tiền.
// Sandbox không quyết toán (gọi thật 21/11/2026: sao kê rỗng, giao dịch toàn 0), nên dạng số đối chiếu bằng fixture OAS.
// Dấu: ví dụ OAS lẫn dấu (`platform_commission_amount: "20"` dương, `fee_tax_amount: "-30"` âm), nên phí, thuế khấu trừ,
// vận chuyển luôn ghi âm (`-|x|`) theo quy ước sổ tiền (vào dương, ra âm); doanh thu, điều chỉnh giữ dấu của sàn.
import { Decimal } from 'decimal.js';
import type { FeeSample, LedgerKind, SampleFeeKind } from '../../../../finance/index.ts';
import { INVALID_AMOUNT, type MarketplaceAdapter, MarketplaceError, type SettlementTxn } from './common.ts';
import type { TiktokClient } from './tiktok-client.ts';

type Row = Record<string, unknown>;

const STATEMENTS = '/finance/202309/statements';
const statementTransactions = (id: string) => `/finance/202501/statements/${encodeURIComponent(id)}/statement_transactions`;
const UNSETTLED = '/finance/202507/orders/unsettled';
const PAGE_SIZE = 100;
/** Giờ Việt Nam: cổng nhận ngày `YYYY-MM-DD` theo giờ VN (`vnDate` của finance). */
const VN_OFFSET = '+07:00';

/** Loại khoản sổ tiền của từng trường `fee_tax_breakdown.fee` (bảng ở plan, cố vấn chốt `mall_service_fee_amount` là % của shop Mall → `fee_service`). */
export const TIKTOK_FEE_KIND: Readonly<Record<string, LedgerKind>> = {
  platform_commission_amount: 'fee_fixed',
  dynamic_commission_amount: 'fee_fixed',
  transaction_fee_amount: 'fee_transaction',
  credit_card_handling_fee_amount: 'fee_transaction',
  seller_paylater_handling_fee_amount: 'fee_transaction',
  vn_fix_infrastructure_fee: 'fee_service',
  fee_per_item_sold_amount: 'fee_service',
  mall_service_fee_amount: 'fee_service',
  sfp_service_fee_amount: 'fee_optional',
  voucher_xtra_service_fee_amount: 'fee_optional',
  flash_sales_service_fee_amount: 'fee_optional',
  live_specials_fee_amount: 'fee_optional',
  pre_order_service_fee_amount: 'fee_optional',
  bonus_cashback_service_fee_amount: 'fee_optional',
  cofunded_promotion_service_fee_amount: 'fee_optional',
  campaign_resource_fee: 'fee_optional',
  shipping_fee_guarantee_service_fee: 'fee_optional',
  affiliate_commission_amount: 'fee_optional',
  affiliate_partner_commission_amount: 'fee_optional',
  affiliate_ads_commission_amount: 'fee_optional',
  tap_shop_ads_commission: 'fee_optional',
  tsp_commission_amount: 'fee_optional',
  external_affiliate_marketing_fee_amount: 'fee_optional',
  cofunded_creator_bonus_amount: 'fee_optional',
};

/** Trường chỉ để tham khảo: số trước khấu trừ TNCN của `affiliate_commission_amount`, cộng vào là đếm hai lần. */
const IGNORED_FEE_FIELDS = new Set(['affiliate_commission_amount_before_pit']);
/** Thuế sàn khấu trừ thay người bán VN (hộ kinh doanh, cá nhân; Luật 56/2024). */
const WITHHOLDING_FIELDS = ['local_vat_amount', 'pit_amount'] as const;

/** Loại khoản của giao dịch điều chỉnh theo `type` (OAS); loại khác `null`: finance ghi `adjustment` kèm tên. */
const ADJUSTMENT_KIND: Readonly<Record<string, LedgerKind>> = {
  PLATFORM_PENALTY: 'penalty',
  PLATFORM_COMMISSION_ADJUSTMENT: 'fee_fixed',
  PLATFORM_COMMISSION_COMPENSATION: 'fee_fixed',
  GMV_PAYMENT_FOR_ADS: 'ads',
};

const AMOUNT = /^[+-]?\d+(?:\.\d+)?$/;

/** Số tiền TikTok trả là chuỗi số trơn ("-12.5", "200"); thiếu là 0, dạng khác là `invalid_amount` (như Lazada, #349). */
export function tiktokAmount(raw: unknown, where: string): Decimal {
  if (raw === undefined || raw === null || raw === '') return new Decimal(0);
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
  if (text === null || !AMOUNT.test(text)) {
    throw new MarketplaceError('rejected', INVALID_AMOUNT, `Số tiền sàn trả không đọc được (${where}): ${JSON.stringify(raw)}`);
  }
  return new Decimal(text);
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
/** Unix giây → ngày giờ VN `YYYY-MM-DD`. */
const vnDay = (seconds: unknown) => new Date((Number(seconds) || 0) * 1000 + 7 * 3600_000).toISOString().slice(0, 10);
/** Ngày VN `YYYY-MM-DD` → Unix giây lúc 00:00 giờ VN. */
const dayStart = (day: string) => Math.floor(Date.parse(`${day}T00:00:00${VN_OFFSET}`) / 1000);
const outflow = (d: Decimal) => d.abs().neg().toString();

/**
 * Các dòng sổ tiền của một giao dịch trong sao kê: đơn thì doanh thu, vận chuyển, từng loại phí khác 0, thuế khấu trừ;
 * điều chỉnh thì một dòng theo `type`; giữ tiền dự trữ (`RESERVE`) một dòng `null`. Mã dòng `<sao kê>:<giao dịch>:<trường>`
 * để kéo lại cùng kỳ không ghi trùng. Thuế khấu trừ ghi dòng riêng `withholding_tax` (không dùng `withholding` của dòng
 * khác, vì finance tách `withholding` thành dòng `<txnId>:wht`).
 */
export function tiktokStatementRows(statementId: string, date: string, t: Row): SettlementTxn[] {
  const txId = str(t.id);
  if (!txId) return [];
  const type = str(t.type) || 'ORDER';
  const orderId = str(t.order_id) || str(t.adjustment_order_id) || str(t.associated_order_id) || null;
  const base = { externalOrderId: orderId, date, transactionType: type, withholding: '0' };
  const where = (field: string) => `${field}, giao dịch ${txId}`;
  const row = (field: string, amount: string, kind: LedgerKind | null): SettlementTxn => ({
    ...base,
    txnId: `${statementId}:${txId}:${field}`,
    feeName: field,
    feeCode: field,
    amount,
    kind,
  });
  if (type === 'RESERVE') {
    const amount = tiktokAmount(t.reserve_amount, where('reserve_amount'));
    return amount.isZero() ? [] : [row('reserve_amount', amount.toString(), null)];
  }
  if (type !== 'ORDER') {
    const amount = tiktokAmount(t.adjustment_amount, where('adjustment_amount'));
    return amount.isZero() ? [] : [row(type, amount.toString(), ADJUSTMENT_KIND[type] ?? null)];
  }
  const out: SettlementTxn[] = [];
  const revenue = tiktokAmount(t.revenue_amount, where('revenue_amount'));
  if (!revenue.isZero()) out.push(row('revenue_amount', revenue.toString(), 'revenue'));
  const shipping = tiktokAmount(t.shipping_cost_amount, where('shipping_cost_amount'));
  if (!shipping.isZero()) out.push(row('shipping_cost_amount', outflow(shipping), 'shipping_cost'));
  const breakdown = (t.fee_tax_breakdown ?? {}) as { fee?: Row; tax?: Row };
  for (const [field, raw] of Object.entries(breakdown.fee ?? {})) {
    if (IGNORED_FEE_FIELDS.has(field)) continue;
    const amount = tiktokAmount(raw, where(field));
    if (!amount.isZero()) out.push(row(field, outflow(amount), TIKTOK_FEE_KIND[field] ?? null));
  }
  for (const field of WITHHOLDING_FIELDS) {
    const amount = tiktokAmount(breakdown.tax?.[field], where(`tax.${field}`));
    if (!amount.isZero()) out.push(row(`tax.${field}`, outflow(amount), 'withholding_tax'));
  }
  return out;
}

/**
 * Mẫu phí của một giao dịch đơn (đã quyết toán hoặc ước tính): chỉ đơn có doanh thu, không hoàn tiền. Cơ sở hoa hồng =
 * `subtotal_before_discount − seller_discount` (trang "Phí Hoa Hồng Nền Tảng"); cơ sở phí giao dịch = khách trả + chiết
 * khấu nền tảng (`supplementary_component`, trang "Phí Giao Dịch"), sàn không trả thì null (gợi ý dùng cơ sở hoa hồng).
 */
export function tiktokFeeSample(t: Row, date: string, estimated: boolean): FeeSample | null {
  if ((str(t.type) || 'ORDER') !== 'ORDER' || !str(t.order_id)) return null;
  const id = str(t.id) || str(t.order_id);
  const where = (field: string) => `${field}, giao dịch ${id}`;
  const rev = (t.revenue_breakdown ?? {}) as Row;
  const refunded = tiktokAmount(rev.refund_subtotal_before_discount_amount, where('refund_subtotal_before_discount_amount'));
  if (!refunded.isZero()) return null;
  const commissionBase = tiktokAmount(rev.subtotal_before_discount_amount, where('subtotal_before_discount_amount')).minus(
    tiktokAmount(rev.seller_discount_amount, where('seller_discount_amount')).abs(),
  );
  if (commissionBase.lte(0)) return null;
  const sup = t.supplementary_component as Row | undefined;
  const transactionBase =
    sup && (sup.customer_payment_amount !== undefined || sup.platform_discount_amount !== undefined)
      ? tiktokAmount(sup.customer_payment_amount, where('customer_payment_amount')).plus(
          tiktokAmount(sup.platform_discount_amount, where('platform_discount_amount')).abs(),
        )
      : null;
  const fees = new Map<SampleFeeKind, Decimal>();
  const add = (k: SampleFeeKind, d: Decimal) => fees.set(k, (fees.get(k) ?? new Decimal(0)).plus(d.abs()));
  const breakdown = (t.fee_tax_breakdown ?? {}) as { fee?: Row; tax?: Row };
  for (const [field, raw] of Object.entries(breakdown.fee ?? {})) {
    const kind = TIKTOK_FEE_KIND[field];
    if (IGNORED_FEE_FIELDS.has(field) || !kind) continue;
    if (kind === 'fee_fixed' || kind === 'fee_transaction' || kind === 'fee_service' || kind === 'fee_optional') add(kind, tiktokAmount(raw, where(field)));
  }
  for (const field of WITHHOLDING_FIELDS) add('withholding_tax', tiktokAmount(breakdown.tax?.[field], where(`tax.${field}`)));
  return {
    externalOrderId: str(t.order_id),
    date,
    commissionBase: commissionBase.toString(),
    transactionBase: transactionBase?.gt(0) ? transactionBase.toString() : null,
    itemCount: null,
    fees: Object.fromEntries([...fees].filter(([, v]) => !v.isZero()).map(([k, v]) => [k, v.toString()])),
    estimated,
  };
}

export function tiktokFinanceMethods(client: TiktokClient): Pick<MarketplaceAdapter, 'getTransactions' | 'feeSamples'> {
  /** Sao kê trong `[from, to]` (ngày VN, cả hai đầu), mới nhất trước khi `desc`. */
  async function statements(token: string, from: string | null, to: string | null, order: 'ASC' | 'DESC'): Promise<Row[]> {
    const out: Row[] = [];
    let page: string | undefined;
    do {
      const data = await client.call<{ statements?: Row[]; next_page_token?: string }>('GET', STATEMENTS, {
        token,
        query: {
          sort_field: 'statement_time',
          sort_order: order,
          page_size: PAGE_SIZE,
          ...(from && { statement_time_ge: dayStart(from) }),
          ...(to && { statement_time_lt: dayStart(to) + 86_400 }),
          ...(page && { page_token: page }),
        },
      });
      out.push(...(data?.statements ?? []));
      page = data?.next_page_token || undefined;
    } while (page);
    return out;
  }

  /** Mọi giao dịch của một sao kê (lật trang). `stop` trả true thì ngừng lật sớm. */
  async function transactionsOf(token: string, statementId: string, stop?: () => boolean): Promise<Row[]> {
    const out: Row[] = [];
    let page: string | undefined;
    do {
      const data = await client.call<{ transactions?: Row[]; next_page_token?: string }>('GET', statementTransactions(statementId), {
        token,
        query: { sort_field: 'order_create_time', page_size: PAGE_SIZE, ...(page && { page_token: page }) },
      });
      out.push(...(data?.transactions ?? []));
      page = data?.next_page_token || undefined;
    } while (page && !stop?.());
    return out;
  }

  return {
    async getTransactions(accessToken, from, to): Promise<SettlementTxn[]> {
      const out: SettlementTxn[] = [];
      for (const s of await statements(accessToken, from, to, 'ASC')) {
        const id = str(s.id);
        if (!id) continue;
        const date = vnDay(s.statement_time);
        for (const t of await transactionsOf(accessToken, id)) out.push(...tiktokStatementRows(id, date, t));
      }
      return out;
    },

    // Mẫu phí cho gợi ý: đơn đã quyết toán mới nhất trước (sao kê từ `since`), đủ `limit` thì thôi; thiếu thì bù bằng số ước
    // tính của đơn chưa quyết toán (Get Unsettled Transactions 202507, cờ `estimated`).
    async feeSamples(accessToken, opts): Promise<FeeSample[]> {
      const out: FeeSample[] = [];
      for (const s of await statements(accessToken, opts.since, null, 'DESC')) {
        if (out.length >= opts.limit) break;
        const id = str(s.id);
        if (!id) continue;
        const date = vnDay(s.statement_time);
        for (const t of await transactionsOf(accessToken, id, () => out.length >= opts.limit)) {
          const sample = tiktokFeeSample(t, date, false);
          if (sample && out.length < opts.limit) out.push(sample);
        }
      }
      let page: string | undefined;
      while (out.length < opts.limit) {
        const data = await client.call<{ transactions?: Row[]; next_page_token?: string }>('GET', UNSETTLED, {
          token: accessToken,
          query: { sort_field: 'order_create_time', sort_order: 'DESC', page_size: PAGE_SIZE, search_time_ge: dayStart(opts.since), ...(page && { page_token: page }) },
        });
        for (const t of data?.transactions ?? []) {
          // Đơn chưa quyết toán: trường số mang tiền tố `est_`, phần breakdown cùng tên như bản quyết toán.
          const sample = tiktokFeeSample(t, vnDay(t.order_delivery_time ?? t.order_create_time), true);
          if (sample && out.length < opts.limit) out.push(sample);
        }
        page = data?.next_page_token || undefined;
        if (!page) break;
      }
      return out;
    },
  };
}
