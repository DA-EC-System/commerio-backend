// Bản sao SKU sàn của gian hàng (#220 đợt 2; Documents/21 §18.3 "SKU đang có trên sàn, đọc từ lần đồng bộ gần nhất").
// Trang ghép, kiểm SKU khi ghép và số SKU chưa ghép đọc bảng `remote_skus`, không gọi sàn mỗi lần mở trang. Làm mới:
// - đọc trọn (`listSkus` có nhãn): thiết lập, nút Tải lại, lần mở trang đầu tiên, và mỗi ngày một lần;
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
import { findShopRow } from '../repository/shops.ts';
import {
  countRemoteSkusSeenSince,
  dropRemoteSkusNotSeen,
  markRemoteSkus,
  recordFullReadFailure,
  recordManualReadFailure,
  upsertRemoteSkus,
} from '../repository/remote-skus.ts';
import type { RemoteSku } from './marketplaces/common.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { onMarketplace, shopSession } from './shops.ts';

/** Bấm Tải lại trong khoảng này sau lần đọc trọn trước thì trả bản sao, không gọi sàn. */
export const REFRESH_COOLDOWN_MS = 60_000;
/** Lần đọc trọn cách quá khoảng này thì lượt làm mới định kỳ đọc trọn (dọn chỗ đọc theo giờ sửa có thể sót). */
export const FULL_REFRESH_EVERY_MS = 24 * 3600_000;
/** Lượt đọc theo giờ sửa cách lần đọc trước ít hơn khoảng này thì bỏ (giữ hạn mức gọi sàn chung của app). */
export const CHANGED_EVERY_MS = 3600_000;
/** Lùi mốc đọc theo giờ sửa, như kéo đơn: giờ của sàn và của app lệch nhau, sàn ghi giờ sửa trễ. */
const CHANGED_LAG_MS = 2 * 60_000;
/** Tải lại trong khoảng này sau lần đọc trọn lỗi gần nhất thì 429 kèm `Retry-After` (review #309 vòng 4 B2). */
export const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

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
/** Chờ lượt làm mới khác của cùng gian hàng (Tải lại trong request). */
const LOCK_WAIT_MS = 30_000;

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
  await markRemoteSkus(shopId, { syncedAt: startedAt, changedSince: startedAt });
}

/**
 * Đọc trọn ngay (Tải lại, lần mở trang đầu). `cooldown`: lần đọc trọn trước còn trong `REFRESH_COOLDOWN_MS` thì thôi.
 * Lần đọc trọn lỗi gần nhất (định kỳ hay Tải lại) còn trong `RETRY_AFTER_FAILURE_MS` thì 429 `remote_skus_retry_later`
 * kèm số giây chờ, không gọi sàn; không chờ mốc giãn của lượt định kỳ.
 * Lượt khác đang làm mới thì chờ nó xong rồi dùng kết quả. Lỗi sàn ném như mọi lời gọi sàn trong request.
 */
export async function refreshRemoteSkusNow(companyId: string, shopId: string, opts: { cooldown: boolean }): Promise<void> {
  const result = await withSessionLock(
    lockKey(shopId),
    async () => {
      const shop = await withCompany(companyId, () => findShopRow(shopId));
      const last = shop?.remoteSkusSyncedAt?.getTime();
      if (last !== undefined && (opts.cooldown ? Date.now() - last < REFRESH_COOLDOWN_MS : true)) return;
      const failedAt = shop?.remoteSkusFullFailedAt?.getTime();
      if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) {
        throw new RemoteSkusRetryLater(Math.ceil((failedAt + RETRY_AFTER_FAILURE_MS - Date.now()) / 1000));
      }
      try {
        await readFull(companyId, shopId);
      } catch (err) {
        await withCompany(companyId, () => recordManualReadFailure(shopId));
        throw err;
      }
    },
    { waitMs: LOCK_WAIT_MS },
  );
  if (result === 'busy') throw new AppError(503, 'remote_skus_busy', 'Đang tải danh sách SKU trên sàn, thử lại sau ít phút');
}

/**
 * Lượt định kỳ sau `channel.listing_sync`: chưa có bản sao hoặc lần đọc trọn quá `FULL_REFRESH_EVERY_MS` thì đọc trọn,
 * lần đọc trước (trọn hay theo giờ sửa) chưa quá `CHANGED_EVERY_MS` thì thôi, không thì đọc sản phẩm sửa từ mốc.
 * Đọc trọn lỗi thì ghi mốc thử lại vào `shops` (1 giờ, 2 giờ, … tối đa 24 giờ; review vòng 3 R1): tới mốc mới đọc trọn
 * lại, giữa chừng vẫn đọc theo giờ sửa. Tải lại (`refreshRemoteSkusNow`) không chờ mốc. Lượt khác đang chạy thì bỏ. Mọi lỗi chỉ ghi log: không làm hỏng lượt đồng bộ.
 */
export async function refreshRemoteSkusQuietly(companyId: string, shopId: string): Promise<void> {
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
          await withCompany(companyId, () => recordFullReadFailure(shopId));
          throw err;
        }
      }
      // Đọc trọn đang chờ mốc thử lại: vẫn đọc theo giờ sửa nếu đã có bản sao.
      if (synced === undefined || !since) return;
      if (Date.now() - since.getTime() < CHANGED_EVERY_MS) return;
      const { adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
      if (!adapter.listSkusChanged) return readFull(companyId, shopId);
      const startedAt = new Date();
      const changed = await onMarketplace(() => adapter.listSkusChanged!(accessToken, new Date(since.getTime() - CHANGED_LAG_MS)));
      await withCompany(companyId, async () => {
        await upsertRemoteSkus(shopId, changed, startedAt);
        await markRemoteSkus(shopId, { changedSince: startedAt });
      });
    });
  } catch (err) {
    logger.warn(
      { shopId, code: err instanceof AppError ? err.code : undefined, err: err instanceof AppError ? undefined : err },
      'Không làm mới được bản sao SKU sàn',
    );
  }
}

async function readFull(companyId: string, shopId: string): Promise<void> {
  const { adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
  if (!adapter.listSkus) throw new AppError(422, 'marketplace_unsupported', 'Sàn này chưa đọc được danh sách SKU của gian hàng');
  const startedAt = new Date();
  const skus = await onMarketplace(() => adapter.listSkus!(accessToken, { labels: true }));
  await withCompany(companyId, () => saveFullSnapshot(shopId, skus, startedAt));
}
