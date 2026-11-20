// Giá trên sàn bị sửa ngoài app (#360; Documents/21 §18.3 `outside_hold` kind `price_changed`, 25 §6.5).
import { Decimal } from 'decimal.js';
import type { ListingStatus } from './listing.ts';

/** Sàn có thể áp giá chậm sau lần đẩy giá: trong 15 phút sau lần đẩy giá thành công không so, tránh báo nhầm. */
export const PRICE_SETTLE_MS = 15 * 60 * 1000;

interface PricedListing {
  mode: 'mapped' | 'unmanaged';
  status: ListingStatus;
  outsideChangeKind: string | null;
  listedPrice: string | null;
  /** Lần đẩy **giá** thành công gần nhất; lần đẩy tồn không tính (bình luận LZ-KB2-B06 của #360). */
  lastPricePushedAt: Date | null;
}

/**
 * Giá gốc trên sàn khác giá app đẩy thành công lần cuối (`listedPrice`): listing `live` hoặc `hidden` chưa chờ CEO quyết,
 * sàn trả giá và không khoá giá do khuyến mãi, lần đẩy giá gần nhất đã quá `PRICE_SETTLE_MS`.
 */
export function platformPriceChanged(row: PricedListing, remote: { price?: string; priceLocked?: boolean }, now: number): boolean {
  if (row.mode !== 'mapped' || (row.status !== 'live' && row.status !== 'hidden') || row.outsideChangeKind) return false;
  if (row.listedPrice === null || remote.price === undefined || remote.priceLocked) return false;
  if (row.lastPricePushedAt && now - row.lastPricePushedAt.getTime() < PRICE_SETTLE_MS) return false;
  return !new Decimal(remote.price).eq(row.listedPrice);
}
