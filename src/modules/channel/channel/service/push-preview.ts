// Kiểm trước khi đăng hàng loạt (be#566, Documents/21 §18.11). Không ghi gì, không gọi sàn. Mục chặn lấy từ cùng hàm với
// readiness (18.10) và `push` (`loadPushContext` + `checkVariant` của be#564), nên hai lối đăng không lệch nhau. Giá, thực
// nhận, phí cùng bước 5 với `price-quote`; tồn sẽ đẩy cùng `stockToPushView` của trang listing.
import { Decimal } from 'decimal.js';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { type PriceRounding, roundingOf } from '../domain/price-filter.ts';
import { holdsStock } from '../domain/shop.ts';
import type { StockHeldReason } from '../domain/stock-to-push.ts';
import type { ListingRow } from '../repository/listings.ts';
import type { ShopRow } from '../repository/shops.ts';
import { assertPushable, stockToPushView } from './listings.ts';
import { evaluatePrices, shopPriceConfig } from './price-inputs.ts';
import type { ProductPort } from './product-port.ts';
import { type Blocker, type BlockItem, blockerScope } from './push-block.ts';
import { type Actor, ownShop } from './shops.ts';

export interface PushPreviewRow {
  variantId: string;
  productId: string;
  productName: string;
  attributesLabel: string;
  sku: string;
  status: 'ready' | 'blocked';
  blockers: Blocker[];
  listPrice: number | null;
  rounding: PriceRounding | null;
  stockToPush: number | null;
  stockHeldReason: StockHeldReason | null;
  netReceived: number | null;
  feePct: number | null;
  feeConfigId: string | null;
}

/** Kết quả kiểm một dòng, dạng đã thống nhất với be#564 (`checkVariant`). */
interface CheckedRow {
  items: BlockItem[];
  /** Giá lần đăng sẽ gửi: giá gõ tay, giá bộ lọc lần đầu (`calc`), hoặc giá đang bán; null khi chưa có. */
  price: { value: string | null; calc?: { rawPrice: string; roundedPrice: string } };
  existing: ListingRow | undefined;
}

/**
 * Chờ be#564 lát 3: thay bằng `loadPushContext(port, shop, ids, listPrices)` rồi `checkVariant(ctx, id)` từng dòng. Chưa có thì
 * route trả 501, không tự viết lại luật chặn ở đây (một luật, một hàm: 21 §18.10).
 */
async function checkRows(
  _port: ProductPort,
  _shop: ShopRow,
  _ids: readonly string[],
  _listPrices: Readonly<Record<string, number>> | undefined,
): Promise<Map<string, CheckedRow>> {
  throw new AppError(501, 'not_implemented', 'Kiểm trước khi đăng chờ hàm readiness chung (commerio-backend#564)');
}

/** `(giá − thực nhận) / giá`, bốn chữ số thập phân. */
const feePctOf = (listPrice: string, net: string) => new Decimal(listPrice).minus(net).div(listPrice).toDecimalPlaces(4).toNumber();

export async function previewPush(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: { variantIds: string[]; listPrices?: Record<string, number> },
  canSeeCost: boolean,
): Promise<{ rows: PushPreviewRow[]; summary: { ready: number; blocked: number } }> {
  return withCompany(actor.companyId, async () => {
    // Lỗi cả request như `push` (21 §18.6.4, §18.6.11): chưa `active`, chờ kiểm kê, chờ phân hàng, rồi hết token.
    const shop = await ownShop(shopId);
    assertPushable(shop);
    if (!shop.accessTokenEnc) {
      throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối hoặc cần kết nối lại', { current: shop.status });
    }
    const ids = [...new Set(input.variantIds)];
    const variants = new Map((await port.variants(ids)).map((v) => [v.id, v]));
    // Biến thể không có hay của công ty khác: không có tên, SKU để hiện dòng (21 §18.11, plan G2). Lưu trữ thì vẫn có dòng.
    const errors: Record<string, string> = {};
    input.variantIds.forEach((id, i) => {
      if (!variants.has(id)) errors[`variantIds.${i}`] = 'Biến thể không tồn tại';
    });
    if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });

    const checked = await checkRows(port, shop, ids, input.listPrices);
    const config = await shopPriceConfig(shop.id);
    const prices = new Map(ids.flatMap((id) => (checked.get(id)?.price.value ? [[id, checked.get(id)!.price.value!] as const] : [])));
    const { hasFee, results } = await evaluatePrices(shop.id, prices);
    const available = await port.availableOf(ids);
    const counted = port.countedOf ? await port.countedOf(ids) : new Set(ids);
    const holdStock = holdsStock(shop);

    const rows = ids.map((id): PushPreviewRow => {
      const v = variants.get(id)!;
      const row = checked.get(id)!;
      // Luật R4 (21 §18.9, §18.11): người không xem được giá vốn không nhận `below_floor`; lệnh đăng vẫn chặn.
      const items = canSeeCost ? row.items : row.items.filter((b) => b.code !== 'below_floor');
      const blockers = items.map((b): Blocker => ({ ...b, scope: blockerScope(b.code), variantIds: [id] }));
      const listPrice = row.price.value;
      const r = listPrice && hasFee ? results.get(id) : undefined;
      const net = r?.ok ? r.net : null;
      return {
        variantId: id,
        productId: v.productId,
        productName: v.productName,
        attributesLabel: v.attributesLabel,
        sku: v.sku,
        status: blockers.length ? 'blocked' : 'ready',
        blockers,
        listPrice: listPrice === null ? null : Number(listPrice),
        rounding: row.price.calc && config.fee ? roundingOf(config.fee, row.price.calc) : null,
        ...stockToPushView(row.existing, { holdStock, counted: counted.has(id), available: available.get(id) }),
        netReceived: net === null ? null : Number(net),
        feePct: listPrice && net !== null ? feePctOf(listPrice, net) : null,
        feeConfigId: config.feeConfigId,
      };
    });
    const ready = rows.filter((r) => r.status === 'ready').length;
    return { rows, summary: { ready, blocked: rows.length - ready } };
  });
}
