import { sendJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { CUSTOM_AXIS, type PlatformAttribute, remoteSpecAttributes } from '../domain/product-spec.ts';
import { findListingById, type ListingRow, setListingCategory } from '../repository/listings.ts';
import { findCategory, leafAttributesOf } from '../repository/platform-categories.ts';
import { findSpec, insertSpec } from '../repository/product-specs.ts';
import { findShopRow } from '../repository/shops.ts';
import { getAdapter, MarketplaceError, type RemoteProductCategory } from './marketplaces/index.ts';
import { ensureLeaf } from './platform-categories.ts';
import type { ProductPort } from './product-port.ts';
import { specProductOf } from './product-specs.ts';
import { type SpecFromMatchJob, specFromMatchQueue } from './shop-jobs.ts';
import { shopSession } from './shops.ts';

const BATCH = 200;

/**
 * Xếp việc dựng spec từ sàn cho các listing vừa ghép có hiệu lực (#400 lát 12). Đi chung giao dịch ghép đang mở: rollback thì
 * không có việc; lỗi của việc không làm hỏng ghép. Thiết lập ghép nhiều SKU: chia lô 200.
 */
export async function sendSpecFromMatch(companyId: string, shopId: string, listingIds: readonly string[]): Promise<void> {
  const ids = [...new Set(listingIds)];
  for (let i = 0; i < ids.length; i += BATCH) await sendJob(specFromMatchQueue, { companyId, shopId, listingIds: ids.slice(i, i + BATCH) });
}

/**
 * Việc `channel.spec_from_match` (#400 lát 12, Documents/19 mục 3.3): mỗi sản phẩm sàn đọc một lần (ngoài giao dịch)
 * category lá và attribute; luôn ghi `listings.external_category_id` (không tăng `version`); listing có biến thể mà sản phẩm
 * cha chưa có spec của sàn thì tạo spec `source = 'match'`, `version = 1` (bản đọc từ sàn, khác bản chép `version = 0`),
 * attribute đổi sang mã lựa chọn của leaf (`remoteSpecAttributes`), mọi trục `__custom`. Spec có sẵn giữ nguyên (người dùng đã
 * chọn). Gian hàng không gọi được sàn thì bỏ; sàn từ chối (sản phẩm đã xoá), mất uỷ quyền thì bỏ sản phẩm đó (lượt đồng bộ
 * xử lý uỷ quyền); lỗi tạm ném để pg-boss thử lại (chạy lại vô hại).
 */
export async function runSpecFromMatch(port: ProductPort, job: SpecFromMatchJob): Promise<void> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(job.companyId, fn);
  const shop = await inCompany(() => findShopRow(job.shopId));
  if (!shop || (shop.status !== 'active' && shop.status !== 'connecting') || !getAdapter(shop.platform)?.productCategory) return;
  let session: Awaited<ReturnType<typeof shopSession>>;
  try {
    session = await inCompany(() => shopSession(job.shopId));
  } catch (err) {
    if (err instanceof AppError) return;
    throw err;
  }
  const { adapter, accessToken } = session;
  const rows = (await inCompany(() => Promise.all(job.listingIds.map((id) => findListingById(id))))).filter(
    (r): r is ListingRow => r !== undefined && r.status !== 'delisted' && r.externalProductId !== null,
  );
  const byProduct = new Map<string, ListingRow[]>();
  for (const r of rows) byProduct.set(r.externalProductId!, [...(byProduct.get(r.externalProductId!) ?? []), r]);

  for (const [externalProductId, group] of byProduct) {
    let remote: RemoteProductCategory | null;
    try {
      remote = await adapter.productCategory!(accessToken, externalProductId);
    } catch (err) {
      if (err instanceof MarketplaceError && err.kind !== 'unavailable') {
        logger.warn({ err, shopId: shop.id, externalProductId }, 'không đọc được category của sản phẩm trên sàn khi ghép');
        continue;
      }
      throw err;
    }
    if (!remote) continue;
    const { externalCategoryId } = remote;
    const lacking = await inCompany(async () => {
      await setListingCategory(
        group.map((r) => r.id),
        externalCategoryId,
      );
      const variantIds = group.flatMap((r) => (r.variantId ? [r.variantId] : []));
      const productIds = [...new Set((variantIds.length ? await port.variants(variantIds) : []).map((v) => v.productId))];
      const out: string[] = [];
      for (const productId of productIds) if (!(await findSpec(productId, shop.platform))) out.push(productId);
      return out;
    });
    if (!lacking.length) continue;
    if (adapter.leafAttributes) {
      try {
        await ensureLeaf(shop.companyId, shop.platform, adapter, externalCategoryId, { shopId: shop.id });
      } catch (err) {
        // Không lấy được attribute leaf (sàn lỗi, category không phải lá): vẫn tạo spec theo category, attribute để trống.
        if (!(err instanceof MarketplaceError) && !(err instanceof AppError)) throw err;
      }
    }
    await inCompany(async () => {
      const category = await findCategory(shop.platform, externalCategoryId);
      const leaf: PlatformAttribute[] | null = category?.attributesFetchedAt ? await leafAttributesOf(shop.platform, externalCategoryId) : null;
      const attributes = remoteSpecAttributes(leaf, remote.attributes);
      for (const productId of lacking) {
        const product = specProductOf(await port.variants(undefined, { productIds: [productId] }));
        await insertSpec({
          companyId: shop.companyId,
          productId,
          platform: shop.platform,
          externalCategoryId,
          attributes,
          axisMap: Object.fromEntries(product.axes.map((a) => [a.attributeId, CUSTOM_AXIS])),
          valueMap: {},
          source: 'match',
          version: 1,
        });
      }
    });
  }
}
