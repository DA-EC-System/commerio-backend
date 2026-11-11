import { and, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, outsideTransaction } from '../../../../shared/db/client.ts';
import { type FileRow, files } from './schema.ts';

export type { FileRow };

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


/** Tệp theo id, trong công ty của giao dịch đang mở (RLS: tệp công ty khác coi như không có). */
export async function findFiles(ids: readonly string[]): Promise<FileRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select()
    .from(files)
    .where(inArray(files.id, [...ids]));
}

/** Ghi nhận đã thấy tệp trên kho; tệp đã ghi từ trước thì giữ mốc cũ. */
export async function markUploaded(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .update(files)
    .set({ uploadedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(inArray(files.id, [...ids]), isNull(files.uploadedAt)));
}
