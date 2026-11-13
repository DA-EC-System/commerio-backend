// `GET /finance/skus/profits` (#231; Documents/21 §21.1, 25 §10.2): lãi theo SKU của phần đã giao trong kỳ.
import { Decimal } from 'decimal.js';
import { withCompany } from '../../../../shared/db/client.ts';
import { getVariants } from '../../../product/index.ts';
import { marginPct } from '../domain/order-profit.ts';
import { findSkuProfits } from '../repository/sku-profits.ts';

export interface SkuProfitsQuery {
  from: string;
  to: string;
  shopId?: string;
  page: number;
  pageSize: number;
}

const money = (v: Decimal.Value) => new Decimal(v).toNumber();

/**
 * Lãi theo SKU trong kỳ giao; tổng tính trên toàn bộ kết quả lọc. SKU, tên sản phẩm qua cổng của product. Không có
 * quyền xem giá vốn thì `cogs`, `gross`, `marginPct` là `null` (R4).
 */
export function listSkuProfits(companyId: string, q: SkuProfitsQuery, canSeeCost: boolean) {
  return withCompany(companyId, async () => {
    const { rows, totals } = await findSkuProfits(
      { from: q.from, to: q.to, shopId: q.shopId },
      { limit: q.pageSize, offset: (q.page - 1) * q.pageSize },
    );
    const ids = rows.flatMap((r) => (r.variantId ? [r.variantId] : []));
    const variants = new Map((ids.length ? await getVariants(ids) : []).map((v) => [v.id, v]));
    return {
      items: rows.map((r) => {
        const gross = new Decimal(r.net).plus(r.cogs);
        const v = r.variantId ? variants.get(r.variantId) : undefined;
        return {
          variantId: r.variantId,
          sku: v?.sku ?? null,
          productName: v?.productName ?? null,
          soldQty: r.soldQty,
          net: money(r.net),
          cogs: canSeeCost ? money(r.cogs) : null,
          gross: canSeeCost ? gross.toNumber() : null,
          marginPct: canSeeCost ? marginPct(r.net, gross) : null,
          costMissing: r.costMissing,
        };
      }),
      totals: {
        net: money(totals.net),
        cogs: canSeeCost ? money(totals.cogs) : null,
        gross: canSeeCost ? new Decimal(totals.net).plus(totals.cogs).toNumber() : null,
      },
      total: totals.total,
      excludedOrders: totals.excludedOrders,
      page: q.page,
      pageSize: q.pageSize,
    };
  });
}
