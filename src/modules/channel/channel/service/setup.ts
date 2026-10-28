// Thiết lập lần đầu (#104; Documents/21 §18.2): ghép listing có sẵn trên sàn theo SellerSku = SKU Commerio (#104 A4,
// A5), đẩy khả dụng, chọn mốc kéo đơn, gian hàng `connecting → active`. Gọi sàn ngoài giao dịch.
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { shopMachine } from '../domain/shop.ts';
import { insertListing, listListingRows } from '../repository/listings.ts';
import { updateShop } from '../repository/shops.ts';
import { syncListings } from './listing-sync.ts';
import type { ProductPort } from './product-port.ts';
import { type Actor, onMarketplace, type Shop, shopSession, shopView } from './shops.ts';

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

export async function setupPreview(port: ProductPort, actor: Actor, shopId: string) {
  // Muốn đếm SKU sàn không ghép được phải quét cả shop; shop thử dùng chung nên trả 0 (#104 A6).
  const items = (await suggestions(port, actor, shopId)).map(({ externalProductId: _, ...s }) => s);
  return { suggestions: items, unmatchedRemote: 0 };
}

export async function finishSetup(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: { externalSkuIds: string[]; openingStock: 'push' | 'stocktake'; orderCutoffAt: Date },
): Promise<{ shop: Shop; matched: number; stocktakeNumber: null }> {
  const offered = await suggestions(port, actor, shopId);
  const picked = offered.filter((s) => input.externalSkuIds.includes(s.externalSkuId));
  const errors: Record<string, string> = {};
  if (input.orderCutoffAt.getTime() > Date.now()) errors.orderCutoffAt = 'Mốc kéo đơn không được ở tương lai';
  // Kiểm kê đầu kỳ cần phiếu kiểm kê của #112.
  if (input.openingStock === 'stocktake') errors.openingStock = 'Chưa hỗ trợ kiểm kê đầu kỳ, chọn đẩy khả dụng';
  if (picked.length !== new Set(input.externalSkuIds).size) errors.externalSkuIds = 'Có SKU sàn không còn để ghép';
  if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });

  await withCompany(actor.companyId, async () => {
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
    const updated = await updateShop(shop.id, { version: shop.version, status: shop.status }, { status: to, orderCutoffAt: input.orderCutoffAt });
    if (!updated) throw new AppError(409, 'version_conflict', 'Gian hàng vừa được cập nhật, thử lại');
    await recordTransition({ entityType: 'shops', entityId: shop.id, from: shop.status, to, action: 'finish_setup', actorId: actor.accountId });
  });
  // `push`: listing vừa ghép đang `stock_sync = pending`, đồng bộ đẩy khả dụng và giá chuẩn.
  await syncListings(port, actor, shopId);
  const shop = await withCompany(actor.companyId, async () => shopView((await shopSession(shopId)).shop));
  return { shop, matched: picked.length, stocktakeNumber: null };
}
