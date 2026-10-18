/**
 * Lỗi nghiệp vụ có chủ đích. Middleware lỗi đổi thành Problem Details (RFC 9457).
 * `code` là định danh ổn định cho client, viết gạch dưới (vd `insufficient_stock`), `message` là câu cho người đọc.
 * Danh sách mã đã chốt với FE ở Documents/21.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extensions: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, extensions?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.extensions = extensions;
  }
}

/** Khung export đã chốt chữ ký nhưng chưa có thân: 501 `not_implemented`, ghi issue sẽ viết thân. */
export function notImplemented(fn: string, issue: string): AppError {
  return new AppError(501, 'not_implemented', `${fn} chưa làm (${issue})`);
}
