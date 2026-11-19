// Trang giá chờ xác nhận, xác nhận giá, ghi đè tay (#225; Documents/21 §18.6.7, §21.4, 25 §6.2 bước 5–6). Gọi trong
// `withCompany`. Xác nhận hay ghi đè đánh `price_sync = pending`: lượt đồng bộ đẩy giá mới lên sàn.
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { recordAudit } from '../../../core/index.ts';
import { findListingById, type ListingRow } from '../repository/listings.ts';
import { confirmPending, pendingCalculations, pendingPage } from '../repository/price-calculations.ts';
import { updateListing } from './listing-writes.ts';
import { floorView, listingPrices } from './listing-prices.ts';
import { evaluatePrices } from './price-inputs.ts';
import { requesterNames, toListing } from './listings.ts';
import type { ProductPort } from './product-port.ts';
import { type Actor, ownShop } from './shops.ts';

const conflict = () => new AppError(409, 'version_conflict', 'Listing vừa được cập nhật, thử lại');
const belowFloor = () =>
  new AppError(422, 'below_floor', 'Thực nhận theo giá này dưới giá tối thiểu (giá vốn cộng lãi tối thiểu trên giá vốn)', {
    errors: { price: ['Giá dưới giá thấp nhất'] },
  });

async function ownListing(shopId: string | null, listingId: string, version: number): Promise<ListingRow> {
  const row = isUuid(listingId) ? await findListingById(listingId) : undefined;
  if (!row || row.status === 'delisted' || !row.variantId || (shopId && row.shopId !== shopId))
    throw new AppError(404, 'not_found', 'Không tìm thấy listing');
  if (row.version !== version) throw conflict();
  return row;
}

export async function listPendingPrices(port: ProductPort, query: { shopId?: string; page: number; pageSize: number }) {
  if (query.shopId) await ownShop(query.shopId);
  const { rows, total } = await pendingPage(query.shopId, query.page, query.pageSize);
  const standard = await port.standardPrices([...new Set(rows.map((r) => r.calc.variantId))]);
  // Giá đang bán và bước 5 của giá chờ theo giá vốn, cấu hình hiện tại (giá vốn có thể đổi sau lần tính).
  const current = new Map<string, Awaited<ReturnType<typeof listingPrices>>>();
  const floors = new Map<string, Awaited<ReturnType<typeof evaluatePrices>>['results']>();
  for (const shopId of new Set(rows.map((r) => r.calc.shopId))) {
    const own = rows.filter((r) => r.calc.shopId === shopId);
    current.set(shopId, await listingPrices(shopId, own.map((r) => r.calc.variantId), own.map((r) => r.listing), standard));
    floors.set(shopId, (await evaluatePrices(shopId, new Map(own.map((r) => [r.calc.variantId, r.calc.roundedPrice])))).results);
  }
  const names = await requesterNames(rows.map((r) => r.listing));
  return {
    items: rows.map(({ calc, listing }) => ({
      listing: toListing(listing, names),
      shopId: calc.shopId,
      variantId: calc.variantId,
      price: current.get(calc.shopId)!.get(calc.variantId)!.price,
      pendingPrice: Number(calc.roundedPrice),
      ...pendingFloor(floors.get(calc.shopId)!.get(calc.variantId)),
      configVersionId: calc.feeVersionId,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** Xác nhận bản chờ của listing: giá theo gian hàng thay giá đang bán (bỏ cả giá ghi đè tay). */
export async function confirmPrice(by: Actor, listingId: string, version: number) {
  const row = await ownListing(null, listingId, version);
  const calc = (await pendingCalculations(row.shopId, [row.variantId!])).get(row.variantId!);
  if (!calc) throw new AppError(409, 'invalid_transition', 'Listing không có giá chờ xác nhận');
  await assertAboveFloor(row, calc.roundedPrice);
  if (!(await confirmPending(calc.id, by.accountId))) throw conflict();
  const updated = await updateListing(row.id, { version }, { priceCalcId: calc.id, manualPrice: null, priceSync: 'pending', priceSyncError: null });
  if (!updated) throw conflict();
  await audit(by, row, updated, { priceCalcId: calc.id, price: calc.roundedPrice });
  return toListing(updated, await requesterNames([updated]));
}

/** Ghi đè tay (bước 6) hoặc bỏ ghi đè (`price = null`). Giá ghi đè vẫn qua bước 5. */
export async function setManualPrice(by: Actor, shopId: string, listingId: string, input: { version: number; price: number | null }) {
  await ownShop(shopId);
  const row = await ownListing(shopId, listingId, input.version);
  if (input.price !== null) await assertAboveFloor(row, String(input.price));
  const manualPrice = input.price === null ? null : String(input.price);
  const updated = await updateListing(row.id, { version: input.version }, { manualPrice, priceSync: 'pending', priceSyncError: null });
  if (!updated) throw conflict();
  await audit(by, row, updated, { manualPrice });
  return toListing(updated, await requesterNames([updated]));
}

/** Bước 5 với giá vốn, cấu hình hiện tại; tổng phí từ 100% trở lên (thực nhận ≤ 0) cũng là dưới giá thấp nhất. */
export async function assertAboveFloor(row: ListingRow, price: string) {
  const r = (await evaluatePrices(row.shopId, new Map([[row.variantId!, price]]))).results.get(row.variantId!)!;
  if (!r.ok || r.belowFloor) throw belowFloor();
}

/** Giá chờ luôn có thực nhận (bản chờ chỉ có khi tổng phí hợp lệ lúc tính); cấu hình đổi sau đó thì theo cấu hình mới. */
const pendingFloor = (r: Parameters<typeof floorView>[0]) => {
  const v = floorView(r);
  return { ...v, netReceived: v.netReceived ?? 0 };
};

const audit = (by: Actor, before: ListingRow, after: ListingRow, change: Record<string, unknown>) =>
  recordAudit({
    companyId: by.companyId,
    actorId: by.accountId,
    action: 'update',
    entityType: 'channel.listings',
    entityId: after.id,
    label: after.sellerSku ?? after.externalSkuId ?? 'Listing chưa có SKU',
    before: { manualPrice: before.manualPrice, priceCalcId: before.priceCalcId },
    after: change,
  });
