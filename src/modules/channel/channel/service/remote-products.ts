// Danh sách SKU sàn gom theo sản phẩm sàn (#565, Documents/21 §18.12 `GET remote-products`): đọc bản sao `remote_skus`,
// phân trang theo sản phẩm sàn, gợi ý liên kết cho SKU chưa liên kết của trang. Không gọi sàn.
import { withCompany } from '../../../../shared/db/client.ts';
import { type MatchConfidence, confidenceOf } from '../domain/match-confidence.ts';
import { type RefreshState } from '../domain/remote-skus-refresh.ts';
import { type RemoteTitleChanged, remoteTitleChanged } from '../domain/remote-title.ts';
import { type ListingRow, liveListingRows } from '../repository/listings.ts';
import { type RemoteLinkStatus, remoteLinkCounts, remoteProductSkuTotals, remoteProductsPage } from '../repository/remote-skus.ts';
import { type ChannelListing, requesterNames, toListing } from './listings.ts';
import { snapshotRefresh } from './mapping.ts';
import type { ProductPort } from './product-port.ts';
import { type CannotCreateReason, createBlocker, productNameOf, suggestMatches } from './setup.ts';
import { type Actor, ownShop } from './shops.ts';

export interface RemoteSkuSuggestion {
  variantId: string;
  sku: string;
  productName: string;
  match: 'sku' | 'name';
  score: number | null;
  confidence: MatchConfidence;
}

export interface RemoteSkuRowOut {
  externalSkuId: string;
  sellerSku: string;
  title: string;
  titleEn: string | null;
  variantLabel: string | null;
  platformStock: number;
  matchedVariantId: string | null;
  mode: 'mapped' | 'unmanaged' | null;
  listingId: string | null;
  listingVersion: number | null;
  pendingMapping: ChannelListing['pendingMapping'];
  remoteTitleChanged: RemoteTitleChanged | null;
  suggestion: RemoteSkuSuggestion | null;
  canCreate: boolean;
  cannotCreateReason: CannotCreateReason | 'already_matched' | null;
  /** Lựa chọn trong nháp thiết lập; chỉ gian hàng `connecting` (be#569 điền), ở đây luôn null. */
  decision: null;
}

export interface RemoteProductOut {
  externalProductId: string;
  title: string;
  titleEn: string | null;
  imageUrl: string | null;
  externalCategoryId: string | null;
  /** Danh mục gợi ý qua `platform_category_group_maps` (be#569); null tới khi bảng đó có trong code. */
  suggestedGroupId: string | null;
  skus: RemoteSkuRowOut[];
}

export interface RemoteProductsQuery {
  status: RemoteLinkStatus | 'all';
  search?: string | undefined;
  page: number;
  pageSize: number;
}

export interface RemoteProductsResult {
  items: RemoteProductOut[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<RemoteLinkStatus, number>;
  syncedAt: Date | null;
  refresh: RefreshState;
  nameMatchSkipped: boolean;
}

/** Ghép đang có hiệu lực: dòng chỉ để chờ duyệt "không quản tồn" (chưa ai duyệt) là chưa ghép. */
const effectiveMode = (r: ListingRow): RemoteSkuRowOut['mode'] => (r.mode === 'unmanaged' && !r.approvedBy ? null : r.mode);

/**
 * Một trang sản phẩm sàn (§18.12). Chưa có bản sao thì xếp lượt tải nền như `remote-skus` (`snapshotRefresh`). Gợi ý chỉ cho
 * SKU `unlinked` của trang, vào biến thể chưa lưu trữ chưa gắn SKU sàn nào ở gian hàng; SKU của sản phẩm sàn nhiều SKU (đếm
 * trên cả bản sao) mà không có nhãn thì không gợi ý theo tên.
 */
export async function remoteProducts(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  q: RemoteProductsQuery,
): Promise<RemoteProductsResult> {
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    const { refresh } = await snapshotRefresh(shop, false);
    const page = await remoteProductsPage(shop.id, q);
    const counts = (await remoteLinkCounts([shop.id])).get(shop.id)!;
    const base = {
      total: page.total,
      page: q.page,
      pageSize: q.pageSize,
      counts,
      syncedAt: shop.remoteSkusSyncedAt,
      refresh,
    };
    if (!page.rows.length) return { ...base, items: [], nameMatchSkipped: false };

    const rows = await liveListingRows(shop.id);
    const names = await requesterNames(rows);
    const byExternal = new Map(rows.flatMap((r) => (r.externalSkuId ? [[r.externalSkuId, r] as const] : [])));
    const byPending = new Map(rows.flatMap((r) => (r.pendingExternalSkuId ? [[r.pendingExternalSkuId, r] as const] : [])));
    const variants = await port.variants();
    const taken = new Set(rows.flatMap((r) => (r.variantId && (r.externalSkuId || r.pendingExternalSkuId) ? [r.variantId] : [])));
    const free = page.rows.filter((r) => r.linkStatus === 'unlinked');
    const totals = await remoteProductSkuTotals(shop.id, [...new Set(free.map((r) => r.externalProductId))]);
    const { chosen, nameMatchSkipped } = await suggestMatches(
      free,
      variants.filter((v) => !v.archived && !taken.has(v.id)),
      totals,
    );
    const suggested = new Map([...chosen].map(([i, c]) => [free[i]!.externalSkuId, c] as const));
    const cannotCreate = createBlocker(variants, actor);

    const items: RemoteProductOut[] = [];
    for (const r of page.rows) {
      let product = items.at(-1);
      if (product?.externalProductId !== r.externalProductId) {
        // Tên, ảnh, category của sản phẩm sàn lấy theo SKU đầu (§18.12); tên bỏ đuôi " - nhãn" TikTok ghép vào tiêu đề SKU.
        product = {
          externalProductId: r.externalProductId,
          title: productNameOf(r),
          titleEn: r.titleEn,
          imageUrl: r.imageUrl,
          externalCategoryId: r.externalCategoryId,
          suggestedGroupId: null,
          skus: [],
        };
        items.push(product);
      }
      const listing = byExternal.get(r.externalSkuId) ?? byPending.get(r.externalSkuId);
      const mode = listing?.externalSkuId === r.externalSkuId ? effectiveMode(listing) : null;
      const s = suggested.get(r.externalSkuId);
      const reason = listing ? 'already_matched' : cannotCreate(r.sellerSku);
      product.skus.push({
        externalSkuId: r.externalSkuId,
        sellerSku: r.sellerSku,
        title: r.title,
        titleEn: r.titleEn,
        variantLabel: r.variantLabel,
        platformStock: r.quantity,
        matchedVariantId: mode === 'mapped' ? listing!.variantId : null,
        mode,
        listingId: listing?.id ?? null,
        listingVersion: listing?.version ?? null,
        pendingMapping: listing ? toListing(listing, names).pendingMapping : null,
        remoteTitleChanged: listing?.externalSkuId === r.externalSkuId ? remoteTitleChanged(listing, r) : null,
        suggestion: s
          ? {
              variantId: s.variant.id,
              sku: s.variant.sku,
              productName: s.variant.productName,
              match: s.score === null ? 'sku' : 'name',
              score: s.score,
              confidence: confidenceOf(s.score),
            }
          : null,
        canCreate: reason === null,
        cannotCreateReason: reason,
        decision: null,
      });
    }
    return { ...base, items, nameMatchSkipped };
  });
}
