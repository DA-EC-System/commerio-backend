// Việc nền đẩy một listing lên sàn (#219, Documents/21 §18.3, §18.6.4). Request `push` chỉ kiểm, chuyển `pushing` và xếp
// việc `channel.listing_push` (`shop-jobs.ts`); việc này gọi sàn ngoài giao dịch rồi ghi kết quả trong giao dịch ngắn.
import { HoldJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { type ListingAction, STALE_PUSH_MS } from '../domain/listing.ts';
import { listCategoryMaps } from '../repository/category-maps.ts';
import { findListingById, type ListingPatch, type ListingRow, updateListing } from '../repository/listings.ts';
import type { SyncError } from '../repository/schema.ts';
import { findShopRow } from '../repository/shops.ts';
import { moveListing } from './listings.ts';
import { type MarketplaceAdapter, MarketplaceError, type NewProduct } from './marketplaces/index.ts';
import type { ProductPort } from './product-port.ts';
import { pushBlock } from './push-block.ts';
import { type ListingPushJob, sendStockPush } from './shop-jobs.ts';
import { loseShopAuth, shopSession } from './shops.ts';
import { untrustedVariants } from './stock-trust.ts';

/** Số lần gọi sàn tối đa của một lượt đẩy (Documents/21 §18.6.4), bằng `attempts` của hàng `channel.listing_push`. */
export const PUSH_ATTEMPTS = 5;

const errorOf = (code: string, message: string): SyncError => ({ code, message, at: new Date().toISOString() });

/**
 * Chạy một việc đẩy. Listing không còn `pushing` (việc chạy lại sau khi đã xong, đồng bộ vừa `fail`) thì bỏ. Kết quả:
 * sàn cho bán ngay thì `go_live`, không thì `send_review`; lỗi tạm thì ghi `pushError`, tăng `pushAttempts` và ném để
 * pg-boss thử lại, tới lần thứ `PUSH_ATTEMPTS` thì `fail`; sàn từ chối thì `fail` ngay. Lỗi đã ghi lên listing không ném
 * (không vào `platform.dead`). Gian hàng mất uỷ quyền thì việc được giữ (`HoldJob`), nối lại trong 30 phút thì chạy tiếp.
 */
export async function runListingPush(port: ProductPort, job: ListingPushJob): Promise<void> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(job.companyId, fn);
  const row = await inCompany(() => findListingById(job.listingId));
  if (row?.status !== 'pushing') return;
  if ((row.pushStartedAt?.getTime() ?? 0) < Date.now() - STALE_PUSH_MS) {
    return finish(job, row, 'fail', { pushError: errorOf('marketplace_unavailable', 'Quá 30 phút chưa có kết quả từ sàn, đẩy lại') });
  }
  const shop = await inCompany(() => findShopRow(job.shopId));
  if (!shop || shop.status === 'disconnected') {
    return finish(job, row, 'fail', { pushError: errorOf('shop_not_connected', 'Gian hàng đã ngắt') });
  }
  if (shop.status === 'needs_reauth') throw new HoldJob('gian hàng mất uỷ quyền');
  const { adapter, accessToken } = await inCompany(() => shopSession(job.shopId));

  const variantId = row.variantId!;
  const data = await inCompany(async () => {
    const [v] = await port.variants([variantId]);
    if (!v) return null;
    const [map] = await listCategoryMaps(shop.platform, [v.categoryId]);
    return {
      v,
      map,
      price: (await port.standardPrices([variantId])).get(variantId) ?? null,
      quantity: (await port.availableOf([variantId])).get(variantId) ?? 0,
      // SKU chưa tin được (#223, 21 §18.6.6): sàn bắt buộc có số lượng nên gửi 0, listing chờ đẩy tồn tới khi lấy đơn xong.
      untrusted: (await untrustedVariants()).has(variantId),
    };
  });
  if (!data || data.v.archived) return finish(job, row, 'fail', { pushError: errorOf('not_found', 'Biến thể không còn bán') });
  const { v, map, price, untrusted } = data;
  const quantity = untrusted ? 0 : data.quantity;
  const block = pushBlock(v, price, map, Boolean(row.externalImageUrls?.length || job.imageUrls.length));
  if (block) return finish(job, row, 'fail', { pushError: errorOf(block.code, block.message) });

  const priceText = price!.toFixed(0);
  const reshelve = Boolean(row.externalProductId && row.externalSkuId && adapter.updateProduct);
  let imageUrls: string[] = row.externalImageUrls ?? [];
  try {
    if (!imageUrls.length) imageUrls = await uploadAll(adapter, accessToken, job.imageUrls);
    const product: NewProduct = {
      externalCategoryId: map!.externalCategoryId,
      attributes: map!.attributes,
      name: v.attributesLabel ? `${v.productName} - ${v.attributesLabel}` : v.productName,
      description: v.description ?? v.productName,
      imageUrls,
      // Listing ghép lúc thiết lập mang SKU người bán trên sàn, có thể khác SKU Commerio.
      sellerSku: row.sellerSku ?? v.sku,
      price: priceText,
      quantity,
      weightG: v.weightG!,
      lengthMm: v.lengthMm!,
      widthMm: v.widthMm!,
      heightMm: v.heightMm!,
      // Giữ nguyên qua các lần thử của lượt, đổi khi người dùng bấm đẩy lại (#219 A4).
      idempotencyKey: `cm-${row.id}-${row.pushStartedAt!.getTime()}`,
    };
    const result = reshelve
      ? { externalProductId: row.externalProductId!, externalSkuId: row.externalSkuId!, ...(await adapter.updateProduct!(accessToken, row.externalProductId!, row.externalSkuId!, product)) }
      : await adapter.createProduct(accessToken, product);
    const at = new Date();
    await finish(job, row, result.live ? 'go_live' : 'send_review', {
      externalProductId: result.externalProductId,
      externalSkuId: result.externalSkuId,
      externalImageUrls: imageUrls,
      pushError: null,
      listedPrice: priceText,
      priceSync: 'synced',
      priceSyncError: null,
      lastPushedAt: at,
      // Tạo mới gửi kèm tồn; đẩy lại thì TikTok không gửi tồn (Edit Product giữ tồn cũ): để đồng bộ đẩy.
      // SKU chưa tin được: sàn nhận 0, chờ đẩy tồn thật (lấy đơn xong trọn thì `channel.stock_push` chạy lại).
      ...(reshelve
        ? { stockSync: 'pending' as const }
        : { platformStock: quantity, stockSync: untrusted ? ('pending' as const) : ('synced' as const), stockSyncError: null }),
    });
  } catch (err) {
    if (!(err instanceof MarketplaceError)) throw err;
    if (err.kind === 'unauthorized') {
      await loseShopAuth(job.companyId, job.shopId, 'Sàn từ chối token khi đẩy listing');
      throw new HoldJob('gian hàng mất uỷ quyền');
    }
    const attempts = row.pushAttempts + 1;
    if (err.kind === 'unavailable') {
      const pushError = errorOf('marketplace_unavailable', err.platformMessage ?? 'Sàn lỗi tạm, đang thử lại');
      if (attempts >= PUSH_ATTEMPTS) return finish(job, row, 'fail', { pushError, pushAttempts: attempts }, err.platformCode);
      const kept = await inCompany(() => updateListing(row.id, { version: row.version, status: 'pushing' }, { pushError, pushAttempts: attempts }));
      // Listing vừa đổi (đồng bộ `fail`, gian hàng ngắt): không thử lại nữa.
      if (kept) throw err;
      return;
    }
    const message = err.platformMessage ?? (err.kind === 'unsupported' ? 'Sàn chưa hỗ trợ đẩy sản phẩm' : 'Sàn từ chối sản phẩm');
    return finish(job, row, 'fail', { pushError: errorOf('marketplace_rejected', message), pushAttempts: attempts }, err.platformCode);
  }
}

/**
 * Ghi kết quả của lượt đẩy. Listing đã đổi trong lúc gọi sàn (đồng bộ vừa `fail` vì quá 30 phút, gian hàng ngắt): không
 * ném, chỉ ghi mã sàn vừa tạo nếu listing chưa có, để lần đẩy sau sửa đúng sản phẩm đó thay vì tạo thêm.
 */
async function finish(job: ListingPushJob, row: ListingRow, action: ListingAction, patch: ListingPatch, reason: string | null = null): Promise<void> {
  await withCompany(job.companyId, async () => {
    try {
      await moveListing(row, action, null, patch, reason ?? (action === 'fail' ? (patch.pushError?.message ?? null) : null));
      // Đẩy lại không gửi tồn: listing lên sàn thì đẩy tồn ngay (25 §6.5, #223), cùng giao dịch.
      if (patch.stockSync === 'pending') await sendStockPush(job.companyId, job.shopId);
      return;
    } catch (err) {
      if (!(err instanceof AppError) || (err.code !== 'version_conflict' && err.code !== 'invalid_transition')) throw err;
    }
    const now = await findListingById(row.id);
    const { externalProductId, externalSkuId, externalImageUrls } = patch;
    if (now && !now.externalProductId && externalProductId && externalSkuId) {
      await updateListing(now.id, { version: now.version }, { externalProductId, externalSkuId, externalImageUrls });
    }
    logger.warn({ listingId: row.id, action, status: now?.status }, 'Listing đổi trong lúc đẩy, bỏ kết quả lượt đẩy');
  });
}

async function uploadAll(adapter: MarketplaceAdapter, accessToken: string, urls: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const url of urls) out.push(await adapter.uploadImage(accessToken, url));
  return out;
}
