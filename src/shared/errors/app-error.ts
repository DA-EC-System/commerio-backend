/**
 * Lỗi nghiệp vụ có chủ đích. Middleware lỗi đổi thành Problem Details (RFC 9457).
 * `code` là định danh ổn định cho client (vd `stock-insufficient`), `message` là câu cho người đọc.
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
