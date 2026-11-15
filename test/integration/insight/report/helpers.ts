import { randomUUID } from 'node:crypto';
import { shops } from '#src/modules/channel/channel/repository/schema.ts';
import type { OrderSource } from '#src/modules/order/sales/index.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';

// Dữ liệu cho test API báo cáo. Hàm tính lại bảng dựng sẵn từ chứng từ cũ (`service/recompute.ts`) đã gỡ ở #235, nên
// test ghi thẳng dòng `insight.daily_channel_summary` bằng role chủ bảng.

/** Gian hàng TikTok của công ty, trả id. */
export async function shopOf(companyId: string, shopName: string): Promise<string> {
  const id = randomUUID();
  await withCompany(companyId, () =>
    getDb().insert(shops).values({ id, companyId, platform: 'tiktok', externalShopId: randomUUID(), shopName }),
  );
  return id;
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
