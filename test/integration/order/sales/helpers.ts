// Thông tin mô tả trống của đơn sàn (#260), cho fixture không quan tâm các trường này.
import type { RemoteLineInfo, RemoteOrderInfo, RemoteShipping } from '#src/modules/channel/channel/service/marketplaces/common.ts';

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
