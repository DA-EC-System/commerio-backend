// Bản sao SKU sàn của gian hàng (#220 đợt 2; Documents/21 §18.3 "SKU đang có trên sàn, đọc từ lần đồng bộ gần nhất").
// Trang ghép, kiểm SKU khi ghép và số SKU chưa ghép đọc bảng `remote_skus`, không gọi sàn mỗi lần mở trang. Làm mới:
// - đọc trọn (`listSkus` có nhãn): thiết lập, nút Tải lại và lần mở trang đầu tiên (chạy nền, việc
//   `channel.remote_skus_refresh`, #361), và mỗi ngày một lần;
// - đọc sản phẩm sửa từ lần trước (`listSkusChanged`): sau lượt `channel.listing_sync` (15 phút), tối đa mỗi giờ một lần
//   (review #309 vòng 2 N2, `CHANGED_EVERY_MS`).
// Số lời gọi Lazada mỗi gian hàng mỗi ngày: 24 lượt theo giờ sửa × 1 trang (≤ 50 sản phẩm sửa trong một giờ) + 1 lần đọc
// trọn chia theo ngày tạo (đo bằng sàn giả: 305 sản phẩm tạo cách nhau 48 giờ 21 lời gọi, cách 1 giờ 41; 1000 sản phẩm
// 47; ≤ 50 sản phẩm 1) ≈ 45–65, thay vì 96 lượt × 2 (`all`, `deleted`) = 192. 45 gian hàng ≈ 2 000–2 900 trên hạn mức
// chung 9 000. Đọc trọn lỗi thì thử lại sau 1, 2, 4, 8, 16 giờ (tối đa 24): thêm tối đa 5 lần đọc trọn mỗi ngày (≈ 205
// lời gọi với 41 lời gọi một lần), thay vì đọc trọn mỗi 15 phút (≈ 96 × 7 = 670; review vòng 3 R1). Bấm Tải lại thêm một
// lần đọc trọn, cách nhau ít nhất 60 giây.
// Mọi lời gọi đi qua `call` của adapter nên tính vào hạn mức gọi sàn trong ngày (Lazada `channel.api_usage`, TikTok
// `reserveCall`); hết hạn mức thì `daily_call_limit` như mọi lời gọi khác.
import { withCompany, withSessionLock } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import type { JobAttempt } from '../../../core/index.ts';
import { findShopRow, type ShopRow } from '../repository/shops.ts';
import {
  clearRefreshRequested,
  markRefreshRequested,
  countRemoteSkusSeenSince,
  dropRemoteSkusNotSeen,
  markRemoteSkus,
  recordFullReadFailure,
  recordManualReadFailure,
  upsertRemoteSkus,
} from '../repository/remote-skus.ts';
import type { RemoteSkusFullError } from '../domain/remote-skus-refresh.ts';
import type { RemoteSku } from './marketplaces/common.ts';
import { asManual } from './marketplaces/index.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { syncChangedCategories, watchedProductIds } from './listing-sync.ts';
import type { ProductPort } from './product-port.ts';
import { sendRemoteSkusRefresh } from './shop-jobs.ts';
import { onMarketplace, shopSession } from './shops.ts';

/** Bấm Tải lại trong khoảng này sau lần đọc trọn trước thì trả bản sao, không gọi sàn. */
export const REFRESH_COOLDOWN_MS = 60_000;
/** Lần đọc trọn cách quá khoảng này thì lượt làm mới định kỳ đọc trọn (dọn chỗ đọc theo giờ sửa có thể sót). */
export const FULL_REFRESH_EVERY_MS = 24 * 3600_000;
/** Lượt đọc theo giờ sửa cách lần đọc trước ít hơn khoảng này thì bỏ (giữ hạn mức gọi sàn chung của app). */
export const CHANGED_EVERY_MS = 3600_000;
/** Lùi mốc đọc theo giờ sửa, như kéo đơn: giờ của sàn và của app lệch nhau, sàn ghi giờ sửa trễ. */
const CHANGED_LAG_MS = 2 * 60_000;
/**
 * Mốc đọc theo giờ sửa giữ lại cho sản phẩm cần category chưa đọc được (review BE2 P2-1) không cũ quá khoảng này: lỗi cấu hình
 * (thiếu scope, sai chữ ký) làm mọi lần đều dừng thì mốc đứng yên mãi, mỗi lượt đọc lại cả khoảng. Quá thì bỏ, mốc tiến như cũ.
 */
export const CHANGED_HOLD_MAX_MS = 24 * 3600_000;

/** 429 `remote_skus_retry_later`; route đặt header `Retry-After` theo `retryAfterSeconds`. */
export class RemoteSkusRetryLater extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(429, 'remote_skus_retry_later', `Lần tải danh sách SKU trước bị lỗi, thử lại sau ${Math.ceil(retryAfterSeconds / 60)} phút`, {
      retryAfterSeconds,
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
const lockKey = (shopId: string) => `channel.remote_skus:${shopId}`;

/**
 * Lưu trọn danh sách vừa đọc (gọi trong `withCompany`): SKU không còn trên sàn bị xoá, đặt cả hai mốc. Chỉ gọi khi adapter
 * đã đọc đủ mọi trang không lỗi (`listSkus` ném `incomplete_list`, `unexpected_response` thay vì trả thiếu).
 *
 * Sàn trả rỗng trong khi bản sao còn SKU đã thấy từ lần đọc trọn trước thì không xoá, ghi cảnh báo (review #309 vòng 2
 * N1): rỗng bất thường hay gặp ở lỗi sàn hơn là gian hàng xoá hết. Lần đọc trọn sau vẫn rỗng (các dòng không được thấy từ
 * lần rỗng đó) thì xoá: gian hàng thật sự không còn SKU nào.
 */
export async function saveFullSnapshot(shopId: string, skus: readonly RemoteSku[], startedAt: Date): Promise<void> {
  const shop = await findShopRow(shopId);
  const prev = shop?.remoteSkusSyncedAt;
  const suspicious = skus.length === 0 && prev ? await countRemoteSkusSeenSince(shopId, prev) : 0;
  await upsertRemoteSkus(shopId, skus, startedAt);
  if (suspicious > 0) {
    logger.warn({ shopId, kept: suspicious }, 'Sàn trả danh sách SKU rỗng, giữ bản sao tới lần đọc trọn sau');
  } else {
    await dropRemoteSkusNotSeen(shopId, startedAt);
  }
  // Đọc trọn không áp category (`syncChangedCategories`) nên không đẩy mốc đọc theo giờ sửa: sản phẩm sửa từ lần đọc theo giờ
  // sửa trước vẫn được đọc lại để lấy category (review BE2 P2-1). Chưa có mốc (lần đầu) thì đặt bằng lúc đọc.
  const changedSince = shop?.remoteSkusChangedSince && shop.remoteSkusChangedSince < startedAt ? shop.remoteSkusChangedSince : startedAt;
  await markRemoteSkus(shopId, { syncedAt: startedAt, changedSince });
}

/**
 * Xếp lượt Tải lại chạy nền (#361; Documents/21 §18.3): đánh dấu lượt chờ và xếp `channel.remote_skus_refresh` cùng giao
 * dịch của bên gọi (gọi trong `withCompany`; rollback thì không còn việc). Gian hàng không gọi được sàn (ngắt, mất token):
 * 409 `shop_not_connected`, không xếp. Đã có việc chờ cùng gian hàng thì pg-boss không thêm (`stately`). Trả lúc đánh dấu.
 */
export async function requestRemoteSkusRefresh(shop: ShopRow): Promise<Date> {
  if ((shop.status !== 'connecting' && shop.status !== 'active') || !shop.accessTokenEnc) {
    throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối hoặc cần kết nối lại', { current: shop.status });
  }
  const at = new Date();
  await markRefreshRequested(shop.id, at);
  await sendRemoteSkusRefresh(shop.companyId, shop.id);
  return at;
}

/**
 * Lượt định kỳ sau `channel.listing_sync`: chưa có bản sao hoặc lần đọc trọn quá `FULL_REFRESH_EVERY_MS` thì đọc trọn,
 * lần đọc trước (trọn hay theo giờ sửa) chưa quá `CHANGED_EVERY_MS` thì thôi, không thì đọc sản phẩm sửa từ mốc.
 * Đọc trọn lỗi thì ghi mốc thử lại vào `shops` (1 giờ, 2 giờ, … tối đa 24 giờ; review vòng 3 R1): tới mốc mới đọc trọn
 * lại, giữa chừng vẫn đọc theo giờ sửa. Tải lại (`runRemoteSkusRefresh`) không chờ mốc. Lượt khác đang chạy thì bỏ. Mọi lỗi chỉ ghi log: không làm hỏng lượt đồng bộ.
 */
export async function refreshRemoteSkusQuietly(companyId: string, shopId: string, port?: ProductPort): Promise<void> {
  try {
    await withSessionLock(lockKey(shopId), async () => {
      const shop = await withCompany(companyId, () => findShopRow(shopId));
      if (!shop) return;
      const synced = shop.remoteSkusSyncedAt?.getTime();
      const since = shop.remoteSkusChangedSince;
      const fullDue = synced === undefined || !since || Date.now() - synced > FULL_REFRESH_EVERY_MS;
      const waiting = shop.remoteSkusFullRetryAt !== null && shop.remoteSkusFullRetryAt.getTime() > Date.now();
      if (fullDue && !waiting) {
        try {
          return await readFull(companyId, shopId);
        } catch (err) {
          await withCompany(companyId, () => recordFullReadFailure(shopId, fullErrorOf(err)));
          throw err;
        }
      }
      // Đọc trọn đang chờ mốc thử lại: vẫn đọc theo giờ sửa nếu đã có bản sao.
      if (synced === undefined || !since) return;
      if (Date.now() - since.getTime() < CHANGED_EVERY_MS) return;
      const session = await withCompany(companyId, () => shopSession(shopId));
      if (!session.adapter.listSkusChanged) return readFull(companyId, shopId, session);
      await readChanged(companyId, shop, session, port);
    });
  } catch (err) {
    logger.warn(
      { shopId, code: err instanceof AppError ? err.code : undefined, err: err instanceof AppError ? undefined : err },
      'Không làm mới được bản sao SKU sàn',
    );
  }
}

/**
 * Lỗi của lần đọc trọn để lưu ở `shops.remote_skus_full_error` (#361): mã app, mã sàn, câu của BE. Không chép câu thô của
 * sàn hay lỗi không rõ (có thể mang URL ký, token).
 */
export function fullErrorOf(err: unknown): RemoteSkusFullError {
  if (err instanceof AppError) {
    const platformCode = err.extensions?.platformCode;
    return { code: err.code, platformCode: typeof platformCode === 'string' ? platformCode : null, message: err.message };
  }
  return { code: 'internal_error', platformCode: null, message: 'Lỗi không rõ khi tải danh sách SKU trên sàn' };
}

/** Lỗi không nên thử lại trong cùng lượt Tải lại: ghi lỗi ngay (#361 A5). */
const FINAL_CODES = new Set(['marketplace_unauthorized', 'marketplace_unsupported', 'shop_not_connected', 'not_found']);
const FINAL_PLATFORM_CODES = new Set(['daily_call_limit', 'company_call_limit']);
const retryable = (err: unknown): boolean => {
  if (!(err instanceof AppError)) return true;
  const { code, platformCode } = fullErrorOf(err);
  return !FINAL_CODES.has(code) && !(platformCode && FINAL_PLATFORM_CODES.has(platformCode));
};

/** Chờ lượt làm mới khác của cùng gian hàng trong việc nền Tải lại; hết hạn thì ném để pg-boss chạy lại. */
const REFRESH_LOCK_WAIT_MS = 5 * 60_000;

/**
 * Việc nền `channel.remote_skus_refresh` (#361; Documents/21 §18.3): lượt Tải lại xếp từ `POST remote-skus/refresh` hoặc lần
 * mở trang ghép đầu tiên. Trong khoá phiên của bản sao:
 * - không còn lượt chờ (`remote_skus_refresh_requested_at` null), hoặc lượt định kỳ đã đọc trọn sau lúc bấm: xoá lượt chờ,
 *   không gọi sàn;
 * - đã có bản sao và sàn đọc được theo giờ sửa: đọc sản phẩm sửa từ mốc trước (một lời gọi thường đủ), lưu, để SKU vừa tạo
 *   trên sàn ghép được kể cả khi lần đọc trọn sau đó lỗi (shop thử dùng chung hay trả `incomplete_list`);
 * - đọc trọn, lưu, xoá lượt chờ, ghi log thời gian để đo trên staging.
 * Lời gọi sàn tính hạn mức như bấm tay (`asManual`, dừng ở 90%). Lỗi: lần cuối, hoặc lỗi không nên thử lại (mất token, ngắt,
 * hết hạn mức) thì ghi giờ lỗi, mã lỗi, xoá lượt chờ và không ném; còn lại ném để pg-boss chạy lại sau 30 giây.
 */
export async function runRemoteSkusRefresh(job: { companyId: string; shopId: string }, attempt: JobAttempt, port?: ProductPort): Promise<void> {
  const { companyId, shopId } = job;
  const result = await withSessionLock(
    lockKey(shopId),
    async () => {
      const shop = await withCompany(companyId, () => findShopRow(shopId));
      const requestedAt = shop?.remoteSkusRefreshRequestedAt;
      if (!shop || !requestedAt) return;
      if (shop.remoteSkusSyncedAt && shop.remoteSkusSyncedAt.getTime() >= requestedAt.getTime()) {
        await withCompany(companyId, () => clearRefreshRequested(shopId));
        return;
      }
      try {
        const { ms, skus } = await asManual(async () => {
          const session = await withCompany(companyId, () => shopSession(shopId));
          await readChanged(companyId, shop, session, port);
          return readFull(companyId, shopId, session);
        });
        await withCompany(companyId, () => clearRefreshRequested(shopId));
        logger.info({ shopId, ms, skus, attempt: attempt.attempt }, 'remote_skus_refresh xong');
      } catch (err) {
        if (!attempt.lastAttempt && retryable(err)) throw err;
        const error = fullErrorOf(err);
        await withCompany(companyId, () => recordManualReadFailure(shopId, error));
        logger.warn(
          { shopId, code: error.code, platformCode: error.platformCode, attempt: attempt.attempt, err: err instanceof AppError ? undefined : err },
          'remote_skus_refresh lỗi',
        );
      }
    },
    { waitMs: REFRESH_LOCK_WAIT_MS },
  );
  if (result === 'busy') throw new Error('Lượt làm mới bản sao SKU sàn khác của gian hàng đang chạy');
}

type Session = Awaited<ReturnType<typeof shopSession>>;

/**
 * Đọc sản phẩm sửa từ `remote_skus_changed_since` trừ 2 phút rồi lưu; chưa có bản sao hay sàn không có thì thôi. Có `port` thì
 * áp category sàn trả kèm (`syncChangedCategories`, #400 lát 13: TikTok đọc category bằng Get Product của chính sản phẩm vừa
 * sửa, tối đa `DETAIL_PRODUCT_MAX` sản phẩm mỗi lần như nhãn biến thể); lỗi khi áp chỉ ghi log, không làm hỏng lượt đọc.
 *
 * Mốc sau (review BE2 P2-1): có `port` thì sản phẩm đang có listing đi trước khi cắt trần (`priorityProductIds`, theo giờ sửa
 * tăng dần); sản phẩm đó chưa đọc được chi tiết (vượt trần, sàn dừng giữa chừng: `detailUnreadSince`) thì mốc chỉ tiến tới
 * giờ sửa sớm nhất của chúng; áp category lỗi thì mốc giữ nguyên. Mốc không lùi, không cũ quá `CHANGED_HOLD_MAX_MS`. Sản
 * phẩm không có listing chưa đọc được nhãn thì như cũ (không giữ mốc, nhãn có ở lần sửa sau hay lần đọc trọn). Mốc đang
 * giữ cũ hơn `CHANGED_EVERY_MS` thì lượt đồng bộ kế (15 phút) đọc lại ngay.
 */
async function readChanged(companyId: string, shop: ShopRow, { adapter, accessToken }: Session, port?: ProductPort): Promise<void> {
  const since = shop.remoteSkusChangedSince;
  if (!shop.remoteSkusSyncedAt || !since || !adapter.listSkusChanged) return;
  const startedAt = new Date();
  const priority = port ? await withCompany(companyId, () => watchedProductIds(shop.id)) : undefined;
  const changed = await onMarketplace(() =>
    adapter.listSkusChanged!(accessToken, new Date(since.getTime() - CHANGED_LAG_MS), priority && { priorityProductIds: priority }),
  );
  await withCompany(companyId, () => upsertRemoteSkus(shop.id, changed, startedAt));
  let next = startedAt;
  if (port && priority) {
    try {
      await syncChangedCategories(port, companyId, shop, changed);
      for (const s of changed) {
        if (s.detailUnreadSince && priority.has(s.externalProductId) && s.detailUnreadSince < next) next = s.detailUnreadSince;
      }
    } catch (err) {
      logger.warn({ shopId: shop.id, err }, 'Không cập nhật được category của listing từ SKU sàn vừa sửa, giữ mốc đọc');
      next = since;
    }
    if (next < since) next = since;
    if (next.getTime() < startedAt.getTime() - CHANGED_HOLD_MAX_MS) {
      logger.warn({ shopId: shop.id, heldSince: next }, 'Mốc đọc theo giờ sửa giữ quá lâu, bỏ: category của sản phẩm chưa đọc được cập nhật ở lần sửa sau');
      next = startedAt;
    } else if (next !== startedAt) {
      logger.info({ shopId: shop.id, heldSince: next }, 'Giữ mốc đọc theo giờ sửa: còn sản phẩm có listing chưa đọc được category');
    }
  }
  await withCompany(companyId, () => markRemoteSkus(shop.id, { changedSince: next }));
}

/** Đọc trọn rồi lưu bản sao; trả thời gian gọi sàn và số SKU sàn trả. */
async function readFull(companyId: string, shopId: string, session?: Session): Promise<{ ms: number; skus: number }> {
  const { adapter, accessToken } = session ?? (await withCompany(companyId, () => shopSession(shopId)));
  if (!adapter.listSkus) throw new AppError(422, 'marketplace_unsupported', 'Sàn này chưa đọc được danh sách SKU của gian hàng');
  const startedAt = new Date();
  const skus = await onMarketplace(() => adapter.listSkus!(accessToken, { labels: true }));
  const ms = Date.now() - startedAt.getTime();
  await withCompany(companyId, () => saveFullSnapshot(shopId, skus, startedAt));
  return { ms, skus: skus.length };
}
