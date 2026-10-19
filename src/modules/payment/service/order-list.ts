// Đơn chưa thu cho hộp gán khoản thu chưa khớp (#27 R1, Documents/21 §12.11): payment lọc theo trạng thái tiền rồi đọc
// đơn qua sales; sales không lọc theo trạng thái tiền (tránh vòng sales ↔ payment). Đơn chưa xác nhận chưa có dòng
// trạng thái tiền nên không có trong danh sách.
import { withCompany } from '../../../shared/db/client.ts';
import { getOrdersForFinance } from '../../sales/index.ts';
import { listOrderPayments } from './boundary.ts';

export function listUnpaidOrders(companyId: string, q: { page: number; pageSize: number; search?: string }) {
  return withCompany(companyId, async () => {
    const rows = await listOrderPayments({ status: 'unpaid' });
    const orders = await getOrdersForFinance(rows.map((r) => r.orderId));
    const needle = q.search?.toLowerCase();
    const items = rows.flatMap((r) => {
      const o = orders.get(r.orderId);
      if (!o || o.status === 'cancelled') return [];
      if (needle && ![o.code, o.customerName].some((v) => v?.toLowerCase().includes(needle))) return [];
      return [{ order: { id: o.id, code: o.code, customerName: o.customerName }, amount: r.amount.toNumber() }];
    });
    const start = (q.page - 1) * q.pageSize;
    return { items: items.slice(start, start + q.pageSize), total: items.length, page: q.page, pageSize: q.pageSize };
  });
}
