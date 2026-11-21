import { getDb } from '../../../../shared/db/client.ts';
import { companyProductSettings } from './schema.ts';

// Chạy trong giao dịch đăng ký (role chủ bảng, chưa có `app.company_id`): ghi `company_id` tường minh.
// Nhóm hàng, thông số, mẫu, thuộc tính chuẩn là dòng nền tảng dùng chung (Documents/21 mục 5.6, 11.3), migration ghi
// một lần cho mọi công ty; không chép vào công ty mới.
export async function insertCompanyDefaults(companyId: string): Promise<void> {
  await getDb().insert(companyProductSettings).values({ companyId });
}
