// Lãi theo danh sách đơn (#231; Documents/25 §10.2; Documents/21 §21.1). Thuần: số của một đơn lấy từ sổ (`profitOf`,
// repository `order-profits.ts` tính cùng cách bằng SQL, kể cả cờ Dưới giá thấp nhất), ở đây chỉ có biên lãi.
import { Decimal } from 'decimal.js';

type Money = Decimal.Value;

/**
 * Biên lãi gộp theo % thực nhận (25 §10.2: "Lãi gộp = thực nhận − giá vốn"), một chữ số thập phân. Thực nhận ≤ 0 thì
 * không có biên (`null`): chia cho số âm ra dấu ngược.
 */
export function marginPct(net: Money, gross: Money): number | null {
  const n = new Decimal(net);
  if (n.lte(0)) return null;
  return new Decimal(gross).div(n).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toNumber();
}
