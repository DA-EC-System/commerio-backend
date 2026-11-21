// Trường sẽ điền ngược vào sản phẩm khi liên kết một cặp (Documents/21 §18.9 R4, 29 bước 5): trường app đang trống mà sàn có.
// Bản sao SKU sàn không có thương hiệu, mô tả, cân nặng, nên đọc chi tiết sản phẩm trên sàn (`productCategory`, cùng lời gọi
// của `spec_from_match` sau khi liên kết). Không ghi gì. Đọc sàn lỗi thì vẫn trả trường app trống với `value` null.
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { syncedPathsOf } from '../repository/platform-categories.ts';
import { findSpec } from '../repository/product-specs.ts';
import type { ShopRow } from '../repository/shops.ts';
import type { RemoteProductCategory } from './marketplaces/common.ts';
import type { ListingVariant } from './product-port.ts';
import { onMarketplace, shopSession } from './shops.ts';
import { sharedFacts } from './spec-from-match.ts';

export type FillBackField = 'originCountry' | 'brand' | 'description' | 'weight' | 'dimensions' | 'platformSpec';
export interface FillBack {
  fillBack: { field: FillBackField; value: string | null }[];
  fillBackError: { code: string; message: string } | null;
}

/** Giữ chi tiết sản phẩm sàn trong tiến trình (chỉ là tối ưu: pod khác, khởi động lại thì đọc lại sàn). */
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: RemoteProductCategory | null }>();

/** Test xoá bộ nhớ đệm giữa các ca. */
export function clearFillBackCache(): void {
  cache.clear();
}

const DESCRIPTION_PREVIEW = 100;
const regionVi = new Intl.DisplayNames(['vi'], { type: 'region', fallback: 'code' });
/** Số đo mm → cm, bỏ phần lẻ 0 ("300" → "30", "155" → "15.5"). */
const cm = (mm: number) => String(Math.round(mm) / 10);

/**
 * Trường app đang trống của biến thể và sản phẩm cha (`variant`), đối chiếu với sản phẩm sàn chứa SKU `externalProductId`.
 * Không trường nào trống thì không gọi sàn. Gọi ngoài giao dịch (lời gọi sàn), tự mở `withCompany` để đọc.
 */
export async function fillBackOf(
  companyId: string,
  shop: Pick<ShopRow, 'id' | 'platform'>,
  variant: ListingVariant,
  remoteSku: { externalProductId: string; externalSkuId: string },
): Promise<FillBack> {
  const hasSpec = await withCompany(companyId, async () => (await findSpec(variant.productId, shop.platform)) !== undefined);
  const gaps: FillBackField[] = [
    ...(variant.originCountry ? [] : (['originCountry'] as const)),
    ...(variant.brand ? [] : (['brand'] as const)),
    ...(variant.description ? [] : (['description'] as const)),
    ...(variant.weightG !== null ? [] : (['weight'] as const)),
    ...(variant.lengthMm !== null && variant.widthMm !== null && variant.heightMm !== null ? [] : (['dimensions'] as const)),
    ...(hasSpec ? [] : (['platformSpec'] as const)),
  ];
  if (!gaps.length) return { fillBack: [], fillBackError: null };

  let remote: RemoteProductCategory | null;
  let adapter: Awaited<ReturnType<typeof shopSession>>['adapter'];
  try {
    const session = await withCompany(companyId, () => shopSession(shop.id));
    adapter = session.adapter;
    if (!adapter.productCategory) throw new AppError(422, 'marketplace_unsupported', 'Sàn chưa đọc được chi tiết sản phẩm');
    remote = await onMarketplace(() =>
      readProduct(shop.id, remoteSku.externalProductId, () => adapter.productCategory!(session.accessToken, remoteSku.externalProductId)),
    );
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    // request_id của sàn chưa có trên lỗi (commerio-backend#504): ghi mã app và chi tiết lỗi (mã sàn) để tra.
    logger.warn({ err, shopId: shop.id, externalProductId: remoteSku.externalProductId, code: err.code }, 'match-preview: không đọc được sản phẩm trên sàn');
    return { fillBack: gaps.map((field) => ({ field, value: null })), fillBackError: { code: err.code, message: err.message } };
  }
  if (!remote) return { fillBack: [], fillBackError: null };

  const shared = sharedFacts(adapter, remote);
  const m = remote.facts.skus.find((s) => s.externalSkuId === remoteSku.externalSkuId);
  const path = gaps.includes('platformSpec')
    ? await withCompany(companyId, async () => (await syncedPathsOf(shop.platform, [remote.externalCategoryId])).get(remote.externalCategoryId))
    : undefined;
  const values: Record<FillBackField, string | null> = {
    originCountry: shared.originCountry ? regionVi.of(shared.originCountry)! : null,
    brand: shared.brand,
    description: shared.description ? shared.description.slice(0, DESCRIPTION_PREVIEW) : null,
    weight: m?.weightG ? `${m.weightG} g` : null,
    dimensions: m?.lengthMm && m.widthMm && m.heightMm ? `${cm(m.lengthMm)} × ${cm(m.widthMm)} × ${cm(m.heightMm)} cm` : null,
    platformSpec: path ?? remote.externalCategoryId,
  };
  return { fillBack: gaps.flatMap((field) => (values[field] ? [{ field, value: values[field] }] : [])), fillBackError: null };
}

async function readProduct(shopId: string, externalProductId: string, read: () => Promise<RemoteProductCategory | null>) {
  const key = `${shopId}:${externalProductId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await read();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}
