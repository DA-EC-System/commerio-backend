// Luật tải tệp lên theo mục đích (Documents/21 §5.3, §14.3). Thuần: không I/O.

export const FILE_PURPOSES = ['product_image', 'attachment'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

const MB = 1024 * 1024;

/** Đuôi tệp theo kiểu: tên tệp trên kho có đuôi để Cloudflare cache ảnh (cache mặc định theo đuôi tệp). */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

interface PurposeRule {
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
  /** Bucket công khai (link cố định, có cache) hay bucket riêng (chỉ xem qua link ký sẵn). */
  readonly visibility: 'public' | 'private';
}

/** MVP không nhận video (Documents/21 §14.3, Documents/25 §13). */
export const PURPOSE_RULES: Readonly<Record<FilePurpose, PurposeRule>> = {
  product_image: { contentTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * MB, visibility: 'public' },
  attachment: {
    contentTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * MB,
    visibility: 'private',
  },
};

export type UploadRejection = 'file_type_not_allowed' | 'file_too_large';

/** Lý do từ chối một tệp sắp tải lên, `null` khi hợp lệ. Kiểm kiểu trước cỡ. */
export function rejectUpload(purpose: FilePurpose, contentType: string, sizeBytes: number): UploadRejection | null {
  const rule = PURPOSE_RULES[purpose];
  if (!rule.contentTypes.includes(contentType.toLowerCase())) return 'file_type_not_allowed';
  if (sizeBytes > rule.maxBytes) return 'file_too_large';
  return null;
}

/**
 * Tên tệp trên kho: `<tiền tố môi trường>/<id tệp>.<đuôi>`. Không chứa tên tệp người dùng gửi (tên gốc lưu ở
 * `file_name`) nên không cần lọc ký tự lạ, và không lộ công ty trong link ảnh công khai.
 */
export function storageKeyOf(prefix: string, fileId: string, contentType: string): string {
  const extension = EXTENSIONS[contentType.toLowerCase()];
  if (!extension) throw new Error(`Kiểu tệp chưa có đuôi: ${contentType}`);
  return `${prefix}/${fileId}.${extension}`;
}
