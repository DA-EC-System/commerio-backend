import { type NextFunction, type Request, type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../../shared/auth/authorize.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { suggestCategories } from '../service/category-suggestions.ts';
import { shopWarehouses } from '../service/shop-warehouses.ts';
import { requestCategorySync } from '../service/category-sync.ts';
import { cascadeLevel, leafDetail, listPlatformCategories } from '../service/platform-categories.ts';
import { applyCategory } from '../service/category-apply.ts';
import { getProductSpec, putProductSpec } from '../service/product-specs.ts';
import { listAxisMappings, putAxisMapping } from '../service/axis-mappings.ts';
import { attributeCatalog, listSpecMappings, putSpecMapping } from '../service/spec-mappings.ts';
import { pushZeroStock, restoreAfterZeroStock, requestListingSync } from '../service/listing-sync.ts';
import { getLatestSyncRun, getSyncRun } from '../service/sync-runs.ts';
import * as listings from '../service/listings.ts';
import * as mapping from '../service/mapping.ts';
import { createVariantFromRemote, matchBulk } from '../service/remote-link.ts';
import { matchPreview } from '../service/match-preview.ts';
import { remoteProducts } from '../service/remote-products.ts';
import { linkSkus } from '../service/sku-links.ts';
import { resolveOutsideChange } from '../service/outside-change.ts';
import { recreateOpeningStocktake } from '../service/opening-stocktake.ts';
import { pullShopOrders } from '../service/order-pull.ts';
import { RemoteSkusRetryLater } from '../service/remote-skus.ts';
import { acknowledgeRemoteTitle } from '../service/remote-title.ts';
import { productPort } from '../service/product-port.ts';
import { requestRegroup, separateProductsOf } from '../service/product-regroup.ts';
import * as prices from '../service/pending-prices.ts';
import { COST_VIEW, quotePrices } from '../service/price-quote.ts';
import * as setup from '../service/setup.ts';
import { deleteShop } from '../service/shop-delete.ts';
import { updateShopSettings } from '../service/shop-settings.ts';
import * as shops from '../service/shops.ts';
import {
  RemoteProductsQuery,
  SkuLinksBody,
  ApplyCategoryBody,
  AxisMappingBody,
  AxisMappingParams,
  AuthorizeUrlQuery,
  CallbackBody,
  DelistBody,
  UpdateContentBody,
  UpdateContentParams,
  ListingParams,
  MappingBody,
  MappingParams,
  MatchBody,
  MatchPreviewQuery,
  AcknowledgeTitleBody,
  AcknowledgeTitleParams,
  OutsideChangeBody,
  OutsideChangeParams,
  TakeOverContentBody,
  TakeOverContentParams,
  PushBody,
  MatchBulkBody,
  CreateVariantBody,
  CreateVariantParams,
  PriceQuoteBody,
  PriceQuoteParams,
  RemoteSkusQuery,
  SetupBody,
  DisconnectBody,
  ShopDeleteBody,
  UpdateShopBody,
  PlatformParams,
  PlatformCategoriesQuery,
  PlatformLeafParams,
  LeafDetailQuery,
  CascadeQuery,
  CategorySuggestionsQuery,
  CategorySyncBody,
  ProductSpecBody,
  ProductListingsParams,
  RegroupParams,
  ProductSpecParams,
  ProductSpecQuery,
  ShopParams,
  SyncRunParams,
  TokenBody,
  ConfirmPriceBody,
  ListingIdParams,
  ManualPriceBody,
  ManualPriceParams,
  PendingPricesQuery,
  AttributeCatalogQuery,
  SpecMappingBody,
  SpecMappingParams,
} from './schemas.ts';

/** 201 khi lần nối có gian hàng tạo mới, kể cả không phải phần tử đầu; 200 khi chỉ nối lại (Documents/21 §18.4). */
const createdStatus = (result: shops.ShopCallbackResult) => (result.shops.some((s) => s.created) ? 201 : 200);

function actor(res: Response): shops.Actor {
  const { accountId, companyId } = getAuth(res);
  const { permissions, enabledModules } = getAccess(res);
  return { accountId, companyId: companyId!, permissions, enabledModules };
}

/** Route của module `channel`, gắn tại /api/v1/channel (Documents/21 §18.1, §18.4). */
export function channelRouter(ctx: ModuleContext): Router {
  const router = Router();
  const view = ctx.authorize('channel.shop.view');
  const connect = ctx.authorize('channel.shop.connect');
  const disconnect = ctx.authorize('channel.shop.disconnect');
  const manage = ctx.authorize('channel.listing.manage');
  const match = ctx.authorize('channel.listing.match');
  // Duyệt ghép: `listing.manage` + vai trò CEO (21 §18.3), kiểm trước `validate()` như quyền.
  const ceoOnly = async (_req: Request, res: Response, next: NextFunction) => {
    if (!(await mapping.isCeo(actor(res)))) throw new AppError(403, 'forbidden', 'Chỉ CEO làm được thao tác này');
    next();
  };

  router.get('/shops', view, async (_req, res) => {
    res.json(await withCompany(actor(res).companyId, () => shops.listShops()));
  });

  // Đặt trước `/shops/:id`, không thì `platforms` bị hiểu là mã gian hàng (404).
  router.get('/shops/platforms', view, (_req, res) => {
    res.json(shops.shopPlatforms());
  });

  router.get(
    '/shops/:platform/authorize-url',
    connect,
    validate({ params: PlatformParams, query: AuthorizeUrlQuery }),
    async (_req, res) => {
      const { platform } = validated<typeof PlatformParams>(res, 'params');
      const { shopId } = validated<typeof AuthorizeUrlQuery>(res, 'query');
      res.json(await shops.authorizeUrl(platform, actor(res), shopId));
    },
  );

  router.post(
    '/shops/:platform/callback',
    connect,
    validate({ params: PlatformParams, body: CallbackBody }),
    async (_req, res) => {
      const { platform } = validated<typeof PlatformParams>(res, 'params');
      const result = await shops.connectByCode(platform, actor(res), validated<typeof CallbackBody>(res, 'body'));
      res.status(createdStatus(result)).json(result);
    },
  );

  router.post('/shops/:platform/token', connect, validate({ params: PlatformParams, body: TokenBody }), async (_req, res) => {
    const { platform } = validated<typeof PlatformParams>(res, 'params');
    const result = await shops.connectByToken(platform, actor(res), validated<typeof TokenBody>(res, 'body'));
    res.status(createdStatus(result)).json(result);
  });

  router.get('/shops/:id', view, validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await withCompany(actor(res).companyId, () => shops.getShop(id)));
  });

  router.patch('/shops/:id', connect, validate({ params: ShopParams, body: UpdateShopBody }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    const who = actor(res);
    res.json(await withCompany(who.companyId, () => updateShopSettings(who, id, validated<typeof UpdateShopBody>(res, 'body'))));
  });

  router.post(
    '/shops/:id/disconnect',
    disconnect,
    validate({ params: ShopParams, body: DisconnectBody }),
    async (_req, res) => {
      const who = actor(res);
      const { id } = validated<typeof ShopParams>(res, 'params');
      const body = validated<typeof DisconnectBody>(res, 'body');
      // Gọi sàn ngoài giao dịch, trước khi ngắt (xoá token), và chỉ khi đã qua mọi kiểm của §18.6.1 (#207);
      // giao dịch ngắt kiểm lại dưới khoá dòng gian hàng.
      let zeroed: string[] = [];
      if (body.zeroStock) {
        await withCompany(who.companyId, () => shops.checkDisconnect(who, id, body.version));
        zeroed = await pushZeroStock(who, id);
      }
      try {
        res.json(await withCompany(who.companyId, () => shops.disconnectShop(who, id, body)));
      } catch (err) {
        await restoreAfterZeroStock(who, zeroed);
        throw err;
      }
    },
  );

  // Xoá gian hàng đã ngắt (#398): quyền ngắt + vai trò CEO, cả hai trước `validate()` (403 trước 422).
  router.delete(
    '/shops/:id',
    disconnect,
    ceoOnly,
    validate({ params: ShopParams, body: ShopDeleteBody }),
    async (_req, res) => {
      const { id } = validated<typeof ShopParams>(res, 'params');
      const { version } = validated<typeof ShopDeleteBody>(res, 'body');
      res.json(await deleteShop(actor(res), id, { version }));
    },
  );

  router.get('/shops/:id/setup', connect, validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await setup.setupPreview(productPort(ctx), actor(res), id));
  });

  router.post('/shops/:id/setup', connect, validate({ params: ShopParams, body: SetupBody }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await setup.finishSetup(productPort(ctx), actor(res), id, validated<typeof SetupBody>(res, 'body')));
  });

  // Lập lại phiếu kiểm kê đầu kỳ khi phiếu cũ bị từ chối hoặc huỷ (21 §18.6.11). Không có body.
  router.post('/shops/:id/opening-stocktake', connect, validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await recreateOpeningStocktake(actor(res), id));
  });

  // Cây category của sàn (#400, 21 §18.5): đọc DB, không gọi sàn; `:platform` phải có adapter (422).
  router.get(
    '/platforms/:platform/categories',
    view,
    validate({ params: PlatformParams, query: PlatformCategoriesQuery }),
    async (_req, res) => {
      const { platform } = validated<typeof PlatformParams>(res, 'params');
      res.json(await listPlatformCategories(platform, validated<typeof PlatformCategoriesQuery>(res, 'query'), actor(res).companyId));
    },
  );

  // Xếp một lượt đồng bộ cây (`channel.category_sync`, mỗi sàn một lượt chờ); không gọi sàn trong request.
  // `allowShrink` bỏ chặn cây thiếu (`CategoryTreeShrunkError`), chỉ quản trị nền tảng (cờ đọc từ DB mỗi lần, như router
  // `platform`); người khác gửi cờ: 403.
  router.post(
    '/platforms/:platform/categories/sync',
    ctx.authorize('channel.shop.sync'),
    validate({ params: PlatformParams, body: CategorySyncBody }),
    async (_req, res) => {
      const { platform } = validated<typeof PlatformParams>(res, 'params');
      const { allowShrink } = validated<typeof CategorySyncBody>(res, 'body');
      res.status(202).json(await requestCategorySync(platform, { allowShrink: allowShrink === true, accountId: actor(res).accountId }));
    },
  );

  router.get(
    '/platforms/:platform/categories/:externalId',
    view,
    validate({ params: PlatformLeafParams, query: LeafDetailQuery }),
    async (_req, res) => {
      const { platform, externalId } = validated<typeof PlatformLeafParams>(res, 'params');
      const { shopId } = validated<typeof LeafDetailQuery>(res, 'query');
      res.json(await leafDetail(ctx, actor(res).companyId, platform, externalId, { shopId }));
    },
  );

  // Gọi sàn ngoài giao dịch; service tự mở `withCompany` lấy token gian hàng.
  router.get(
    '/platforms/:platform/categories/:externalId/cascade',
    manage,
    validate({ params: PlatformLeafParams, query: CascadeQuery }),
    async (_req, res) => {
      const { platform, externalId } = validated<typeof PlatformLeafParams>(res, 'params');
      res.json(await cascadeLevel(actor(res).companyId, platform, externalId, validated<typeof CascadeQuery>(res, 'query')));
    },
  );

  // Gợi ý category (#400 lát 9): gọi sàn ngoài giao dịch, service tự mở `withCompany`.
  router.get(
    '/shops/:id/category-suggestions',
    manage,
    validate({ params: ShopParams, query: CategorySuggestionsQuery }),
    async (_req, res) => {
      const { id } = validated<typeof ShopParams>(res, 'params');
      const { productId } = validated<typeof CategorySuggestionsQuery>(res, 'query');
      res.json(await suggestCategories(ctx, actor(res).companyId, id, productId));
    },
  );

  router.get('/products/:productId/specs/:platform', view, validate({ params: ProductSpecParams, query: ProductSpecQuery }), async (_req, res) => {
    const { productId, platform } = validated<typeof ProductSpecParams>(res, 'params');
    const { categoryId } = validated<typeof ProductSpecQuery>(res, 'query');
    res.json(await getProductSpec(ctx, actor(res).companyId, productId, platform, { ...(categoryId !== undefined && { categoryId }) }));
  });

  // Gọi sàn lấy attribute leaf (khi thiếu/cũ) ngoài giao dịch; service tự mở `withCompany` (A16).
  router.put(
    '/products/:productId/specs/:platform',
    manage,
    validate({ params: ProductSpecParams, body: ProductSpecBody }),
    async (_req, res) => {
      const { productId, platform } = validated<typeof ProductSpecParams>(res, 'params');
      res.json(await putProductSpec(ctx, actor(res), productId, platform, validated<typeof ProductSpecBody>(res, 'body')));
    },
  );

  // Ánh xạ trục phân loại sang sales attribute của sàn theo công ty (#448, 21 §18.8.1): đọc DB, không gọi sàn.
  router.get('/platforms/:platform/axis-mappings', ctx.authorize('catalog.product.view'), validate({ params: PlatformParams }), async (_req, res) => {
    const { platform } = validated<typeof PlatformParams>(res, 'params');
    res.json(await listAxisMappings(ctx, actor(res).companyId, platform));
  });

  router.put(
    '/platforms/:platform/axis-mappings/:attributeId',
    ctx.authorize('catalog.group.manage'),
    validate({ params: AxisMappingParams, body: AxisMappingBody }),
    async (_req, res) => {
      const { platform, attributeId } = validated<typeof AxisMappingParams>(res, 'params');
      const { codes } = validated<typeof AxisMappingBody>(res, 'body');
      res.json(await putAxisMapping(ctx, actor(res), platform, attributeId, codes.map((c) => c.attributeCode)));
    },
  );

  // Đổi category trên sàn (#467, 21 §18.5): kiểm, ghi `queued`, xếp việc nền; không gọi sàn trong request.
  router.post(
    '/products/:productId/specs/:platform/apply-category',
    manage,
    validate({ params: ProductSpecParams, body: ApplyCategoryBody }),
    async (_req, res) => {
      const { productId, platform } = validated<typeof ProductSpecParams>(res, 'params');
      const { version } = validated<typeof ApplyCategoryBody>(res, 'body');
      res.status(202).json(await applyCategory(productPort(ctx), actor(res), productId, platform, version, () => mapping.isCeo(actor(res))));
    },
  );

  // Ánh xạ thông số sang sàn (#509, 21 §18.8.1): cấu hình sản phẩm của công ty, quyền như mẫu nhóm.
  router.get(
    '/platforms/:platform/spec-mappings',
    ctx.authorize('catalog.product.view'),
    validate({ params: PlatformParams }),
    async (_req, res) => {
      const { platform } = validated<typeof PlatformParams>(res, 'params');
      res.json(await listSpecMappings(ctx, actor(res).companyId, platform));
    },
  );
  router.put(
    '/platforms/:platform/spec-mappings/:fieldId',
    ctx.authorize('catalog.group.manage'),
    validate({ params: SpecMappingParams, body: SpecMappingBody }),
    async (_req, res) => {
      const { platform, fieldId } = validated<typeof SpecMappingParams>(res, 'params');
      res.json(await putSpecMapping(ctx, actor(res), platform, fieldId, validated<typeof SpecMappingBody>(res, 'body')));
    },
  );
  router.get(
    '/platforms/:platform/attribute-catalog',
    ctx.authorize('catalog.product.view'),
    validate({ params: PlatformParams, query: AttributeCatalogQuery }),
    async (_req, res) => {
      const { platform } = validated<typeof PlatformParams>(res, 'params');
      const { search, kind } = validated<typeof AttributeCatalogQuery>(res, 'query');
      res.json(await withCompany(actor(res).companyId, () => attributeCatalog(platform, search, kind)));
    },
  );

  // Kho của gian hàng trên sàn (#430): gọi sàn ngoài giao dịch, service tự mở `withCompany`.
  router.get('/shops/:id/warehouses', view, validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await shopWarehouses(actor(res).companyId, id));
  });

  router.get('/products/:productId/listings', view, validate({ params: ProductListingsParams }), async (_req, res) => {
    const { productId } = validated<typeof ProductListingsParams>(res, 'params');
    // `separateProducts` (#295): gian hàng mà SKU của sản phẩm nằm ở nhiều sản phẩm sàn.
    res.json(
      await withCompany(actor(res).companyId, async () => ({
        ...(await listings.listProductListings(productPort(ctx), productId)),
        separateProducts: await separateProductsOf(productPort(ctx), productId),
      })),
    );
  });

  router.get('/shops/:id/listings', view, validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await withCompany(actor(res).companyId, () => listings.listListings(productPort(ctx), id)));
  });

  // Gọi sàn ngoài giao dịch: service tự mở `withCompany` từng bước (#104 A3).
  router.post('/shops/:id/listings/push', manage, validate({ params: ShopParams, body: PushBody }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    const { variantIds, listPrices } = validated<typeof PushBody>(res, 'body');
    res.json(await listings.pushListings(productPort(ctx), actor(res), id, { variantIds, listPrices }));
  });

  // Tính thử giá trước khi đăng (21 §18.9 R1): không ghi gì, không trả giá thấp nhất; biên lãi theo quyền xem giá vốn (R4).
  router.post('/products/:productId/price-quote', manage, validate({ params: PriceQuoteParams, body: PriceQuoteBody }), async (_req, res) => {
    const { productId } = validated<typeof PriceQuoteParams>(res, 'params');
    const { items } = validated<typeof PriceQuoteBody>(res, 'body');
    const a = actor(res);
    res.json({ items: await withCompany(a.companyId, () => quotePrices(productPort(ctx), productId, items, a.permissions.includes(COST_VIEW))) });
  });

  router.post('/shops/:id/listings/sync', ctx.authorize('channel.shop.sync'), validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.status(202).json(await requestListingSync(actor(res), id));
  });

  // Kết quả lượt đồng bộ do người bấm (21 §18 "Kết quả lượt đồng bộ"). `latest` đặt trước `:runId`.
  router.get('/shops/:id/listings/sync-runs/latest', view, validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await getLatestSyncRun(actor(res), id));
  });

  router.get('/shops/:id/listings/sync-runs/:runId', view, validate({ params: SyncRunParams }), async (_req, res) => {
    const { id, runId } = validated<typeof SyncRunParams>(res, 'params');
    res.json(await getSyncRun(actor(res), id, runId));
  });

  // Kéo đơn ngay, không chờ vòng 5 phút (#105).
  router.post('/shops/:id/orders/pull', ctx.authorize('channel.shop.sync'), validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await pullShopOrders(getAuth(res).companyId!, id));
  });

  // 429 `remote_skus_retry_later` mang số giây chờ: đặt header `Retry-After` (review #309 vòng 4 B2).
  const withRetryAfter = async <T>(res: Response, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RemoteSkusRetryLater) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      throw err;
    }
  };

  // Ghép SKU tay (#220, 21 §18.6.5). `remote-skus` đọc bản sao SKU sàn; lần đầu và Tải lại xếp lượt tải nền
  // `channel.remote_skus_refresh`, không gọi sàn trong request (#361): Tải lại có xếp (hoặc đang chạy) thì 202.
  router.get('/shops/:id/remote-skus', match, validate({ params: ShopParams, query: RemoteSkusQuery }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    const { unmatched } = validated<typeof RemoteSkusQuery>(res, 'query');
    const { items, syncedAt, refresh } = await mapping.remoteSkus(productPort(ctx), actor(res), id, unmatched ?? false);
    res.json({ items, syncedAt, refresh });
  });

  router.post('/shops/:id/remote-skus/refresh', match, validate({ params: ShopParams, query: RemoteSkusQuery }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    const { unmatched } = validated<typeof RemoteSkusQuery>(res, 'query');
    const { accepted, ...list } = await withRetryAfter(res, () => mapping.remoteSkus(productPort(ctx), actor(res), id, unmatched ?? false, true));
    res.status(accepted ? 202 : 200).json(list);
  });

  // Liên kết SKU sàn gom theo sản phẩm sàn (#565, 21 §18.12). `remote-skus`, `match-bulk`, `create-variant` còn tới khi
  // FE#460 chuyển sang hai route này (luật chuyển tiếp 18.6), rồi bỏ ở PR riêng.
  router.get('/shops/:id/remote-products', match, validate({ params: ShopParams, query: RemoteProductsQuery }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    const q = validated<typeof RemoteProductsQuery>(res, 'query');
    res.json(await remoteProducts(productPort(ctx), actor(res), id, { status: q.status, search: q.search || undefined, page: q.page, pageSize: q.pageSize }));
  });

  router.post('/shops/:id/sku-links', match, validate({ params: ShopParams, body: SkuLinksBody }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await linkSkus(productPort(ctx), actor(res), id, validated<typeof SkuLinksBody>(res, 'body')));
  });

  // Xem trước số sẽ đẩy khi ghép (#460): hộp ghép gọi khi người dùng chọn một cặp.
  router.get('/shops/:id/listings/match-preview', match, validate({ params: ShopParams, query: MatchPreviewQuery }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await matchPreview(productPort(ctx), actor(res), id, validated<typeof MatchPreviewQuery>(res, 'query')));
  });

  router.post('/shops/:id/listings/match', match, validate({ params: ShopParams, body: MatchBody }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    const { listing, pending } = await mapping.matchListing(productPort(ctx), actor(res), id, validated<typeof MatchBody>(res, 'body'));
    res.status(pending ? 202 : 200).json(listing);
  });

  // Liên kết hàng loạt (21 §18.9 R2): 200 kể cả khi có cặp lỗi, kết quả theo cặp.
  router.post('/shops/:id/listings/match-bulk', match, validate({ params: ShopParams, body: MatchBulkBody }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json({ results: await matchBulk(productPort(ctx), actor(res), id, validated<typeof MatchBulkBody>(res, 'body').pairs) });
  });

  // Tạo SKU kho từ SKU sàn rồi liên kết (21 §18.9 R2): 201 khi tạo mới; trùng SKU kho có sẵn thì 200/202 như `listings/match`.
  router.post(
    '/shops/:id/remote-skus/:externalSkuId/create-variant',
    match,
    validate({ params: CreateVariantParams, body: CreateVariantBody }),
    async (_req, res) => {
      const { id, externalSkuId } = validated<typeof CreateVariantParams>(res, 'params');
      const result = await createVariantFromRemote(productPort(ctx), actor(res), id, externalSkuId, validated<typeof CreateVariantBody>(res, 'body').groupId);
      res.status(result.created ? 201 : result.pending ? 202 : 200).json(result);
    },
  );

  router.post(
    '/shops/:id/listings/:listingId/mapping/:action',
    manage,
    ceoOnly,
    validate({ params: MappingParams, body: MappingBody }),
    async (_req, res) => {
      const { id, listingId, action } = validated<typeof MappingParams>(res, 'params');
      res.json(await mapping.decideMapping(productPort(ctx), actor(res), id, listingId, action, validated<typeof MappingBody>(res, 'body')));
    },
  );

  router.post(
    '/shops/:id/listings/:listingId/update-content',
    manage,
    validate({ params: UpdateContentParams, body: UpdateContentBody }),
    async (_req, res) => {
      const { id, listingId } = validated<typeof UpdateContentParams>(res, 'params');
      const { version } = validated<typeof UpdateContentBody>(res, 'body');
      res.json(await listings.updateListingContent(productPort(ctx), actor(res), id, listingId, version));
    },
  );

  router.post(
    '/shops/:id/listings/:listingId/take-over-content',
    manage,
    ceoOnly,
    validate({ params: TakeOverContentParams, body: TakeOverContentBody }),
    async (_req, res) => {
      const { id, listingId } = validated<typeof TakeOverContentParams>(res, 'params');
      const { version } = validated<typeof TakeOverContentBody>(res, 'body');
      res.status(202).json(await listings.takeOverContent(productPort(ctx), actor(res), id, listingId, version));
    },
  );

  router.post(
    '/shops/:id/listings/:variantId/delist',
    manage,
    validate({ params: ListingParams, body: DelistBody }),
    async (_req, res) => {
      const { id, variantId } = validated<typeof ListingParams>(res, 'params');
      const { version } = validated<typeof DelistBody>(res, 'body');
      res.json(await listings.delistListing(actor(res), id, variantId, version));
    },
  );

  // Giá theo gian hàng (#225, 21 §18.6.7, §21.4).
  router.get('/listings/pending-prices', manage, validate({ query: PendingPricesQuery }), async (_req, res) => {
    const query = validated<typeof PendingPricesQuery>(res, 'query');
    res.json(await withCompany(actor(res).companyId, () => prices.listPendingPrices(productPort(ctx), query)));
  });
  router.post('/listings/:id/confirm-price', manage, validate({ params: ListingIdParams, body: ConfirmPriceBody }), async (_req, res) => {
    const { id } = validated<typeof ListingIdParams>(res, 'params');
    const { version } = validated<typeof ConfirmPriceBody>(res, 'body');
    const by = actor(res);
    res.json(await withCompany(by.companyId, () => prices.confirmPrice(by, id, version)));
  });
  router.put(
    '/shops/:id/listings/:listingId/price',
    manage,
    validate({ params: ManualPriceParams, body: ManualPriceBody }),
    async (_req, res) => {
      const { id, listingId } = validated<typeof ManualPriceParams>(res, 'params');
      const by = actor(res);
      res.json(await withCompany(by.companyId, () => prices.setManualPrice(by, id, listingId, validated<typeof ManualPriceBody>(res, 'body'))));
    },
  );
  router.post(
    '/shops/:id/listings/:listingId/outside-change/:action',
    manage,
    ceoOnly,
    validate({ params: OutsideChangeParams, body: OutsideChangeBody }),
    async (_req, res) => {
      const { id, listingId, action } = validated<typeof OutsideChangeParams>(res, 'params');
      const { version } = validated<typeof OutsideChangeBody>(res, 'body');
      res.json(await resolveOutsideChange(productPort(ctx), actor(res), id, listingId, action, version));
    },
  );
  // Xác nhận tên trên sàn đã đổi (#396, 21 §18.3): quyền như các thao tác listing khác, không cần vai trò CEO.
  router.post(
    '/shops/:id/listings/:listingId/acknowledge-title',
    manage,
    validate({ params: AcknowledgeTitleParams, body: AcknowledgeTitleBody }),
    async (_req, res) => {
      const { id, listingId } = validated<typeof AcknowledgeTitleParams>(res, 'params');
      const { version } = validated<typeof AcknowledgeTitleBody>(res, 'body');
      res.json(await acknowledgeRemoteTitle(actor(res), id, listingId, version));
    },
  );

  // Gom lại dữ liệu cũ (#295, 21 §18.8.4): gọi sàn ở việc nền, request chỉ kiểm và xếp việc.
  router.post(
    '/shops/:id/products/:productId/regroup',
    manage,
    ceoOnly,
    validate({ params: RegroupParams }),
    async (_req, res) => {
      const { id, productId } = validated<typeof RegroupParams>(res, 'params');
      res.status(202).json(await requestRegroup(productPort(ctx), actor(res), id, productId));
    },
  );

  return router;
}
