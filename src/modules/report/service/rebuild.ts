// Dựng lại số liệu báo cáo của một công ty từ dữ liệu gốc (Documents/21 D7), dùng khi đổi công thức. Chạy:
//   node --env-file=.env src/modules/report/service/rebuild.ts <companyId> <from YYYY-MM-DD> [to YYYY-MM-DD]
// `to` mặc định hôm nay (giờ VN). Không có `--all`: platform chưa có hàm liệt kê công ty (plan #29 A5).
import { z } from 'zod';
import { closeDb } from '../../../shared/db/client.ts';
import { isUuid } from '../../../shared/uuid.ts';
import { vnDay } from '../domain/days.ts';
import { recompute } from './recompute.ts';

if (import.meta.main) {
  const [companyId, from, to = vnDay(new Date())] = process.argv.slice(2);
  const day = z.iso.date();
  if (!isUuid(companyId ?? '') || !day.safeParse(from).success || !day.safeParse(to).success || from! > to) {
    console.error('Cách dùng: node --env-file=.env src/modules/report/service/rebuild.ts <companyId> <from> [to]');
    process.exit(2);
  }
  await recompute(companyId!, from!, to);
  console.log(`Đã dựng lại báo cáo của ${companyId} từ ${from} tới ${to}`);
  await closeDb();
}
