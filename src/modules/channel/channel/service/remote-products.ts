// Danh sách SKU sàn gom theo sản phẩm sàn (#565, Documents/21 §18.12 `GET remote-products`): đọc bản sao `remote_skus`,
// phân trang theo sản phẩm sàn, gợi ý liên kết cho SKU chưa liên kết của trang. Không gọi sàn.
import { withCompany } from '../../../../shared/db/client.ts';
import { type MatchConfidence, confidenceOf } from '../domain/match-confidence.ts';
import { type RefreshState } from '../domain/remote-skus-refresh.ts';
import { type DraftDecisionAction, type SetupDecision, draftDecisionsOf } from '../domain/setup-draft.ts';
import { type RemoteTitleChanged, remoteTitleChanged } from '../domain/remote-title.ts';
import { type ListingRow, liveListingRows } from '../repository/listings.ts';
import { syncedPathsOf } from '../repository/platform-categories.ts';
import {
  type RemoteLinkStatus,
  type SkuIdFilter,
  remoteFilterStock,
  remoteLinkCounts,
  remoteProductSkuTotals,
  remoteProductsPage,
} from '../repository/remote-skus.ts';
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
  /** Số có thể bán của biến thể dòng đang trỏ tới (`matchedVariantId`, hoặc biến thể nháp chọn `link`); không có thì null. */
  available: number | null;
  matchedVariantId: string | null;
  mode: 'mapped' | 'unmanaged' | null;
  listingId: string | null;
  listingVersion: number | null;
  pendingMapping: ChannelListing['pendingMapping'];
  remoteTitleChanged: RemoteTitleChanged | null;
  suggestion: RemoteSkuSuggestion | null;
  canCreate: boolean;
  cannotCreateReason: CannotCreateReason | 'already_matched' | null;
  /** Lựa chọn trong nháp thiết lập; chỉ gian hàng `connecting` và người gọi có `channel.shop.connect`. */
  decision: { action: DraftDecisionAction; variantId: string | null; groupId: string | null } | null;
}

export interface RemoteProductOut {
  externalProductId: string;
  title: string;
  titleEn: string | null;
  imageUrl: string | null;
  externalCategoryId: string | null;
  /** Đường dẫn category trong cây đã đồng bộ; null khi chưa có category hoặc category chưa có trong cây. */
  externalCategoryPath: string | null;
  /** Danh mục gợi ý qua `platform_category_group_maps` (be#569); null tới khi bảng đó có trong code. */
  suggestedGroupId: string | null;
  skus: RemoteSkuRowOut[];
}

export interface RemoteProductsQuery {
  status: RemoteLinkStatus | 'all';
  search?: string | undefined;
  decision?: DecisionFilter | undefined;
  page: number;
  pageSize: number;
}

export interface RemoteProductsResult {
  items: RemoteProductOut[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<RemoteLinkStatus, number>;
  totals: RemoteProductsTotals;
  syncedAt: Date | null;
  refresh: RefreshState;
  nameMatchSkipped: boolean;
}

export type DecisionFilter = DraftDecisionAction | 'none';

export interface RemoteProductsTotals {
  create: number | null;
  link: number | null;
  skip: number | null;
  unmanaged: number | null;
  none: number | null;
  drifted: number;
  matched: number;
  /** Tổng tồn trên sàn của mọi SKU khớp lọc; null khi không có SKU nào. */
  platformStockSum: number | null;
  /** Tổng số có thể bán ở Commerio của các SKU có `available` (dòng `create` tính 0); null khi không SKU nào có. */
  availableSum: number | null;
}

/** `availableOf` theo lô để số tham số của câu SQL không vượt giới hạn của PostgreSQL. */
const AVAILABLE_CHUNK = 5000;

async function availableMap(port: ProductPort, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += AVAILABLE_CHUNK) {
    for (const [k, v] of await port.availableOf(ids.slice(i, i + AVAILABLE_CHUNK))) out.set(k, v);
  }
  return out;
}

/** Lọc `decision` thành tập SKU: `none` là SKU chưa có lựa chọn trong nháp. */
function decisionSkuFilter(decisions: Map<string, SetupDecision>, decision: DecisionFilter): SkuIdFilter {
  if (decision === 'none') return { notIn: [...decisions.keys()] };
  return { in: [...decisions.values()].filter((d) => d.action === decision).map((d) => d.externalSkuId) };
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
    // Nháp thiết lập chỉ đọc cho gian hàng `connecting` và người có quyền kết nối gian hàng (§18.12); còn lại bỏ qua `decision`.
    const draft = shop.status === 'connecting' && actor.permissions.includes('channel.shop.connect') ? draftDecisionsOf(shop.setupDraft) : null;
    const filter = {
      status: q.status,
      search: q.search,
      skuIds: draft && q.decision ? decisionSkuFilter(draft.decisions, q.decision) : undefined,
    };
    const page = await remoteProductsPage(shop.id, { ...filter, page: q.page, pageSize: q.pageSize });
    const counts = (await remoteLinkCounts([shop.id])).get(shop.id)!;

    // `totals` và `available` (§18.12): mọi SKU khớp cả bộ lọc, một lần `availableOf` cho các biến thể dòng đang trỏ tới.
    const stock = await remoteFilterStock(shop.id, filter);
    const variantOf = new Map(
      stock.map((r) => {
        const d = draft?.decisions.get(r.externalSkuId);
        return [r.externalSkuId, r.mappedVariantId ?? (d?.action === 'link' ? d.variantId : null)] as const;
      }),
    );
    const available = await availableMap(port, [...new Set([...variantOf.values()].filter((v): v is string => v !== null))]);
    const availableOfSku = (externalSkuId: string): number | null => {
      const v = variantOf.get(externalSkuId);
      return v ? (available.get(v) ?? null) : null;
    };
    const totals: RemoteProductsTotals = draft
      ? { create: 0, link: 0, skip: 0, unmanaged: 0, none: 0, drifted: 0, matched: 0, platformStockSum: null, availableSum: null }
      : { create: null, link: null, skip: null, unmanaged: null, none: null, drifted: 0, matched: 0, platformStockSum: null, availableSum: null };
    for (const r of stock) {
      const action = draft?.decisions.get(r.externalSkuId)?.action;
      if (draft) totals[action ?? 'none'] = (totals[action ?? 'none'] ?? 0) + 1;
      // Dòng `create` chưa có SKU kho: tính có thể bán 0 như FE.
      const n = availableOfSku(r.externalSkuId) ?? (action === 'create' && !variantOf.get(r.externalSkuId) ? 0 : null);
      totals.platformStockSum = (totals.platformStockSum ?? 0) + r.platformStock;
      if (n !== null) {
        totals[n === r.platformStock ? 'matched' : 'drifted'] += 1;
        totals.availableSum = (totals.availableSum ?? 0) + n;
      }
    }

    const base = {
      total: page.total,
      page: q.page,
      pageSize: q.pageSize,
      counts,
      totals,
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
    const skuCounts = await remoteProductSkuTotals(shop.id, [...new Set(free.map((r) => r.externalProductId))]);
    const { chosen, nameMatchSkipped } = await suggestMatches(
      free,
      variants.filter((v) => !v.archived && !taken.has(v.id)),
      skuCounts,
    );
    const suggested = new Map([...chosen].map(([i, c]) => [free[i]!.externalSkuId, c] as const));
    const cannotCreate = createBlocker(variants, actor);
    const categoryPaths = await syncedPathsOf(shop.platform, page.rows.flatMap((r) => (r.externalCategoryId ? [r.externalCategoryId] : [])));

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
          externalCategoryPath: r.externalCategoryId ? (categoryPaths.get(r.externalCategoryId) ?? null) : null,
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
        available: availableOfSku(r.externalSkuId),
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
        decision: decisionOut(draft, r.externalSkuId, r.externalProductId),
      });
    }
    return { ...base, items, nameMatchSkipped };
  });
}

/** `decision` của dòng: `groupId` là danh mục nháp chọn cho sản phẩm sàn, chỉ có nghĩa với dòng `create`. */
function decisionOut(
  draft: ReturnType<typeof draftDecisionsOf> | null,
  externalSkuId: string,
  externalProductId: string,
): RemoteSkuRowOut['decision'] {
  const d = draft?.decisions.get(externalSkuId);
  if (!d) return null;
  return { action: d.action, variantId: d.variantId, groupId: d.action === 'create' ? (draft!.groups.get(externalProductId) ?? null) : null };
}
