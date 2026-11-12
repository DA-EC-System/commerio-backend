// Token gian hàng (#201; Documents/21 §18.4, Documents/16 bài toán 3): mã hoá, làm mới trong khoá theo gian hàng, lớp bọc
// adapter làm mới khi sàn báo `unauthorized`, mất uỷ quyền.
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { env } from '../../../../shared/config/env.ts';
import { decryptBytes, encryptBytes } from '../../../../shared/crypto/aes-gcm.ts';
import { outsideTransaction, requireCompanyId, withCompany, withSessionLock } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { authDeadline, authLapsed, shopMachine } from '../domain/shop.ts';
import { findShopRow, saveRefreshedTokens, type ShopRow, updateShop } from '../repository/shops.ts';
import { DEFAULT_REFRESH_LEAD_MS, refreshBefore } from './marketplaces/common.ts';
import { getAdapter, type MarketplaceAdapter, MarketplaceError, type TokenSet } from './marketplaces/index.ts';
import { queueDueReauthMail } from './reauth-mail.ts';
import { stopShopJobs } from './shop-jobs.ts';

export function tokenKey(): Buffer {
  if (!env.CHANNEL_TOKEN_KEY) {
    throw new AppError(500, 'channel_token_key_missing', 'Máy chủ chưa đặt CHANNEL_TOKEN_KEY để mã hoá token sàn');
  }
  return Buffer.from(env.CHANNEL_TOKEN_KEY, 'base64');
}

/** Cột token đã mã hoá; AAD = "<shopId>:<loại>" nên chép bản mã sang dòng khác không giải mã được. */
export function tokenColumns(shopId: string, tokens: TokenSet) {
  const key = tokenKey();
  return {
    accessTokenEnc: encryptBytes(Buffer.from(tokens.accessToken), `${shopId}:access`, key),
    refreshTokenEnc: tokens.refreshToken ? encryptBytes(Buffer.from(tokens.refreshToken), `${shopId}:refresh`, key) : null,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    authExpiresAt: tokens.authExpiresAt ?? null,
  };
}

export function decryptAccessToken(row: ShopRow): string | null {
  return row.accessTokenEnc ? decryptBytes(row.accessTokenEnc, `${row.id}:access`, tokenKey()).toString() : null;
}

/**
 * Gian hàng mất uỷ quyền (refresh token thất bại, sàn báo gỡ app, tới hạn uỷ quyền): `connecting` hoặc `active` →
 * `needs_reauth`, nguồn hệ thống (§18.1). Cho #102 gọi trong `withCompany`. Trạng thái khác thì bỏ qua.
 */
export async function markNeedsReauth(shopId: string, reason: string): Promise<void> {
  requireCompanyId('markNeedsReauth');
  const row = await findShopRow(shopId);
  if (row?.status !== 'connecting' && row?.status !== 'active') return;
  const { to } = assertTransition(shopMachine, row.status, 'lose_auth', { actor: null });
  const updated = await updateShop(shopId, { version: row.version, status: row.status }, { status: to, lastError: reason });
  if (updated) {
    await recordTransition({ entityType: 'shops', entityId: shopId, from: row.status, to, action: 'lose_auth', actorId: null, reason });
    // Thư đầu tiên báo CEO, Admin xếp ngay trong giao dịch này, không chờ việc nền 15 phút (#312).
    await queueDueReauthMail(shopId, new Date());
  }
}

/** Mất uỷ quyền do việc nền phát hiện: `needs_reauth` rồi dừng lịch của gian hàng (#102 A5). Gọi ngoài giao dịch. */
export async function loseShopAuth(companyId: string, shopId: string, reason: string): Promise<void> {
  await withCompany(companyId, () => markNeedsReauth(shopId, reason));
  await stopShopJobs(shopId);
}

/** Lúc phải làm mới token theo adapter (21 §18.4 "ngưỡng adapter khai"); adapter không khai thì 48 giờ trước hạn access. */
export function refreshDueAt(adapter: MarketplaceAdapter, row: Pick<ShopRow, 'accessExpiresAt' | 'refreshExpiresAt'>): Date | null {
  const tokens = { accessExpiresAt: row.accessExpiresAt, refreshExpiresAt: row.refreshExpiresAt };
  return adapter.refreshDueAt ? adapter.refreshDueAt(tokens) : refreshBefore(tokens, DEFAULT_REFRESH_LEAD_MS);
}

/**
 * Chờ khoá làm mới của gian hàng tối đa chừng này: lâu hơn một lần gọi sàn (10 giây, có thể gọi lại một lần khi bị giới
 * hạn tần suất). Hết thì `busy`: việc nền thử lại, lớp bọc trả lỗi gốc.
 */
const LOCK_WAIT_MS = 30_000;
let lockWaitMs = LOCK_WAIT_MS;

/** Chỉ cho test: rút thời gian chờ khoá để dựng ca `busy` nhanh. Không truyền thì về mặc định. */
export function setTokenLockWaitForTests(ms?: number): void {
  lockWaitMs = ms ?? LOCK_WAIT_MS;
}

/** Không lấy được khoá làm mới trong hạn: lỗi tạm (bên gọi, việc nền thử lại), không phải mất uỷ quyền. */
function refreshBusy(): MarketplaceError {
  return new MarketplaceError('unavailable', 'token_refresh_busy', 'Token gian hàng đang được làm mới, thử lại sau');
}

export type RefreshOutcome = 'refreshed' | 'skipped' | 'lost' | 'inactive' | 'busy';

/**
 * Làm mới token của một gian hàng trong khoá advisory **phiên** `channel.token:<shopId>` (#201).
 *
 * Vì sao khoá phiên mà không `SELECT … FOR UPDATE`: lời gọi sàn mất tới 10 giây (hơn nữa khi bị giới hạn tần suất); giữ
 * giao dịch và khoá dòng `shops` ngần ấy thì chặn kéo đơn (`lockShopForOrders`), ngắt, thiết lập của gian hàng, trái quy
 * ước "gọi sàn ngoài giao dịch". Khoá phiên chỉ chặn lần làm mới khác của cùng gian hàng; tiến trình chết thì phiên đóng
 * và khoá tự nhả. Trong khoá: đọc lại dòng, quyết định, gọi sàn, lưu cặp token mới trong một giao dịch ngắn đã commit
 * rồi mới nhả khoá, nên lần làm mới chờ sau đọc thấy token mới và bỏ qua, không dùng lại refresh token đã tiêu.
 *
 * - `staleAccessToken` không có (việc nền): chỉ làm mới khi tới `refreshDueAt` của adapter.
 * - Có (lớp bọc, sàn vừa từ chối access này): làm mới ngay, trừ khi token đã lưu khác token đó (người khác vừa làm mới),
 *   khi đó trả `refreshed` để bên gọi đọc token mới.
 *
 * Tới hạn uỷ quyền (`authDeadline`) hoặc sàn từ chối refresh token thì `lose_auth` (`lost`). Lỗi tạm của sàn thì ném.
 */
export async function refreshShopTokenLocked(
  companyId: string,
  shopId: string,
  opts: { staleAccessToken?: string; activeOnly?: boolean } = {},
): Promise<RefreshOutcome> {
  return withSessionLock(
    `channel.token:${shopId}`,
    async (): Promise<RefreshOutcome> => {
      const row = await withCompany(companyId, () => findShopRow(shopId));
      const live = opts.activeOnly ? row?.status === 'active' : row?.status === 'active' || row?.status === 'connecting';
      if (!row || !live) return 'inactive';
      if (authLapsed(authDeadline(row.authExpiresAt, row.refreshExpiresAt))) {
        await loseShopAuth(companyId, shopId, 'Hết hạn uỷ quyền gian hàng, cần kết nối lại');
        return 'lost';
      }
      const adapter = getAdapter(row.platform);
      if (!adapter || !row.refreshTokenEnc) return 'skipped';
      if (opts.staleAccessToken !== undefined) {
        if (decryptAccessToken(row) !== opts.staleAccessToken) return 'refreshed';
      } else {
        const due = refreshDueAt(adapter, row);
        if (!due || due.getTime() > Date.now()) return 'skipped';
      }
      const refreshToken = decryptBytes(row.refreshTokenEnc, `${row.id}:refresh`, tokenKey()).toString();
      /** Người dùng vừa nối lại gian hàng trong lúc gọi sàn (token đã lưu khác bản đọc lúc đầu) thì token đó thắng. */
      const reconnected = async (): Promise<RefreshOutcome | null> => {
        const now = await withCompany(companyId, () => findShopRow(shopId));
        const stillLive = now?.status === 'active' || now?.status === 'connecting';
        if (!now || !stillLive) return 'inactive';
        const same = now.accessTokenEnc && row.accessTokenEnc ? now.accessTokenEnc.equals(row.accessTokenEnc) : now.accessTokenEnc === row.accessTokenEnc;
        return same ? null : 'refreshed';
      };
      let tokens: TokenSet;
      try {
        tokens = await adapter.refreshToken(refreshToken);
      } catch (err) {
        if (err instanceof MarketplaceError && err.kind === 'unauthorized') {
          // Lần nối lại có thể đã thu hồi refresh token cũ: không hạ gian hàng vừa nối sang `needs_reauth`.
          const after = await reconnected();
          if (after) return after;
          await loseShopAuth(companyId, shopId, `Làm mới token thất bại (${err.platformCode ?? 'unauthorized'})`);
          return 'lost';
        }
        throw err;
      }
      // Sàn không trả refresh token mới thì giữ cái cũ (refresh token dùng lại được). Chỉ ghi khi token đã lưu vẫn là bản
      // đọc lúc đầu (compare-and-set): người dùng vừa nối lại thì bỏ cặp vừa lấy. Sàn có hạn refresh cố định (Lazada) thì
      // giữ hạn đã lưu: hạn adapter tính lại từ số giây còn lại lệch vài giây mỗi lần (#312).
      const refreshExpiresAt = adapter.refreshKeepsAuthDeadline && row.refreshExpiresAt ? row.refreshExpiresAt : tokens.refreshExpiresAt;
      const saved = await withCompany(companyId, () =>
        saveRefreshedTokens(
          row.id,
          row.accessTokenEnc,
          tokenColumns(row.id, { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken, refreshExpiresAt }),
        ),
      );
      if (saved) return 'refreshed';
      return (await reconnected()) ?? 'inactive';
    },
    { waitMs: lockWaitMs },
  );
}

/**
 * Việc nền `channel.token_refresh` (#102 AC-5, #201) cho gian hàng `active`. Trả `inactive` khi gian hàng không còn
 * `active` (bên gọi bỏ lịch). Không có khoá trong `LOCK_WAIT_MS` thì ném để pg-boss thử lại.
 */
export async function refreshShopToken(companyId: string, shopId: string): Promise<Exclude<RefreshOutcome, 'busy'>> {
  const outcome = await refreshShopTokenLocked(companyId, shopId, { activeOnly: true });
  if (outcome === 'busy') throw refreshBusy();
  return outcome;
}

/**
 * Sàn vừa từ chối `stale`: làm mới (hoặc chờ lần làm mới đang chạy) rồi trả access token mới; không làm mới được (mất uỷ
 * quyền, gian hàng không còn gọi được sàn) thì null. Không lấy được khoá trong hạn thì ném `unavailable`
 * `token_refresh_busy`: token có thể vẫn tốt, bên gọi không được coi là mất uỷ quyền (`loseShopAuth`), việc nền thử lại.
 * Chạy ngoài giao dịch của bên gọi để cặp token mới commit trước khi nhả khoá.
 */
async function renewAccessToken(companyId: string, shopId: string, stale: string): Promise<string | null> {
  return outsideTransaction(async () => {
    const outcome = await refreshShopTokenLocked(companyId, shopId, { staleAccessToken: stale });
    if (outcome === 'busy') throw refreshBusy();
    if (outcome !== 'refreshed') return null;
    const row = await withCompany(companyId, () => findShopRow(shopId));
    const fresh = row ? decryptAccessToken(row) : null;
    return fresh && fresh !== stale ? fresh : null;
  });
}

/** Hàm của adapter không nhận access token ở tham số đầu. */
const NO_ACCESS_TOKEN = new Set<string | symbol>([
  'connectMethods',
  'authorizeUrl',
  'exchangeCode',
  'connectWithToken',
  'refreshToken',
  'refreshDueAt',
]);

/**
 * Hàm ghi nhiều bước của adapter: bước ghi lên sàn có thể đã xong khi bước sau gặp `unauthorized`, nên gọi lại cả hàm có
 * thể ghi trùng (tạo hai sản phẩm). Với các hàm này lớp bọc chỉ làm mới token cho lần gọi sau rồi ném lỗi gốc. Hàm ghi
 * khác gọi sàn ghi đúng một lần ở bước cuối (lỗi ở bước đó là chưa ghi) hoặc ghi giá trị tuyệt đối (tồn, giá, ẩn hiện),
 * gọi lại an toàn.
 */
const NO_RETRY = new Set<string | symbol>(['createProduct', 'updateProduct']);

/**
 * Lớp `TokenRefresh` của `Retry(RateLimit(TokenRefresh(adapter)))` (Documents/16 bài toán 3), dùng chung mọi sàn: hàm
 * nào của adapter được gọi với access token của phiên mà sàn báo `unauthorized` thì làm mới token một lần (qua khoá ở
 * `refreshShopTokenLocked`) rồi gọi lại với token mới; lần sau trong phiên dùng luôn token mới. Không làm mới được, hoặc
 * gọi lại vẫn `unauthorized`, thì ném lỗi của sàn như cũ để bên gọi `lose_auth`. Chờ khoá làm mới quá hạn thì ném
 * `unavailable` `token_refresh_busy` (không phải mất uỷ quyền). Hàm trong `NO_RETRY` không gọi lại: làm mới được thì ném
 * `unavailable` `token_refreshed` (bên gọi tự thử lại), không làm mới được thì ném lỗi gốc. Hàm gọi với token khác
 * giữ nguyên.
 * Giới hạn tần suất và thử lại khi lỗi tạm do từng adapter lo (Lazada `SellerCallLimit`, TikTok `rateLimit`).
 */
export function withTokenRefresh(adapter: MarketplaceAdapter, companyId: string, shopId: string, accessToken: string): MarketplaceAdapter {
  let current = accessToken;
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || NO_ACCESS_TOKEN.has(prop)) return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (args[0] !== accessToken && args[0] !== current) return fn.apply(target, args);
        const used = current;
        const call = (token: string) => Promise.resolve(fn.apply(target, [token, ...args.slice(1)]));
        return call(used).catch(async (err: unknown) => {
          if (!(err instanceof MarketplaceError && err.kind === 'unauthorized')) throw err;
          if (NO_RETRY.has(prop)) {
            // Làm mới cho lần sau; lỗi khi làm mới (bận, sàn lỗi) không che lỗi gốc. Làm mới được thì token vẫn còn uỷ
            // quyền: báo lỗi tạm để bên gọi (việc đẩy listing nền, #219) thử lại với token mới, không `lose_auth`.
            const next = await renewAccessToken(companyId, shopId, used).catch(() => null);
            if (!next) throw err;
            current = next;
            throw new MarketplaceError('unavailable', 'token_refreshed', 'Token vừa được làm mới, thử lại');
          }
          const fresh = await renewAccessToken(companyId, shopId, used);
          if (!fresh) throw err;
          current = fresh;
          return call(fresh);
        });
      };
    },
  });
}
