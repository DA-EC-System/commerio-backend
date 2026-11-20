// Đưa ảnh từ URL bên ngoài (ảnh sản phẩm trên sàn khi ghép SKU, #498) vào kho tệp, như một tệp người dùng tải lên.
import { randomUUID } from 'node:crypto';
import { env } from '../../../../shared/config/env.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { type SafeDownloadOptions, safeDownload } from '../../../../shared/net/safe-download.ts';
import { type FilePurpose, PURPOSE_RULES, rejectUpload, storageKeyOf } from '../domain/upload-rules.ts';
import { insertFile, markUploaded, totalStoredBytes } from '../repository/files.ts';
import { putObject, storageConfig } from './storage.ts';

const log = logger.child({ module: 'files' });

/** Kiểu sàn trả mà không chuẩn (Lazada `image/jpg`, đo 20/11/2026) → kiểu chuẩn. */
const TYPE_ALIASES: Readonly<Record<string, string>> = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg' };
const FILE_NAME_MAX = 200;

let downloadOptions: SafeDownloadOptions = {};

/** Test cho tải từ server cục bộ (`allowAddress`); `null` trả về mặc định (chỉ địa chỉ công khai). */
export function setRemoteImageOptions(opts: SafeDownloadOptions | null): void {
  downloadOptions = opts ?? {};
}

class Skip extends Error {}

function fileNameOf(url: URL, contentType: string): string {
  let name = 'image';
  try {
    name = decodeURIComponent(url.pathname.split('/').pop() || '') || 'image';
  } catch {
    // giữ tên mặc định
  }
  name = name.split('~')[0]!.slice(0, FILE_NAME_MAX) || 'image';
  return /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.${contentType === 'image/png' ? 'png' : 'jpg'}`;
}

/**
 * Tải ảnh từ `url` (http/https, địa chỉ công khai, ghim địa chỉ đã kiểm, 15 giây, đọc tối đa trần của `purpose`) rồi lưu như
 * tệp tải lên của công ty: kiểu, cỡ theo luật **hiện hành** của `purpose` (`rejectUpload`; không đổi cỡ, nén ảnh), trong trần
 * `STORAGE_QUOTA_BYTES`. Ghi dòng `core.files` (`uploaded_by` null: hệ thống) trước, PUT lên kho, rồi ghi `uploaded_at`: PUT
 * lỗi thì dòng nằm lại như vé chưa dùng. Trả id tệp, hoặc `null` khi không được (URL hỏng, sàn lỗi, sai kiểu, quá cỡ, kho đầy,
 * kho chưa cấu hình) kèm log `warn` chỉ có host, không có URL (link sàn có thể mang chữ ký). Không ném: ảnh lỗi bỏ qua. Gọi
 * **ngoài** giao dịch (có lời gọi mạng).
 */
export async function ingestRemoteImage(companyId: string, url: string, purpose: FilePurpose): Promise<string | null> {
  const rule = PURPOSE_RULES[purpose];
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    // URL hỏng: safeDownload báo
  }
  try {
    const config = storageConfig();
    if (!config) throw new Skip('kho chưa cấu hình');
    const downloaded = await safeDownload(url, downloadOptions, {
      accept: rule.contentTypes.join(', '),
      isType: (type) => (TYPE_ALIASES[type] ?? type).startsWith('image/'),
      maxBytes: rule.maxBytes,
      error: (why) => new Skip(why),
    });
    const contentType = TYPE_ALIASES[downloaded.type] ?? downloaded.type;
    const sizeBytes = downloaded.bytes.byteLength;
    const rejection = rejectUpload(purpose, contentType, sizeBytes);
    if (rejection) throw new Skip(rejection);
    if ((await totalStoredBytes()) + sizeBytes > env.STORAGE_QUOTA_BYTES) throw new Skip('storage_quota_exceeded');
    const fileId = randomUUID();
    const storageKey = storageKeyOf(config.keyPrefix, fileId, contentType);
    await withCompany(companyId, () =>
      insertFile({ id: fileId, companyId, storageKey, fileName: fileNameOf(downloaded.url, contentType), contentType, sizeBytes, purpose, uploadedBy: null }),
    );
    await putObject(config, { bucket: config.buckets[rule.visibility], key: storageKey, contentType, body: downloaded.bytes });
    await withCompany(companyId, () => markUploaded([fileId]));
    log.info({ fileId, purpose, sizeBytes, companyId, host }, 'đưa ảnh từ ngoài vào kho');
    return fileId;
  } catch (err) {
    log.warn({ companyId, purpose, host, reason: err instanceof Skip ? err.message : String(err) }, 'không đưa được ảnh từ ngoài vào kho');
    return null;
  }
}
