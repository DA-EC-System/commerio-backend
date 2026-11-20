// Tải ảnh nguồn từ URL người dùng đưa (sàn chỉ nhận file, vd TikTok upload-product-image-202309) và tệp vận đơn của sàn. Lõi
// chống SSRF (ghim địa chỉ đã kiểm, chặn địa chỉ riêng, trần byte, chuyển hướng) ở `src/shared/net/safe-download.ts` (#498);
// file này chỉ đặt luật theo việc và đổi lỗi sang `MarketplaceError`.
import { type SafeDownloadOptions, safeDownload } from '../../../../../shared/net/safe-download.ts';
import { MarketplaceError } from './common.ts';

export { isPrivateAddress } from '../../../../../shared/net/safe-download.ts';

/** Ảnh tối đa 10MB (upload-product-image-202309). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type ImageSourceOptions = Omit<SafeDownloadOptions, 'trustedOrigin'>;

export interface DocumentSourceOptions extends ImageSourceOptions {
  /** Origin từ cấu hình của sàn, cho phép tải từ sàn giả lập cục bộ. */
  trustedOrigin?: string;
}

export interface DownloadedImage {
  bytes: Buffer;
  type: string;
  name: string;
}

/**
 * Tải ảnh nguồn an toàn. Lỗi nào cũng là `rejected` `image_source_invalid` kèm câu cho người dùng; không lộ địa chỉ đã
 * phân giải hay lỗi mạng chi tiết.
 */
export async function downloadImage(source: string, opts: ImageSourceOptions = {}): Promise<DownloadedImage> {
  const { bytes, type, url } = await safeDownload(source, opts, {
    accept: 'image/*',
    isType: (type) => type.startsWith('image/'),
    maxBytes: MAX_IMAGE_BYTES,
    error: (why) => new MarketplaceError('rejected', 'image_source_invalid', why),
  });
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.split('/').pop() || 'image') || 'image';
  } catch {
    name = 'image';
  }
  return { bytes, type, name };
}

function documentError() {
  return new MarketplaceError('unavailable', 'document_download_failed', 'Sàn trả tệp vận đơn hỏng, thử lại sau');
}

export async function downloadDocument(source: string, opts: DocumentSourceOptions = {}): Promise<Uint8Array> {
  const { bytes } = await safeDownload(source, opts, {
    accept: 'application/pdf',
    isType: (type) => type === 'application/pdf',
    maxBytes: MAX_DOCUMENT_BYTES,
    httpsOnly: true,
    error: documentError,
  });
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw documentError();
  return bytes;
}

