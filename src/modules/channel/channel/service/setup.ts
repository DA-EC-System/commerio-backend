// Thiết lập lần đầu (#104, #198; Documents/21 §18.2, §18.6.2): ghép listing có sẵn trên sàn, gian hàng
// `connecting → active`. Mốc kéo đơn do BE đặt bằng lúc thiết lập (không nhận từ người dùng, §18.7.6). Gian hàng đầu tiên
// của công ty buộc kiểm kê đầu kỳ (`stocktake`): lập phiếu qua cổng inventory, gian hàng ở chế độ chờ kiểm kê tới khi
// phiếu ghi sổ. Gọi sàn ngoài giao dịch.
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { returnWindowError, shopMachine } from '../domain/shop.ts';
import { insertListing, listListingRows } from '../repository/listings.ts';
import { setupStateOfCompany, updateShop } from '../repository/shops.ts';
import { stocktakePort } from './stocktake-port.ts';
import { syncListings } from './listing-sync.ts';
import { capabilitiesOf } from './marketplaces/index.ts';
import { startShopJobs } from './shop-jobs.ts';
import type { ProductPort } from './product-port.ts';
import { type Actor, onMarketplace, ownShop, type Shop, shopSession, shopView } from './shops.ts';

export interface SetupSuggestion {
  externalSkuId: string;
  title: string;
  variantId: string;
  sku: string;
  available: number;
  platformStock: number;
}

type Suggestion = SetupSuggestion & { externalProductId: string };

/** Gợi ý ghép: SKU sàn có SellerSku trùng SKU Commerio, biến thể chưa có listing trên gian hàng này. */
async function suggestions(port: ProductPort, actor: Actor, shopId: string): Promise<Suggestion[]> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(actor.companyId, fn);
  const { shop, adapter, accessToken } = await inCompany(async () => {
    const session = await shopSession(shopId);
    assertTransition(shopMachine, session.shop.status, 'finish_setup', { actor });
    return session;
  });
  const { variants, listed } = await inCompany(async () => ({
    variants: (await port.variants()).filter((v) => !v.archived),
    listed: new Set((await listListingRows(shop.id)).map((l) => l.variantId)),
  }));
  const open = variants.filter((v) => !listed.has(v.id));
  if (!open.length) return [];
  const remote = await onMarketplace(() => adapter.getSkus(accessToken, open.map((v) => v.sku)));
  const available = await inCompany(() => port.availableOf(open.map((v) => v.id)));
  const bySku = new Map(open.map((v) => [v.sku, v]));
  return remote.flatMap((r) => {
    const v = bySku.get(r.sellerSku);
    if (!v) return [];
    return [
      {
        externalProductId: r.externalProductId,
        externalSkuId: r.externalSkuId,
        title: r.title,
        variantId: v.id,
        sku: v.sku,
        available: available.get(v.id) ?? 0,
        platformStock: r.quantity,
      },
    ];
  });
}

/** Công ty chưa có gian hàng nào xong thiết lập (có mốc, không chờ kiểm kê) thì gian hàng này là đầu tiên (#198 A1). */
async function companySetupState(actor: Actor, shopId: string) {
  const state = await withCompany(actor.companyId, () => setupStateOfCompany(shopId));
  return { firstShopOfCompany: !state.hasSetUpShop, awaitingStocktake: state.awaitingStocktake };
}

const awaitingError = (number: string) => `Công ty đang chờ phiếu kiểm kê đầu kỳ ${number} ghi sổ`;

export async function setupPreview(port: ProductPort, actor: Actor, shopId: string) {
  // Muốn đếm SKU sàn không ghép được phải quét cả shop; shop thử dùng chung nên trả 0 (#104 A6).
  const items = (await suggestions(port, actor, shopId)).map(({ externalProductId: _, ...s }) => s);
  const { firstShopOfCompany } = await companySetupState(actor, shopId);
  return { suggestions: items, unmatchedRemote: 0, proposedCutoffAt: new Date(), firstShopOfCompany };
}

export async function finishSetup(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: {
    externalSkuIds: string[];
    openingStock: 'push' | 'stocktake';
    returnWindowDays?: number | null | undefined;
  },
): Promise<{ shop: Shop; matched: number; stocktakeNumber: string | null }> {
  const offered = await suggestions(port, actor, shopId);
  const { returnWindow } = capabilitiesOf((await withCompany(actor.companyId, () => ownShop(shopId))).platform);
  const picked = offered.filter((s) => input.externalSkuIds.includes(s.externalSkuId));
  const { firstShopOfCompany, awaitingStocktake } = await companySetupState(actor, shopId);
  const errors: Record<string, string> = {};
  if (awaitingStocktake) errors.openingStock = awaitingError(awaitingStocktake);
  else if (firstShopOfCompany && input.openingStock === 'push') errors.openingStock = 'Gian hàng đầu tiên của công ty phải kiểm kê đầu kỳ';
  if (picked.length !== new Set(input.externalSkuIds).size) errors.externalSkuIds = 'Có SKU sàn không còn để ghép';
  const returnWindowInvalid = returnWindowError(returnWindow, input.returnWindowDays);
  if (returnWindowInvalid) errors.returnWindowDays = returnWindowInvalid;
  if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });

  const stocktake = await withCompany(actor.companyId, async () => {
    const { shop } = await shopSession(shopId);
    const { to } = assertTransition(shopMachine, shop.status, 'finish_setup', { actor });
    for (const p of picked) {
      const row = await insertListing({
        companyId: actor.companyId,
        shopId: shop.id,
        variantId: p.variantId,
        externalSkuId: p.externalSkuId,
        externalProductId: p.externalProductId,
        sellerSku: p.sku,
        status: 'live',
        platformStock: p.platformStock,
      });
      await recordTransition({ entityType: 'listings', entityId: row.id, from: null, to: 'live', action: 'match', actorId: actor.accountId });
    }
    // Sàn `platform_status` luôn null; sàn `days` chỉ ghi khi có gửi số, không gửi thì giữ giá trị đang có (A3).
    const returnWindowDays =
      returnWindow !== 'days' ? { returnWindowDays: null } : typeof input.returnWindowDays === 'number' ? { returnWindowDays: input.returnWindowDays } : {};
    // Bản tạm của cổng (chưa có #245) ném 501: cả giao dịch rollback, gian hàng vẫn `connecting` (Documents/21 §18.7.9).
    const doc =
      input.openingStock === 'stocktake' ? await stocktakePort().createOpeningStocktake(shop.id, { actorId: actor.accountId }) : null;
    const updated = await updateShop(
      shop.id,
      { version: shop.version, status: shop.status },
      {
        status: to,
        orderCutoffAt: new Date(),
        openingStocktakeId: doc?.documentId ?? null,
        openingStocktakeNumber: doc?.number ?? null,
        openingStockMode: input.openingStock,
        unmatchedSkuCount: offered.length - picked.length,
        openOrdersPulledAt: null,
        stockPushedAt: null,
        ...returnWindowDays,
      },
    );
    if (!updated) throw new AppError(409, 'version_conflict', 'Gian hàng vừa được cập nhật, thử lại');
    await recordTransition({ entityType: 'shops', entityId: shop.id, from: shop.status, to, action: 'finish_setup', actorId: actor.accountId });
    return doc;
  }).catch((err: unknown) => {
    // Hai gian hàng cùng lập phiếu đầu kỳ một lúc: index một phần chặn phiếu thứ hai (#198 A12).
    if (pgError(err).constraint === 'shops_one_opening_stocktake_uq') {
      throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', {
        errors: { openingStock: 'Công ty đang chờ một phiếu kiểm kê đầu kỳ khác ghi sổ' },
      });
    }
    throw err;
  });
  // Gian hàng đã `active`: đặt lịch việc nền trước khi gọi sàn, đồng bộ lỗi thì lịch vẫn chạy lại (#102).
  await startShopJobs(actor.companyId, shopId);
  // Listing vừa ghép chờ đồng bộ: đẩy giá chuẩn ngay; tồn chỉ đẩy sau lượt kéo đơn còn mở và khi không chờ kiểm kê (A10).
  await syncListings(port, actor.companyId, shopId);
  const shop = await withCompany(actor.companyId, async () => shopView((await shopSession(shopId)).shop));
  return { shop, matched: picked.length, stocktakeNumber: stocktake?.number ?? null };
}
