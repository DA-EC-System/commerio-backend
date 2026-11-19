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
  | 'outside_hold'
  | 'outside_resolve'
  | 'delist'
  | 'update_content'
  | 'request_review'
  | 'take_over_content'
  | 'take_over_failed';

const manage = 'channel.listing.manage';
/**
 * Listing có sản phẩm trên sàn mà CEO ghi nội dung Commerio lên được (#399). Không có `hidden`: `updateProduct` bật SKU
 * trên sàn, nên phải hiện lại listing trước.
 */
export const TAKE_OVER_FROM = ['live', 'platform_hold', 'rejected', 'push_failed'] as const satisfies readonly ListingStatus[];

export const listingMachine = defineMachine<ListingStatus, ListingAction>([
  // `not_listed` không có bản ghi: đẩy lần đầu (hoặc sau khi gỡ) tạo dòng mới ở `pushing`, không qua bảng này. `delisted`
  // là trạng thái cuối (§18.3, #219).
  { from: ['push_failed', 'rejected', 'platform_hold'], to: 'pushing', action: 'push', permission: manage },
  { from: 'pushing', to: 'live', action: 'go_live', system: true },
  { from: 'pushing', to: 'under_review', action: 'send_review', system: true },
  { from: 'pushing', to: 'push_failed', action: 'fail', system: true },
  { from: 'under_review', to: 'live', action: 'approve', system: true },
  { from: 'under_review', to: 'rejected', action: 'reject', system: true },
  { from: ['live', 'hidden'], to: 'platform_hold', action: 'hold', system: true },
  { from: 'platform_hold', to: 'live', action: 'release', system: true },
  { from: 'live', to: 'hidden', action: 'hide', system: true },
  { from: 'hidden', to: 'live', action: 'unhide', system: true },
  // Sàn đổi listing ngoài app (#360, 21 §18.3): lượt đồng bộ dừng bán, CEO quyết (route kiểm vai trò CEO).
  { from: 'live', to: 'hidden', action: 'outside_hold', system: true },
  { from: 'hidden', to: 'live', action: 'outside_resolve', permission: manage },
  // Sửa nội dung (#293): sàn vẫn bán bản cũ thì giữ `live` kèm bản sửa đang duyệt; sàn ngừng bán để duyệt thì hệ thống
  // chuyển tiếp `request_review` (ca C2-23).
  { from: 'live', to: 'live', action: 'update_content', permission: manage },
  { from: 'live', to: 'under_review', action: 'request_review', system: true },
  // Ghi nội dung Commerio lên sản phẩm người bán đã ghép (#399): đi lại luồng đẩy (`channel.listing_push`); route kiểm
  // vai trò CEO và `content_source = 'platform'`.
  {
    from: [...TAKE_OVER_FROM],
    to: 'pushing',
    action: 'take_over_content',
    permission: manage,
  },
  // Lượt ghi nội dung xuất phát từ `live` lỗi (sàn từ chối, hết lượt thử, quá 30 phút): sản phẩm người bán vẫn đang bán trên
  // sàn nên về `live` (giữ `pushError`), không `push_failed` làm ngừng đẩy tồn, giá. Xuất phát từ trạng thái khác thì `fail`.
  { from: 'pushing', to: 'live', action: 'take_over_failed', system: true },
  // Người gỡ cần quyền; sàn báo đã xoá sản phẩm thì hệ thống gỡ (`actor` null, E24).
  {
    from: ['live', 'hidden', 'under_review', 'platform_hold', 'rejected', 'push_failed'],
    to: 'delisted',
    action: 'delist',
    permission: manage,
  },
]);

/** Trạng thái trên sàn đã chuẩn hoá (adapter `RemoteState`). */
export type RemoteState = 'review' | 'live' | 'rejected' | 'hold' | 'inactive' | 'deleted';

/** Trạng thái còn sản phẩm trên sàn mà sàn có thể xoá ngoài app (đồng bộ đọc để bắt `deleted`, #219). */
export const DELETABLE: readonly ListingStatus[] = ['under_review', 'live', 'hidden', 'platform_hold', 'rejected', 'push_failed'];

/**
 * Thao tác của sàn cần áp khi đồng bộ, null khi không đổi. Sàn xoá sản phẩm → `delist` (25 §6.4 "gỡ trên sàn (sàn báo
 * về)"); sàn tắt listing đang `live` → `outside_hold` (#360). Listing `hidden` mà sàn tắt là do chính app tắt: giữ nguyên.
 */
export function syncAction(status: ListingStatus, remote: RemoteState): ListingAction | null {
  if (remote === 'deleted') return DELETABLE.includes(status) ? 'delist' : null;
  if (status === 'under_review' && remote === 'live') return 'approve';
  if (status === 'under_review' && remote === 'rejected') return 'reject';
  if ((status === 'live' || status === 'hidden') && remote === 'hold') return 'hold';
  if (status === 'platform_hold' && remote === 'live') return 'release';
  if (status === 'live' && remote === 'inactive') return 'outside_hold';
  return null;
}

/**
 * Ẩn, hiện theo trạng thái SKU (#224, 25 §6.4), so mỗi lượt nên sàn lỗi thì lượt sau làm lại: SKU tạm ngừng mà listing
 * `live` (kể cả vừa được sàn duyệt, E25) → `hide`; SKU hết tạm ngừng mà listing `hidden` do app ẩn (`appHidden`: lần vào
 * `hidden` gần nhất là `hide`) → `unhide`. Listing ẩn vì lý do khác (nối lại gian hàng khi sàn đang tắt) giữ nguyên.
 */
export function visibilityAction(status: ListingStatus, paused: boolean, appHidden: boolean): ListingAction | null {
  if (status === 'live' && paused) return 'hide';
  if (status === 'hidden' && !paused && appHidden) return 'unhide';
  return null;
}

/** Listing có sản phẩm trên sàn mà đối chiếu tồn xét (25 §6.5). */
export const STOCK_RECONCILED: readonly ListingStatus[] = ['under_review', 'live', 'hidden', 'platform_hold'];

/**
 * Kết quả đối chiếu tồn một listing (25 §6.5 bước 2, #223), gọi sau khi đã lấy đơn mới. `platformStock` là số trên sàn
 * biết gần nhất (lần đẩy, hoặc lần đối chiếu trước). `match`: khớp. `push`: sàn cao hơn, đẩy giảm ngay. `wait`: sàn thấp
 * hơn lần đầu, chờ lượt sau (kể cả listing đang Lệch tồn). `drift`: sàn vẫn thấp hơn ở lượt liền sau (số sàn biết trước
 * đó đã thấp hơn số có thể bán): đẩy tăng và bật cờ Lệch tồn (`stock_sync = error`, 21 §18.6.6).
 *
 * Sàn cao hơn lần đầu chỉ đẩy giảm (US-GH-08 dòng 3). Sàn vẫn cao hơn ngay sau khi app vừa đẩy đúng số có thể bán và sàn
 * nhận lệnh (`synced`, `platformStock` = số đó, `lastPushedAt` trong `STUCK_PUSH_MS`) là `drift` (#430): đẩy lại không
 * làm sàn giảm, ghi "Đã đồng bộ" là sai (test đêm 18/11: Lazada bán tổng hai kho, app đẩy một kho; mỗi lượt đẩy lại 46 mà
 * sàn vẫn 136). Lúc khớp app không đẩy nên `lastPushedAt` cũ; kẹt thì lượt nào cũng đẩy. Vừa đẩy vì đơn rồi người bán
 * tăng tồn trên sàn cũng ra `drift` một lượt, lượt sau khớp thì hết cờ. Vẫn đẩy lại mỗi lượt.
 */
export type StockDecision = 'match' | 'push' | 'wait' | 'drift';

/** Lần đẩy trước còn tính là "lượt liền trước" (hai lượt đồng bộ 15 phút). */
export const STUCK_PUSH_MS = 30 * 60_000;

export function stockDecision(
  row: { stockSync: 'synced' | 'pending' | 'error'; platformStock: number | null; lastPushedAt?: Date | null },
  remote: number,
  available: number,
  now: Date = new Date(),
): StockDecision {
  if (remote === available) return 'match';
  if (remote > available) {
    const justPushed = row.lastPushedAt != null && now.getTime() - row.lastPushedAt.getTime() < STUCK_PUSH_MS;
    return row.stockSync === 'synced' && row.platformStock === available && justPushed ? 'drift' : 'push';
  }
  if (row.platformStock !== null && row.platformStock < available) return 'drift';
  return 'wait';
}

/** Listing kẹt `pushing` quá lâu (server chết giữa lúc gọi sàn): lần đồng bộ sau chuyển `push_failed` (§18.3). */
export const STALE_PUSH_MS = 30 * 60_000;

/** Bỏ ghép chờ duyệt (#220; CHECK `listings_pending_mapping`: bốn cột cùng rỗng), kể cả SKU sàn chờ ghép (#346). */
export const NO_PENDING = {
  pendingVariantId: null,
  pendingMode: null,
  pendingRequestedBy: null,
  pendingRequestedAt: null,
  pendingExternalSkuId: null,
  pendingExternalProductId: null,
  pendingSellerSku: null,
} as const;
/** Bỏ dấu "sàn đổi ngoài app" (#360; CHECK `listings_outside_change`: ba cột cùng rỗng khi rời `hidden`). */
export const NO_OUTSIDE_CHANGE = { outsideChangeKind: null, outsideChangePrice: null, outsideChangeAt: null } as const;

/** Trạng thái còn giữ bản sửa nội dung chờ sàn duyệt (#293): sàn vẫn duyệt bản sửa trong lúc ẩn hay khoá. */
export const REVISION_KEPT: readonly ListingStatus[] = ['live', 'hidden', 'platform_hold'];
export const NO_REVISION = { revisionStatus: null, revisionRejectReason: null, revisionAt: null } as const;

/** Lý do khi sàn từ chối (sản phẩm hay bản sửa nội dung) mà không ghi câu nào. */
export const NO_REASON = 'Sàn từ chối, không ghi lý do';
/** Lý do ghi lịch sử khi ghép chờ bị bỏ vì listing đã gỡ (CHECK `listings_delisted_no_pending`, #220 đợt 2). */
export const DELISTED_REASON = 'Listing đã gỡ, bỏ ghép chờ duyệt';
/** Dòng tạo ra chỉ để chờ duyệt "không quản tồn" của SKU chưa ghép (chưa có ghép hiệu lực). */
export const pendingOnly = (r: { mode: 'mapped' | 'unmanaged'; approvedBy: string | null }): boolean => r.mode === 'unmanaged' && !r.approvedBy;
