// Đổi category của sản phẩm trên sàn (`apply-category`, commerio-backend#467, Documents/21 §18.5). Request chỉ kiểm, ghi
// `category_change = queued` và xếp việc `channel.category_apply` (mỗi gian hàng, mỗi sản phẩm sàn một việc) trong một giao
// dịch, không gọi sàn; việc nền gọi sàn ngoài giao dịch rồi ghi kết quả trong giao dịch ngắn (như `listing-push.ts`).
import { HoldJob, type JobAttempt, responsibleOrgOf } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { type ListingStatus, STALE_PUSH_MS } from '../domain/listing.ts';
import {
  failStaleCategoryChanges,
  finishCategoryChange,
  listingsByIds,
  type ListingRow,
  markCategoryQueued,
  platformListingRows,
  remoteProductListings,
  updateQueuedCategoryChange,
} from '../repository/listings.ts';
import { findCategory, leafAttributesOf, syncedPathsOf } from '../repository/platform-categories.ts';
import { findSpec } from '../repository/product-specs.ts';
import type { CategoryChange } from '../repository/schema.ts';
import { findShopRow, listShopRows } from '../repository/shops.ts';
import { MarketplaceError } from './marketplaces/index.ts';
import { moveListing } from './listings.ts';
import { ensureLeaf } from './platform-categories.ts';
import type { ProductPort } from './product-port.ts';
import { missingOf, pushAttributes, specProductOf, specView } from './product-specs.ts';
import { type CategoryApplyJob, sendCategoryApply } from './shop-jobs.ts';
import { type Actor, loseShopAuth, platformOf, shopSession } from './shops.ts';

/** Số lần gọi sàn tối đa của một lượt đổi category, bằng `attempts` của hàng `channel.category_apply` (như đẩy, §18.6.4). */
export const CATEGORY_APPLY_ATTEMPTS = 5;

/** Listing được đổi category: còn bán trên sàn (Documents/21 §18.5). */
const APPLICABLE: readonly ListingStatus[] = ['live', 'hidden'];

/** Một dòng của 202: một sản phẩm trên sàn sẽ đổi category; `code` null là đã xếp việc. */
export interface CategoryApplyItem {
  shopId: string;
  shopName: string;
  externalProductId: string;
  listingIds: string[];
  fromCategoryId: string | null;
  fromCategoryPath: string | null;
  toCategoryId: string;
  toCategoryPath: string | null;
  code: string | null;
}

const queuedOf = (r: ListingRow) => r.categoryChange?.status === 'queued';

const STALE_MESSAGE = 'Quá 30 phút chưa có kết quả từ sàn, thử lại';
const IN_PROGRESS = 'Sản phẩm đang đổi category trên sàn, chờ lượt trước xong';

/**
 * Kiểm và xếp việc đổi category (Documents/21 §18.5). Thứ tự lỗi, không gọi sàn: 404 sản phẩm → 409 `category_unmapped` →
 * `spec_incomplete` → `version_conflict` (kèm `current`) → `category_change_in_progress` → `category_in_sync` →
 * `size_chart_missing` → 422 `marketplace_unsupported`. Nhóm theo (gian hàng, mã sản phẩm sàn); gian hàng không `active`
 * hoặc hết token thì dòng `shop_not_connected`, không xếp. Request khác vừa xếp cùng listing (đua) thì 409
 * `category_change_in_progress`, rollback cả lượt. Lượt `queued` quá 30 phút (việc rơi) coi như hết, đánh `failed` cùng giao dịch
 * rồi xếp lại. Sau khi nhóm: 409 `shared_remote_product` khi sản phẩm sàn còn chứa listing của sản phẩm khác trong app (Edit
 * Product ghi đè cả sản phẩm sàn), CEO gate xét mọi listing của sản phẩm sàn đó, nhóm mà mọi listing đang có bản sửa
 * `auditing` thì bỏ (hết nhóm: 409 `category_change_in_progress`).
 */
export async function applyCategory(
  port: ProductPort,
  actor: Actor,
  productId: string,
  raw: string,
  version: number,
  isCeo: () => Promise<boolean>,
): Promise<{ items: CategoryApplyItem[] }> {
  const { platform, adapter } = platformOf(raw);
  return withCompany(actor.companyId, async () => {
    const variants = await port.variants(undefined, { productIds: [productId] });
    if (!variants.length) throw new AppError(404, 'not_found', 'Không tìm thấy sản phẩm');
    const spec = await findSpec(productId, platform);
    if (!spec) throw new AppError(409, 'category_unmapped', `Sản phẩm chưa có category của ${adapter.name}`);
    const product = specProductOf(variants);
    const org = adapter.responsibleFields ? await responsibleOrgOf(actor.companyId) : null;
    const { missing } = await missingOf(adapter, spec, product, org);
    if (spec.categoryStatus !== 'ok' || missing.length) {
      throw new AppError(409, 'spec_incomplete', `Thông tin ${adapter.name} của sản phẩm còn thiếu, bổ sung rồi lưu trước khi đổi category`);
    }
    if (spec.version !== version) {
      throw new AppError(409, 'version_conflict', 'Thông tin sàn của sản phẩm vừa được người khác sửa', {
        current: (await specView(actor.companyId, adapter, spec, product)).spec,
      });
    }
    const rows = await platformListingRows(platform, variants.map((v) => v.id));
    const staleBefore = new Date(Date.now() - STALE_PUSH_MS);
    const stale = new Set(await failStaleCategoryChanges(staleBefore, STALE_MESSAGE, rows.filter(queuedOf).map((r) => r.id)));
    if (rows.some((r) => queuedOf(r) && !stale.has(r.id))) throw new AppError(409, 'category_change_in_progress', IN_PROGRESS);
    const target = spec.externalCategoryId;
    const groups = new Map<string, ListingRow[]>();
    for (const r of rows) {
      if (stale.has(r.id)) r.categoryChange = null;
      if (!APPLICABLE.includes(r.status) || !r.externalProductId || r.externalCategoryId === target) continue;
      const key = `${r.shopId} ${r.externalProductId}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    if (!groups.size) throw new AppError(409, 'category_in_sync', `Sản phẩm trên ${adapter.name} đã ở đúng category này`);
    // Edit Product ghi đè cả sản phẩm sàn: listing của sản phẩm khác trong app cùng sản phẩm sàn bị đổi theo (như
    // `update-content`, `shared_remote_product`); đổi category trên Seller Center.
    const pairs = [...groups.values()].map((g) => ({ shopId: g[0]!.shopId, externalProductId: g[0]!.externalProductId! }));
    const remote = await remoteProductListings(pairs);
    const own = new Set(variants.map((v) => v.id));
    if (remote.some((r) => r.variantId && !own.has(r.variantId))) {
      throw new AppError(409, 'shared_remote_product', 'Sản phẩm trên sàn chứa SKU của sản phẩm khác trong Commerio; đổi category trên Seller Center');
    }
    const otherStale = new Set(await failStaleCategoryChanges(staleBefore, STALE_MESSAGE, remote.filter(queuedOf).map((r) => r.id)));
    if (remote.some((r) => queuedOf(r) && !otherStale.has(r.id))) throw new AppError(409, 'category_change_in_progress', IN_PROGRESS);
    // Category là nội dung của người bán (`25-vong-doi-ly-tuong.md` §6.4): sản phẩm người bán tự đăng chỉ CEO đổi được, như
    // `take-over-content` (acn-89 chốt 20/11/2026, commerio-backend#467). Xét mọi listing của sản phẩm sàn (kể cả listing đã
    // đúng category hay ở trạng thái khác: lượt PUT vẫn ghi đè sản phẩm của họ).
    if (remote.some((r) => r.contentSource === 'platform') && !(await isCeo())) {
      throw new AppError(403, 'forbidden', 'Chỉ CEO đổi được category của sản phẩm người bán tự đăng trên sàn');
    }
    // Sàn đang duyệt bản sửa trước của mọi listing trong nhóm: không gửi chồng thêm một bản sửa.
    for (const [key, group] of groups) if (group.every((r) => r.revisionStatus === 'auditing')) groups.delete(key);
    if (!groups.size) throw new AppError(409, 'category_change_in_progress', 'Sàn đang duyệt bản sửa trước của sản phẩm, chờ duyệt xong');
    const category = await findCategory(platform, target);
    if (category?.sizeChartRule === 'required') {
      const chart = (await port.productSizeChartUrls?.([productId]))?.get(productId);
      if (!chart) throw new AppError(409, 'size_chart_missing', 'Category mới bắt buộc bảng kích cỡ, thêm ảnh bảng kích cỡ cho sản phẩm trước');
    }
    if (!adapter.changeCategory) throw new AppError(422, 'marketplace_unsupported', `${adapter.name} chưa hỗ trợ đổi category từ app`);

    const shops = new Map((await listShopRows()).map((s) => [s.id, s]));
    const fromIds = [...groups.values()].flatMap((g) => (g[0]!.externalCategoryId ? [g[0]!.externalCategoryId] : []));
    const paths = await syncedPathsOf(platform, [target, ...fromIds]);
    const toCategoryPath = paths.get(target) ?? null;
    const items: CategoryApplyItem[] = [];
    for (const group of groups.values()) {
      const first = group[0]!;
      const shop = shops.get(first.shopId)!;
      const listingIds = group.map((r) => r.id);
      const connected = shop.status === 'active' && Boolean(shop.accessTokenEnc);
      if (connected) {
        const change: CategoryChange = { status: 'queued', toCategoryId: target, toCategoryPath, code: null, message: null, attempts: 0, at: new Date().toISOString() };
        if ((await markCategoryQueued(listingIds, change)) !== listingIds.length) throw new AppError(409, 'category_change_in_progress', IN_PROGRESS);
        await sendCategoryApply({
          companyId: actor.companyId,
          shopId: shop.id,
          productId,
          externalProductId: first.externalProductId!,
          listingIds,
          toCategoryId: target,
        });
      }
      items.push({
        shopId: shop.id,
        shopName: shop.shopName,
        externalProductId: first.externalProductId!,
        listingIds,
        fromCategoryId: first.externalCategoryId,
        fromCategoryPath: first.externalCategoryId ? (paths.get(first.externalCategoryId) ?? null) : null,
        toCategoryId: target,
        toCategoryPath,
        code: connected ? null : 'shop_not_connected',
      });
    }
    return { items };
  });
}

/**
 * Chạy một việc đổi category. Listing không còn `queued` (đã xong, đã gỡ) thì bỏ. Kết quả: sàn nhận và đọc lại khớp thì
 * `category_change` về null kèm bản sửa `auditing` (như `update_content`; sàn ngừng bán để duyệt thì listing `live` chuyển
 * `request_review`), đọc lại lệch thì `mismatch` kèm câu liệt kê; lỗi tạm thì tăng `attempts`, ghi mã, câu và ném để pg-boss
 * thử lại, tới lần thứ `CATEGORY_APPLY_ATTEMPTS` hoặc lần cuối của pg-boss (`attempt.lastAttempt`) thì `failed` (lỗi không dự
 * kiến cũng vậy: `internal`; không để listing kẹt `queued`); sàn từ chối thì `failed` ngay. Không đổi trạng thái listing hay
 * `external_category_id` (lượt đồng bộ category ghi khi sàn duyệt xong). Gian hàng mất uỷ quyền thì việc được giữ (`HoldJob`).
 */
export async function runCategoryApply(
  port: ProductPort,
  job: CategoryApplyJob,
  attempt: Pick<JobAttempt, 'lastAttempt'> = { lastAttempt: false },
): Promise<void> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(job.companyId, fn);
  const rows = (await inCompany(() => listingsByIds(job.listingIds))).filter(queuedOf);
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const queued = rows[0]!.categoryChange!;
  const fail = (code: string, message: string, attempts = queued.attempts) =>
    inCompany(() => finishCategoryChange(ids, { ...queued, status: 'failed', code, message, attempts, at: new Date().toISOString() }, false));
  // Không để listing `queued` mãi (server chết giữa lúc gọi sàn, việc rơi): quá 30 phút từ lúc xếp thì `failed`.
  if (rows.some((r) => new Date(r.categoryChange!.at).getTime() < Date.now() - STALE_PUSH_MS)) {
    await fail('marketplace_unavailable', 'Quá 30 phút chưa có kết quả từ sàn, đổi category lại');
    return;
  }
  const shop = await inCompany(() => findShopRow(job.shopId));
  if (!shop || shop.status === 'disconnected') {
    await fail('shop_not_connected', 'Gian hàng đã ngắt');
    return;
  }
  if (shop.status === 'needs_reauth') throw new HoldJob('gian hàng mất uỷ quyền');
  let session;
  try {
    session = await inCompany(() => shopSession(job.shopId));
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'shop_not_connected') throw err;
    await fail('shop_not_connected', 'Gian hàng chưa kết nối hoặc cần kết nối lại');
    return;
  }
  const { adapter, accessToken } = session;
  if (!adapter.changeCategory) {
    await fail('marketplace_unsupported', `${adapter.name} chưa hỗ trợ đổi category từ app`);
    return;
  }
  const spec = await inCompany(() => findSpec(job.productId, shop.platform));
  if (!spec || spec.externalCategoryId !== job.toCategoryId) {
    await fail('spec_incomplete', 'Category của sản phẩm trong app đã đổi sau khi xếp việc, bấm đổi category lại');
    return;
  }
  // Attribute leaf thiếu hay quá 7 ngày thì lấy lại (ngoài giao dịch, như đẩy); sàn lỗi thì dùng bản đang có.
  if (adapter.leafAttributes) {
    try {
      await ensureLeaf(shop.companyId, shop.platform, adapter, job.toCategoryId, { shopId: shop.id });
    } catch (err) {
      if (!(err instanceof MarketplaceError) && !(err instanceof AppError)) throw err;
    }
  }
  const data = await inCompany(async () => {
    const variants = await port.variants(undefined, { productIds: [job.productId] });
    const category = await findCategory(shop.platform, job.toCategoryId);
    const attributes = category?.attributesFetchedAt ? await leafAttributesOf(shop.platform, job.toCategoryId) : null;
    const chartUrl = category?.sizeChartRule === 'required' ? ((await port.productSizeChartUrls?.([job.productId]))?.get(job.productId) ?? null) : null;
    return {
      attributes: pushAttributes(adapter, attributes, spec, specProductOf(variants)),
      responsible: await responsibleOrgOf(shop.companyId),
      chartUrl,
    };
  });
  let result;
  try {
    // Category mới bắt buộc bảng size: adapter đưa ảnh của app lên chỉ khi sản phẩm trên sàn chưa có bảng size (21 §18.5).
    // Listing app đã ẩn: adapter tắt lại sản phẩm sau khi sửa dù lần đọc này thấy đang bật (lượt thử lại).
    result = await adapter.changeCategory(accessToken, job.externalProductId, {
      externalCategoryId: job.toCategoryId,
      attributes: data.attributes,
      ...(data.responsible && { responsible: data.responsible }),
      ...(data.chartUrl && { sizeChartUrl: data.chartUrl }),
      ...(rows.some((r) => r.status === 'hidden') && { keepDeactivated: true }),
    });
  } catch (err) {
    if (!(err instanceof MarketplaceError)) {
      // Lỗi không dự kiến (đọc ảnh, lỗi mã): thử lại tới lần cuối rồi ghi `failed`, không rơi việc để listing kẹt `queued`.
      if (!attempt.lastAttempt) throw err;
      logger.error({ err, shopId: job.shopId, externalProductId: job.externalProductId }, 'đổi category lỗi không dự kiến ở lần thử cuối');
      await fail('internal', 'Lỗi hệ thống khi đổi category, thử lại', queued.attempts + 1);
      return;
    }
    if (err.kind === 'unauthorized') {
      await loseShopAuth(job.companyId, job.shopId, 'Sàn từ chối token khi đổi category');
      throw new HoldJob('gian hàng mất uỷ quyền');
    }
    const attempts = queued.attempts + 1;
    if (err.kind === 'unavailable') {
      const message = err.platformMessage ?? 'Sàn lỗi tạm, đang thử lại';
      if (attempts >= CATEGORY_APPLY_ATTEMPTS || attempt.lastAttempt) {
        await fail('marketplace_unavailable', message, attempts);
        return;
      }
      const kept = await inCompany(() =>
        updateQueuedCategoryChange(ids, { ...queued, code: 'marketplace_unavailable', message, attempts }),
      );
      // Listing vừa đổi (gỡ, gian hàng ngắt): không thử lại nữa.
      if (kept.length) throw err;
      return;
    }
    const message = err.platformMessage ?? (err.kind === 'unsupported' ? 'Sàn chưa hỗ trợ đổi category' : 'Sàn từ chối đổi category');
    await fail('marketplace_rejected', message, attempts);
    return;
  }
  const { underReview, mismatch } = result;
  await inCompany(async () => {
    const change: CategoryChange | null = mismatch.length
      ? {
          ...queued,
          status: 'mismatch',
          code: 'category_change_mismatch',
          message: `Sau khi đổi category, ${adapter.name} ${mismatch.join('; ')}`,
          attempts: queued.attempts + 1,
          at: new Date().toISOString(),
        }
      : null;
    // Sàn vẫn bán bản cũ: bản sửa đang duyệt (`revision_*`); sàn ngừng bán để duyệt: listing `live` chuyển `request_review`
    // (như `update_content`, #293), listing ẩn giữ trạng thái kèm bản sửa.
    const done = await finishCategoryChange(ids, change, true);
    if (!underReview) return;
    for (const row of done.filter((r) => r.status === 'live')) {
      try {
        await moveListing(row, 'request_review', null);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        logger.warn({ err, listingId: row.id }, 'Listing đổi trong lúc đổi category, bỏ chuyển chờ duyệt');
      }
    }
  });
}
