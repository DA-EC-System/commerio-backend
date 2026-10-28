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

/** Kết quả theo từng SKU khi đẩy theo lô (§18.4): SKU lỗi không đánh lỗi cả lô. */
export type PerSkuResult = { externalSkuId: string; ok: true } | { externalSkuId: string; ok: false; code: string; message: string };

export interface MarketplaceAdapter {
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
