import { type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../../shared/auth/authorize.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import * as categories from '../service/categories.ts';
import { pushZeroStock, syncListings } from '../service/listing-sync.ts';
import * as listings from '../service/listings.ts';
import { pullShopOrders } from '../service/order-pull.ts';
import { productPort } from '../service/product-port.ts';
import * as setup from '../service/setup.ts';
import * as shops from '../service/shops.ts';
import {
  CallbackBody,
  DelistBody,
  ListingParams,
  PushBody,
  SetupBody,
  CategoryMapBody,
  CategoryMapParams,
  CategoryParams,
  CategorySearchQuery,
  DisconnectBody,
  PlatformParams,
  ShopParams,
  TokenBody,
} from './schemas.ts';

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
      res.status(result.created ? 201 : 200).json(result);
    },
  );

  router.post('/shops/:platform/token', connect, validate({ params: PlatformParams, body: TokenBody }), async (_req, res) => {
    const { platform } = validated<typeof PlatformParams>(res, 'params');
    const result = await shops.connectByToken(platform, actor(res), validated<typeof TokenBody>(res, 'body'));
    res.status(result.created ? 201 : 200).json(result);
  });

  router.get('/shops/:id', view, validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await withCompany(actor(res).companyId, () => shops.getShop(id)));
  });

  router.post(
    '/shops/:id/disconnect',
    disconnect,
    validate({ params: ShopParams, body: DisconnectBody }),
    async (_req, res) => {
      const who = actor(res);
      const { id } = validated<typeof ShopParams>(res, 'params');
      const body = validated<typeof DisconnectBody>(res, 'body');
      // Gọi sàn ngoài giao dịch, trước khi ngắt (xoá token).
      if (body.zeroStock) await pushZeroStock(who, id);
      res.json(await withCompany(who.companyId, () => shops.disconnectShop(who, id, body)));
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
    res.json(await listings.pushListings(productPort(ctx), actor(res), id, validated<typeof PushBody>(res, 'body')));
  });

  router.post('/shops/:id/listings/sync', ctx.authorize('channel.shop.sync'), validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await syncListings(productPort(ctx), actor(res), id));
  });

  // Kéo đơn ngay, không chờ vòng 5 phút (#105).
  router.post('/shops/:id/orders/pull', ctx.authorize('channel.shop.sync'), validate({ params: ShopParams }), async (_req, res) => {
    const { id } = validated<typeof ShopParams>(res, 'params');
    res.json(await pullShopOrders(getAuth(res).companyId!, id));
  });

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

  return router;
}
