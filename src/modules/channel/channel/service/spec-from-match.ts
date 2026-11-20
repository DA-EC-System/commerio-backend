import { ingestRemoteImage, sendJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { CUSTOM_AXIS, isoOfCountryLabel, type PlatformAttribute, remoteSpecAttributes, type RemoteSpecFacts } from '../domain/product-spec.ts';
import { findListingById, type ListingRow, setListingCategory } from '../repository/listings.ts';
import { findCategory, leafAttributesOf } from '../repository/platform-categories.ts';
import { reverseSpecValues } from '../domain/spec-resolve.ts';
import { findSpec, insertSpec, recordRemoteFacts } from '../repository/product-specs.ts';
import { mappingsOf } from '../repository/spec-mappings.ts';
import { findShopRow } from '../repository/shops.ts';
import { getAdapter, type MarketplaceAdapter, MarketplaceError, type RemoteProductCategory, type RemoteProductFacts } from './marketplaces/index.ts';
import { ensureLeaf } from './platform-categories.ts';
import type { ProductPort } from './product-port.ts';
import { specProductOf } from './product-specs.ts';
import { type SpecFromMatchJob, specFromMatchQueue } from './shop-jobs.ts';
import { shopSession } from './shops.ts';

const BATCH = 200;
/** Trần ảnh sản phẩm của catalog (P8). */
const PRODUCT_IMAGE_MAX = 9;

/**
 * Xếp việc dựng spec từ sàn cho các listing vừa ghép có hiệu lực (#400 lát 12). Đi chung giao dịch ghép đang mở: rollback thì
 * không có việc; lỗi của việc không làm hỏng ghép. Thiết lập ghép nhiều SKU: chia lô 200.
 */
export async function sendSpecFromMatch(companyId: string, shopId: string, listingIds: readonly string[]): Promise<void> {
  const ids = [...new Set(listingIds)];
  for (let i = 0; i < ids.length; i += BATCH) await sendJob(specFromMatchQueue, { companyId, shopId, listingIds: ids.slice(i, i + BATCH) });
}

/**
 * Việc `channel.spec_from_match` (#400 lát 12, #497; Documents/19 mục 3.3, 21 §11.3, §18.5, 25 §6.4): mỗi sản phẩm sàn đọc một
 * lần (ngoài giao dịch) category lá, attribute và trường dùng chung (`productCategory`); luôn ghi `listings.external_category_id`
 * (không tăng `version`). Mỗi sản phẩm Commerio của các listing có biến thể, một giao dịch:
 * - điền trường dùng chung đang trống qua cổng `fillProductFacts` của catalog (xuất xứ đổi từ lựa chọn sàn sang mã ISO, thương
 *   hiệu bỏ thương hiệu mặc định của sàn, mô tả, cân nặng và kích thước theo SKU đã ghép), cả khi spec đã có; sản phẩm chưa có
 *   ảnh (bảng size) thì trước giao dịch tải ảnh sàn về kho tệp (`ingestRemoteImage`, tối đa 9 ảnh, mỗi sản phẩm sàn tải một
 *   lần) rồi truyền id tệp, catalog chỉ gắn khi vẫn còn trống (#498); ảnh lỗi bỏ qua, không làm hỏng ghép;
 * - chưa có spec của sàn thì tạo spec `source = 'match'`, `version = 1` (bản đọc từ sàn, khác bản chép `version = 0`), attribute
 *   đổi sang mã lựa chọn của leaf (`remoteSpecAttributes`, nguồn `match`), mọi trục `__custom`; spec có sẵn giữ nguyên attribute
 *   (người dùng đã chọn);
 * - ghi bản sàn đang ghi (`remote_facts`) theo giờ đọc: bản đọc sau thắng (`recordRemoteFacts`).
 * Gian hàng không gọi được sàn thì bỏ; sàn từ chối (sản phẩm đã xoá), mất uỷ quyền thì bỏ sản phẩm đó (lượt đồng bộ xử lý uỷ
 * quyền); lỗi tạm ném để pg-boss thử lại (chạy lại vô hại: chỉ điền khi trống, bản sàn ghi theo giờ đọc).
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
  // Chiều ngược (#509): thông số và ánh xạ của công ty trên sàn này, đọc một lần cho cả việc.
  const specLibrary = await inCompany(async () => {
    const fields = (await port.specFields?.()) ?? [];
    return { fields, mappings: fields.length ? await mappingsOf(shop.platform) : [] };
  });
  const byProduct = new Map<string, ListingRow[]>();
  for (const r of rows) byProduct.set(r.externalProductId!, [...(byProduct.get(r.externalProductId!) ?? []), r]);

  for (const [externalProductId, group] of byProduct) {
    let remote: RemoteProductCategory | null;
    const readAt = new Date();
    try {
      remote = await adapter.productCategory!(accessToken, externalProductId);
    } catch (err) {
      if (err instanceof MarketplaceError && err.kind !== 'unavailable') {
        logger.warn({ err, shopId: shop.id, externalProductId }, 'không đọc được sản phẩm trên sàn khi ghép');
        continue;
      }
      throw err;
    }
    if (!remote) continue;
    const { externalCategoryId } = remote;
    const { products, lacking, gaps } = await inCompany(async () => {
      await setListingCategory(
        group.map((r) => r.id),
        externalCategoryId,
      );
      const variantIds = group.flatMap((r) => (r.variantId ? [r.variantId] : []));
      const variants = variantIds.length ? await port.variants(variantIds) : [];
      const products = new Map<string, string[]>();
      for (const v of variants) products.set(v.productId, [...(products.get(v.productId) ?? []), v.id]);
      const lacking = new Set<string>();
      for (const productId of products.keys()) if (!(await findSpec(productId, shop.platform))) lacking.add(productId);
      const gaps = products.size ? ((await port.productMediaGaps?.([...products.keys()])) ?? new Map()) : new Map();
      return { products, lacking, gaps };
    });
    if (!products.size) continue;
    if (lacking.size && adapter.leafAttributes) {
      try {
        await ensureLeaf(shop.companyId, shop.platform, adapter, externalCategoryId, { shopId: shop.id });
      } catch (err) {
        // Không lấy được attribute leaf (sàn lỗi, category không phải lá): vẫn tạo spec theo category, attribute để trống.
        if (!(err instanceof MarketplaceError) && !(err instanceof AppError)) throw err;
      }
    }
    const shared = sharedFacts(adapter, remote);
    const skuOfVariant = new Map(group.flatMap((r) => (r.variantId && r.externalSkuId ? [[r.variantId, r.externalSkuId] as const] : [])));
    const measures = new Map(remote.facts.skus.map((s) => [s.externalSkuId, s]));
    const media = remoteMedia(shop.companyId, remote.facts);
    for (const [productId, variantIds] of products) {
      const variants = variantIds.flatMap((variantId) => {
        const m = measures.get(skuOfVariant.get(variantId) ?? '');
        return m ? [{ variantId, weightG: m.weightG, lengthMm: m.lengthMm, widthMm: m.widthMm, heightMm: m.heightMm }] : [];
      });
      const facts: RemoteSpecFacts = { shopName: shop.shopName, ...shared, variants };
      const gap = gaps.get(productId);
      const imageFileIds = gap?.images ? await media.images() : [];
      const sizeChartFileId = gap?.sizeChart ? await media.sizeChart() : null;
      await inCompany(async () => {
        const filled = new Set(((await port.productSpecs?.([productId]))?.get(productId)?.values ?? []).map((v) => v.fieldId));
        const reverse = reverseSpecValues({ remote: remote.attributes, ...specLibrary, filled });
        const specFacts = reverse.specs.length ? { specs: reverse.specs } : {};
        await port.fillProductFacts?.(
          productId,
          { ...shared, variants, imageFileIds, sizeChartFileId, ...specFacts },
          { shopId: shop.id, shopName: shop.shopName },
        );
        if (lacking.has(productId)) {
          const category = await findCategory(shop.platform, externalCategoryId);
          const leaf: PlatformAttribute[] | null = category?.attributesFetchedAt ? await leafAttributesOf(shop.platform, externalCategoryId) : null;
          // Attribute có ánh xạ đã về thông số catalog (đọc lại qua `resolved`), không chép vào phần ghi đè.
          const attributes = Object.fromEntries(Object.entries(remoteSpecAttributes(leaf, remote.attributes)).filter(([code]) => !reverse.mappedCodes.has(code)));
          const product = specProductOf(await port.variants(undefined, { productIds: [productId] }));
          const created = await insertSpec({
            companyId: shop.companyId,
            productId,
            platform: shop.platform,
            externalCategoryId,
            attributes,
            axisMap: Object.fromEntries(product.axes.map((a) => [a.attributeId, CUSTOM_AXIS])),
            valueMap: {},
            fieldSources: Object.fromEntries(Object.keys(attributes).map((code) => [code, 'match' as const])),
            source: 'match',
            version: 1,
            remoteFacts: facts,
            remoteReadAt: readAt,
            remoteShopId: shop.id,
          });
          if (created) return;
        }
        await recordRemoteFacts(productId, shop.platform, { facts, readAt, shopId: shop.id });
      });
    }
  }
}

/** Ảnh, ảnh bảng size của một sản phẩm sàn đưa vào kho tệp khi cần lần đầu, dùng lại cho mọi sản phẩm Commerio cùng ghép (#498). */
function remoteMedia(companyId: string, facts: RemoteProductFacts) {
  let images: Promise<string[]> | undefined;
  let chart: Promise<string | null> | undefined;
  return {
    images: () =>
      (images ??= Promise.all(facts.imageUrls.slice(0, PRODUCT_IMAGE_MAX).map((url) => ingestRemoteImage(companyId, url, 'product_image'))).then((ids) =>
        ids.filter((id): id is string => id !== null),
      )),
    sizeChart: () => (chart ??= facts.sizeChartUrl ? ingestRemoteImage(companyId, facts.sizeChartUrl, 'product_image') : Promise.resolve(null)),
  };
}

/**
 * Trường dùng chung của sản phẩm sàn theo dạng catalog: xuất xứ là lựa chọn của attribute mà adapter khai `originCountry` trong
 * `productFields`, đổi sang mã ISO (`isoOfCountryLabel`, không khớp thì null); thương hiệu trùng thương hiệu mặc định của sàn
 * ("No Brand") là không có thương hiệu.
 */
export function sharedFacts(
  adapter: Pick<MarketplaceAdapter, 'productFields' | 'defaultBrand'>,
  remote: RemoteProductCategory,
): Omit<RemoteSpecFacts, 'shopName' | 'variants'> {
  const originCode = Object.entries(adapter.productFields ?? {}).find(([, field]) => field === 'originCountry')?.[0];
  const label = remote.attributes.find((a) => a.code === originCode)?.values[0]?.name;
  const { brand, description, imageUrls, sizeChartUrl } = remote.facts;
  const isDefault = brand !== null && adapter.defaultBrand !== undefined && brand.toLowerCase() === adapter.defaultBrand.toLowerCase();
  return {
    originCountry: label ? isoOfCountryLabel(label) : null,
    brand: isDefault ? null : brand,
    description,
    sizeChartUrl,
    imageUrls,
  };
}
