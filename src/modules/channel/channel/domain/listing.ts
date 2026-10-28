// Máy trạng thái listing (Documents/21 §18.3, sơ đồ C2), cùng bảng với FE `src/lib/machines/channel.ts`.
import { defineMachine } from '../../../core/index.ts';

export type ListingStatus =
  | 'pushing'
  | 'push_failed'
  | 'under_review'
  | 'rejected'
  | 'live'
  | 'hidden'
  | 'platform_hold'
  | 'delisted';
export type ListingAction =
  | 'push'
  | 'go_live'
  | 'send_review'
  | 'fail'
  | 'approve'
  | 'reject'
  | 'hold'
  | 'release'
  | 'hide'
  | 'unhide'
  | 'delist';

const manage = 'channel.listing.manage';

export const listingMachine = defineMachine<ListingStatus, ListingAction>([
  { from: ['push_failed', 'rejected', 'delisted', 'live', 'under_review'], to: 'pushing', action: 'push', permission: manage },
  { from: 'pushing', to: 'live', action: 'go_live', system: true },
  { from: 'pushing', to: 'under_review', action: 'send_review', system: true },
  { from: 'pushing', to: 'push_failed', action: 'fail', system: true },
  { from: 'under_review', to: 'live', action: 'approve', system: true },
  { from: 'under_review', to: 'rejected', action: 'reject', system: true },
  { from: ['live', 'hidden'], to: 'platform_hold', action: 'hold', system: true },
  { from: 'platform_hold', to: 'live', action: 'release', system: true },
  { from: 'live', to: 'hidden', action: 'hide', system: true },
  { from: 'hidden', to: 'live', action: 'unhide', system: true },
  {
    from: ['live', 'hidden', 'under_review', 'platform_hold', 'rejected', 'push_failed'],
    to: 'delisted',
    action: 'delist',
    permission: manage,
  },
]);

/** Trạng thái trên sàn đã chuẩn hoá (adapter `RemoteState`). */
export type RemoteState = 'review' | 'live' | 'rejected' | 'hold' | 'inactive' | 'deleted';

/**
 * Thao tác của sàn cần áp khi đồng bộ, null khi không đổi. Sàn tắt hay xoá sản phẩm ngoài app chưa có mũi tên trên
 * sơ đồ C2 nên để nguyên.
 */
export function syncAction(status: ListingStatus, remote: RemoteState): ListingAction | null {
  if (status === 'under_review' && remote === 'live') return 'approve';
  if (status === 'under_review' && remote === 'rejected') return 'reject';
  if ((status === 'live' || status === 'hidden') && remote === 'hold') return 'hold';
  if (status === 'platform_hold' && remote === 'live') return 'release';
  return null;
}

/** Listing kẹt `pushing` quá lâu (server chết giữa lúc gọi sàn): lần đồng bộ sau chuyển `push_failed` (§18.3). */
export const STALE_PUSH_MS = 30 * 60_000;
