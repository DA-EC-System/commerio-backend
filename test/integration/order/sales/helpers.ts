// Thông tin mô tả trống của đơn sàn (#260), cho fixture không quan tâm các trường này.
import type { RemoteLineInfo, RemoteOrderInfo, RemoteShipping } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { testPool } from '../../helpers/db.ts';
import { seedPackage } from '../fulfillment/helpers.ts';

export const noOrderInfo: RemoteOrderInfo = {
  platformPaymentMethod: null,
  buyerNote: null,
  shippingFeeOriginal: null,
  shippingFeeDiscountSeller: null,
  shippingFeeDiscountPlatform: null,
};

export const noLineInfo: RemoteLineInfo = {
  thumbnailUrl: null,
  attributesLabel: null,
  externalSkuId: null,
  externalShopSku: null,
  externalProductId: null,
  paidPrice: null,
  taxAmount: null,
  shippingAmount: null,
  walletCredits: null,
  cancelReason: null,
  cancelReasonDetail: null,
  cancelInitiator: null,
  cancelKind: null,
  reverseOrderId: null,
  returnStatus: null,
};

export const noShipping: RemoteShipping = { shipmentProvider: null, shippingProviderType: null, shippingType: null, promisedShippingAt: null };

/**
 * Đơn sàn `processing` có mọi kiện đã huỷ mà còn một dòng chưa huỷ nằm ngoài mọi kiện (món sàn còn bán, vd trạng thái
 * lạ #358): việc nền không khép đơn này (#236 PR 3, P2). Huỷ kiện, ghi `cancelled_qty` và chèn dòng sống trong **một**
 * giao dịch: trigger kiểm bằng lúc commit, và việc nền của file khác không thấy trạng thái nửa chừng.
 */
export async function allCancelledWithLiveLine(companyId: string): Promise<{ orderId: string }> {
  const { variantId } = await createVariant(companyId);
  const { orderId, packageId } = await seedPackage(companyId, { status: 'reserved', orderStatus: 'processing', lines: [{ variantId, quantity: 1 }] });
  const client = await testPool().connect();
  try {
    await client.query('begin');
    await client.query(`update "order".packages set status = 'cancelled' where id = $1`, [packageId]);
    await client.query(`update "order".order_lines set cancelled_qty = quantity where order_id = $1`, [orderId]);
    await client.query(
      `insert into "order".order_lines (company_id, order_id, variant_id, product_name, quantity, unit_price, line_total)
       values ($1, $2, $3, 'Món sàn còn bán', 1, 0, 0)`,
      [companyId, orderId, variantId],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return { orderId };
}
