// Gắn và đọc tệp của chứng từ, của sản phẩm (#212, #303; Documents/21 §5.4, §14.3). Module khác gọi qua `core/index.ts`.
import { env } from '../../../../shared/config/env.ts';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { type FilePurpose, PURPOSE_RULES, rejectUpload, type UploadRejection } from '../domain/upload-rules.ts';
import { attachedFiles, countAttachments, type EntityRef, replaceAttachmentRows } from '../repository/attachments.ts';
import { type FileRow, findFiles, markUploaded } from '../repository/files.ts';
import { headObject, signDownload, type StorageConfig, storageConfig } from './storage.ts';
import { REJECTION_MESSAGES } from './uploads.ts';

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

interface ProblemText {
  readonly tooMany: (max: number) => string;
  readonly duplicate: string;
  readonly unusable: string;
  readonly rejected: (file: FileRow, why: UploadRejection) => string;
}

/** Câu lỗi ô tệp theo mục đích: ảnh sản phẩm khớp mock FE (#303), tệp đính kèm giữ câu của #212. */
const PROBLEM_TEXT: Readonly<Record<FilePurpose, ProblemText>> = {
  product_image: {
    tooMany: (max) => `Tối đa ${max} ảnh`,
    duplicate: 'Ảnh bị trùng',
    unusable: 'Có ảnh chưa tải xong hoặc không thuộc công ty',
    rejected: (file, why) =>
      why === 'file_type_not_allowed' ? `Ảnh ${file.fileName} không phải JPG hoặc PNG` : `Ảnh ${file.fileName} lớn hơn 1 MB`,
  },
  attachment: {
    tooMany: (max) => `Tối đa ${max} tệp`,
    duplicate: 'Có tệp bị lặp',
    unusable: 'Có tệp chưa tải xong hoặc không thuộc công ty',
    rejected: (_file, why) => REJECTION_MESSAGES[why].attachment,
  },
};

/**
 * Câu lỗi cho ô tệp, `null` khi gắn được: tối đa `max`, không lặp, mỗi id là tệp của công ty này (RLS), xin vé với
 * đúng `purpose`, đã PUT xong (`confirmUploads` đã ghi nhận), và còn đúng kiểu, cỡ theo luật **hiện hành** của
 * `purpose` (chặn tệp xin vé trước khi đổi luật). Gọi trong `withCompany`.
 */
export async function fileProblem(fileIds: readonly string[], purpose: FilePurpose, max: number): Promise<string | null> {
  requireCompanyId('fileProblem');
  const text = PROBLEM_TEXT[purpose];
  if (fileIds.length > max) return text.tooMany(max);
  if (new Set(fileIds).size !== fileIds.length) return text.duplicate;
  if (!fileIds.every(isUuid)) return text.unusable;
  const found = new Map((await findFiles(fileIds)).map((f) => [f.id, f]));
  const files = fileIds.map((id) => found.get(id));
  if (!files.every((f) => f !== undefined && f.purpose === purpose && f.uploadedAt !== null)) return text.unusable;
  for (const file of files as FileRow[]) {
    const why = rejectUpload(purpose, file.contentType, file.sizeBytes);
    if (why) return text.rejected(file, why);
  }
  return null;
}

/** Câu lỗi cho ô tệp đính kèm của chứng từ (tối đa 10), như `fileProblem`. Gọi trong `withCompany`. */
export function attachmentProblem(fileIds: readonly string[]): Promise<string | null> {
  return fileProblem(fileIds, 'attachment', MAX_ATTACHMENTS);
}

/**
 * Link cố định của các tệp ở bucket công khai (ảnh sản phẩm): `<S3_PUBLIC_URL>/<storage_key>`; thiếu `S3_PUBLIC_URL`
 * thì chuỗi rỗng (trang vẫn mở được, chỉ không có ảnh). Tệp ở bucket riêng, tệp công ty khác, id lạ không có trong
 * Map. Không gọi mạng. Gọi trong `withCompany`.
 */
export async function publicFileUrls(fileIds: readonly string[]): Promise<Map<string, string>> {
  requireCompanyId('publicFileUrls');
  const base = env.S3_PUBLIC_URL?.replace(/\/+$/, '');
  const files = await findFiles(fileIds.filter(isUuid));
  return new Map(
    files.filter((f) => PURPOSE_RULES[f.purpose].visibility === 'public').map((f) => [f.id, base ? `${base}/${f.storageKey}` : '']),
  );
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
