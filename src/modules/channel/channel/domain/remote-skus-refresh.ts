// Trạng thái lượt Tải lại SKU sàn chạy nền (#361; Documents/21 §18.3 `remote-skus` trường `refresh`). Hàm thuần: đọc hai
// mốc trên `shops` (`remote_skus_refresh_requested_at`, `remote_skus_full_failed_at`) và lỗi đã lưu
// (`remote_skus_full_error`), không đọc bảng việc của pg-boss (pg-boss dọn việc cũ, core không mở hàm đọc việc).

/** Lượt Tải lại chờ hoặc chạy quá khoảng này mà chưa xong (worker chết, việc mất) thì coi là kẹt: `refresh_stale`. */
export const REFRESH_STALE_MS = 15 * 60_000;
/** Trong khoảng này sau lần đọc trọn lỗi gần nhất thì Tải lại trả 429, `refresh` báo `failed` (review #309 vòng 4 B2). */
export const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

/** Lỗi của lần đọc trọn gần nhất, lưu ở `shops.remote_skus_full_error`. `message` là câu của BE, không phải câu thô của sàn. */
export interface RemoteSkusFullError {
  code: string;
  platformCode?: string | null;
  message: string;
}

export interface RefreshState {
  status: 'idle' | 'running' | 'failed';
  requestedAt: Date | null;
  error: { code: string; platformCode: string | null; message: string } | null;
  retryAfterSeconds: number | null;
}

export interface RefreshMarks {
  remoteSkusRefreshRequestedAt: Date | null;
  remoteSkusFullFailedAt: Date | null;
  remoteSkusFullError: RemoteSkusFullError | null;
}

/**
 * - Có lượt chờ chưa quá `REFRESH_STALE_MS`: `running`; quá thì `failed` mã `refresh_stale` (bấm Tải lại được ngay).
 * - Không có lượt chờ mà đọc trọn (Tải lại hay định kỳ) lỗi chưa quá `RETRY_AFTER_FAILURE_MS`: `failed` kèm lỗi đã lưu và
 *   số giây còn phải chờ.
 * - Còn lại `idle`.
 */
export function refreshState(shop: RefreshMarks, now: Date = new Date()): RefreshState {
  const requestedAt = shop.remoteSkusRefreshRequestedAt;
  if (requestedAt) {
    if (now.getTime() - requestedAt.getTime() < REFRESH_STALE_MS) {
      return { status: 'running', requestedAt, error: null, retryAfterSeconds: null };
    }
    return {
      status: 'failed',
      requestedAt,
      error: { code: 'refresh_stale', platformCode: null, message: 'Quá 15 phút chưa tải xong danh sách SKU, bấm Tải lại' },
      retryAfterSeconds: null,
    };
  }
  const failedAt = shop.remoteSkusFullFailedAt;
  const left = failedAt ? failedAt.getTime() + RETRY_AFTER_FAILURE_MS - now.getTime() : 0;
  if (left > 0) {
    const saved = shop.remoteSkusFullError;
    return {
      status: 'failed',
      requestedAt: null,
      error: saved
        ? { code: saved.code, platformCode: saved.platformCode ?? null, message: saved.message }
        : { code: 'marketplace_unavailable', platformCode: null, message: 'Lần tải danh sách SKU trước bị lỗi' },
      retryAfterSeconds: Math.ceil(left / 1000),
    };
  }
  return { status: 'idle', requestedAt: null, error: null, retryAfterSeconds: null };
}
