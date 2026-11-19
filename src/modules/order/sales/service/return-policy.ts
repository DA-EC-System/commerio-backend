// Chính sách hạn trả của gian hàng (#236): channel trả qua `ctx.returnPoliciesOf` (tiêm ở `src/wiring.ts`), sales điền
// mặc định cho đơn không gian hàng hay gian hàng không tìm thấy. Gọi trong `withCompany`.
import { AppError } from '../../../../shared/errors/app-error.ts';
import { DEFAULT_RETURN_POLICY, type ReturnPolicy } from '../domain/order.ts';

/** Phần `SalesContext` cần ở đây; khai tại chỗ để `orders.ts` import file này không thành vòng. */
export interface ReturnPolicySource {
  readonly returnPoliciesOf?: (shopIds: readonly string[]) => Promise<Map<string, ReturnPolicy>>;
}

/**
 * Chính sách theo id gian hàng, một lời gọi cho cả lô. Bỏ `null` (đơn tay), bỏ trùng; danh sách rỗng thì Map rỗng, không
 * gọi. `ctx` thiếu hàm (ctx dựng tay, chưa nối ở `src/wiring.ts`) thì ném, như việc hoàn tất: đó là lỗi nối module, không
 * phải "gian hàng không thấy", rơi về 7 ngày sẽ hiện sai hạn của gian hàng đặt hạn khác. Lỗi của channel cũng ném tiếp:
 * bên gọi không được rơi về 7 ngày (có thể chốt sớm đơn của gian hàng đặt hạn dài hơn).
 */
export async function returnPoliciesFor(
  ctx: ReturnPolicySource,
  shopIds: readonly (string | null)[],
): Promise<Map<string, ReturnPolicy>> {
  if (!ctx.returnPoliciesOf) {
    throw new AppError(500, 'internal_error', 'Chưa nối hạn trả của gian hàng (ctx.returnPoliciesOf, src/wiring.ts)');
  }
  const ids = [...new Set(shopIds.filter((id): id is string => id !== null))];
  if (!ids.length) return new Map();
  return ctx.returnPoliciesOf(ids);
}

/** Chính sách của một gian hàng trong Map đã đọc; vắng (hoặc đơn không gian hàng) là mặc định 7 ngày. */
export function policyOf(map: Map<string, ReturnPolicy>, shopId: string | null): ReturnPolicy {
  return (shopId && map.get(shopId)) || DEFAULT_RETURN_POLICY;
}
