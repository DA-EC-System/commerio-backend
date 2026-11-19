// Việc nền đẩy một listing lên sàn (#219, Documents/21 §18.3, §18.6.4). Request `push` chỉ kiểm, chuyển `pushing` và xếp
// việc `channel.listing_push` (`shop-jobs.ts`); việc này gọi sàn ngoài giao dịch rồi ghi kết quả trong giao dịch ngắn.
import { Decimal } from 'decimal.js';
import { HoldJob, responsibleOrgOf } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { type ListingAction, type RemoteState, STALE_PUSH_MS } from '../domain/listing.ts';
import { permissionOf } from '../domain/product-spec.ts';
import { sentBaseline, snapshotBaseline } from '../domain/remote-title.ts';
import { findListingByExternalSku, findListingById, findListingByPendingExternalSku, type ListingPatch, type ListingRow, markCreateAttempted, updateListing } from '../repository/listings.ts';
import type { SyncError } from '../repository/schema.ts';
import { markPushed } from '../repository/price-calculations.ts';
import { findRemoteSkuRow } from '../repository/remote-skus.ts';
import { permissionsOf, upsertPermissions } from '../repository/product-specs.ts';
import { findShopRow, type ShopRow } from '../repository/shops.ts';
import { currentPrices } from './listing-prices.ts';
import { activateOnMarketplace, remoteSkuOf, type Session } from './listing-sync.ts';
import { moveListing, pushFailureOf } from './listings.ts';
import { type MarketplaceAdapter, MarketplaceError, type NewProduct, PRECHECK_CODES, type SizeChartRule } from './marketplaces/index.ts';
import { evaluatePrices } from './price-inputs.ts';
import type { ListingVariant, ProductPort } from './product-port.ts';
import { ensureLeaf } from './platform-categories.ts';
import { pushAttributes, specChecks } from './product-specs.ts';
import { keepsPlatformContent, listingText, pushBlock, pushSpec } from './push-block.ts';
import { type ListingPushJob, sendStockPush } from './shop-jobs.ts';
import { loseShopAuth, shopSession } from './shops.ts';
import { untrustedVariants } from './stock-trust.ts';

/** Số lần gọi sàn tối đa của một lượt đẩy (Documents/21 §18.6.4), bằng `attempts` của hàng `channel.listing_push`. */
export const PUSH_ATTEMPTS = 5;

/** Lệch giờ cho phép giữa app và sàn khi so giờ sàn tạo sản phẩm có sẵn với giờ của lần gọi tạo trước (`create_attempted_at`, #399). */
export const CLOCK_SKEW_MS = 5 * 60_000;

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
  const session = await inCompany(() => shopSession(job.shopId));
  const { adapter, accessToken } = session;

  const variantId = row.variantId!;
  // Sản phẩm người bán đã có trên sàn (#399 Ca 1): đẩy lại chỉ bật lại SKU, không gửi nội dung, ảnh của app, không xét spec
  // (cùng vị từ với request, review BE2 P1-1); `take-over-content` (CEO) mới ghi nội dung lên.
  const keepContent = keepsPlatformContent(row, job.takeOver);
  // Spec của sản phẩm (#400): attribute leaf thiếu hay quá 7 ngày thì lấy lại trước khi kiểm (A16, ngoài giao dịch; sàn lỗi mà
  // còn bản cũ thì kiểm theo bản cũ, chưa có bản nào thì kiểm theo category, trục và để sàn quyết).
  const specOf = async (v: ListingVariant) =>
    (await specChecks(shop, adapter, await port.variants(undefined, { productIds: [v.productId] }))).get(v.productId);
  const first = await inCompany(async () => {
    const [v] = await port.variants([variantId]);
    return v ? specOf(v) : undefined;
  });
  if (first && !keepContent && !first.attributes && adapter.leafAttributes) {
    try {
      await ensureLeaf(shop.companyId, shop.platform, adapter, first.externalCategoryId, { shopId: shop.id });
    } catch (err) {
      if (!(err instanceof MarketplaceError) && !(err instanceof AppError)) throw err;
    }
  }
  if (first && !keepContent) await refreshPermission(shop, adapter, accessToken, first.externalCategoryId);
  const data = await inCompany(async () => {
    const [v] = await port.variants([variantId]);
    if (!v) return null;
    const map = await specOf(v);
    // Giá đang bán (#225 phần 2): ghi đè tay > giá bộ lọc đã xác nhận lúc bấm đẩy > giá chuẩn.
    const own = (await currentPrices([variantId], [row], await port.standardPrices([variantId]))).get(variantId)!;
    // Giá bộ lọc kiểm lại giá thấp nhất với giá vốn, cấu hình lúc chạy (có thể đổi sau lúc bấm).
    const floor = own.priceSource === 'shop' ? (await evaluatePrices(row.shopId, new Map([[variantId, String(own.price)]]))).results.get(variantId) : undefined;
    return {
      v,
      map,
      price: own.price === null ? null : new Decimal(own.price),
      shopPrice: own.priceSource === 'shop',
      belowFloor: floor !== undefined && (!floor.ok || floor.belowFloor === true),
      quantity: (await port.availableOf([variantId])).get(variantId) ?? 0,
      // SKU chưa tin được (#223, 21 §18.6.6): sàn bắt buộc có số lượng nên gửi 0, listing chờ đẩy tồn tới khi lấy đơn xong.
      untrusted: (await untrustedVariants()).has(variantId),
      responsible: await responsibleOrgOf(shop.companyId),
    };
  });
  if (!data || data.v.archived) return finish(job, row, 'fail', { pushError: errorOf('not_found', 'Biến thể không còn bán') });
  const { v, map, price, untrusted, responsible, shopPrice, belowFloor } = data;
  if (belowFloor) {
    return finish(job, row, 'fail', { pushError: errorOf('below_floor', 'Giá theo bộ lọc giá của gian hàng có thực nhận dưới giá thấp nhất') });
  }
  const quantity = untrusted ? 0 : data.quantity;
  const sizeChartRule = map && !keepContent ? await sizeChartRuleOf(adapter, accessToken, map) : null;
  const block = pushBlock(
    v,
    price,
    pushSpec(keepContent, map && { ...map, sizeChartRule }),
    Boolean(row.externalImageUrls?.length || job.imageUrls.length),
    Boolean(job.sizeChartUrl),
  );
  if (block) return finish(job, row, 'fail', { pushError: errorOf(block.code, block.message) });

  const priceText = price!.toFixed(0);
  const reshelve = Boolean(row.externalProductId && row.externalSkuId && adapter.updateProduct);
  let imageUrls: string[] = row.externalImageUrls ?? [];
  try {
    if (keepContent) {
      // Giá, tồn để lượt đẩy tồn gửi như sau khi ghép (`finish` xếp `channel.stock_push`).
      const action = await reactivate(session, row);
      return await finish(job, row, action, { pushError: null, stockSync: 'pending', priceSync: 'pending', priceSyncError: null });
    }
    if (!imageUrls.length) imageUrls = await uploadAll(adapter, accessToken, job.imageUrls);
    // Ảnh bảng kích cỡ (#347): danh mục không hỗ trợ thì không gửi; tải lên mỗi lượt (không lưu `uri`, sàn có thể đổi).
    const sizeChartUri =
      job.sizeChartUrl && sizeChartRule !== 'unsupported' ? await adapter.uploadImage(accessToken, job.sizeChartUrl, 'size_chart') : null;
    const product: NewProduct = {
      externalCategoryId: map!.externalCategoryId,
      attributes: pushAttributes(adapter, map!.attributes, map!.row, map!.product),
      responsible,
      brand: v.brand ?? null,
      ...listingText(v),
      imageUrls,
      ...(sizeChartUri && { sizeChartUri }),
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
    // Mốc lần gọi tạo gần nhất (#399): ghi đè mỗi lần, commit trước khi gọi sàn để lần thử sau thấy mốc dù lần gọi này lỗi hay ném.
    // `row` giữ giá trị của lần gọi trước.
    if (!reshelve) await inCompany(() => markCreateAttempted(row.id));
    let result = reshelve
      ? { externalProductId: row.externalProductId!, externalSkuId: row.externalSkuId!, ...(await adapter.updateProduct!(accessToken, row.externalProductId!, row.externalSkuId!, product)) }
      : await adapter.createProduct(accessToken, product);
    // Sàn đã có SKU cùng SellerSku (#346, Documents/21 §18.6.4): SKU đó thuộc listing khác thì không ghi đè; không thì ghi
    // nội dung, giá của app lên như đẩy lại.
    let rewritten = reshelve;
    if (result.existing) {
      const { externalProductId, externalSkuId } = result;
      // Kể cả SKU đang chờ CEO duyệt ghép vào listing lỗi khác.
      const owner = await inCompany(
        async () => (await findListingByExternalSku(job.shopId, externalSkuId)) ?? (await findListingByPendingExternalSku(job.shopId, externalSkuId)),
      );
      if (owner && owner.id !== row.id) {
        const message = `SKU người bán ${product.sellerSku} đã có trên sàn và đang ghép với biến thể khác; ghép tay hoặc đổi SKU`;
        return finish(job, row, 'fail', { pushError: errorOf('marketplace_rejected', message), pushAttempts: row.pushAttempts + 1 });
      }
      // #399 Ca 2: sản phẩm của app sinh ra trong đúng lần gọi tạo ngay trước (sàn báo lỗi mà vẫn tạo, #346); nếu nó tồn tại
      // thì lần gọi kế luôn thấy nó ở bước tra `existing` trước khi tạo, nên chỉ xét lần gọi trước (`create_attempted_at` lúc
      // đọc dòng). Chưa có lần gọi trước, không có giờ tạo, hoặc giờ tạo lệch quá `CLOCK_SKEW_MS` so với lần đó (sản phẩm người
      // bán, kể cả tạo sau một lần gọi bị sàn từ chối) thì là của người bán: không ghi đè.
      const previousCall = row.createAttemptedAt;
      if (!previousCall || !result.createdAt || Math.abs(result.createdAt.getTime() - previousCall.getTime()) > CLOCK_SKEW_MS) {
        const named = result.title ? ` (${result.title})` : '';
        const message = `SKU ${product.sellerSku} đã có trên ${adapter.name}${named}. Dùng Ghép SKU thay vì đẩy.`;
        // Lần gọi này không tạo gì trên sàn: trả mốc về lần gọi trước. Giữ mốc vừa ghi thì sản phẩm người bán tạo trong
        // `CLOCK_SKEW_MS` trước lần gọi này sẽ bị lần đẩy lại nhận nhầm là của app và ghi đè (review #407).
        return finish(job, row, 'fail', {
          pushError: errorOf('sku_exists_on_platform', message),
          pushAttempts: row.pushAttempts + 1,
          createAttemptedAt: previousCall,
        });
      }
      if (adapter.updateProduct) {
        result = { externalProductId, externalSkuId, ...(await adapter.updateProduct(accessToken, externalProductId, externalSkuId, product)) };
        rewritten = true;
      }
    }
    const at = new Date();
    const priceSent = !result.existing || rewritten;
    // Giá bộ lọc đã lên sàn: lần tính `confirmed` → `pushed`.
    if (shopPrice && priceSent) await inCompany(() => markPushed(row.priceCalcId!));
    // Mốc tên trên sàn (#396): app vừa ghi tên lên sàn thì là tên đã gửi, không thì tên trong bản sao.
    const remote = await inCompany(() => findRemoteSkuRow(job.shopId, result.externalSkuId));
    const titleBaseline = priceSent ? sentBaseline(product.name, remote, at) : snapshotBaseline(remote);
    await finish(job, row, result.live ? 'go_live' : 'send_review', {
      externalProductId: result.externalProductId,
      externalSkuId: result.externalSkuId,
      externalImageUrls: imageUrls,
      pushError: null,
      // Category thật của listing trên gian hàng (#400, cột thông tin, không tăng `version`, L029).
      externalCategoryId: product.externalCategoryId,
      // Nội dung trên sàn giờ là của app (tạo mới, ghi lại, hay CEO ghi đè bằng `take-over-content`).
      contentSource: 'app',
      ...titleBaseline,
      listedPrice: priceText,
      // Nhận về sản phẩm có sẵn mà sàn không cho sửa: giá chưa ghi lên, để đồng bộ đẩy.
      priceSync: result.existing && !rewritten ? 'pending' : 'synced',
      priceSyncError: null,
      lastPushedAt: at,
      // Tạo mới gửi kèm tồn; đẩy lại thì TikTok không gửi tồn (Edit Product giữ tồn cũ): để đồng bộ đẩy.
      // SKU chưa tin được: sàn nhận 0, chờ đẩy tồn thật (lấy đơn xong trọn thì `channel.stock_push` chạy lại).
      ...(rewritten || result.existing
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
    // Bước kiểm trước khi tạo (#305) giữ mã riêng để FE báo đúng câu (Documents/21 §18.6.4).
    const code = err.platformCode && PRECHECK_CODES.has(err.platformCode) ? err.platformCode : 'marketplace_rejected';
    return finish(job, row, 'fail', { pushError: errorOf(code, message), pushAttempts: attempts }, err.platformCode);
  }
}

/**
 * Ghi kết quả của lượt đẩy. Listing đã đổi trong lúc gọi sàn (đồng bộ vừa `fail` vì quá 30 phút, gian hàng ngắt): không
 * ném, chỉ ghi mã sàn vừa tạo nếu listing chưa có, để lần đẩy sau sửa đúng sản phẩm đó thay vì tạo thêm.
 */
async function finish(job: ListingPushJob, row: ListingRow, action: ListingAction, patch: ListingPatch, reason: string | null = null): Promise<void> {
  await withCompany(job.companyId, async () => {
    try {
      const reasonText = reason ?? (action === 'fail' ? (patch.pushError?.message ?? null) : null);
      // Lỗi của lượt ghi nội dung xuất phát từ `live`: về `live`, không `push_failed` (sản phẩm người bán vẫn đang bán).
      const failure = action === 'fail' ? await pushFailureOf(row) : { action, patch: {} };
      await moveListing(row, failure.action, null, { ...patch, ...failure.patch }, reasonText);
      // Đẩy lại không gửi tồn: listing lên sàn thì đẩy tồn ngay (25 §6.5, #223), cùng giao dịch. Lên `live` thì lượt đẩy
      // tồn cũng ẩn ngay nếu SKU vừa tạm ngừng trong lúc đẩy (#224, E25).
      if (patch.stockSync === 'pending' || failure.patch.stockSync === 'pending' || action === 'go_live') await sendStockPush(job.companyId, job.shopId);
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

/**
 * Bật lại SKU của sản phẩm người bán (#399 Ca 1), như `restore` của #360: sàn đang bán hay đang duyệt thì không gọi bật.
 * Trả thao tác theo trạng thái sàn sau khi bật; sàn không còn SKU thì `sku_not_found`, vẫn tắt hay bị khoá thì
 * `still_inactive` (như `updateProduct`).
 */
async function reactivate(session: Session, row: ListingRow): Promise<ListingAction> {
  const found = await remoteSkuOf(session, row);
  if (!found || found.state === 'deleted') throw new MarketplaceError('rejected', 'sku_not_found', 'Sản phẩm trên sàn không còn SKU của listing này');
  let state: RemoteState = found.state;
  if (state === 'inactive') {
    await activateOnMarketplace(session, row.externalProductId!, row.externalSkuId!);
    // Sàn đã nhận lệnh bật: đọc lại lỗi thì coi như chờ duyệt, lượt đồng bộ sửa sau (không ném để khỏi bật lại).
    state = (await remoteSkuOf(session, row).catch(() => undefined))?.state ?? 'review';
  }
  if (state === 'live') return 'go_live';
  if (state === 'review' || state === 'rejected') return 'send_review';
  throw new MarketplaceError('rejected', 'still_inactive', `Sàn chưa bật lại sản phẩm (trạng thái ${state})`);
}

async function uploadAll(adapter: MarketplaceAdapter, accessToken: string, urls: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const url of urls) out.push(await adapter.uploadImage(accessToken, url));
  return out;
}

/**
 * Quy tắc bảng kích cỡ của danh mục (#347). Ghép mới đã lưu quy tắc; ghép trước #347 chưa có thì hỏi sàn một lần, lỗi thì
 * coi như chưa biết (sàn tự quyết khi tạo sản phẩm, lỗi `unauthorized` được xử lý ở bước gọi sàn sau đó).
 */
/** Dòng quyền category quá hạn này thì việc đẩy đọc lại cây của gian hàng (#400 A17). */
export const PERMISSION_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Quyền category theo gian hàng (#400 A17, Documents/21 §18.5): sàn có quyền theo gian hàng (`categoryPermissionsPerShop`,
 * TikTok) mà chưa có dòng quyền cho leaf của spec hoặc dòng quá `PERMISSION_TTL_MS`, thì đọc cây bằng token gian hàng (ngoài
 * giao dịch) và ghi quyền mọi leaf một lần (`upsertPermissions`). Sàn lỗi thì bỏ qua: không có dòng thì không chặn, sàn quyết.
 */
async function refreshPermission(shop: ShopRow, adapter: MarketplaceAdapter, accessToken: string, externalCategoryId: string): Promise<void> {
  if (!adapter.categoryPermissionsPerShop || !adapter.categoryTree) return;
  const current = (await withCompany(shop.companyId, () => permissionsOf(shop.id, [externalCategoryId]))).get(externalCategoryId);
  if (current && current.checkedAt.getTime() > Date.now() - PERMISSION_TTL_MS) return;
  let nodes;
  try {
    nodes = await adapter.categoryTree(accessToken);
  } catch (err) {
    if (err instanceof MarketplaceError || err instanceof AppError) {
      logger.warn({ err, shopId: shop.id, externalCategoryId }, 'đọc quyền category của gian hàng lỗi, để sàn quyết');
      return;
    }
    throw err;
  }
  const items = nodes.flatMap((n) => {
    const status = n.isLeaf && n.permissionStatuses ? permissionOf(n.permissionStatuses) : null;
    return status ? [{ externalCategoryId: n.externalId, status }] : [];
  });
  await withCompany(shop.companyId, () => upsertPermissions(shop.companyId, shop.id, items, new Date()));
}

async function sizeChartRuleOf(
  adapter: MarketplaceAdapter,
  accessToken: string,
  map: { externalCategoryId: string; sizeChartRule: SizeChartRule | null },
): Promise<SizeChartRule | null> {
  if (map.sizeChartRule || !adapter.categoryRules) return map.sizeChartRule;
  try {
    return (await adapter.categoryRules(accessToken, map.externalCategoryId)).sizeChart;
  } catch (err) {
    if (err instanceof MarketplaceError) return null;
    throw err;
  }
}
