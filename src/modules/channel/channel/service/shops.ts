// Gian hàng (#103; Documents/21 §18.1, §18.4). Gọi sàn trước, ngoài giao dịch; ghi DB sau trong `withCompany`.
import { randomUUID } from 'node:crypto';
import { assertTransition, getStatusHistory, recordTransition, type StatusChange } from '../../../core/index.ts';
import { PurposeTokenError, signPurposeToken, verifyPurposeToken } from '../../../../shared/auth/purpose-token.ts';
import { env } from '../../../../shared/config/env.ts';
import { decryptBytes, encryptBytes } from '../../../../shared/crypto/aes-gcm.ts';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { reconnectAction, type ShopStatus, shopMachine, tokenExpiringSoon } from '../domain/shop.ts';
import {
  countListingsOnPlatform,
  delistForDisconnect,
  findLiveCompanyOf,
  findShopByExternal,
  findShopRow,
  insertShop,
  listShopRows,
  type ShopRow,
  updateShop,
} from '../repository/shops.ts';
import { getAdapter, type MarketplaceAdapter, MarketplaceError, type SellerInfo, type TokenSet } from './marketplaces/index.ts';

/** Người làm: `accountId`, `companyId` từ token, quyền và phân hệ từ `getAccess(res)`. */
export interface Actor {
  accountId: string;
  companyId: string;
  permissions: readonly string[];
  enabledModules: readonly string[];
}

export interface Shop {
  id: string;
  companyId: string;
  platform: ShopRow['platform'];
  externalShopId: string;
  shopName: string;
  region: string | null;
  status: ShopStatus;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  tokenExpiringSoon: boolean;
  lastOrderSyncAt: Date | null;
  orderCutoffAt: Date | null;
  /** Hàng chờ đẩy khi chưa gọi được sàn: #102 làm, tới đó luôn 0. */
  pendingJobs: number;
  listingCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShopCallbackResult {
  shop: Shop;
  created: boolean;
  reconnect: { pulledFrom: Date | null; relisted: number; jobsRun: number } | null;
}

const ENTITY = 'shops';

type Platform = ShopRow['platform'];

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy gian hàng');
const unsupported = () => new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ thao tác này');

function toShop(row: ShopRow, listingCount: number): Shop {
  return {
    id: row.id,
    companyId: row.companyId,
    platform: row.platform,
    externalShopId: row.externalShopId,
    shopName: row.shopName,
    region: row.region,
    status: row.status,
    accessExpiresAt: row.accessExpiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    tokenExpiringSoon: tokenExpiringSoon(row.status, row.refreshExpiresAt),
    lastOrderSyncAt: row.lastOrderSyncAt,
    orderCutoffAt: row.orderCutoffAt,
    pendingJobs: 0,
    listingCount,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function shopView(row: ShopRow): Promise<Shop> {
  return toShop(row, (await countListingsOnPlatform([row.id])).get(row.id) ?? 0);
}

function adapterOf(platform: Platform): MarketplaceAdapter {
  const adapter = getAdapter(platform);
  if (!adapter) throw unsupported();
  return adapter;
}

/** Lỗi sàn đổi sang mã app, giữ mã gốc (Documents/21 §1.1 R8, R9). */
function toAppError(err: MarketplaceError): AppError {
  const platform = { platformCode: err.platformCode, platformMessage: err.platformMessage };
  switch (err.kind) {
    case 'unavailable':
      return new AppError(503, 'marketplace_unavailable', 'Sàn đang không phản hồi, thử lại sau', platform);
    case 'unsupported':
      return unsupported();
    default:
      return new AppError(409, 'marketplace_rejected', 'Sàn từ chối yêu cầu', platform);
  }
}

export async function onMarketplace<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof MarketplaceError ? toAppError(err) : err;
  }
}

function tokenKey(): Buffer {
  if (!env.CHANNEL_TOKEN_KEY) {
    throw new AppError(500, 'channel_token_key_missing', 'Máy chủ chưa đặt CHANNEL_TOKEN_KEY để mã hoá token sàn');
  }
  return Buffer.from(env.CHANNEL_TOKEN_KEY, 'base64');
}

/** Cột token đã mã hoá; AAD = "<shopId>:<loại>" nên chép bản mã sang dòng khác không giải mã được. */
function tokenColumns(shopId: string, tokens: TokenSet) {
  const key = tokenKey();
  return {
    accessTokenEnc: encryptBytes(Buffer.from(tokens.accessToken), `${shopId}:access`, key),
    refreshTokenEnc: tokens.refreshToken ? encryptBytes(Buffer.from(tokens.refreshToken), `${shopId}:refresh`, key) : null,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

/** Gian hàng của công ty đang đặt trong `withCompany`; không có (kể cả `id` sai định dạng) thì 404. */
export async function ownShop(id: string): Promise<ShopRow> {
  requireCompanyId('ownShop');
  const shop = isUuid(id) ? await findShopRow(id) : undefined;
  if (!shop) throw notFound();
  return shop;
}

/** Gian hàng gọi được sàn (`connecting`, `active`) kèm adapter và access token đã giải mã. Gọi trong `withCompany`. */
export async function shopSession(id: string): Promise<{ shop: ShopRow; adapter: MarketplaceAdapter; accessToken: string }> {
  const shop = await ownShop(id);
  if ((shop.status !== 'connecting' && shop.status !== 'active') || !shop.accessTokenEnc) {
    throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối hoặc cần kết nối lại', { current: shop.status });
  }
  const accessToken = decryptBytes(shop.accessTokenEnc, `${shop.id}:access`, tokenKey()).toString();
  return { shop, adapter: adapterOf(shop.platform), accessToken };
}

export async function listShops(): Promise<{ items: Shop[] }> {
  requireCompanyId('listShops');
  const rows = await listShopRows();
  const counts = await countListingsOnPlatform(rows.map((r) => r.id));
  return { items: rows.map((r) => toShop(r, counts.get(r.id) ?? 0)) };
}

export async function getShop(id: string): Promise<Shop & { statusHistory: StatusChange[] }> {
  requireCompanyId('getShop');
  const row = isUuid(id) ? await findShopRow(id) : undefined;
  if (!row) throw notFound();
  return { ...(await shopView(row)), statusHistory: await getStatusHistory(ENTITY, id) };
}

/** URL uỷ quyền; `state` là token ký 10 phút gắn công ty, người bấm và sàn (#103 B1). */
export async function authorizeUrl(platform: Platform, actor: Actor): Promise<{ url: string }> {
  const adapter = adapterOf(platform);
  const state = await signPurposeToken('oauth', { cid: actor.companyId, sub: actor.accountId, plt: platform });
  return { url: await onMarketplace(async () => adapter.authorizeUrl(state)) };
}

/** Callback OAuth: kiểm `state`, đổi `code` lấy token, tạo hoặc nối lại gian hàng. */
export async function connectByCode(
  platform: Platform,
  actor: Actor,
  input: { code: string; state: string },
): Promise<ShopCallbackResult> {
  const adapter = adapterOf(platform);
  const claims = await verifyPurposeToken('oauth', input.state).catch((err: unknown) => {
    if (err instanceof PurposeTokenError) return null;
    throw err;
  });
  if (!claims || claims.cid !== actor.companyId || claims.sub !== actor.accountId || claims.plt !== platform) {
    throw new AppError(422, 'oauth_state_invalid', 'Phiên kết nối đã hết hạn hoặc không hợp lệ');
  }
  const tokens = await onMarketplace(() => adapter.exchangeCode(input.code));
  const seller = await onMarketplace(() => adapter.getSeller(tokens.accessToken));
  return attach(platform, actor, tokens, seller);
}

/**
 * Nối gian hàng bằng token lấy trên console của sàn (#103 B2, shop thử không đi OAuth được). Có refresh token thì làm
 * mới một lần để biết hạn; không có thì hạn để trống, hết hạn thì dán token mới.
 */
export async function connectByToken(
  platform: Platform,
  actor: Actor,
  input: { accessToken: string; refreshToken?: string | undefined },
): Promise<ShopCallbackResult> {
  const adapter = adapterOf(platform);
  const tokens: TokenSet = input.refreshToken
    ? await onMarketplace(() => adapter.refreshToken(input.refreshToken!))
    : { accessToken: input.accessToken, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null };
  const seller = await onMarketplace(() => adapter.getSeller(tokens.accessToken));
  return attach(platform, actor, tokens, seller);
}

const connectedElsewhere = () => new AppError(409, 'shop_connected_elsewhere', 'Gian hàng này đã kết nối ở công ty khác');

async function attach(platform: Platform, actor: Actor, tokens: TokenSet, seller: SellerInfo): Promise<ShopCallbackResult> {
  const owner = await findLiveCompanyOf(platform, seller.externalShopId);
  if (owner && owner !== actor.companyId) throw connectedElsewhere();
  try {
    return await withCompany(actor.companyId, async () => {
      const existing = await findShopByExternal(platform, seller.externalShopId);
      if (!existing) {
        const id = randomUUID();
        const row = await insertShop({
          id,
          companyId: actor.companyId,
          platform,
          externalShopId: seller.externalShopId,
          shopName: seller.shopName,
          region: seller.region,
          status: 'connecting',
          ...tokenColumns(id, tokens),
        });
        await recordTransition({ entityType: ENTITY, entityId: id, from: null, to: 'connecting', action: 'connect', actorId: actor.accountId });
        return { shop: await shopView(row), created: true, reconnect: null };
      }

      const action = reconnectAction(existing.status, existing.orderCutoffAt);
      const to = action ? assertTransition(shopMachine, existing.status, action, { actor }).to : existing.status;
      const row = await updateShop(
        existing.id,
        { version: existing.version, status: existing.status },
        { ...tokenColumns(existing.id, tokens), shopName: seller.shopName, status: to, disconnectedAt: null, lastError: null },
      );
      if (!row) throw new AppError(409, 'version_conflict', 'Gian hàng vừa được cập nhật, thử lại');
      if (action) {
        await recordTransition({ entityType: ENTITY, entityId: row.id, from: existing.status, to, action, actorId: actor.accountId });
      }
      // Kéo đơn từ mốc cuối (#105), chạy hàng chờ (#102), đưa lên lại listing gỡ do ngắt (#104) chưa làm: báo 0.
      const reconnect =
        action === 'reconnect' ? { pulledFrom: row.lastOrderSyncAt ?? row.orderCutoffAt, relisted: 0, jobsRun: 0 } : null;
      return { shop: await shopView(row), created: false, reconnect };
    });
  } catch (err) {
    if (pgError(err).constraint === 'shops_platform_external_live_uq') throw connectedElsewhere();
    throw err;
  }
}

/** Đẩy tồn 0 (`zeroStock`) do route gọi trước, ngoài giao dịch (`listing-sync.ts` `pushZeroStock`). */
export async function disconnectShop(actor: Actor, id: string, input: { version: number }): Promise<Shop> {
  const row = await ownShop(id);
  const { to } = assertTransition(shopMachine, row.status, 'disconnect', { actor });
  const updated = await updateShop(
    id,
    { version: input.version, status: row.status },
    {
      status: to,
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
      disconnectedAt: new Date(),
    },
  );
  if (!updated) {
    throw new AppError(409, 'version_conflict', `Gian hàng "${row.shopName}" vừa được người khác cập nhật`, {
      current: await shopView((await findShopRow(id))!),
    });
  }
  await recordTransition({ entityType: ENTITY, entityId: id, from: row.status, to, action: 'disconnect', actorId: actor.accountId });
  for (const listing of await delistForDisconnect(id)) {
    await recordTransition({
      entityType: 'listings',
      entityId: listing.id,
      from: listing.from,
      to: 'delisted',
      action: 'delist',
      actorId: actor.accountId,
      reason: 'Ngắt gian hàng',
    });
  }
  return shopView(updated);
}

/**
 * Gian hàng mất uỷ quyền (refresh token thất bại, sàn báo gỡ app): `active` → `needs_reauth`, nguồn hệ thống.
 * Cho #102, #133 gọi trong `withCompany`. Gian hàng không ở `active` thì bỏ qua.
 */
export async function markNeedsReauth(shopId: string, reason: string): Promise<void> {
  requireCompanyId('markNeedsReauth');
  const row = await findShopRow(shopId);
  if (row?.status !== 'active') return;
  const { to } = assertTransition(shopMachine, row.status, 'lose_auth', { actor: null });
  const updated = await updateShop(shopId, { version: row.version, status: row.status }, { status: to, lastError: reason });
  if (updated) {
    await recordTransition({ entityType: ENTITY, entityId: shopId, from: row.status, to, action: 'lose_auth', actorId: null, reason });
  }
}
