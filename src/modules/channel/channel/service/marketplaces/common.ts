// Kiểu chung của adapter sàn (Strategy, #103 B7). Chỉ adapter gọi HTTP sàn, ký request và biết mã lỗi của sàn;
// nghiệp vụ nhận kiểu đã chuẩn hoá và `MarketplaceError`. #104–#106 thêm năng lực của mình vào `MarketplaceAdapter`.

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

export interface MarketplaceAdapter {
  /** URL trang uỷ quyền của sàn, mang `state` để kiểm ở callback. */
  authorizeUrl(state: string): string;
  /** Đổi `code` ở callback lấy token. */
  exchangeCode(code: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;
  getSeller(accessToken: string): Promise<SellerInfo>;
}

/**
 * Lỗi khi gọi sàn, đã phân loại (Documents/21 §1.1 R8, R9). `platformCode`, `platformMessage` là mã và câu gốc của sàn.
 * - `unavailable`: lỗi tạm (mạng, 5xx, sàn quá tải), thử lại được.
 * - `unauthorized`: token sai hoặc hết hạn: gian hàng cần nối lại.
 * - `not_whitelisted`: app đang thử, seller chưa trong danh sách.
 * - `rejected`: sàn từ chối, chưa có mã riêng.
 * - `unsupported`: sàn chưa cấu hình hoặc không có năng lực này.
 */
export type MarketplaceErrorKind = 'unavailable' | 'unauthorized' | 'not_whitelisted' | 'rejected' | 'unsupported';

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
