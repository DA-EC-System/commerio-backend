import { randomUUID } from 'node:crypto';
import { shops } from '#src/modules/channel/channel/repository/schema.ts';
import type { OrderSource } from '#src/modules/order/sales/index.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';

// Dữ liệu cho test báo cáo. API gom thẳng sổ tiền (#333), nên test ghi thẳng `finance.ledger_entries`,
// `finance.ledger_replacements` bằng role chủ bảng. `summaryRow` còn cho test bảng cũ `daily_channel_summary` (ràng buộc,
// xoá theo gian hàng) tới khi bảng bị xoá.

/** Gian hàng TikTok của công ty, trả id. */
export async function shopOf(companyId: string, shopName: string): Promise<string> {
  const id = randomUUID();
  await withCompany(companyId, () =>
    getDb().insert(shops).values({ id, companyId, platform: 'tiktok', externalShopId: randomUUID(), shopName }),
  );
  return id;
}

/** Một dòng sổ tiền (mặc định thực tế); trả id. Tiền có dấu như sổ: khoản ra âm. */
export async function ledgerRow(
  companyId: string,
  row: { kind: string; amount: number; day: string; shopId?: string | null; estimate?: boolean; sourceId?: string; reason?: string },
): Promise<string> {
  const { rows } = await testPool().query<{ id: string }>(
    `insert into finance.ledger_entries (company_id, kind, amount, is_estimate, occurred_on, shop_id, source_type, source_id, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      companyId,
      row.kind,
      row.amount,
      row.estimate ?? false,
      row.day,
      row.shopId ?? null,
      row.sourceId ? 'package' : null,
      row.sourceId ?? null,
      row.reason ?? null,
    ],
  );
  return rows[0]!.id;
}

/** Dòng thực tế `actualId` thay dòng ước tính `estimateId` (bảng nối, #231). */
export async function replaces(companyId: string, actualId: string, estimateId: string): Promise<void> {
  await testPool().query('insert into finance.ledger_replacements (company_id, actual_id, estimate_id) values ($1, $2, $3)', [
    companyId,
    actualId,
    estimateId,
  ]);
}

/** Một dòng số liệu của (ngày, nguồn, gian hàng); ô tiền bỏ trống là 0. */
export async function summaryRow(
  companyId: string,
  row: {
    day: string;
    source: OrderSource;
    shopId?: string | null;
    revenue?: number;
    cashCollected?: number;
    platformFee?: number;
    shippingFee?: number;
    cogs?: number;
    profit?: number;
    feesPending?: boolean;
  },
): Promise<void> {
  await testPool().query(
    `insert into insight.daily_channel_summary
       (company_id, day, source, shop_id, revenue, cash_collected, platform_fee, shipping_fee, cogs, profit, fees_pending)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      companyId,
      row.day,
      row.source,
      row.shopId ?? null,
      row.revenue ?? 0,
      row.cashCollected ?? 0,
      row.platformFee ?? 0,
      row.shippingFee ?? 0,
      row.cogs ?? 0,
      row.profit ?? 0,
      row.feesPending ?? false,
    ],
  );
}
