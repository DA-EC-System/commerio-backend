import { sql } from 'drizzle-orm';
import { getDb, outsideTransaction } from '../../../../shared/db/client.ts';
import { files } from './schema.ts';

export type NewFile = typeof files.$inferInsert;

/** Ghi thông tin tệp. Gọi trong `withCompany` của công ty sở hữu tệp (RLS kiểm `company_id`). */
export async function insertFile(row: NewFile): Promise<void> {
  await getDb().insert(files).values(row);
}

/**
 * Tổng `size_bytes` của mọi công ty, gồm cả tệp đã xin vé mà chưa PUT: con số này là cận trên của dung lượng thật
 * trên kho. Luôn chạy ngoài giao dịch đang mở, bằng role chủ bảng (bỏ qua RLS), vì trần là của cả tài khoản R2; chỉ
 * trả một con số, không lộ dữ liệu công ty khác.
 */
export async function totalStoredBytes(): Promise<number> {
  return outsideTransaction(async () => {
    const [row] = await getDb()
      .select({ total: sql<string>`coalesce(sum(${files.sizeBytes}), 0)` })
      .from(files);
    return Number(row?.total ?? 0);
  });
}
