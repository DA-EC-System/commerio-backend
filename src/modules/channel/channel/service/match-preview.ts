// Xem trước số sẽ đẩy khi ghép SKU sàn có sẵn (#460; Documents/21 §18.3 `listings/match-preview`, 25 §6.4 "Ghép listing
// có sẵn"). Đọc bản sao SKU sàn và số của app, không gọi sàn (#361), không ghi gì.
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { holdsStock } from '../domain/shop.ts';
import { findListingByExternalSku } from '../repository/listings.ts';
import { findRemoteSkuRow } from '../repository/remote-skus.ts';
import { currentPrices } from './listing-prices.ts';
import type { ProductPort } from './product-port.ts';
import { type Actor, ownShop } from './shops.ts';
import { type FillBack, fillBackOf } from './fill-back.ts';

export interface MatchPreview extends FillBack {
  platform: { stock: number; price: string | null; syncedAt: Date };
  app: { stock: number | null; price: string | null };
  stockWillPush: boolean;
  /** Lý do không đẩy tồn: gian hàng chờ kiểm kê lần đầu thắng SKU chưa có số. */
  stockHeldReason: 'shop_waiting_opening' | 'not_counted' | null;
  priceWillPush: boolean;
}

const invalid = (field: string, message: string) =>
  new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors: { [field]: message } });

/**
 * Tồn, giá trên sàn (bản sao, lần đọc thấy SKU gần nhất) cạnh số có thể bán và giá đang bán của biến thể. Ghép xong thì
 * giá app luôn được đẩy (`priceSync = pending`, N6); tồn đẩy trừ khi gian hàng chờ kiểm kê lần đầu hoặc SKU kho chưa có số
 * (`app.stock` null). Giá app: listing hiện có của SKU sàn (đổi ghép giữ giá ghi đè tay) không thì giá chuẩn.
 */
export async function matchPreview(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: { externalSkuId: string; variantId: string },
): Promise<MatchPreview> {
  const base = await withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    const remote = await findRemoteSkuRow(shop.id, input.externalSkuId);
    if (!remote) throw invalid('externalSkuId', 'SKU sàn chưa có trong lần đồng bộ gần nhất, bấm Tải lại rồi liên kết');
    const [variant] = await port.variants([input.variantId]);
    if (!variant) throw invalid('variantId', 'Biến thể không thuộc công ty');
    const id = variant.id;
    const listing = await findListingByExternalSku(shop.id, input.externalSkuId);
    const rows = listing ? [{ ...listing, variantId: id }] : [];
    const price = (await currentPrices([id], rows, await port.standardPrices([id]))).get(id)?.price ?? null;
    const counted = port.countedOf ? (await port.countedOf([id])).has(id) : true;
    const available = (await port.availableOf([id])).get(id) ?? 0;
    const stockHeldReason: MatchPreview['stockHeldReason'] = holdsStock(shop) ? 'shop_waiting_opening' : counted ? null : 'not_counted';
    return {
      platform: { stock: remote.quantity, price: remote.price, syncedAt: remote.seenAt },
      app: { stock: counted ? available : null, price: price === null ? null : String(price) },
      stockWillPush: stockHeldReason === null,
      stockHeldReason,
      priceWillPush: price !== null,
      shop,
      variant,
      remote,
    };
  });
  // Gọi sàn ngoài giao dịch (21 §18.9 R4); lỗi sàn không làm hỏng preview.
  const { shop, variant, remote, ...preview } = base;
  return { ...preview, ...(await fillBackOf(actor.companyId, shop, variant, remote)) };
}
