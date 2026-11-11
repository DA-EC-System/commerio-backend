// Gắn và đọc tệp đính kèm của chứng từ (#212; Documents/21 §14.3). Module khác gọi qua `core/index.ts`.
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { PURPOSE_RULES } from '../domain/upload-rules.ts';
import { attachedFiles, countAttachments, type EntityRef, replaceAttachmentRows } from '../repository/attachments.ts';
import { type FileRow, findFiles, markUploaded } from '../repository/files.ts';
import { headObject, signDownload, type StorageConfig, storageConfig } from './storage.ts';

export type { EntityRef };

const log = logger.child({ module: 'files' });

/** Tối đa 10 tệp mỗi chứng từ (§14.3). */
export const MAX_ATTACHMENTS = 10;
/** Link xem hoặc tải hết hạn sau 15 phút: FE không lưu, cần thì tải lại chi tiết chứng từ. */
export const DOWNLOAD_TTL_SECONDS = 15 * 60;

export interface Attachment {
  readonly fileId: string;
  readonly name: string;
  readonly url: string;
  readonly contentType: string;
}

function requireStorage(): StorageConfig {
  const config = storageConfig();
  if (!config) throw new AppError(503, 'storage_unavailable', 'Kho tệp chưa được cấu hình, hãy báo quản trị hệ thống');
  return config;
}

const bucketOf = (config: StorageConfig, file: FileRow) => config.buckets[PURPOSE_RULES[file.purpose].visibility];

/**
 * Hỏi kho các tệp chưa xác nhận đã PUT xong, có rồi (đúng cỡ đã khai) thì ghi `uploaded_at`. Gọi **trước** giao dịch
 * gắn tệp, ngoài `withCompany` của bên gọi: lời gọi mạng không giữ khoá dòng. Id lạ, tệp công ty khác, tệp chưa có
 * trên kho thì bỏ qua: `attachmentProblem` trong giao dịch sẽ báo. Kho không trả lời thì 503 `storage_unavailable`.
 */
export async function confirmUploads(companyId: string, fileIds: readonly string[]): Promise<void> {
  const ids = [...new Set(fileIds.filter(isUuid))];
  if (ids.length === 0) return;
  const pending = (await withCompany(companyId, () => findFiles(ids))).filter((f) => !f.uploadedAt);
  if (pending.length === 0) return;
  const config = requireStorage();
  const seen = await Promise.all(
    pending.map(async (file) => {
      try {
        const found = await headObject(config, { bucket: bucketOf(config, file), key: file.storageKey });
        return found && found.sizeBytes === file.sizeBytes ? file.id : null;
      } catch (err) {
        log.error({ err, fileId: file.id }, 'không hỏi được kho tệp');
        throw new AppError(503, 'storage_unavailable', 'Chưa kết nối được kho tệp, hãy thử lại sau');
      }
    }),
  );
  await withCompany(companyId, () => markUploaded(seen.filter((id): id is string => id !== null)));
}

/**
 * Câu lỗi cho ô tệp của chứng từ, `null` khi gắn được: mỗi id là tệp của công ty này (RLS), xin vé với
 * `purpose: 'attachment'`, đã PUT xong (`confirmUploads` đã ghi nhận), không lặp, tối đa 10. Gọi trong `withCompany`.
 */
export async function attachmentProblem(fileIds: readonly string[]): Promise<string | null> {
  requireCompanyId('attachmentProblem');
  if (fileIds.length > MAX_ATTACHMENTS) return `Tối đa ${MAX_ATTACHMENTS} tệp`;
  if (new Set(fileIds).size !== fileIds.length) return 'Có tệp bị lặp';
  if (!fileIds.every(isUuid)) return 'Có tệp chưa tải xong hoặc không thuộc công ty';
  const found = new Map((await findFiles(fileIds)).map((f) => [f.id, f]));
  const usable = fileIds.every((id) => {
    const file = found.get(id);
    return file !== undefined && file.purpose === 'attachment' && file.uploadedAt !== null;
  });
  return usable ? null : 'Có tệp chưa tải xong hoặc không thuộc công ty';
}

/**
 * Thay toàn bộ tệp của chứng từ theo thứ tự `fileIds` (gỡ tệp không xoá tệp). Bên gọi đã kiểm `attachmentProblem`
 * trong cùng giao dịch `withCompany`.
 */
export async function replaceAttachments(entity: EntityRef, fileIds: readonly string[], actorId: string): Promise<void> {
  const companyId = requireCompanyId('replaceAttachments');
  await replaceAttachmentRows(companyId, entity, fileIds, actorId);
}

/** Id tệp đang gắn, theo thứ tự (cho nhật ký thao tác). Gọi trong `withCompany`. */
export async function attachmentIdsOf(entity: EntityRef): Promise<string[]> {
  requireCompanyId('attachmentIdsOf');
  return (await attachedFiles(entity)).map((f) => f.id);
}

/** Chứng từ có ít nhất một tệp (vd bằng chứng mở thùng trước khi ghi sổ). Gọi trong `withCompany`. */
export async function hasAttachments(entity: EntityRef): Promise<boolean> {
  requireCompanyId('hasAttachments');
  return (await countAttachments(entity)) > 0;
}

/**
 * Tệp của chứng từ kèm link ký sẵn 15 phút (ký trong máy, không gọi mạng). Gọi trong `withCompany`. Chứng từ không có
 * tệp thì không cần kho; có tệp mà kho chưa cấu hình thì 503.
 */
export async function attachmentsOf(entity: EntityRef): Promise<Attachment[]> {
  requireCompanyId('attachmentsOf');
  const rows = await attachedFiles(entity);
  if (rows.length === 0) return [];
  const config = requireStorage();
  return Promise.all(
    rows.map(async (file) => ({
      fileId: file.id,
      name: file.fileName,
      contentType: file.contentType,
      url: await signDownload(
        config,
        { bucket: bucketOf(config, file), key: file.storageKey, contentType: file.contentType, fileName: file.fileName },
        DOWNLOAD_TTL_SECONDS,
      ),
    })),
  );
}
