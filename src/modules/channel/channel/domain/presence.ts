// Hiện diện của một SKU trên sàn, gộp từ các listing của nó (#204 D8, Thành sửa 16/11/2026 theo Documents/25 §5.1).
// Catalog nhận qua `ctx.listingPresenceOf` để dựng nhãn; giá trị trùng `Presence` của `catalog/domain/labels.ts`.
import type { ListingStatus } from './listing.ts';

export type ListingPresence = 'live' | 'error' | 'pending' | 'not_listed';

/** Listing lỗi: hiện nhãn phụ "Có lỗi" kể cả khi SKU đã `live` ở gian hàng khác. */
const ERROR: readonly ListingStatus[] = ['push_failed', 'rejected', 'platform_hold'];
const PENDING: readonly ListingStatus[] = ['pushing', 'under_review'];

/**
 * `live` > `error` > `pending` > `not_listed`. `hidden` không tính là `live`; `delisted` không tính gì (dòng đã gỡ).
 * `hasListingError` có listing lỗi, độc lập với `presence`.
 */
export function presenceOf(statuses: readonly ListingStatus[]): { presence: ListingPresence; hasListingError: boolean } {
  const hasListingError = statuses.some((s) => ERROR.includes(s));
  const presence = statuses.includes('live')
    ? 'live'
    : hasListingError
      ? 'error'
      : statuses.some((s) => PENDING.includes(s))
        ? 'pending'
        : 'not_listed';
  return { presence, hasListingError };
}
