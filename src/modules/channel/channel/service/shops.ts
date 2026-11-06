// Gian hàng (#103; Documents/21 §18.1, §18.4). Gọi sàn trước, ngoài giao dịch; ghi DB sau trong `withCompany`.
import { randomUUID } from "node:crypto";
import {
  assertTransition,
  countHeld,
  lastDeadJobs,
  dropHeld,
  getCompanies,
  getStatusHistory,
  recordTransition,
  releaseHeld,
  type StatusChange,
} from "../../../core/index.ts";
import {
  PurposeTokenError,
  signPurposeToken,
  verifyPurposeToken,
} from "../../../../shared/auth/purpose-token.ts";
import { env } from "../../../../shared/config/env.ts";
import {
  decryptBytes,
  encryptBytes,
} from "../../../../shared/crypto/aes-gcm.ts";
import { requireCompanyId, withCompany } from "../../../../shared/db/client.ts";
import { pgError } from "../../../../shared/db/pg-error.ts";
import { AppError } from "../../../../shared/errors/app-error.ts";
import { isUuid } from "../../../../shared/uuid.ts";
import { countOpenOrders } from "../../../order/index.ts";
import {
  assertNoOpenOrders,
  reconnectAction,
  type ShopStatus,
  shopMachine,
  tokenExpiringSoon,
} from "../domain/shop.ts";
import { isMarketplace } from "../repository/schema.ts";
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
} from "../repository/shops.ts";
import {
  capabilitiesOf,
  type ConnectMethod,
  connectablePlatforms,
  getAdapter,
  type MarketplaceAdapter,
  MarketplaceError,
  type ShopCapabilities,
  type ShopConnection,
  type TokenSet,
} from "./marketplaces/index.ts";
import {
  listingSyncQueue,
  openOrderPullQueue,
  resumeOpenOrderPull,
  startShopJobs,
  stopShopJobs,
} from "./shop-jobs.ts";
import { setupOf, type ShopSetup } from "../domain/shop-setup.ts";
import {
  type OpeningStocktakeStatus,
  stocktakePort,
} from "./stocktake-port.ts";

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
  platform: ShopRow["platform"];
  externalShopId: string;
  shopName: string;
  region: string | null;
  status: ShopStatus;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  tokenExpiringSoon: boolean;
  lastOrderSyncAt: Date | null;
  orderCutoffAt: Date | null;
  /** Năng lực của sàn (adapter khai, không lưu DB). */
  capabilities: ShopCapabilities;
  /** Hạn trả hàng (ngày), null khi chưa thiết lập hoặc sàn `returnWindow = 'platform_status'`. */
  returnWindowDays: number | null;
  /** Phiếu kiểm kê đầu kỳ đang chờ ghi sổ (chế độ chờ kiểm kê lần đầu, #198). */
  openingStocktake: {
    documentId: string;
    number: string;
    status: OpeningStocktakeStatus;
  } | null;
  /** Tiến độ thiết lập (#198, 21 §18.7.7). */
  setup: ShopSetup | null;
  /** Hàng chờ đẩy khi chưa gọi được sàn: #102 làm, tới đó luôn 0. */
  pendingJobs: number;
  listingCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShopConnectionResult {
  shop: Shop;
  created: boolean;
  reconnect: {
    pulledFrom: Date | null;
    relisted: number;
    jobsRun: number;
  } | null;
}

/** `shop`, `created`, `reconnect` là của phần tử đầu; `shops` đủ mọi gian hàng của lần nối (Documents/21 §18.4). */
export interface ShopCallbackResult extends ShopConnectionResult {
  shops: ShopConnectionResult[];
}

const ENTITY = "shops";

type Platform = ShopRow["platform"];

const notFound = () =>
  new AppError(404, "not_found", "Không tìm thấy gian hàng");
const unsupported = () =>
  new AppError(
    422,
    "marketplace_unsupported",
    "Sàn này chưa hỗ trợ thao tác này",
  );

interface ShopExtras {
  listings: Map<string, number>;
  held: Map<string, number>;
  stocktakeStatus: Map<string, OpeningStocktakeStatus>;
  /** Lúc lỗi gần nhất của việc hết lượt thử, khoá `"<shopId> <hàng>"` (`lastDeadJobs`). */
  dead: Map<string, Date>;
}

/** Gian hàng đang thiết lập dở (#198): mới cần đọc hàng lỗi cho `setup`. */
const settingUp = (r: ShopRow) =>
  r.openingStockMode !== null &&
  r.status !== "disconnected" &&
  (!r.openOrdersPulledAt || !r.stockPushedAt);

/** Số đếm và trạng thái phiếu đầu kỳ cho các gian hàng, đọc một lần cho cả danh sách. Gọi trong `withCompany`. */
async function shopExtras(rows: readonly ShopRow[]): Promise<ShopExtras> {
  const ids = rows.map((r) => r.id);
  const docs = rows.flatMap((r) =>
    r.openingStocktakeId ? [r.openingStocktakeId] : [],
  );
  const [listings, held, stocktakeStatus, dead] = await Promise.all([
    countListingsOnPlatform(ids),
    countHeld(ids),
    docs.length
      ? stocktakePort().openingStocktakeStatusOf(docs)
      : new Map<string, OpeningStocktakeStatus>(),
    lastDeadJobs(
      rows.filter(settingUp).map((r) => r.id),
      [openOrderPullQueue.name, listingSyncQueue.name],
    ),
  ]);
  return { listings, held, stocktakeStatus, dead };
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
    tokenExpiringSoon: tokenExpiringSoon(row.status, row.refreshExpiresAt),
    lastOrderSyncAt: row.lastOrderSyncAt,
    orderCutoffAt: row.orderCutoffAt,
    capabilities: capabilitiesOf(row.platform),
    returnWindowDays: row.returnWindowDays,
    openingStocktake:
      row.openingStocktakeId && row.openingStocktakeNumber
        ? {
            documentId: row.openingStocktakeId,
            number: row.openingStocktakeNumber,
            status:
              extras.stocktakeStatus.get(row.openingStocktakeId) ?? "draft",
          }
        : null,
    setup: setupOf(
      {
        ...row,
        openOrderPullFailedAt:
          extras.dead.get(`${row.id} ${openOrderPullQueue.name}`) ?? null,
        listingSyncFailedAt:
          extras.dead.get(`${row.id} ${listingSyncQueue.name}`) ?? null,
      },
      new Date(),
    ),
    pendingJobs,
    listingCount,
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
function platformOf(platform: string): {
  platform: Platform;
  adapter: MarketplaceAdapter;
} {
  if (!isMarketplace(platform)) throw unsupported();
  return { platform, adapter: adapterOf(platform) };
}

/** Lỗi sàn đổi sang mã app, giữ mã gốc (Documents/21 §1.1 R8, R9). */
function toAppError(err: MarketplaceError): AppError {
  const platform = {
    platformCode: err.platformCode,
    platformMessage: err.platformMessage,
  };
  switch (err.kind) {
    case "unavailable":
      return new AppError(
        503,
        "marketplace_unavailable",
        "Sàn đang không phản hồi, thử lại sau",
        platform,
      );
    case "unsupported":
      return unsupported();
    case "unauthorized":
      return new AppError(
        409,
        "marketplace_unauthorized",
        "Sàn từ chối token của gian hàng, cần kết nối lại",
        platform,
      );
    default:
      return new AppError(
        409,
        "marketplace_rejected",
        "Sàn từ chối yêu cầu",
        platform,
      );
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
    throw new AppError(
      500,
      "channel_token_key_missing",
      "Máy chủ chưa đặt CHANNEL_TOKEN_KEY để mã hoá token sàn",
    );
  }
  return Buffer.from(env.CHANNEL_TOKEN_KEY, "base64");
}

/** Cột token đã mã hoá; AAD = "<shopId>:<loại>" nên chép bản mã sang dòng khác không giải mã được. */
function tokenColumns(shopId: string, tokens: TokenSet) {
  const key = tokenKey();
  return {
    accessTokenEnc: encryptBytes(
      Buffer.from(tokens.accessToken),
      `${shopId}:access`,
      key,
    ),
    refreshTokenEnc: tokens.refreshToken
      ? encryptBytes(Buffer.from(tokens.refreshToken), `${shopId}:refresh`, key)
      : null,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

/** Gian hàng của công ty đang đặt trong `withCompany`; không có (kể cả `id` sai định dạng) thì 404. */
export async function ownShop(id: string): Promise<ShopRow> {
  requireCompanyId("ownShop");
  const shop = isUuid(id) ? await findShopRow(id) : undefined;
  if (!shop) throw notFound();
  return shop;
}

/** Gian hàng gọi được sàn (`connecting`, `active`) kèm adapter và access token đã giải mã. Gọi trong `withCompany`. */
export async function shopSession(
  id: string,
): Promise<{
  shop: ShopRow;
  adapter: MarketplaceAdapter;
  accessToken: string;
}> {
  const shop = await ownShop(id);
  if (
    (shop.status !== "connecting" && shop.status !== "active") ||
    !shop.accessTokenEnc
  ) {
    throw new AppError(
      409,
      "shop_not_connected",
      "Gian hàng chưa kết nối hoặc cần kết nối lại",
      { current: shop.status },
    );
  }
  const accessToken = decryptBytes(
    shop.accessTokenEnc,
    `${shop.id}:access`,
    tokenKey(),
  ).toString();
  return { shop, adapter: adapterOf(shop.platform), accessToken };
}

export async function listShops(): Promise<{ items: Shop[] }> {
  requireCompanyId("listShops");
  const rows = await listShopRows();
  const extras = await shopExtras(rows);
  return { items: rows.map((r) => toShop(r, extras)) };
}

/** Sàn kết nối được và cách nối (Documents/21 §18.1). Cấu hình của máy chủ, giống nhau với mọi công ty; không lộ khoá. */
export function shopPlatforms(): {
  items: {
    platform: string;
    name: string;
    connectable: true;
    methods: readonly ConnectMethod[];
    capabilities: ShopCapabilities;
  }[];
} {
  return {
    items: connectablePlatforms().map((p) => ({ ...p, connectable: true })),
  };
}

export async function getShop(
  id: string,
): Promise<Shop & { statusHistory: StatusChange[] }> {
  const row = await ownShop(id);
  return {
    ...(await shopView(row)),
    statusHistory: await getStatusHistory(ENTITY, id),
  };
}

/** URL uỷ quyền; `state` là token ký 10 phút gắn công ty, người bấm và sàn (#103 B1). */
export async function authorizeUrl(
  raw: string,
  actor: Actor,
): Promise<{ url: string }> {
  const { platform, adapter } = platformOf(raw);
  const state = await signPurposeToken("oauth", {
    cid: actor.companyId,
    sub: actor.accountId,
    plt: platform,
  });
  return { url: await onMarketplace(async () => adapter.authorizeUrl(state)) };
}

/**
 * Callback OAuth: kiểm `state`, adapter đổi `params` (mọi query sàn trả trừ `state`) lấy các gian hàng, tạo hoặc nối lại.
 * Body cũ `{ code, state }` coi như `params = { code }` (21 §18.6.3).
 */
export async function connectByCode(
  raw: string,
  actor: Actor,
  input: {
    state?: string | undefined;
    params?: Record<string, string> | undefined;
    code?: string | undefined;
  },
): Promise<ShopCallbackResult> {
  const { platform, adapter } = platformOf(raw);
  const claims = input.state
    ? await verifyPurposeToken("oauth", input.state).catch((err: unknown) => {
        if (err instanceof PurposeTokenError) return null;
        throw err;
      })
    : null;
  if (
    !claims?.cid ||
    claims.sub !== actor.accountId ||
    claims.plt !== platform
  ) {
    throw new AppError(
      422,
      "oauth_state_invalid",
      "Phiên kết nối đã hết hạn hoặc không hợp lệ",
    );
  }
  if (claims.cid !== actor.companyId)
    throw await companyMismatch(claims.cid, actor.companyId);
  const params = input.params ?? { code: input.code! };
  return attachAll(
    platform,
    actor,
    await onMarketplace(async () =>
      atLeastOne(await adapter.exchangeCode(params)),
    ),
  );
}

/**
 * Người bấm đổi công ty giữa lúc mở trang uỷ quyền và lúc sàn trả về (21 §18.7.4): `expected` là công ty trong `state`,
 * `actual` là công ty trong token. Ném trước khi đổi `code`, nên không nhận token sàn nào, không ghi gian hàng nào.
 */
async function companyMismatch(
  expectedId: string,
  actualId: string,
): Promise<AppError> {
  const names = await getCompanies([expectedId, actualId]);
  const ref = (id: string) => ({ id, name: names.get(id)?.name ?? "" });
  return new AppError(
    409,
    "company_mismatch",
    "Phiên kết nối được mở ở công ty khác công ty đang chọn",
    {
      expected: ref(expectedId),
      actual: ref(actualId),
    },
  );
}

/** Nối gian hàng bằng token lấy trên console của sàn (#103 B2, shop thử không đi OAuth được); adapter tự làm mới nếu cần. */
export async function connectByToken(
  raw: string,
  actor: Actor,
  input: { accessToken: string; refreshToken?: string | undefined },
): Promise<ShopCallbackResult> {
  const { platform, adapter } = platformOf(raw);
  const connections = await onMarketplace(async () =>
    atLeastOne(
      await adapter.connectWithToken({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
      }),
    ),
  );
  return attachAll(platform, actor, connections);
}

/** Uỷ quyền mà không ra gian hàng nào: ném trong `onMarketplace` để thành 409 `marketplace_rejected`, không 500. */
function atLeastOne(connections: ShopConnection[]): ShopConnection[] {
  if (connections.length === 0)
    throw new MarketplaceError(
      "rejected",
      "no_shop",
      "Sàn không trả gian hàng nào cho lần uỷ quyền này",
    );
  return connections;
}

const connectedElsewhere = () =>
  new AppError(
    409,
    "shop_connected_elsewhere",
    "Gian hàng này đã kết nối ở công ty khác",
  );

/**
 * Nối mọi gian hàng của một lần uỷ quyền, tất cả hoặc không (#200): kiểm "đã gắn công ty khác" cho từng gian hàng ngoài
 * giao dịch (role chủ bảng, RLS không che), ghi tất cả trong một `withCompany`, rồi mới chạy việc sau commit.
 */
async function attachAll(
  platform: Platform,
  actor: Actor,
  connections: ShopConnection[],
): Promise<ShopCallbackResult> {
  const unique = [
    ...new Map(connections.map((c) => [c.externalShopId, c])).values(),
  ];
  for (const c of unique) {
    const owner = await findLiveCompanyOf(platform, c.externalShopId);
    if (owner && owner !== actor.companyId) throw connectedElsewhere();
  }
  let results: ShopConnectionResult[];
  try {
    results = await withCompany(actor.companyId, async () => {
      const out: ShopConnectionResult[] = [];
      for (const c of unique) out.push(await writeShop(platform, actor, c));
      return out;
    });
  } catch (err) {
    if (pgError(err).constraint === "shops_platform_external_live_uq")
      throw connectedElsewhere();
    throw err;
  }
  // Sau commit: gian hàng đã `active` (nối lại) thì chạy việc đang giữ và bật lại lịch (#102 A5).
  for (const result of results) {
    if (result.shop.status !== "active") continue;
    const jobsRun = await releaseHeld(result.shop.id);
    await startShopJobs(result.shop.companyId, result.shop.id);
    await resumeOpenOrderPull(result.shop.companyId, result.shop.id);
    result.shop.pendingJobs = 0;
    if (result.reconnect) result.reconnect.jobsRun = jobsRun;
  }
  return { ...results[0]!, shops: results };
}

/** Tạo hoặc nối lại một gian hàng; gọi trong `withCompany`. */
async function writeShop(
  platform: Platform,
  actor: Actor,
  c: ShopConnection,
): Promise<ShopConnectionResult> {
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
      status: "connecting",
      ...tokenColumns(id, c.tokens),
    });
    await recordTransition({
      entityType: ENTITY,
      entityId: id,
      from: null,
      to: "connecting",
      action: "connect",
      actorId: actor.accountId,
    });
    return { shop: await shopView(row), created: true, reconnect: null };
  }

  const action = reconnectAction(existing.status, existing.orderCutoffAt);
  const to = action
    ? assertTransition(shopMachine, existing.status, action, { actor }).to
    : existing.status;
  const row = await updateShop(
    existing.id,
    { version: existing.version, status: existing.status },
    {
      ...tokenColumns(existing.id, c.tokens),
      shopName: c.shopName,
      status: to,
      disconnectedAt: null,
      lastError: null,
    },
  );
  if (!row)
    throw new AppError(
      409,
      "version_conflict",
      "Gian hàng vừa được cập nhật, thử lại",
    );
  if (action) {
    await recordTransition({
      entityType: ENTITY,
      entityId: row.id,
      from: existing.status,
      to,
      action,
      actorId: actor.accountId,
    });
  }
  // Kéo đơn từ mốc cuối (#105), đưa lên lại listing gỡ do ngắt (#104) chưa làm: báo 0. `jobsRun` điền sau khi commit.
  const reconnect =
    action === "reconnect"
      ? {
          pulledFrom: row.lastOrderSyncAt ?? row.orderCutoffAt,
          relisted: 0,
          jobsRun: 0,
        }
      : null;
  return { shop: await shopView(row), created: false, reconnect };
}

/**
 * Kiểm ngắt được theo thứ tự Documents/21 §18.6.1: 404, `invalid_transition`, `version_conflict`, `shop_has_open_orders`.
 * Khoá dòng gian hàng tới hết giao dịch của bên gọi, nên đơn đang về (`order-pull.ts` khoá chia sẻ) không lọt.
 * Route gọi riêng một lần trước khi đẩy tồn 0; `disconnectShop` gọi lại trong giao dịch ngắt.
 */
export async function checkDisconnect(
  actor: Actor,
  id: string,
  version: number,
): Promise<{ row: ShopRow; to: ShopStatus }> {
  requireCompanyId("checkDisconnect");
  const row = isUuid(id) ? await lockShopRow(id) : undefined;
  if (!row) throw notFound();
  const { to } = assertTransition(shopMachine, row.status, "disconnect", {
    actor,
  });
  if (row.version !== version) {
    throw new AppError(
      409,
      "version_conflict",
      `Gian hàng "${row.shopName}" vừa được người khác cập nhật`,
      {
        current: await shopView(row),
      },
    );
  }
  assertNoOpenOrders(await countOpenOrders(id));
  return { row, to };
}

/** Đẩy tồn 0 (`zeroStock`) do route gọi trước, ngoài giao dịch (`listing-sync.ts` `pushZeroStock`). */
export async function disconnectShop(
  actor: Actor,
  id: string,
  input: { version: number },
): Promise<Shop> {
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
      disconnectedAt: new Date(),
    },
  ))!;
  await recordTransition({
    entityType: ENTITY,
    entityId: id,
    from: row.status,
    to,
    action: "disconnect",
    actorId: actor.accountId,
  });
  for (const listing of await delistForDisconnect(id)) {
    await recordTransition({
      entityType: "listings",
      entityId: listing.id,
      from: listing.from,
      to: "delisted",
      action: "delist",
      actorId: actor.accountId,
      reason: "Ngắt gian hàng",
    });
  }
  // Ngắt thì bỏ lịch và việc đang giữ (§18.1). Giao dịch lỗi sau bước này thì gian hàng còn `active` mà thiếu lịch:
  // worker khởi động lại sẽ đặt lại (`reconcileShopJobs`).
  await stopShopJobs(id);
  await dropHeld(id);
  return shopView(updated);
}

/**
 * Gian hàng mất uỷ quyền (refresh token thất bại, sàn báo gỡ app): `connecting` hoặc `active` → `needs_reauth`,
 * nguồn hệ thống (§18.1). Cho #102 gọi trong `withCompany`. Trạng thái khác thì bỏ qua.
 */
export async function markNeedsReauth(
  shopId: string,
  reason: string,
): Promise<void> {
  requireCompanyId("markNeedsReauth");
  const row = await findShopRow(shopId);
  if (row?.status !== "connecting" && row?.status !== "active") return;
  const { to } = assertTransition(shopMachine, row.status, "lose_auth", {
    actor: null,
  });
  const updated = await updateShop(
    shopId,
    { version: row.version, status: row.status },
    { status: to, lastError: reason },
  );
  if (updated) {
    await recordTransition({
      entityType: ENTITY,
      entityId: shopId,
      from: row.status,
      to,
      action: "lose_auth",
      actorId: null,
      reason,
    });
  }
}

/** Mất uỷ quyền do việc nền phát hiện: `needs_reauth` rồi dừng lịch của gian hàng (#102 A5). Gọi ngoài giao dịch. */
export async function loseShopAuth(
  companyId: string,
  shopId: string,
  reason: string,
): Promise<void> {
  await withCompany(companyId, () => markNeedsReauth(shopId, reason));
  await stopShopJobs(shopId);
}

/** Access còn dưới mức này thì làm mới (việc chạy hằng ngày, access Lazada sống 7 ngày). */
const REFRESH_WITHIN_MS = 48 * 3_600_000;

/**
 * Làm mới token của gian hàng `active` khi access sắp hết hạn (#102 AC-5). Gọi sàn ngoài giao dịch.
 * Sàn từ chối refresh token thì gian hàng mất uỷ quyền; lỗi tạm thì ném để việc nền thử lại.
 * Trả `inactive` khi gian hàng không còn `active` (bên gọi bỏ lịch).
 */
export async function refreshShopToken(
  companyId: string,
  shopId: string,
): Promise<"refreshed" | "skipped" | "lost" | "inactive"> {
  const row = await withCompany(companyId, () => findShopRow(shopId));
  if (row?.status !== "active") return "inactive";
  if (!row.refreshTokenEnc) return "skipped";
  if (
    row.accessExpiresAt &&
    row.accessExpiresAt.getTime() - Date.now() > REFRESH_WITHIN_MS
  )
    return "skipped";
  const refreshToken = decryptBytes(
    row.refreshTokenEnc,
    `${row.id}:refresh`,
    tokenKey(),
  ).toString();
  let tokens: TokenSet;
  try {
    tokens = await adapterOf(row.platform).refreshToken(refreshToken);
  } catch (err) {
    if (err instanceof MarketplaceError && err.kind === "unauthorized") {
      await loseShopAuth(
        companyId,
        shopId,
        `Làm mới token thất bại (${err.platformCode ?? "unauthorized"})`,
      );
      return "lost";
    }
    throw err;
  }
  await withCompany(companyId, async () => {
    const updated = await updateShop(
      row.id,
      { version: row.version, status: row.status },
      tokenColumns(row.id, tokens),
    );
    if (!updated)
      throw new AppError(
        409,
        "version_conflict",
        "Gian hàng vừa được cập nhật, làm mới lại sau",
      );
  });
  return "refreshed";
}
