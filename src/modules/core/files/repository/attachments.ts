import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { attachments, type FileRow, files } from './schema.ts';

/** Chứng từ mang tệp: `type` là tên bảng của chứng từ (vd `goods_receipts`), `id` là id bản ghi. */
export interface EntityRef {
  readonly type: string;
  readonly id: string;
}

/** Tệp đang gắn vào chứng từ, theo thứ tự lúc gắn. */
export async function attachedFiles(entity: EntityRef): Promise<FileRow[]> {
  const rows = await getDb()
    .select({ file: files })
    .from(attachments)
    .innerJoin(files, eq(files.id, attachments.fileId))
    .where(and(eq(attachments.entityType, entity.type), eq(attachments.entityId, entity.id)))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  return rows.map((r) => r.file);
}

export async function countAttachments(entity: EntityRef): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(attachments)
    .where(and(eq(attachments.entityType, entity.type), eq(attachments.entityId, entity.id)));
  return row?.n ?? 0;
}

/**
 * Thay toàn bộ tệp của chứng từ: xoá dòng gắn cũ rồi chèn theo thứ tự `fileIds` (`created_at` = now() + i µs để giữ
 * thứ tự trong một giao dịch). Không xoá tệp.
 */
export async function replaceAttachmentRows(
  companyId: string,
  entity: EntityRef,
  fileIds: readonly string[],
  createdBy: string,
): Promise<void> {
  await getDb()
    .delete(attachments)
    .where(and(eq(attachments.entityType, entity.type), eq(attachments.entityId, entity.id)));
  if (fileIds.length === 0) return;
  await getDb()
    .insert(attachments)
    .values(
      fileIds.map((fileId, i) => ({
        companyId,
        fileId,
        entityType: entity.type,
        entityId: entity.id,
        createdBy,
        createdAt: sql`now() + ${i} * interval '1 microsecond'`,
      })),
    );
}
