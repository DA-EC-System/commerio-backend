import { randomUUID } from 'node:crypto';
import { env } from '../../../../shared/config/env.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { type FilePurpose, PURPOSE_RULES, rejectUpload, storageKeyOf } from '../domain/upload-rules.ts';
import { insertFile, totalStoredBytes } from '../repository/files.ts';
import { countTicket } from './metrics.ts';
import { signUpload, storageConfig } from './storage.ts';

const log = logger.child({ module: 'files' });

/** Vé có hạn 15 phút (Documents/21 §14.3). */
export const TICKET_TTL_SECONDS = 15 * 60;

export interface UploadRequest {
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly purpose: FilePurpose;
}

export interface UploadTicket {
  readonly fileId: string;
  readonly uploadUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

const REJECTION_MESSAGES = {
  file_type_not_allowed: {
    product_image: 'Ảnh sản phẩm phải là JPG, PNG hoặc WebP',
    attachment: 'Tệp đính kèm phải là ảnh JPG, PNG, WebP hoặc PDF',
  },
  file_too_large: {
    product_image: 'Ảnh sản phẩm tối đa 5 MB',
    attachment: 'Tệp đính kèm tối đa 10 MB',
  },
} as const;

/**
 * Cấp vé tải tệp lên (Documents/21 §5.2, §14.3): ghi dòng `core.files` rồi trả URL PUT ký sẵn. Tệp đi thẳng từ trình
 * duyệt lên kho, không qua api. Bên gọi đã kiểm quyền theo `purpose`. Mỗi lần gọi là một tệp mới.
 */
export async function createUploadTicket(
  caller: { accountId: string; companyId: string },
  request: UploadRequest,
): Promise<UploadTicket> {
  const { purpose, sizeBytes, fileName } = request;
  const contentType = request.contentType.toLowerCase();
  const rejection = rejectUpload(purpose, contentType, sizeBytes);
  if (rejection) {
    countTicket(purpose, rejection);
    throw new AppError(422, rejection, REJECTION_MESSAGES[rejection][purpose]);
  }

  const config = storageConfig();
  if (!config) {
    countTicket(purpose, 'unavailable');
    throw new AppError(503, 'storage_unavailable', 'Kho tệp chưa được cấu hình, hãy báo quản trị hệ thống');
  }

  // Không khoá: hai vé cùng lúc có thể vượt trần thêm một tệp, trần đã chừa khoảng trống dưới gói miễn phí.
  const used = await totalStoredBytes();
  if (used + sizeBytes > env.STORAGE_QUOTA_BYTES) {
    countTicket(purpose, 'quota_exceeded');
    log.warn({ used, sizeBytes, quota: env.STORAGE_QUOTA_BYTES }, 'kho tệp chạm trần dung lượng');
    throw new AppError(507, 'storage_quota_exceeded', 'Kho tệp đã đầy, hãy báo quản trị hệ thống');
  }

  const fileId = randomUUID();
  const storageKey = storageKeyOf(config.keyPrefix, fileId, contentType);
  await withCompany(caller.companyId, () =>
    insertFile({
      id: fileId,
      companyId: caller.companyId,
      storageKey,
      fileName,
      contentType,
      sizeBytes,
      purpose,
      uploadedBy: caller.accountId,
    }),
  );
  const bucket = config.buckets[PURPOSE_RULES[purpose].visibility];
  const signed = await signUpload(config, { bucket, key: storageKey, contentType, sizeBytes }, TICKET_TTL_SECONDS);
  countTicket(purpose, 'ok');
  // Không log URL: chữ ký trong đó dùng được tới khi hết hạn.
  log.info({ fileId, purpose, sizeBytes, companyId: caller.companyId }, 'cấp vé tải tệp');
  return { fileId, uploadUrl: signed.url, headers: signed.headers };
}
