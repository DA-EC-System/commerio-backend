// Đọc đơn cho payment (getOrderForPayment, #23). Chỉ schema sales: đơn + khách, không join chéo schema.
import { eq } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { customers, orders } from './schema.ts';

export async function findOrderForPayment(orderId: string, lock?: 'share') {
  // Chỉ khoá dòng đơn: bên huỷ đơn giữ khoá dòng này thì câu này chờ tới khi họ commit (plan #23 A7). Tách câu riêng vì
  // `FOR SHARE` không áp được lên phía nullable của left join, còn `OF` của Drizzle ghi tên có schema mà PostgreSQL từ chối.
  if (lock) await getDb().select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for('share');
  const [row] = await getDb()
    .select({
      id: orders.id,
      code: orders.code,
      status: orders.status,
      source: orders.source,
      paymentMethod: orders.paymentMethod,
      total: orders.total,
      customerId: customers.id,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId));
  return row;
}
