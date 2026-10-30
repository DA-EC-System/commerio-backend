// Kiểu chung của adapter sàn (Strategy, #103 B7). Chỉ adapter gọi HTTP sàn, ký request và biết mã lỗi của sàn;
// nghiệp vụ nhận kiểu đã chuẩn hoá và `MarketplaceError`. #104–#106 thêm năng lực của mình vào `MarketplaceAdapter`.
import type { RemoteState } from '../../domain/listing.ts';

export interface TokenSet {
  accessToken: string;
  /** null khi sàn hoặc người dùng không đưa (token dán từ console): hết hạn access thì phải nối lại. */
  refreshToken: string | null;
  /** null khi không biết hạn (token dán tay). */
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

export interface SellerInfo {
  /** Mã shop của sàn (Lazada: `seller_id`); push chỉ mang mã này nên phải lưu đúng giá trị (#133). */
  externalShopId: string;
  shopName: string;
  region: string;
}

/** Danh mục lá của sàn; `name` là cả đường dẫn ("Quần áo nam > Áo > Áo thun có cổ nam"). */
export interface PlatformCategory {
  externalId: string;
  name: string;
}

/** Thuộc tính bắt buộc ở cấp sản phẩm của một danh mục; `options` rỗng khi nhập tự do. */
export interface CategoryAttribute {
  name: string;
  label: string;
  options: string[];
}

/** Một sản phẩm một SKU (#104 A1). Tiền là chuỗi thập phân; kích thước theo đơn vị của Commerio. */
export interface NewProduct {
  externalCategoryId: string;
  attributes: Record<string, string>;
  name: string;
  description: string;
  /** URL ảnh đã nằm trên sàn (`uploadImage`). */
  imageUrls: string[];
  sellerSku: string;
  price: string;
  quantity: number;
  weightG: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

export interface CreatedProduct {
  externalProductId: string;
  externalSkuId: string;
  /** Sàn cho bán ngay (Lazada `item_status: Active`, gọi thật 28/10); false là chờ duyệt. */
  live: boolean;
}

/**
 * Trạng thái sản phẩm trên sàn, đã chuẩn hoá: `review` chờ duyệt, `live` đang bán, `rejected` bị từ chối,
 * `hold` sàn khoá, `inactive` đã tắt, `deleted` đã xoá.
 */
export type { RemoteState };

export interface RemoteSku {
  externalProductId: string;
  externalSkuId: string;
  sellerSku: string;
  title: string;
  state: RemoteState;
  rejectReason: string | null;
  quantity: number;
}

export interface PriceQuantity {
  externalProductId: string;
  externalSkuId: string;
  price?: string;
  quantity?: number;
}

/** Một khoản tiền sàn ghi theo đơn trong kỳ quyết toán (#117; Lazada `/finance/transaction/details/get`). */
export interface SettlementTxn {
  /** Mã giao dịch của sàn, duy nhất: chống ghi trùng khi kéo lại cùng kỳ. */
  txnId: string;
  externalOrderId: string | null;
  /** `YYYY-MM-DD`. */
  date: string;
  feeName: string;
  transactionType: string;
  /** Có dấu: sàn trả shop dương, sàn trừ âm. Chuỗi thập phân. */
  amount: string;
  /** Thuế sàn khấu trừ của khoản này (số dương), `"0"` khi không có. */
  withholding: string;
}

/** Một kỳ quyết toán (#117; Lazada `/finance/payout/status/get`). */
export interface Payout {
  statementNumber: string;
  createdAt: string;
  payout: string;
  closingBalance: string;
  paid: boolean;
}

/**
 * Trạng thái một món trên sàn, đã chuẩn hoá theo trạng thái kiện của app (#105). `pending`: chưa đóng gói (kiện giữ
 * hàng hoặc thiếu hàng); `return_failed`: hoàn hàng thất bại, kiện giữ `returning` và cần xử lý.
 */
export type RemoteLineStatus =
  | 'pending'
  | 'packed'
  | 'awaiting_pickup'
  | 'in_transit'
  | 'delivered'
  | 'delivery_failed'
  | 'returning'
  | 'returned'
  | 'return_failed'
  | 'lost'
  | 'cancelled';

export interface RemoteOrderRef {
  externalOrderId: string;
  placedAt: Date;
  updatedAt: Date;
}

/** Một món của đơn sàn. Tiền là chuỗi thập phân; Lazada mỗi món một đơn vị. */
export interface RemoteOrderLine {
  externalLineId: string;
  sellerSku: string;
  productName: string;
  unitPrice: string;
  sellerDiscount: string;
  platformDiscount: string;
  /** Mã kiện của sàn; null khi sàn chưa chia kiện. */
  packageCode: string | null;
  trackingCode: string | null;
  rawStatus: string;
  /** null khi sàn trả giá trị app chưa biết. */
  status: RemoteLineStatus | null;
}

/** Đơn sàn đã chuẩn hoá (#105); kéo định kỳ và push (#133) cùng đưa vào service nhận đơn. */
export interface RemoteOrder {
  externalOrderId: string;
  /** Các trạng thái gốc của món, nối bằng dấu phẩy, chỉ để hiện. */
  rawStatus: string;
  /** Khách đã trả, hoặc đơn COD sàn đã nhận. */
  paid: boolean;
  isCod: boolean;
  placedAt: Date;
  updatedAt: Date;
  shipBy: Date | null;
  shippingAddress: { name: string; phone: string; address: string } | null;
  shippingFee: string;
  /** Khách xin huỷ, chờ người bán đồng ý. */
  cancelRequested: boolean;
  lines: RemoteOrderLine[];
}

/** Kết quả theo từng SKU khi đẩy theo lô (§18.4): SKU lỗi không đánh lỗi cả lô. */
export type PerSkuResult = { externalSkuId: string; ok: true } | { externalSkuId: string; ok: false; code: string; message: string };

/** Cách nối gian hàng (#163): `oauth` qua trang uỷ quyền của sàn, `token` dán token lấy trên console của sàn. */
export type ConnectMethod = 'oauth' | 'token';

export interface MarketplaceAdapter {
  /** Tên sàn hiển thị cho người dùng. */
  readonly name: string;
  /** Cách nối dùng được với cấu hình hiện tại; rỗng là sàn chưa nối được trên môi trường này. */
  connectMethods(): readonly ConnectMethod[];
  /** URL trang uỷ quyền của sàn, mang `state` để kiểm ở callback. */
  authorizeUrl(state: string): string;
  /** Đổi `code` ở callback lấy token. */
  exchangeCode(code: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;
  getSeller(accessToken: string): Promise<SellerInfo>;
  listCategories(accessToken: string): Promise<PlatformCategory[]>;
  categoryAttributes(accessToken: string, externalCategoryId: string): Promise<CategoryAttribute[]>;
  /** Đưa ảnh từ URL công khai lên sàn, trả URL trên sàn. */
  uploadImage(accessToken: string, url: string): Promise<string>;
  createProduct(accessToken: string, product: NewProduct): Promise<CreatedProduct>;
  /** Chỉ SKU có SellerSku trong danh sách (shop thử dùng chung, #104 A4). */
  getSkus(accessToken: string, sellerSkus: readonly string[]): Promise<RemoteSku[]>;
  /** Tự chia lô theo giới hạn của sàn. Token sai ném `unauthorized`; lỗi khác trả theo từng SKU. */
  updatePriceQuantity(accessToken: string, items: readonly PriceQuantity[]): Promise<PerSkuResult[]>;
  deactivate(accessToken: string, externalProductId: string, externalSkuId: string): Promise<void>;
  /** Khoản tiền theo đơn trong khoảng ngày `[from, to]` (#117). Sàn chưa hỗ trợ thì không có. */
  getTransactions?(accessToken: string, from: string, to: string): Promise<SettlementTxn[]>;
  /** Các kỳ quyết toán từ ngày `from` (#117). */
  getPayouts?(accessToken: string, from: string): Promise<Payout[]>;
  /** Đơn có cập nhật sau `updatedAfter`, cũ trước, lật trang bằng `offset` (#105). */
  listOrders?(accessToken: string, updatedAfter: Date, offset: number): Promise<{ orders: RemoteOrderRef[]; hasMore: boolean }>;
  /** Một đơn kèm các món (#105, #133). */
  getOrder?(accessToken: string, externalOrderId: string): Promise<RemoteOrder>;
  /** Lý do huỷ sàn cho phép với các món này; sàn không cho huỷ thì ném `rejected` kèm câu của sàn (#105 PR 2). */
  cancelReasons?(accessToken: string, externalOrderId: string, externalLineIds: readonly string[]): Promise<{ id: string; label: string }[]>;
  /** Người bán huỷ các món; sàn xác nhận sau, đơn về qua lần kéo kế tiếp. */
  cancelOrder?(accessToken: string, externalOrderId: string, externalLineIds: readonly string[], reasonId: string): Promise<void>;
  /** Đồng ý hay từ chối yêu cầu huỷ của khách trên đơn. */
  decideCancelRequest?(accessToken: string, externalOrderId: string, accept: boolean): Promise<void>;
}

/**
 * Lỗi khi gọi sàn, đã phân loại (Documents/21 §1.1 R8, R9). `platformCode`, `platformMessage` là mã và câu gốc của sàn.
 * - `unavailable`: lỗi tạm (mạng, 5xx, sàn quá tải), thử lại được.
 * - `unauthorized`: token sai hoặc hết hạn: gian hàng cần nối lại.
 * - `rejected`: sàn từ chối, chưa có mã riêng.
 * - `unsupported`: sàn chưa cấu hình hoặc không có năng lực này.
 */
export type MarketplaceErrorKind = 'unavailable' | 'unauthorized' | 'rejected' | 'unsupported';

export class MarketplaceError extends Error {
  readonly kind: MarketplaceErrorKind;
  readonly platformCode: string | null;
  readonly platformMessage: string | null;

  constructor(kind: MarketplaceErrorKind, platformCode: string | null = null, platformMessage: string | null = null) {
    super(`Sàn trả lỗi ${kind}${platformCode ? ` (${platformCode})` : ''}`);
    this.name = 'MarketplaceError';
    this.kind = kind;
    this.platformCode = platformCode;
    this.platformMessage = platformMessage;
  }
}
