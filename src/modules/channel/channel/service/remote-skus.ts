// Bản sao SKU sàn của gian hàng (#220 đợt 2; Documents/21 §18.3 "SKU đang có trên sàn, đọc từ lần đồng bộ gần nhất").
// Trang ghép, kiểm SKU khi ghép và số SKU chưa ghép đọc bảng `remote_skus`, không gọi sàn mỗi lần mở trang. Làm mới:
// - đọc trọn (`listSkus` có nhãn): thiết lập, nút Tải lại, lần mở trang đầu tiên, và mỗi ngày một lần;
// - đọc sản phẩm sửa từ lần trước (`listSkusChanged`): sau lượt `channel.listing_sync` (15 phút), tối đa mỗi giờ một lần
//   (review #309 vòng 2 N2, `CHANGED_EVERY_MS`).
// Số lời gọi Lazada mỗi gian hàng mỗi ngày: 24 lượt theo giờ sửa × 1 trang (≤ 50 sản phẩm sửa trong một giờ) + 1 lần đọc
// trọn × ⌈số sản phẩm / 50⌉ (shop thử 305 sản phẩm: 7) ≈ 31, thay vì 96 lượt × 2 (`all`, `deleted`) = 192. 45 gian hàng
// ≈ 1 400 trên hạn mức chung 9 000. Bấm Tải lại thêm ⌈số sản phẩm / 50⌉ mỗi lần, cách nhau ít nhất 60 giây.
// Mọi lời gọi đi qua `call` của adapter nên tính vào hạn mức gọi sàn trong ngày (Lazada `channel.api_usage`, TikTok
// `reserveCall`); hết hạn mức thì `daily_call_limit` như mọi lời gọi khác.
import { withCompany, withSessionLock } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { findShopRow } from '../repository/shops.ts';
import { countRemoteSkusSeenSince, dropRemoteSkusNotSeen, markRemoteSkus, upsertRemoteSkus } from '../repository/remote-skus.ts';
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
 * Lượt khác đang làm mới thì chờ nó xong rồi dùng kết quả. Lỗi sàn ném như mọi lời gọi sàn trong request.
 */
export async function refreshRemoteSkusNow(companyId: string, shopId: string, opts: { cooldown: boolean }): Promise<void> {
  const result = await withSessionLock(
    lockKey(shopId),
    async () => {
      const shop = await withCompany(companyId, () => findShopRow(shopId));
      const last = shop?.remoteSkusSyncedAt?.getTime();
      if (last !== undefined && (opts.cooldown ? Date.now() - last < REFRESH_COOLDOWN_MS : true)) return;
      await readFull(companyId, shopId);
    },
    { waitMs: LOCK_WAIT_MS },
  );
  if (result === 'busy') throw new AppError(503, 'remote_skus_busy', 'Đang tải danh sách SKU trên sàn, thử lại sau ít phút');
}

/**
 * Lượt định kỳ sau `channel.listing_sync`: chưa có bản sao hoặc lần đọc trọn quá `FULL_REFRESH_EVERY_MS` thì đọc trọn,
 * lần đọc trước (trọn hay theo giờ sửa) chưa quá `CHANGED_EVERY_MS` thì thôi, không thì đọc sản phẩm sửa từ mốc. Lượt khác đang chạy thì bỏ. Mọi lỗi chỉ ghi log: không làm hỏng lượt đồng bộ.
 */
export async function refreshRemoteSkusQuietly(companyId: string, shopId: string): Promise<void> {
  try {
    await withSessionLock(lockKey(shopId), async () => {
      const shop = await withCompany(companyId, () => findShopRow(shopId));
      if (!shop) return;
      const synced = shop.remoteSkusSyncedAt?.getTime();
      const since = shop.remoteSkusChangedSince;
      if (synced === undefined || !since || Date.now() - synced > FULL_REFRESH_EVERY_MS) return readFull(companyId, shopId);
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
