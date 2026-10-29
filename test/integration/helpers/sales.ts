import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { products, productVariants } from '#src/modules/product/catalog/repository/schema.ts';
import type { OrderSource, PaymentMethod } from '#src/modules/order/sales/index.ts';
import { orderLines, orders } from '#src/modules/order/sales/repository/schema.ts';
import { withCompany } from '#src/shared/db/client.ts';

interface OrderLineInput {
  variantId: string;
  quantity: number;
  unitPrice: number;
}

/**
 * Một đơn của công ty, ghi thẳng vào bảng của sales trong `withCompany` như request thật (D17: link/QR không chờ API
 * tạo đơn #24). Dòng đơn chép SKU, tên sản phẩm của biến thể (tạo bằng `createVariant`). Đơn tay mặc định trả trước;
 * đơn sàn không có phương thức thanh toán, có gian hàng và mã đơn sàn ngẫu nhiên (19-D11, D32). Không tạo
 * `finance.order_payments` (việc của payment khi xác nhận đơn, A8).
 */
export async function createOrder(
  companyId: string,
  options: {
    lines: readonly OrderLineInput[];
    paymentMethod?: PaymentMethod;
    source?: OrderSource;
  },
) {
  const source = options.source ?? 'manual';
  const marketplace = source === 'marketplace';
  const code = `DH-${randomUUID().slice(0, 8).toUpperCase()}`;
  const lineTotal = (l: OrderLineInput) => new Decimal(l.unitPrice).times(l.quantity);
  const total = options.lines.reduce((sum, l) => sum.plus(lineTotal(l)), new Decimal(0)).toFixed(2);

  return withCompany(companyId, async (tx) => {
    const variants = await tx
      .select({ id: productVariants.id, sku: productVariants.sku, productName: products.name })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(inArray(productVariants.id, options.lines.map((l) => l.variantId)));
    const byId = new Map(variants.map((v) => [v.id, v]));

    const [order] = await tx
      .insert(orders)
      .values({
        companyId,
        code,
        source,
        paymentMethod: marketplace ? null : (options.paymentMethod ?? 'prepaid'),
        shopId: marketplace ? randomUUID() : null,
        externalOrderId: marketplace ? `SAN-${randomUUID().slice(0, 8)}` : null,
        subtotal: total,
        total,
      })
      .returning({ id: orders.id });
    await tx.insert(orderLines).values(
      options.lines.map((l) => {
        const variant = byId.get(l.variantId);
        if (!variant) throw new Error(`createOrder: không thấy biến thể ${l.variantId} của công ty`);
        return {
          companyId,
          orderId: order!.id,
          variantId: l.variantId,
          sku: variant.sku,
          productName: variant.productName,
          quantity: l.quantity,
          unitPrice: new Decimal(l.unitPrice).toFixed(2),
          lineTotal: lineTotal(l).toFixed(2),
        };
      }),
    );
    return { orderId: order!.id, code, total };
  });
}
