// Helper riêng của test sổ tiền (#355): yêu cầu trả có dòng, để finance tính trần hoàn tiền. Không đặt ở
// `integration/helpers/` (đóng băng khi các nhánh làm song song, test/CLAUDE.md).
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { eq } from 'drizzle-orm';
import { orderLines, returnRequestLines, returnRequests } from '#src/modules/order/sales/repository/schema.ts';
import { withCompany } from '#src/shared/db/client.ts';

/**
 * Yêu cầu trả tạo tay của đơn, một dòng trên dòng đơn đầu, gắn kiện `packageId` (null: dòng chưa gắn kiện). Ghi thẳng như
 * `createOrder`. Finance đọc dòng này khi nhận `sales.return_refunded` để tính trần hoàn tiền (#355).
 */
export async function createReturnRequest(
  companyId: string,
  options: { orderId: string; packageId: string | null; quantity: number; unitPrice: number },
) {
  return withCompany(companyId, async (tx) => {
    const [line] = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, options.orderId)).limit(1);
    if (!line) throw new Error(`createReturnRequest: đơn ${options.orderId} không có dòng`);
    const unitPrice = new Decimal(options.unitPrice);
    const [request] = await tx
      .insert(returnRequests)
      .values({
        companyId,
        code: `YCT-${randomUUID().slice(0, 8).toUpperCase()}`,
        orderId: options.orderId,
        source: 'manual',
        reason: 'Khách trả hàng',
        refundAmount: unitPrice.times(options.quantity).toFixed(2),
      })
      .returning({ id: returnRequests.id, code: returnRequests.code });
    await tx.insert(returnRequestLines).values({
      companyId,
      requestId: request!.id,
      orderLineId: line.id,
      packageId: options.packageId,
      quantity: options.quantity,
      unitPrice: unitPrice.toFixed(2),
    });
    return { returnRequestId: request!.id, code: request!.code };
  });
}
