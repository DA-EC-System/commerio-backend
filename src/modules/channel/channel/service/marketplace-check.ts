// Đối chiếu registry adapter với danh mục sàn `channel.marketplaces` lúc worker khởi động (Documents/19 mục 3.3).
import { listMarketplaces } from '../repository/marketplaces.ts';
import { marketplaceMismatches } from './marketplaces/index.ts';

/** Lệch thì ném lỗi để worker dừng ngay: thêm adapter mà quên migration chèn dòng sàn thì biết lúc deploy, không đợi tới lúc nối gian hàng. */
export async function verifyMarketplaces(): Promise<void> {
  const problems = marketplaceMismatches(await listMarketplaces());
  if (problems.length) throw new Error(`Danh mục sàn lệch registry adapter: ${problems.join('; ')}`);
}
