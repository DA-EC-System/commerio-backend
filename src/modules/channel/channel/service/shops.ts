// Gian hàng (#103; Documents/21 §18.1, §18.4). Gọi sàn trước, ngoài giao dịch; ghi DB sau trong `withCompany`.
import { randomUUID } from 'node:crypto';
import {
  assertTransition,
  countHeld,
  lastDeadJobs,
  dropHeld,
  getCompanies,
  getStatusHistory,
  lastTransitionsAt,
  recordTransition,
  releaseHeld,
  type StatusChange,
} from '../../../core/index.ts';
import { PurposeTokenError, signPurposeToken, verifyPurposeToken } from '../../../../shared/auth/purpose-token.ts';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { countOpenOrders, oldestOpenOrders, orderCountsByShop } from '../../../order/index.ts';
import { logger } from '../../../../shared/logger.ts';
import {
  assertNoOpenOrders,
  authDeadline,
  reconnectAction,
  type ShopStatus,
  shopMachine,
  tokenExpiringSoon,
} from '../domain/shop.ts';
import { isMarketplace } from '../repository/schema.ts';
import {
  countListingsOnPlatform,
  delistForDisconnect,
  findLiveCompanyOf,
  findShopByExternal,
  findShopRow,
  insertShop,
  listShopRows,
  lockShopRow,
  type ShopRow,
  updateShop,
} from '../repository/shops.ts';
import {
  capabilitiesOf,
  getAdapter,
  type MarketplaceAdapter,
  MarketplaceError,
  type PlatformEntry,
  platformEntries,
  type ShopCapabilities,
  type ShopConnection,
} from './marketplaces/index.ts';
import {
  listingSyncQueue,
  openOrderPullQueue,
  resumeOpenOrderPull,
  sendOrderPull,
  startShopJobs,
  stopShopJobs,
} from './shop-jobs.ts';
import { decryptAccessToken, tokenColumns, withTokenRefresh } from './shop-tokens.ts';
import { setupOf, type ShopSetup } from '../domain/shop-setup.ts';
import { type OpeningStocktakeStatus, stocktakePort } from './stocktake-port.ts';

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
  /** Hạn uỷ quyền seller chọn trên sàn, null khi sàn không có hạn riêng (21 §18.4). */
  authExpiresAt: Date | null;
  /** Hạn gần hơn trong `authExpiresAt`, `refreshExpiresAt` còn dưới 3 ngày (gian hàng `active`). */
  tokenExpiringSoon: boolean;
  lastOrderSyncAt: Date | null;
  orderCutoffAt: Date | null;
  /** Năng lực của sàn (adapter khai, không lưu DB). */
  capabilities: ShopCapabilities;
  /** Hạn trả hàng (ngày), null khi chưa thiết lập hoặc sàn `returnWindow = 'platform_status'`. */
  returnWindowDays: number | null;
  /** Phiếu kiểm kê đầu kỳ đang chờ ghi sổ (chế độ chờ kiểm kê lần đầu, #198). */
  openingStocktake: { documentId: string; number: string; status: OpeningStocktakeStatus } | null;
  /** Tiến độ thiết lập (#198, 21 §18.7.7). */
  setup: ShopSetup | null;
  /** Hàng chờ đẩy khi chưa gọi được sàn: #102 làm, tới đó luôn 0. */
  pendingJobs: number;
  listingCount: number;
  /** Số đơn chưa `completed` hoặc `cancelled`, cùng cách đếm với `openOrders` của ngắt (§18.7.1). */
  pendingOrderCount: number;
  /** Số đơn đặt trên sàn (`placedAt`) trong 7 × 24 giờ tính lùi từ lúc gọi (§18.7.1). */
  orders7d: number;
  /** Lần đổi `status` gần nhất (lịch sử trạng thái), chưa đổi lần nào thì bằng `createdAt` (§18.7.1). */
  statusChangedAt: Date;
  /** Phiên bản cấu hình phí đang áp: `null` tới commerio-backend#230 (§18.7.1). */
  feeConfigVersion: number | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShopConnectionResult {
  shop: Shop;
  created: boolean;
  reconnect: { pulledFrom: Date | null; relisted: number; jobsRun: number } | null;
}

/** Một gian hàng của lần nối (§18.7.4): thêm trạng thái ngay trước lần nối và số SKU người bán đọc được trên sàn. */
export interface ShopConnectionItem extends ShopConnectionResult {
  /** null khi `created: true`. */
  previousStatus: ShopStatus | null;
  /** null khi chưa đọc được: sàn không có `listSkus`, sàn lỗi hoặc quá `REMOTE_SKU_COUNT_MS`. */
  remoteSkuCount: number | null;
}

/**
 * `shop`, `created`, `reconnect` là của phần tử đầu; `shops` đủ mọi gian hàng của lần nối (Documents/21 §18.4). Gốc không
 * có `previousStatus`, `remoteSkuCount` (§18.7.4).
 */
export interface ShopCallbackResult extends ShopConnectionResult {
  shops: ShopConnectionItem[];
}

const ENTITY = 'shops';

type Platform = ShopRow['platform'];

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy gian hàng');
const unsupported = () => new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ thao tác này');

interface ShopExtras {
  listings: Map<string, number>;
  held: Map<string, number>;
  stocktakeStatus: Map<string, OpeningStocktakeStatus>;
  /** Lúc lỗi gần nhất của việc hết lượt thử, khoá `"<shopId> <hàng>"` (`lastDeadJobs`). */
  dead: Map<string, Date>;
  /** Số đơn theo gian hàng, đọc qua cổng của `order` (§18.7.1). */
  orders: Map<string, { open: number; placed: number }>;
  /** Lần đổi trạng thái gần nhất theo `core.state_transitions`. */
  statusChanged: Map<string, Date>;
}

const ORDERS_WINDOW_MS = 7 * 24 * 3600_000;

/** Gian hàng đang thiết lập dở (#198): mới cần đọc hàng lỗi cho `setup`. */
const settingUp = (r: ShopRow) => r.openingStockMode !== null && r.status !== 'disconnected' && (!r.openOrdersPulledAt || !r.stockPushedAt);

/** Số đếm và trạng thái phiếu đầu kỳ cho các gian hàng, đọc một lần cho cả danh sách. Gọi trong `withCompany`. */
async function shopExtras(rows: readonly ShopRow[]): Promise<ShopExtras> {
  const ids = rows.map((r) => r.id);
  const docs = rows.flatMap((r) => (r.openingStocktakeId ? [r.openingStocktakeId] : []));
  const [listings, held, stocktakeStatus, dead, orders, statusChanged] = await Promise.all([
    countListingsOnPlatform(ids),
    countHeld(ids),
    docs.length ? stocktakePort().openingStocktakeStatusOf(docs) : new Map<string, OpeningStocktakeStatus>(),
    lastDeadJobs(rows.filter(settingUp).map((r) => r.id), [openOrderPullQueue.name, listingSyncQueue.name]),
    orderCountsByShop(ids, new Date(Date.now() - ORDERS_WINDOW_MS)),
    lastTransitionsAt(ENTITY, ids),
  ]);
  return { listings, held, stocktakeStatus, dead, orders, statusChanged };
}

function toShop(row: ShopRow, extras: ShopExtras): Shop {
  const listingCount = extras.listings.get(row.id) ?? 0;
  const pendingJobs = extras.held.get(row.id) ?? 0;
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
    authExpiresAt: row.authExpiresAt,
    tokenExpiringSoon: tokenExpiringSoon(row.status, authDeadline(row.authExpiresAt, row.refreshExpiresAt)),
    lastOrderSyncAt: row.lastOrderSyncAt,
    orderCutoffAt: row.orderCutoffAt,
    capabilities: capabilitiesOf(row.platform),
    returnWindowDays: row.returnWindowDays,
    openingStocktake:
      row.openingStocktakeId && row.openingStocktakeNumber
        ? {
            documentId: row.openingStocktakeId,
            number: row.openingStocktakeNumber,
            status: extras.stocktakeStatus.get(row.openingStocktakeId) ?? 'draft',
          }
        : null,
    setup: setupOf(
      {
        ...row,
        openOrderPullFailedAt: extras.dead.get(`${row.id} ${openOrderPullQueue.name}`) ?? null,
        listingSyncFailedAt: extras.dead.get(`${row.id} ${listingSyncQueue.name}`) ?? null,
      },
      new Date(),
    ),
    pendingJobs,
    listingCount,
    pendingOrderCount: extras.orders.get(row.id)?.open ?? 0,
    orders7d: extras.orders.get(row.id)?.placed ?? 0,
    statusChangedAt: extras.statusChanged.get(row.id) ?? row.createdAt,
    feeConfigVersion: null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function shopView(row: ShopRow): Promise<Shop> {
  return toShop(row, await shopExtras([row]));
}

function adapterOf(platform: string): MarketplaceAdapter {
  const adapter = getAdapter(platform);
  if (!adapter) throw unsupported();
  return adapter;
}

/** Mã sàn từ URL: phải có adapter và có trong enum DB, không thì 422 `marketplace_unsupported` (21 §18.4). */
function platformOf(platform: string): { platform: Platform; adapter: MarketplaceAdapter } {
  if (!isMarketplace(platform)) throw unsupported();
  return { platform, adapter: adapterOf(platform) };
}

/** Lỗi sàn đổi sang mã app, giữ mã gốc (Documents/21 §1.1 R8, R9). */
function toAppError(err: MarketplaceError): AppError {
  const platform = { platformCode: err.platformCode, platformMessage: err.platformMessage };
  switch (err.kind) {
    case 'unavailable':
      return new AppError(503, 'marketplace_unavailable', 'Sàn đang không phản hồi, thử lại sau', platform);
    case 'unsupported':
      return unsupported();
    case 'unauthorized':
      return new AppError(409, 'marketplace_unauthorized', 'Sàn từ chối token của gian hàng, cần kết nối lại', platform);
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
  const accessToken = decryptAccessToken(shop)!;
  // Sàn báo `unauthorized` thì làm mới token một lần rồi gọi lại (#201, Documents/16 bài toán 3).
  return { shop, adapter: withTokenRefresh(adapterOf(shop.platform), shop.companyId, shop.id, accessToken), accessToken };
}

export async function listShops(): Promise<{ items: Shop[] }> {
  requireCompanyId('listShops');
  const rows = await listShopRows();
  const extras = await shopExtras(rows);
  return { items: rows.map((r) => toShop(r, extras)) };
}

/**
 * Sàn và cách nối (Documents/21 §18.1, §18.7.3), gồm cả sàn chưa nối được (`connectable: false` kèm `reason`). Cấu hình
 * của máy chủ, giống nhau với mọi công ty; không lộ khoá.
 */
export function shopPlatforms(): { items: PlatformEntry[] } {
  return { items: platformEntries() };
}

export async function getShop(id: string): Promise<Shop & { statusHistory: StatusChange[] }> {
  const row = await ownShop(id);
  return { ...(await shopView(row)), statusHistory: await getStatusHistory(ENTITY, id) };
}

/** URL uỷ quyền; `state` là token ký 10 phút gắn công ty, người bấm và sàn (#103 B1). */
export async function authorizeUrl(raw: string, actor: Actor): Promise<{ url: string }> {
  const { platform, adapter } = platformOf(raw);
  const state = await signPurposeToken('oauth', { cid: actor.companyId, sub: actor.accountId, plt: platform });
  return { url: await onMarketplace(async () => adapter.authorizeUrl(state)) };
}

/**
 * Callback OAuth: kiểm `state`, adapter đổi `params` (mọi query sàn trả trừ `state`) lấy các gian hàng, tạo hoặc nối lại.
 * Body cũ `{ code, state }` coi như `params = { code }` (21 §18.6.3).
 */
export async function connectByCode(
  raw: string,
  actor: Actor,
  input: { state?: string | undefined; params?: Record<string, string> | undefined; code?: string | undefined },
): Promise<ShopCallbackResult> {
  const { platform, adapter } = platformOf(raw);
  const claims = input.state
    ? await verifyPurposeToken('oauth', input.state).catch((err: unknown) => {
        if (err instanceof PurposeTokenError) return null;
        throw err;
      })
    : null;
  if (!claims?.cid || claims.sub !== actor.accountId || claims.plt !== platform) {
    throw new AppError(422, 'oauth_state_invalid', 'Phiên kết nối đã hết hạn hoặc không hợp lệ');
  }
  if (claims.cid !== actor.companyId) throw await companyMismatch(claims.cid, actor.companyId);
  const params = input.params ?? { code: input.code! };
  return attachAll(platform, actor, await onMarketplace(async () => atLeastOne(await adapter.exchangeCode(params))));
}

/**
 * Người bấm đổi công ty giữa lúc mở trang uỷ quyền và lúc sàn trả về (21 §18.7.4): `expected` là công ty trong `state`,
 * `actual` là công ty trong token. Ném trước khi đổi `code`, nên không nhận token sàn nào, không ghi gian hàng nào.
 */
async function companyMismatch(expectedId: string, actualId: string): Promise<AppError> {
  const names = await getCompanies([expectedId, actualId]);
  const ref = (id: string) => ({ id, name: names.get(id)?.name ?? '' });
  return new AppError(409, 'company_mismatch', 'Phiên kết nối được mở ở công ty khác công ty đang chọn', {
    expected: ref(expectedId),
    actual: ref(actualId),
  });
}

/** Nối gian hàng bằng token lấy trên console của sàn (#103 B2, shop thử không đi OAuth được); adapter tự làm mới nếu cần. */
export async function connectByToken(
  raw: string,
  actor: Actor,
  input: { accessToken: string; refreshToken?: string | undefined },
): Promise<ShopCallbackResult> {
  const { platform, adapter } = platformOf(raw);
  const connections = await onMarketplace(async () =>
    atLeastOne(await adapter.connectWithToken({ accessToken: input.accessToken, refreshToken: input.refreshToken ?? null })),
  );
  return attachAll(platform, actor, connections);
}

/** Uỷ quyền mà không ra gian hàng nào: ném trong `onMarketplace` để thành 409 `marketplace_rejected`, không 500. */
function atLeastOne(connections: ShopConnection[]): ShopConnection[] {
  if (connections.length === 0) throw new MarketplaceError('rejected', 'no_shop', 'Sàn không trả gian hàng nào cho lần uỷ quyền này');
  return connections;
}

const connectedElsewhere = () => new AppError(409, 'shop_connected_elsewhere', 'Gian hàng này đã kết nối ở công ty khác');

/**
 * Nối mọi gian hàng của một lần uỷ quyền, tất cả hoặc không (#200): kiểm "đã gắn công ty khác" cho từng gian hàng ngoài
 * giao dịch (role chủ bảng, RLS không che), ghi tất cả trong một `withCompany`, rồi mới chạy việc sau commit.
 */
async function attachAll(platform: Platform, actor: Actor, connections: ShopConnection[]): Promise<ShopCallbackResult> {
  const unique = [...new Map(connections.map((c) => [c.externalShopId, c])).values()];
  for (const c of unique) {
    const owner = await findLiveCompanyOf(platform, c.externalShopId);
    if (owner && owner !== actor.companyId) throw connectedElsewhere();
  }
  const adapter = adapterOf(platform);
  const skuCounts = await Promise.all(unique.map((c) => remoteSkuCount(adapter, c)));
  let results: ShopConnectionItem[];
  try {
    results = await withCompany(actor.companyId, async () => {
      const out: ShopConnectionItem[] = [];
      for (const [i, c] of unique.entries()) out.push({ ...(await writeShop(platform, actor, c)), remoteSkuCount: skuCounts[i]! });
      return out;
    });
  } catch (err) {
    if (pgError(err).constraint === 'shops_platform_external_live_uq') throw connectedElsewhere();
    throw err;
  }
  // Sau commit: gian hàng đã `active` (nối lại) thì chạy việc đang giữ và bật lại lịch (#102 A5).
  for (const result of results) {
    if (result.shop.status !== 'active') continue;
    const jobsRun = await releaseHeld(result.shop.id);
    await startShopJobs(result.shop.companyId, result.shop.id);
    await resumeOpenOrderPull(result.shop.companyId, result.shop.id);
    // Nối lại gian hàng đã thiết lập: kéo đơn ngay từ lần kéo thành công cuối (US-GH-14 dòng 1), không chờ vòng 5 phút.
    if (result.reconnect) await sendOrderPull(result.shop.companyId, result.shop.id);
    result.shop.pendingJobs = 0;
    if (result.reconnect) result.reconnect.jobsRun = jobsRun;
  }
  const { shop, created, reconnect } = results[0]!;
  return { shop, created, reconnect, shops: results };
}

/** Hạn tổng cho việc đếm SKU trên sàn lúc nối (§18.7.4): quá hạn thì `remoteSkuCount: null`, việc nối vẫn xong. */
const REMOTE_SKU_COUNT_MS = 10_000;

/**
 * Số SKU người bán đọc được trên sàn lúc nối (§18.7.4), không tính SKU đã xoá trên sàn, như gợi ý ghép của thiết lập.
 * Gọi sàn ngoài giao dịch, các gian hàng của một lần nối đếm song song. Chỉ để hiện trên màn kết quả nên không chặn việc
 * nối: sàn chưa có `listSkus`, gọi lỗi (mọi lỗi) hoặc quá `REMOTE_SKU_COUNT_MS` thì `null` (chưa đọc được), ghi log.
 * `listSkus` không nhận `AbortSignal` nên lời gọi quá hạn vẫn chạy nốt ở nền, kết quả bị bỏ.
 */
async function remoteSkuCount(adapter: MarketplaceAdapter, c: ShopConnection): Promise<number | null> {
  if (!adapter.listSkus) return null;
  const listSkus = adapter.listSkus.bind(adapter);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), REMOTE_SKU_COUNT_MS);
  });
  try {
    const result = await Promise.race([listSkus(c.tokens.accessToken), timeout]);
    if (result === 'timeout') {
      logger.warn({ externalShopId: c.externalShopId, timeoutMs: REMOTE_SKU_COUNT_MS }, 'Đếm SKU trên sàn lúc nối quá hạn');
      return null;
    }
    return result.filter((r) => r.state !== 'deleted').length;
  } catch (err) {
    if (err instanceof MarketplaceError) {
      logger.warn({ externalShopId: c.externalShopId, kind: err.kind, platformCode: err.platformCode }, 'Không đọc được SKU trên sàn lúc nối');
    } else {
      logger.error({ err, externalShopId: c.externalShopId }, 'Lỗi khi đếm SKU trên sàn lúc nối');
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Tạo hoặc nối lại một gian hàng; gọi trong `withCompany`. */
async function writeShop(
  platform: Platform,
  actor: Actor,
  c: ShopConnection,
): Promise<ShopConnectionResult & { previousStatus: ShopStatus | null }> {
  const existing = await findShopByExternal(platform, c.externalShopId);
  if (!existing) {
    const id = randomUUID();
    const row = await insertShop({
      id,
      companyId: actor.companyId,
      platform,
      externalShopId: c.externalShopId,
      shopName: c.shopName,
      region: c.region,
      status: 'connecting',
      ...tokenColumns(id, c.tokens),
    });
    await recordTransition({ entityType: ENTITY, entityId: id, from: null, to: 'connecting', action: 'connect', actorId: actor.accountId });
    return { shop: await shopView(row), created: true, reconnect: null, previousStatus: null };
  }

  const action = reconnectAction(existing.status, existing.orderCutoffAt);
  const to = action ? assertTransition(shopMachine, existing.status, action, { actor }).to : existing.status;
  const row = await updateShop(
    existing.id,
    { version: existing.version, status: existing.status },
    { ...tokenColumns(existing.id, c.tokens), shopName: c.shopName, status: to, disconnectedAt: null, lastError: null },
  );
  if (!row) throw new AppError(409, 'version_conflict', 'Gian hàng vừa được cập nhật, thử lại');
  if (action) {
    await recordTransition({ entityType: ENTITY, entityId: row.id, from: existing.status, to, action, actorId: actor.accountId });
  }
  // Kéo đơn từ mốc cuối (#105), đưa lên lại listing gỡ do ngắt (#104) chưa làm: báo 0. `jobsRun` điền sau khi commit.
  const reconnect = action === 'reconnect' ? { pulledFrom: row.lastOrderSyncAt ?? row.orderCutoffAt, relisted: 0, jobsRun: 0 } : null;
  return { shop: await shopView(row), created: false, reconnect, previousStatus: existing.status };
}

/**
 * Kiểm ngắt được theo thứ tự Documents/21 §18.6.1: 404, `invalid_transition`, `version_conflict`, `shop_has_open_orders`.
 * Khoá dòng gian hàng tới hết giao dịch của bên gọi, nên đơn đang về (`order-pull.ts` khoá chia sẻ) không lọt.
 * Route gọi riêng một lần trước khi đẩy tồn 0; `disconnectShop` gọi lại trong giao dịch ngắt.
 */
export async function checkDisconnect(actor: Actor, id: string, version: number): Promise<{ row: ShopRow; to: ShopStatus }> {
  requireCompanyId('checkDisconnect');
  const row = isUuid(id) ? await lockShopRow(id) : undefined;
  if (!row) throw notFound();
  const { to } = assertTransition(shopMachine, row.status, 'disconnect', { actor });
  if (row.version !== version) {
    throw new AppError(409, 'version_conflict', `Gian hàng "${row.shopName}" vừa được người khác cập nhật`, {
      current: await shopView(row),
    });
  }
  const openOrders = await countOpenOrders(id);
  if (openOrders > 0) assertNoOpenOrders(openOrders, await oldestOpenOrders(id, OPEN_ORDERS_LISTED));
  return { row, to };
}

/** Số đơn liệt kê ở 409 `shop_has_open_orders` (§18.7.8). */
const OPEN_ORDERS_LISTED = 20;

/** Đẩy tồn 0 (`zeroStock`) do route gọi trước, ngoài giao dịch (`listing-sync.ts` `pushZeroStock`). */
export async function disconnectShop(actor: Actor, id: string, input: { version: number }): Promise<Shop> {
  const { row, to } = await checkDisconnect(actor, id, input.version);
  // Dòng đã khoá và đã kiểm `version`, `status` nên cập nhật luôn trúng.
  const updated = (await updateShop(
    id,
    { version: input.version, status: row.status },
    {
      status: to,
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
      authExpiresAt: null,
      disconnectedAt: new Date(),
    },
  ))!;
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
  // Ngắt thì bỏ lịch và việc đang giữ (§18.1). Giao dịch lỗi sau bước này thì gian hàng còn `active` mà thiếu lịch:
  // worker khởi động lại sẽ đặt lại (`reconcileShopJobs`).
  await stopShopJobs(id);
  await dropHeld(id);
  return shopView(updated);
}

// Mất uỷ quyền và làm mới token ở `shop-tokens.ts` (#201); giữ đường import cũ cho `index.ts`, `background.ts`.
export { loseShopAuth, markNeedsReauth, refreshShopToken } from './shop-tokens.ts';
