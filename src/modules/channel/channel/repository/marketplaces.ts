// Danh mục sàn `channel.marketplaces` (Documents/19 mục 3.3): bảng tham chiếu nền tảng, không RLS; `commerio_app` chỉ đọc,
// dòng do migration chèn (migration `*_bang-san-fk`).
import { asc } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { marketplaces } from './schema.ts';

export async function listMarketplaces(): Promise<{ code: string; enabled: boolean }[]> {
  return getDb().select({ code: marketplaces.code, enabled: marketplaces.enabled }).from(marketplaces).orderBy(asc(marketplaces.code));
}
