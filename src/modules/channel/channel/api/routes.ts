import { type NextFunction, type Request, type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../../shared/auth/authorize.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import * as categories from '../service/categories.ts';
import { pushZeroStock, restoreAfterZeroStock, requestListingSync } from '../service/listing-sync.ts';
import * as listings from '../service/listings.ts';
import * as mapping from '../service/mapping.ts';
import { resolveOutsideChange } from '../service/outside-change.ts';
import { recreateOpeningStocktake } from '../service/opening-stocktake.ts';
import { pullShopOrders } from '../service/order-pull.ts';
import { RemoteSkusRetryLater } from '../service/remote-skus.ts';
import { acknowledgeRemoteTitle } from '../service/remote-title.ts';
import { productPort } from '../service/product-port.ts';
import * as prices from '../service/pending-prices.ts';
import * as setup from '../service/setup.ts';
import { updateShopSettings } from '../service/shop-settings.ts';
import * as shops from '../service/shops.ts';
import {
  CallbackBody,
  DelistBody,
  UpdateContentBody,
  UpdateContentParams,
  ListingParams,
  MappingBody,
  MappingParams,
  MatchBody,
  AcknowledgeTitleBody,
  AcknowledgeTitleParams,
  OutsideChangeBody,
  OutsideChangeParams,
  PushBody,
  RemoteSkusQuery,
  SetupBody,
  CategoryMapBody,
  CategoryMapParams,
  CategoryParams,
  CategorySearchQuery,
  DisconnectBody,
  UpdateShopBody,
  PlatformParams,
  ShopParams,
  TokenBody,
  ConfirmPriceBody,
  ListingIdParams,
  ManualPriceBody,
  ManualPriceParams,
  PendingPricesQuery,
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

  router.get('/shops/:platform/authorize-url', connect, validate({ params: PlatformParams }), async (_req, res) => {
    res.json(await shops.authorizeUrl(validated<typeof PlatformParams>(res, 'params').platform, actor(res)));
  });

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

  router.get(
    '/shops/:id/categories',
    manage,
    validate({ params: ShopParams, query: CategorySearchQuery }),
    async (_req, res) => {
      const { id } = validated<typeof ShopParams>(res, 'params');
      const { search } = validated<typeof CategorySearchQuery>(res, 'query');
      res.json(await withCompany(actor(res).companyId, () => categories.searchCategories(id, search)));
    },
  );

  router.get('/shops/:id/categories/:externalId/attributes', manage, validate({ params: CategoryParams }), async (_req, res) => {
    const { id, externalId } = validated<typeof CategoryParams>(res, 'params');
    res.json(await withCompany(actor(res).companyId, () => categories.categoryAttributes(id, externalId)));
  });

  router.get('/shops/:id/category-maps', view, validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await withCompany(actor(res).companyId, () => categories.getCategoryMaps(id)));
  });

  router.put(
    '/shops/:id/category-maps/:categoryId',
    manage,
    validate({ params: CategoryMapParams, body: CategoryMapBody }),
    async (_req, res) => {
      const { id, categoryId } = validated<typeof CategoryMapParams>(res, 'params');
      const body = validated<typeof CategoryMapBody>(res, 'body');
      res.json(await withCompany(actor(res).companyId, () => categories.putCategoryMap(id, categoryId, body)));
    },
  );

  router.get('/shops/:id/listings', view, validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await withCompany(actor(res).companyId, () => listings.listListings(productPort(ctx), id)));
  });

  // Gọi sàn ngoài giao dịch: service tự mở `withCompany` từng bước (#104 A3).
  router.post('/shops/:id/listings/push', manage, validate({ params: ShopParams, body: PushBody }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    const { variantIds } = validated<typeof PushBody>(res, 'body');
    res.json(await listings.pushListings(productPort(ctx), actor(res), id, { variantIds }));
  });

  router.post('/shops/:id/listings/sync', ctx.authorize('channel.shop.sync'), validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.status(202).json(await requestListingSync(actor(res).companyId, id));
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
    const { items, syncedAt, refresh } = await mapping.remoteSkus(actor(res), id, unmatched ?? false);
    res.json({ items, syncedAt, refresh });
  });

  router.post('/shops/:id/remote-skus/refresh', match, validate({ params: ShopParams, query: RemoteSkusQuery }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    const { unmatched } = validated<typeof RemoteSkusQuery>(res, 'query');
    const { accepted, ...list } = await withRetryAfter(res, () => mapping.remoteSkus(actor(res), id, unmatched ?? false, true));
    res.status(accepted ? 202 : 200).json(list);
  });

  router.post('/shops/:id/listings/match', match, validate({ params: ShopParams, body: MatchBody }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    const { listing, pending } = await mapping.matchListing(productPort(ctx), actor(res), id, validated<typeof MatchBody>(res, 'body'));
    res.status(pending ? 202 : 200).json(listing);
  });

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

  return router;
}
