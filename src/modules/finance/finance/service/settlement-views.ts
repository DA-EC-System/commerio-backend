// API đối soát tiền sàn (Documents/21 §12.6, §12.8; plan #30 A2, A7): danh sách bảng kê, dòng, nhận bảng kê ở dev.
import { Decimal } from 'decimal.js';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import type { PlatformPayout, PlatformTxn } from '../domain/settlement.ts';
import { feeTotal, needsReceipt } from '../domain/settlement-match.ts';
import {
  FEE_KEYS,
  mapTikTokStatement,
  mapTikTokTransaction,
  SettlementMappingError,
  type SettlementFees,
  type TikTokStatement,
  type TikTokTransaction,
} from '../domain/tiktok-settlement.ts';
import { type LineFilter, listLines, listStatements, type StatementFilter } from '../repository/settlements.ts';
import { ingestSettlementStatement } from './settlement-ingest.ts';
import { isUuid, money, notFound, orderRef, ordersOf } from './views.ts';

export interface ShopInfo {
  shopName: string;
  platform: string;
}

/**
 * `ctx` mà router của finance nhận. Tên gian hàng ở `channel` (lớp trên): `src/wiring.ts` tiêm `channel.getShops`
 * (plan #30 A7). Gọi trong `withCompany` để RLS của `channel.shops` lọc theo công ty.
 */
export interface FinanceContext extends ModuleContext {
  readonly shopsOf?: (ids: readonly string[]) => Promise<Map<string, ShopInfo>>;
  /** Kéo quyết toán từ sàn (#117): `src/wiring.ts` tiêm các hàm cổng của channel. Thiếu thì không kéo được (422). */
  readonly settlementSource?: SettlementSource;
}

/** Cổng quyết toán của channel (#117). Hai hàm đầu gọi sàn: gọi ngoài giao dịch; `shops` đọc mọi công ty. */
export interface SettlementSource {
  transactions(companyId: string, shopId: string, from: string, to: string): Promise<PlatformTxn[]>;
  payouts(companyId: string, shopId: string, from: string): Promise<PlatformPayout[]>;
  shops(): Promise<{ companyId: string; shopId: string }[]>;
}

interface Paging {
  page: number;
  pageSize: number;
}

const shopsOf = (ctx: FinanceContext, ids: readonly string[]) =>
  ctx.shopsOf ? ctx.shopsOf([...new Set(ids)]) : Promise.resolve(new Map<string, ShopInfo>());

type StatementRow = Awaited<ReturnType<typeof listStatements>>['rows'][number];

function statementView(s: StatementRow, shops: Map<string, ShopInfo>) {
  const shop = shops.get(s.shopId);
  return {
    id: s.id,
    shop: { id: s.shopId, shopName: shop?.shopName ?? null, platform: shop?.platform ?? null },
    externalStatementId: s.externalStatementId,
    statementTime: s.statementTime.toISOString(),
    settlementAmount: money(s.settlementAmount),
    paymentStatus: s.paymentStatus,
    lineCount: s.lineCount,
    matchedCount: s.matchedCount,
    discrepancyCount: s.discrepancyCount,
    refundTaggedCount: s.refundTaggedCount,
    receiptTotal: money(s.receiptTotal),
  };
}

async function statementsPage(ctx: FinanceContext, f: StatementFilter, q: Paging) {
  const { rows, total } = await listStatements(f, q.pageSize, (q.page - 1) * q.pageSize);
  const shops = await shopsOf(
    ctx,
    rows.map((r) => r.shopId),
  );
  return { items: rows.map((r) => statementView(r, shops)), total, page: q.page, pageSize: q.pageSize };
}

export function listSettlements(ctx: FinanceContext, companyId: string, q: Paging & Omit<StatementFilter, 'id'>) {
  return withCompany(companyId, () => statementsPage(ctx, q, q));
}

async function statementById(ctx: FinanceContext, id: string) {
  const [s] = isUuid(id) ? (await statementsPage(ctx, { id }, { page: 1, pageSize: 1 })).items : [];
  if (!s) throw notFound('bảng kê');
  return s;
}

export function getSettlement(ctx: FinanceContext, companyId: string, id: string) {
  return withCompany(companyId, () => statementById(ctx, id));
}

const feesView = (fees: Record<string, string>) =>
  Object.fromEntries(FEE_KEYS.map((k) => [k, money(fees[k] ?? '0')])) as Record<keyof SettlementFees, number>;

export function listSettlementLines(companyId: string, q: Paging & LineFilter) {
  return withCompany(companyId, async () => {
    const { rows, total } = await listLines(q, q.pageSize, (q.page - 1) * q.pageSize);
    const orders = await ordersOf(rows.map((r) => r.line.orderId));
    const items = rows.map(({ line: l, paymentStatus, receiptId, receiptNumber }) => {
      const fees = l.fees as Record<string, string>;
      const settlement = new Decimal(l.settlement);
      const order = l.orderId ? orders.get(l.orderId) : undefined;
      return {
        id: l.id,
        statementId: l.statementId,
        kind: l.kind,
        externalTransactionId: l.externalTransactionId,
        externalOrderId: l.externalOrderId,
        order: orderRef(orders, l.orderId),
        revenue: money(l.revenue),
        fees: feesView(fees),
        feeTotal: feeTotal(
          Object.fromEntries(FEE_KEYS.map((k) => [k, new Decimal(fees[k] ?? 0)])) as SettlementFees,
        ).toNumber(),
        shippingCost: money(l.shippingCost),
        adjustment: money(l.adjustment),
        settlement: settlement.toNumber(),
        orderTotal: order ? order.total.toNumber() : null,
        matchStatus: l.matchStatus,
        discrepancyReason: l.discrepancyReason,
        receipt: receiptId && receiptNumber ? { id: receiptId, number: receiptNumber } : null,
        receiptPending:
          !receiptId && paymentStatus !== 'PAID' && needsReceipt({ matchStatus: l.matchStatus, settlement }, 'PAID'),
      };
    });
    return { items, total, page: q.page, pageSize: q.pageSize };
  });
}

const invalid = (errors: Record<string, string>) =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors });

/** Ánh xạ cả bảng kê; gom mọi lỗi theo ô (`statement.<trường>`, `transactions.<i>.<trường>`). */
function mapImport(statement: TikTokStatement, transactions: readonly TikTokTransaction[]) {
  const errors: Record<string, string> = {};
  const attempt = <T>(prefix: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof SettlementMappingError)) throw e;
      errors[`${prefix}.${e.field}`] = e.message;
      return undefined;
    }
  };
  const st = attempt('statement', () => mapTikTokStatement(statement));
  const lines = transactions.map((tx, i) => attempt(`transactions.${i}`, () => mapTikTokTransaction(tx)));
  if (Object.keys(errors).length > 0 || !st) throw invalid(errors);
  return { st, lines: lines.filter((l) => l !== undefined) };
}

/** Nhận bảng kê khuôn OAS qua HTTP (chỉ dev/E2E, A2): cùng đường với kéo từ sàn (PR2). */
export function importSettlement(
  ctx: FinanceContext,
  companyId: string,
  body: { shopId: string; statement: TikTokStatement; transactions: TikTokTransaction[] },
) {
  return withCompany(companyId, async () => {
    if (!(await shopsOf(ctx, [body.shopId])).has(body.shopId)) {
      throw invalid({ shopId: 'Gian hàng không thuộc công ty' });
    }
    const { st, lines } = mapImport(body.statement, body.transactions);
    const { statementId, created } = await ingestSettlementStatement(body.shopId, st, lines);
    return { created, statement: await statementById(ctx, statementId) };
  });
}
