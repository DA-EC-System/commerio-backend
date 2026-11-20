// Bảng cũ `insight.daily_channel_summary`: không còn đọc (#333, báo cáo gom thẳng sổ tiền), xoá ở một migration sau
// (Documents/19 mục 3.6). Còn lại hàm dọn dòng cũ khi xoá gian hàng. Chạy trong `withCompany` của bên gọi.
import { eq } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { dailyChannelSummary } from './schema.ts';

/** Xoá số liệu theo ngày của gian hàng bị xoá (#398); trả số dòng đã xoá. */
export async function deleteShopSummaries(shopId: string): Promise<number> {
  const rows = await getDb()
    .delete(dailyChannelSummary)
    .where(eq(dailyChannelSummary.shopId, shopId))
    .returning({ id: dailyChannelSummary.id });
  return rows.length;
}
