// Lãi theo danh sách đơn (#231; Documents/25 §10.2, §6.2; Documents/21 §21.1). Thuần: số của một đơn lấy từ sổ
// (`profitOf`, repository `orderProfits` tính cùng cách bằng SQL), ở đây chỉ có biên lãi và cờ Dưới giá thấp nhất.
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

export interface FloorInput {
  /** Thực nhận của phần đã giao. */
  net: Money;
  /** Giá vốn theo sổ: âm (tiền ra), 0 khi chưa có dòng giá vốn. */
  cogs: Money;
  estimated: boolean;
  /** Lãi tối thiểu (%) của phiên bản `min_margin` áp tại ngày giao; `null` khi chưa có cấu hình. */
  minMarginPct: number | null;
}

/**
 * Cờ Dưới giá thấp nhất thực tế (25 §10.2, E132): "Giá thấp nhất = giá vốn × (1 + lãi tối thiểu)" (25 §6.2, bước 5
 * so với thực nhận). Chỉ xét số thật ("lãi thực của đơn", E132): đơn còn ước tính thì không bật, vì số ước tính lấy từ
 * chính cấu hình phí mà cờ này dùng để báo lỗi thời. Chưa có giá vốn hoặc chưa có cấu hình lãi tối thiểu thì không bật.
 * Repository `orderProfits` tính cùng điều kiện bằng SQL để lọc và đếm trên toàn bộ kết quả.
 */
export function isBelowFloor(p: FloorInput): boolean {
  const cost = new Decimal(p.cogs).negated();
  if (p.estimated || p.minMarginPct === null || cost.lte(0)) return false;
  return new Decimal(p.net).lt(cost.times(new Decimal(p.minMarginPct).div(100).plus(1)));
}
