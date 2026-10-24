// Mảnh dùng chung của các API tài chính (Documents/21 §12.8): tham chiếu đơn, người, chứng từ; trang; tìm kiếm.
import { AppError } from '../../../../shared/errors/app-error.ts';
import { getOrdersForFinance, type OrderForFinance } from '../../../order/index.ts';
import { findAccountById } from '../../../core/index.ts';

export type Orders = Map<string, OrderForFinance>;

export interface Page {
  page: number;
  pageSize: number;
  search?: string;
}

export const money = (v: string) => Number(v);
export { isUuid } from '../../../../shared/uuid.ts';
export const notFound = (what: string) => new AppError(404, 'not_found', `Không tìm thấy ${what}`);

/** Đơn của các dòng (một truy vấn sales, T8). */
export const ordersOf = (orderIds: readonly (string | null)[]) =>
  getOrdersForFinance(orderIds.filter((id): id is string => !!id));

export const orderRef = (orders: Orders, id: string | null) => {
  const o = id ? orders.get(id) : undefined;
  return o ? { id: o.id, code: o.code, customerName: o.customerName } : null;
};

export const orderRefWithPhone = (orders: Orders, id: string) => {
  const o = orders.get(id);
  return o ? { id: o.id, code: o.code, customerName: o.customerName, customerPhone: o.customerPhone } : null;
};

type UserRef = { id: string; name: string };

/**
 * `UserRef` (§12.8); `staff.accounts` không có RLS nên đọc được trong `withCompany`. `cache` dùng chung trong một lượt
 * danh sách: mỗi người đọc một lần.
 */
export function userRef(id: string | null, cache = new Map<string, Promise<UserRef | null>>()): Promise<UserRef | null> {
  if (!id) return Promise.resolve(null);
  let ref = cache.get(id);
  if (!ref) {
    ref = findAccountById(id).then((a) => (a ? { id: a.id, name: a.fullName } : null));
    cache.set(id, ref);
  }
  return ref;
}

/**
 * Trang của danh sách đã lọc theo DB; có `search` thì khớp không phân biệt hoa thường trong các chuỗi `keys` (mã đơn, tên
 * khách nằm ở sales: lọc trong bộ nhớ như D10, plan #27 A16).
 */
export function paginate<T>(rows: T[], q: Page, keys: (row: T) => (string | null | undefined)[]) {
  const needle = q.search?.toLowerCase();
  const matched = needle ? rows.filter((r) => keys(r).some((k) => k?.toLowerCase().includes(needle))) : rows;
  const start = (q.page - 1) * q.pageSize;
  return { slice: matched.slice(start, start + q.pageSize), total: matched.length, page: q.page, pageSize: q.pageSize };
}
